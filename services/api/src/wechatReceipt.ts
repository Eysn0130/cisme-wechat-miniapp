import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { DomainError } from '@cisme/domain';
import { requireActiveMemberWithClient } from './authority.js';
import { transaction, type DbClient } from './db.js';
import { validateShippingBinding, type ReceiptObservation, type ShippingBinding,
  type WechatOrderShippingClient } from './wechatOrderShipping.js';

const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const fail=(code:string,status=409):never=>{throw new DomainError(code,'微信收货状态暂无法核对，请稍后刷新原订单或联系客服',status);};
type Source={owner:string;orderVersion:number;shipmentId:string;shipmentVersion:number;paymentInboxId:string;binding:ShippingBinding};

export function receiptState(state:number|null):'unverified'|'awaiting_shipping'|'shipped'|'confirmed'|'completed'|'refunded'|'settlement_pending'|'unknown'{
  switch(state){case null:return 'unverified';case 1:return 'awaiting_shipping';case 2:return 'shipped';
    case 3:return 'confirmed';case 4:return 'completed';case 5:return 'refunded';
    case 6:return 'settlement_pending';default:return 'unknown';}
}
export function receiptView(state:number|null,inComplaint:boolean|null,observedAt:Date|null){
  const status=receiptState(state);
  const labels:Record<typeof status,string>={unverified:'微信收货状态尚未核对',awaiting_shipping:'微信仍显示待发货',
    shipped:'微信显示已发货',confirmed:'微信已记录确认收货',completed:'微信显示交易完成',
    refunded:'微信显示已退款',settlement_pending:'微信显示资金待结算',unknown:'微信状态需人工核对'};
  return {source:'wechat_get_order' as const,status,label:labels[status],inComplaint,
    observedAt:observedAt?.toISOString()??null,canOpenComponent:status==='shipped'&&inComplaint===false};
}

/** Reads only get_order. No shipping executor, payment, refund or worker path is
 * reachable through this class. A query may replace its own projection only. */
export class WechatReceiptService {
  constructor(private readonly pool:pg.Pool,private readonly appId:string,private readonly merchantId:string,
    private readonly channel:Pick<WechatOrderShippingClient,'queryOrder'>){}

  private async source(client:DbClient,actor:string|undefined,orderId:string):Promise<Source>{
    const owner=await requireActiveMemberWithClient(client,actor);
    const order=(await client.query(`SELECT o.order_number,o.status,o.version AS order_version,o.transaction_source_kind,
      s.id AS shipment_id,s.version AS shipment_version
      FROM commerce_order o JOIN commerce_shipment s ON s.order_id=o.id
      WHERE o.id=$1 AND o.member_id=$2`,[orderId,owner])).rows[0];
    if(!order)fail('ORDER_NOT_FOUND',404);
    if(order.status!=='paid'||order.transaction_source_kind!=='verified_commerce')fail('WECHAT_RECEIPT_NOT_APPLICABLE');
    const payments=(await client.query(`SELECT p.member_id,p.app_id,p.merchant_id,p.payer_openid,p.out_trade_no,p.amount_cents,
      i.id AS payment_inbox_id,i.provider_transaction_id,i.payer_total_cents
      FROM commerce_payment_attempt p JOIN commission_payment_inbox i
        ON i.order_id=p.order_id AND i.app_id=p.app_id AND i.merchant_id=p.merchant_id
      WHERE p.order_id=$1 AND p.state='paid' AND i.state='applied' AND i.composition_status='full_cash'`,[orderId])).rows;
    if(payments.length!==1)fail('WECHAT_RECEIPT_PAYMENT_BINDING_REQUIRED');
    const paid=payments[0];
    if(paid.member_id!==owner||paid.app_id!==this.appId||paid.merchant_id!==this.merchantId
      ||paid.out_trade_no!==order.order_number||Number(paid.amount_cents)!==Number(paid.payer_total_cents))
      fail('WECHAT_RECEIPT_PAYMENT_BINDING_REQUIRED');
    const binding:ShippingBinding={merchantId:paid.merchant_id,merchantOrderNumber:paid.out_trade_no,
      transactionId:paid.provider_transaction_id,payerOpenid:paid.payer_openid,
      payerTotalCents:Number(paid.payer_total_cents)};
    validateShippingBinding(binding);
    return {owner,orderVersion:order.order_version,shipmentId:order.shipment_id,
      shipmentVersion:order.shipment_version,paymentInboxId:paid.payment_inbox_id,binding};
  }

  async queryMine(actor:string|undefined,orderId:string){
    if(!uuid.test(orderId))fail('WECHAT_RECEIPT_ORDER_ID_INVALID',404);
    const queryId=randomUUID();
    const source=await transaction(this.pool,async client=>{
      const found=await this.source(client,actor,orderId);
      await client.query(`INSERT INTO commerce_wechat_receipt_observation
        (order_id,shipment_id,payment_inbox_id,query_id,query_started_at)
        VALUES($1,$2,$3,$4,clock_timestamp()) ON CONFLICT(order_id) DO UPDATE SET
        query_id=EXCLUDED.query_id,query_started_at=EXCLUDED.query_started_at,
        watch_lease_token=NULL,watch_lease_until=NULL`,
        [orderId,found.shipmentId,found.paymentInboxId,queryId]);
      return found;
    });
    // The protected channel checks the revocable shipping.query grant before
    // and after token retrieval. This is the only outbound operation here.
    const observed:ReceiptObservation=await this.channel.queryOrder(source.binding);
    return transaction(this.pool,async client=>{
      const current=await this.source(client,actor,orderId);
      if(current.orderVersion!==source.orderVersion||current.shipmentVersion!==source.shipmentVersion
        ||current.shipmentId!==source.shipmentId||current.paymentInboxId!==source.paymentInboxId
        ||JSON.stringify(current.binding)!==JSON.stringify(source.binding))fail('WECHAT_RECEIPT_BINDING_CHANGED');
      const row=(await client.query(`UPDATE commerce_wechat_receipt_observation SET
        platform_order_state=$3,in_complaint=$4,observed_at=clock_timestamp(),version=version+1,
        watch_state=CASE WHEN $3::integer IN (4,5) THEN 'complete' ELSE 'active' END,
        watch_next_attempt_at=CASE WHEN $3::integer IN (4,5) THEN NULL
          ELSE clock_timestamp()+(CASE WHEN $3::integer=2 THEN 12 ELSE 24 END * interval '1 hour') END,
        watch_failures=0,watch_last_error_code=NULL
        WHERE order_id=$1 AND query_id=$2 AND shipment_id=$5 AND payment_inbox_id=$6
        RETURNING platform_order_state,in_complaint,observed_at,version`,
        [orderId,queryId,observed.platformOrderState,observed.inComplaint,source.shipmentId,source.paymentInboxId])).rows[0];
      if(!row)fail('WECHAT_RECEIPT_NEWER_QUERY_EXISTS',409);
      const result=receiptView(row.platform_order_state,row.in_complaint,row.observed_at);
      await client.query(`INSERT INTO audit_log(principal_id,action,object_type,object_id,after_state,trace_id)
        VALUES($1,'commerce.wechat_receipt.queried','commerce_order',$2,$3,$4)`,
        [`member:${source.owner}`,orderId,{source:result.source,status:result.status,
          inComplaint:result.inComplaint,observedAt:result.observedAt,version:row.version},`wechat-receipt:${queryId}`]);
      return {orderId,shipmentId:source.shipmentId,...result,
        ...(result.canOpenComponent?{component:{transactionId:source.binding.transactionId}}:{})};
    });
  }
}
