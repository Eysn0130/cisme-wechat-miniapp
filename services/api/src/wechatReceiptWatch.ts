import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { transaction, type DbClient } from './db.js';
import { receiptView } from './wechatReceipt.js';
import { validateShippingBinding, type ReceiptObservation, type ShippingBinding,
  type WechatOrderShippingClient } from './wechatOrderShipping.js';

type Source = {orderId:string;owner:string;orderVersion:number;shipmentId:string;shipmentVersion:number;
  paymentInboxId:string;binding:ShippingBinding};
type SourceResult={status:'ready'|'waiting';source:Source}|{status:'invalid'};
type Claim = {source:Source;queryId:string;leaseToken:string};
const nextHours=(state:number)=>state===2?12:24;
const retryMinutes=(failures:number)=>Math.min(1440,5*2**Math.min(failures-1,8));

/** A bounded read-only observation lane for orders whose shipping upload was
 * already verified. It never confirms a local receipt, settles money or calls
 * uploadOnce. Leases and query IDs fence late responses across workers/users. */
export class WechatReceiptWatch {
  constructor(private readonly pool:pg.Pool,private readonly appId:string,private readonly merchantId:string,
    private readonly channel:Pick<WechatOrderShippingClient,'queryOrder'>){}

  private async source(client:DbClient,orderId:string):Promise<SourceResult>{
    const order=(await client.query(`SELECT o.member_id,o.order_number,o.status,o.version AS order_version,
      o.transaction_source_kind,s.id AS shipment_id,s.version AS shipment_version,y.state AS sync_state
      FROM commerce_order o JOIN commerce_shipment s ON s.order_id=o.id
      JOIN commerce_shipping_sync y ON y.id=s.shipping_sync_id AND y.order_id=o.id
      WHERE o.id=$1`,[orderId])).rows[0];
    if(!order||order.status!=='paid'||order.transaction_source_kind!=='verified_commerce')return {status:'invalid'};
    const payments=(await client.query(`SELECT p.member_id,p.app_id,p.merchant_id,p.payer_openid,p.out_trade_no,p.amount_cents,
      i.id AS payment_inbox_id,i.provider_transaction_id,i.payer_total_cents
      FROM commerce_payment_attempt p JOIN commission_payment_inbox i
        ON i.order_id=p.order_id AND i.app_id=p.app_id AND i.merchant_id=p.merchant_id
      WHERE p.order_id=$1 AND p.state='paid' AND i.state='applied' AND i.composition_status='full_cash'`,[orderId])).rows;
    if(payments.length!==1)return {status:'invalid'};
    const paid=payments[0];
    if(paid.member_id!==order.member_id||paid.app_id!==this.appId||paid.merchant_id!==this.merchantId
      ||paid.out_trade_no!==order.order_number||Number(paid.amount_cents)!==Number(paid.payer_total_cents))return {status:'invalid'};
    const binding:ShippingBinding={merchantId:paid.merchant_id,merchantOrderNumber:paid.out_trade_no,
      transactionId:paid.provider_transaction_id,payerOpenid:paid.payer_openid,
      payerTotalCents:Number(paid.payer_total_cents)};
    try{validateShippingBinding(binding);}catch{return {status:'invalid'};}
    if(!['prepared','dispatching','verifying','synced'].includes(order.sync_state))return {status:'invalid'};
    const source={orderId,owner:order.member_id,orderVersion:order.order_version,shipmentId:order.shipment_id,
      shipmentVersion:order.shipment_version,paymentInboxId:paid.payment_inbox_id,binding};
    return {status:order.sync_state==='synced'?'ready':'waiting',source};
  }

  private async seed():Promise<number>{
    const result=await this.pool.query(`INSERT INTO commerce_wechat_receipt_observation
      (order_id,shipment_id,payment_inbox_id)
      SELECT o.id,s.id,i.id FROM commerce_shipping_sync y
      JOIN commerce_shipment s ON s.shipping_sync_id=y.id
      JOIN commerce_order o ON o.id=y.order_id
      JOIN commerce_payment_attempt p ON p.order_id=o.id
      JOIN commission_payment_inbox i ON i.order_id=o.id AND i.app_id=p.app_id AND i.merchant_id=p.merchant_id
      WHERE y.state='synced' AND o.status='paid' AND o.transaction_source_kind='verified_commerce'
        AND p.state='paid' AND p.app_id=$1 AND p.merchant_id=$2
        AND i.state='applied' AND i.composition_status='full_cash'
        AND NOT EXISTS(SELECT 1 FROM commerce_wechat_receipt_observation w WHERE w.order_id=o.id)
      ORDER BY y.order_id LIMIT 20 ON CONFLICT(order_id) DO NOTHING`,[this.appId,this.merchantId]);
    return result.rowCount??0;
  }

  private async claim():Promise<Claim|null>{
    return transaction(this.pool,async client=>{
      for(let attempt=0;attempt<10;attempt++){
      const row=(await client.query(`SELECT w.order_id,w.shipment_id,w.payment_inbox_id
        FROM commerce_wechat_receipt_observation w
        WHERE w.watch_state='active' AND w.watch_next_attempt_at<=clock_timestamp()
          AND (w.watch_lease_until IS NULL OR w.watch_lease_until<clock_timestamp())
        ORDER BY w.watch_next_attempt_at,w.order_id LIMIT 1 FOR UPDATE OF w SKIP LOCKED`)).rows[0];
      if(!row)return null;
      const result=await this.source(client,row.order_id);
      const source=result.status==='invalid'?null:result.source;
      if(!source||source.shipmentId!==row.shipment_id||source.paymentInboxId!==row.payment_inbox_id){
        await client.query(`UPDATE commerce_wechat_receipt_observation SET watch_state='manual_review',
          watch_next_attempt_at=NULL,watch_last_error_code='PAYMENT_OR_SHIPMENT_BINDING_CHANGED'
          WHERE order_id=$1`,[row.order_id]);
        continue;
      }
      if(result.status==='waiting'){
        await client.query(`UPDATE commerce_wechat_receipt_observation SET
          watch_next_attempt_at=clock_timestamp()+interval '5 minutes',watch_last_error_code='SHIPPING_SYNC_PENDING',
          watch_lease_token=NULL,watch_lease_until=NULL WHERE order_id=$1`,[row.order_id]);
        continue;
      }
      const queryId=randomUUID(),leaseToken=randomUUID();
      await client.query(`UPDATE commerce_wechat_receipt_observation SET
        query_id=$2,query_started_at=clock_timestamp(),watch_lease_token=$3,
        watch_lease_until=clock_timestamp()+interval '90 seconds'
        WHERE order_id=$1`,[row.order_id,queryId,leaseToken]);
      return {source,queryId,leaseToken};
      }
      return null;
    });
  }

  private async finish(claim:Claim,observed:ReceiptObservation):Promise<boolean>{
    return transaction(this.pool,async client=>{
      const {source,queryId,leaseToken}=claim;
      const result=await this.source(client,source.orderId);
      const current=result.status==='ready'?result.source:null;
      const valid=current&&current.owner===source.owner&&current.orderVersion===source.orderVersion
        && current.shipmentVersion===source.shipmentVersion&&current.shipmentId===source.shipmentId
        && current.paymentInboxId===source.paymentInboxId
        && JSON.stringify(current.binding)===JSON.stringify(source.binding);
      if(!valid){
        await client.query(`UPDATE commerce_wechat_receipt_observation SET
          watch_lease_token=NULL,watch_lease_until=NULL,watch_next_attempt_at=clock_timestamp()+interval '5 minutes',
          watch_last_error_code='SOURCE_CHANGED_DURING_QUERY'
          WHERE order_id=$1 AND query_id=$2 AND watch_lease_token=$3 AND watch_state='active'`,
          [source.orderId,queryId,leaseToken]);
        return false;
      }
      const previous=(await client.query(`SELECT platform_order_state,in_complaint FROM commerce_wechat_receipt_observation
        WHERE order_id=$1 AND query_id=$2 AND watch_lease_token=$3 FOR UPDATE`,
        [source.orderId,queryId,leaseToken])).rows[0];
      if(!previous)return false;
      const terminal=observed.platformOrderState===4||observed.platformOrderState===5;
      const updated=(await client.query(`UPDATE commerce_wechat_receipt_observation SET
        platform_order_state=$4,in_complaint=$5,observed_at=clock_timestamp(),version=version+1,
        watch_state=$6,watch_next_attempt_at=CASE WHEN $6='complete' THEN NULL
          ELSE clock_timestamp()+($7::integer * interval '1 hour') END,
        watch_lease_token=NULL,watch_lease_until=NULL,watch_failures=0,watch_last_error_code=NULL
        WHERE order_id=$1 AND query_id=$2 AND watch_lease_token=$3
        RETURNING observed_at,version`,[source.orderId,queryId,leaseToken,observed.platformOrderState,
        observed.inComplaint,terminal?'complete':'active',nextHours(observed.platformOrderState)])).rows[0];
      if(!updated)return false;
      if(previous.platform_order_state!==observed.platformOrderState||previous.in_complaint!==observed.inComplaint){
        const view=receiptView(observed.platformOrderState,observed.inComplaint,updated.observed_at);
        await client.query(`INSERT INTO audit_log(principal_id,action,object_type,object_id,after_state,trace_id)
          VALUES('system:wechat-receipt-watch','commerce.wechat_receipt.observed','commerce_order',$1,$2,$3)`,
          [source.orderId,{status:view.status,inComplaint:view.inComplaint,observedAt:view.observedAt,
            version:updated.version},`wechat-receipt-watch:${queryId}`]);
      }
      return true;
    });
  }

  private async fail(claim:Claim,orderSpecific:boolean):Promise<void>{
    await transaction(this.pool,async client=>{
      const {source,queryId,leaseToken}=claim;
      const row=(await client.query(`SELECT watch_failures FROM commerce_wechat_receipt_observation
        WHERE order_id=$1 AND query_id=$2 AND watch_lease_token=$3 FOR UPDATE`,
        [source.orderId,queryId,leaseToken])).rows[0];
      if(!row)return;
      await client.query(`UPDATE commerce_wechat_receipt_observation SET
        watch_failures=watch_failures+1,
        watch_last_error_code=CASE WHEN $5 THEN 'ORDER_RESPONSE_MISMATCH' ELSE 'QUERY_UNAVAILABLE' END,
        watch_state=CASE WHEN $5 AND watch_failures>=2 THEN 'manual_review' ELSE 'active' END,
        watch_next_attempt_at=CASE WHEN $5 AND watch_failures>=2 THEN NULL
          ELSE clock_timestamp()+($4::integer * interval '1 minute') END,
        watch_lease_token=NULL,watch_lease_until=NULL
        WHERE order_id=$1 AND query_id=$2 AND watch_lease_token=$3`,
        [source.orderId,queryId,leaseToken,retryMinutes(Number(row.watch_failures)+1),orderSpecific]);
      if(!orderSpecific)await client.query(`UPDATE commerce_wechat_receipt_watch_control SET
        cooldown_until=GREATEST(cooldown_until,clock_timestamp()+interval '30 minutes'),
        last_error_code='QUERY_UNAVAILABLE' WHERE singleton=true`);
    });
  }

  async runCycle(limit=4):Promise<{processed:number;status:'processed'|'cooldown'}>{
    if(!Number.isSafeInteger(limit)||limit<1||limit>10)throw new Error('RECEIPT_WATCH_LIMIT_INVALID');
    const cooldown=(await this.pool.query(`SELECT cooldown_until>clock_timestamp() AS active
      FROM commerce_wechat_receipt_watch_control WHERE singleton=true`)).rows[0];
    if(!cooldown||cooldown.active)return {processed:0,status:'cooldown'};
    await this.seed();
    let processed=0;
    for(let n=0;n<limit;n++){
      const claim=await this.claim();
      if(!claim)break;
      let observed:ReceiptObservation;
      try{observed=await this.channel.queryOrder(claim.source.binding);}catch(error){
        const code=(error as {code?:unknown})?.code;
        const orderSpecific=code==='WECHAT_RECEIPT_ORDER_BINDING_MISMATCH'
          ||code==='WECHAT_SHIPPING_BINDING_INVALID';
        await this.fail(claim,orderSpecific);
        // A mismatched individual order cannot starve the rest of the batch.
        // Unclassified provider/account failures cool the whole lane so 48001
        // and permission errors are not retried every worker tick.
        if(orderSpecific)continue;
        return {processed,status:'cooldown'};
      }
      if(await this.finish(claim,observed))processed++;
    }
    return {processed,status:'processed'};
  }
}
