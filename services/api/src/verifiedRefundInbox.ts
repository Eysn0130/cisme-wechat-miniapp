import { createHash } from "node:crypto";
import type pg from "pg";
import { DomainError } from "@cisme/domain";
import { transaction } from "./db.js";
import { cumulativeCommission } from "./commissionPolicy.js";
import { assertRefundBinding, decodeRefundNotification, type RefundTransaction, WechatPayV3Client } from "./wechatPayV3.js";
import { claimDueMoneyInbox, recordMoneyInboxFailure } from "./moneyInboxRetry.js";
import { freezeCreditExposureForRefund } from "./shoppingCredit.js";

type LineAllocation={lineId:string;eligibleCashRefundCents:number;otherCashRefundCents:number};
const refundPattern=/^[A-Za-z0-9_-]{8,64}$/;
function cents(value:unknown):number{
  const number=Number(value);
  if(!Number.isSafeInteger(number)||number<0||number>9_900_000_000)
    throw new DomainError("REFUND_AMOUNT_INVALID","退款金额不在支持范围内",422);
  return number;
}
function allocations(value:unknown):LineAllocation[]{
  if(!Array.isArray(value)||value.length>100)
    throw new DomainError("REFUND_ALLOCATION_INVALID","退款商品分摊无效",422);
  const seen=new Set<string>();
  return value.map(item=>{
    if(!item||typeof item!=="object"||typeof item.lineId!=="string"||
      !/^[0-9a-f-]{36}$/i.test(item.lineId)||seen.has(item.lineId))
      throw new DomainError("REFUND_ALLOCATION_INVALID","退款商品分摊无效",422);
    seen.add(item.lineId);
    return {lineId:item.lineId,eligibleCashRefundCents:cents(item.eligibleCashRefundCents),
      otherCashRefundCents:cents(item.otherCashRefundCents)};
  });
}

/** Internal fact receiver only. A future approved refund command must persist
 * the merchant refund number and line allocation before sending to WeChat. */
export class VerifiedRefundInbox{
  constructor(private readonly pool:pg.Pool,private readonly binding:{merchantId:string;apiV3Key:string;
    platformKeys:ReadonlyMap<string,string>}){}

  async receive(rawBody:Uint8Array,headers:Record<string,string|undefined>,now=new Date()){
    const decoded=decodeRefundNotification({rawBody,headers,apiV3Key:this.binding.apiV3Key,
      publicKeys:this.binding.platformKeys,now});
    return this.persistRefund(decoded.refund,decoded.status,decoded.eventId,
      createHash("sha256").update(rawBody).digest("hex"));
  }

  async receiveQueried(channel:WechatPayV3Client,intentId:string){
    const intent=(await this.pool.query(`SELECT i.out_refund_no,i.refund_cents,i.payer_refund_cents,
      o.order_number,o.total_cents,p.amount_cents,p.provider_transaction_id,p.merchant_id
      FROM commission_refund_intent i JOIN commerce_order o ON o.id=i.order_id
      JOIN commission_payment_inbox p ON p.id=i.payment_inbox_id WHERE i.id=$1`,[intentId])).rows[0];
    if(!intent||intent.merchant_id!==this.binding.merchantId)
      throw new DomainError("REFUND_INTENT_UNMATCHED","退款意图与原支付事实未匹配",422);
    const binding={merchantId:this.binding.merchantId,outTradeNo:intent.order_number,
      providerTransactionId:intent.provider_transaction_id,outRefundNo:intent.out_refund_no,
      totalCents:cents(intent.total_cents),refundCents:cents(intent.refund_cents),
      payerTotalCents:cents(intent.amount_cents),payerRefundCents:cents(intent.payer_refund_cents)};
    const {result,fact,rawSha256}=await channel.queryRefundByMerchantRefundNumberWithEvidence(binding);
    if(fact.status==="PROCESSING")
      throw new DomainError("REFUND_QUERY_PROCESSING","渠道退款仍在处理中",409);
    return this.persistRefund({...result,mchid:this.binding.merchantId,
      refund_status:fact.status},fact.status,`query:${fact.providerRefundId}:${fact.status}`,rawSha256);
  }

  private async persistRefund(source:RefundTransaction,status:"SUCCESS"|"CLOSED"|"ABNORMAL",eventId:string,rawHash:string){
    if(typeof source.out_refund_no!=="string"||!refundPattern.test(source.out_refund_no))
      throw new DomainError("REFUND_INTENT_UNMATCHED","商户退款单号未匹配",422);
    const row=(await this.pool.query(`SELECT i.id AS intent_id,i.order_id,i.out_refund_no,i.refund_cents,
      i.payer_refund_cents,o.order_number,o.total_cents,p.amount_cents AS paid_cents,
      p.provider_transaction_id,p.merchant_id,p.state AS payment_state
      FROM commission_refund_intent i JOIN commerce_order o ON o.id=i.order_id
      JOIN commission_payment_inbox p ON p.id=i.payment_inbox_id
      WHERE i.out_refund_no=$1`,[source.out_refund_no])).rows[0];
    if(!row||row.merchant_id!==this.binding.merchantId||row.payment_state!=="applied")
      throw new DomainError("REFUND_INTENT_UNMATCHED","退款单或原支付事实未匹配",422);
    const fact=assertRefundBinding(source,{merchantId:this.binding.merchantId,
      outTradeNo:row.order_number,providerTransactionId:row.provider_transaction_id,
      outRefundNo:row.out_refund_no,totalCents:cents(row.total_cents),
      refundCents:cents(row.refund_cents),payerTotalCents:cents(row.paid_cents),
      payerRefundCents:cents(row.payer_refund_cents)},status);
    const equivalent=(await this.pool.query(`SELECT * FROM commission_refund_inbox
      WHERE refund_intent_id=$1 AND provider_refund_id=$2 AND refund_status=$3
      ORDER BY received_at,id LIMIT 1`,[row.intent_id,fact.providerRefundId,fact.status])).rows[0];
    if(equivalent){
      if(cents(equivalent.refund_cents)!==fact.refundCents||
        cents(equivalent.payer_refund_cents)!==fact.payerRefundCents||
        new Date(equivalent.succeeded_at??0).toISOString()!==new Date(fact.succeededAt??0).toISOString())
        throw new DomainError("REFUND_EVENT_CONFLICT","退款事实与已收事实冲突",409);
      return {persisted:true,inboxId:equivalent.id,state:equivalent.state};
    }
    const inserted=await this.pool.query<{id:string}>(`INSERT INTO commission_refund_inbox(
      notification_id,refund_intent_id,provider_refund_id,refund_status,merchant_id,out_trade_no,
      provider_transaction_id,refund_cents,payer_refund_cents,succeeded_at,raw_sha256)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (notification_id) DO NOTHING RETURNING id`,
      [eventId,row.intent_id,fact.providerRefundId,fact.status,this.binding.merchantId,row.order_number,
        row.provider_transaction_id,fact.refundCents,fact.payerRefundCents,fact.succeededAt,rawHash]);
    let id=inserted.rows[0]?.id;
    if(!id){
      const prior=(await this.pool.query(`SELECT * FROM commission_refund_inbox WHERE notification_id=$1`,[eventId])).rows[0];
      if(!prior||prior.refund_intent_id!==row.intent_id||prior.provider_refund_id!==fact.providerRefundId||
        prior.refund_status!==fact.status||prior.raw_sha256!==rawHash)
        throw new DomainError("REFUND_EVENT_CONFLICT","退款通知与已收事实冲突",409);
      id=prior.id;
    }
    const state=(await this.pool.query(`SELECT state FROM commission_refund_inbox WHERE id=$1`,[id])).rows[0]?.state;
    return {persisted:true,inboxId:id!,state};
  }

  async processPending(limit=20){
    const ids=await claimDueMoneyInbox(this.pool,"refund",limit);
    const results=[];
    for(const id of ids){
      try{results.push({id,state:await this.processOne(id)});}
      catch(error){results.push({id,state:await recordMoneyInboxFailure(this.pool,"refund",id,error)});}
    }
    return results;
  }

  async processOne(inboxId:string):Promise<"pending"|"applied"|"exception">{
    return transaction(this.pool,async client=>{
      const fact=(await client.query(`SELECT * FROM commission_refund_inbox WHERE id=$1 FOR UPDATE`,[inboxId])).rows[0];
      if(!fact)throw new DomainError("REFUND_FACT_NOT_FOUND","退款事实不存在",404);
      if(fact.state!=="pending")return fact.state;
      const intent=(await client.query(`SELECT * FROM commission_refund_intent WHERE id=$1 FOR UPDATE`,[fact.refund_intent_id])).rows[0];
      if(!intent)throw new DomainError("REFUND_INTENT_NOT_FOUND","退款单不存在",404);
      const order=(await client.query(`SELECT * FROM commerce_order WHERE id=$1 FOR UPDATE`,[intent.order_id])).rows[0];
      const except=async(code:string)=>{
        await client.query(`UPDATE commission_refund_inbox SET state='exception',exception_code=$2,lease_until=NULL WHERE id=$1`,[inboxId,code]);
        await client.query(`INSERT INTO audit_log(principal_id,action,object_type,object_id,reason_code,trace_id)
          VALUES('worker:refund-inbox','commerce.refund_exception','commerce_order',$1,$2,$3)`,
          [intent.order_id,code,`refund-inbox:${inboxId}`]);
        return "exception" as const;
      };
      const payment=(await client.query(`SELECT * FROM commission_payment_inbox WHERE id=$1`,[intent.payment_inbox_id])).rows[0];
      if(!order||order.transaction_source_kind!=="verified_commerce"||order.status!=="paid"||
        !payment||payment.state!=="applied"||payment.order_id!==order.id)
        return except("REFUND_ORDER_NOT_VERIFIED");
      const priorProvider=(await client.query(`SELECT EXISTS(SELECT 1 FROM commission_refund_inbox
        WHERE state='applied' AND
          ((provider_refund_id=$1 AND refund_intent_id<>$2)
            OR (refund_intent_id=$2 AND provider_refund_id<>$1))) AS conflict`,
        [fact.provider_refund_id,intent.id])).rows[0];
      if(priorProvider?.conflict)return except("REFUND_PROVIDER_ID_CONFLICT");
      if(intent.state==="succeeded"||intent.state==="closed")return except("REFUND_ALREADY_TERMINAL");
      if(fact.refund_status==="CLOSED"||fact.refund_status==="ABNORMAL"){
        const nextState=fact.refund_status==="CLOSED"?"closed":"abnormal";
        if(intent.state!==nextState)await client.query(`UPDATE commission_refund_intent SET state=$2,
          finalized_at=now(),reconcile_lease_until=NULL WHERE id=$1`,
          [intent.id,nextState]);
        await client.query(`UPDATE commission_refund_inbox SET state='applied',applied_at=now(),lease_until=NULL WHERE id=$1`,[inboxId]);
        return "applied";
      }
      if(fact.refund_status!=="SUCCESS"||!fact.succeeded_at||
        new Date(fact.succeeded_at)<new Date(order.paid_at))return except("REFUND_SUCCESS_TIME_INVALID");
      if(cents(intent.refund_cents)!==cents(intent.payer_refund_cents))
        return except("VOUCHER_REFUND_UNSUPPORTED");
      const snapshot=(await client.query(`SELECT * FROM commission_order_snapshot WHERE order_id=$1`,[order.id])).rows[0];
      if(snapshot&&snapshot.source_kind!=="verified_commerce")return except("REFUND_COMMISSION_SNAPSHOT_MISMATCH");
      if(!snapshot&&cents(intent.eligible_merchandise_refund_cents)>0)
        return except("REFUND_ELIGIBLE_WITHOUT_SNAPSHOT");
      let current:LineAllocation[];
      try{current=allocations(intent.line_allocation);}catch{return except("REFUND_ALLOCATION_INVALID");}
      if(current.reduce((sum,line)=>sum+line.eligibleCashRefundCents,0)!==cents(intent.eligible_merchandise_refund_cents)||
        current.reduce((sum,line)=>sum+line.otherCashRefundCents,0)!==cents(intent.other_merchandise_refund_cents))
        return except("REFUND_ALLOCATION_SUM_MISMATCH");
      const lines=(await client.query(`SELECT id,line_total_cents FROM commerce_order_line WHERE order_id=$1`,[order.id])).rows;
      const lineCaps=new Map<string,number>(lines.map(line=>[line.id,cents(line.line_total_cents)]));
      if(current.some(line=>!lineCaps.has(line.lineId)))return except("REFUND_LINE_NOT_IN_ORDER");
      const prior=(await client.query(`SELECT i.id,i.payer_refund_cents,i.eligible_merchandise_refund_cents,
        i.shipping_cash_refund_cents,
        i.line_allocation FROM commission_refund_intent i WHERE i.order_id=$1 AND i.state='succeeded'`,[order.id])).rows;
      const lineTotals=new Map<string,number>();
      let eligibleTotal=cents(intent.eligible_merchandise_refund_cents),payerTotal=cents(intent.payer_refund_cents),
        shippingTotal=cents(intent.shipping_cash_refund_cents);
      try{
        for(const old of prior){
          eligibleTotal+=cents(old.eligible_merchandise_refund_cents);
          payerTotal+=cents(old.payer_refund_cents);
          shippingTotal+=cents(old.shipping_cash_refund_cents);
          for(const line of allocations(old.line_allocation))lineTotals.set(line.lineId,
            (lineTotals.get(line.lineId)??0)+line.eligibleCashRefundCents+line.otherCashRefundCents);
        }
      }catch{return except("REFUND_PRIOR_ALLOCATION_INVALID");}
      for(const line of current)lineTotals.set(line.lineId,
        (lineTotals.get(line.lineId)??0)+line.eligibleCashRefundCents+line.otherCashRefundCents);
      if(payerTotal>cents(payment.amount_cents)||shippingTotal>cents(order.shipping_cents)||
        eligibleTotal>cents(snapshot?.cash_merchandise_cents??0)||
        [...lineTotals].some(([lineId,value])=>value>(lineCaps.get(lineId)??-1)))
        return except("REFUND_CUMULATIVE_OVERDRAW");
      const accrual=(await client.query(`SELECT id,amount_cents FROM commission_ledger_entry
        WHERE order_id=$1 AND kind='accrual' FOR UPDATE`,[order.id])).rows[0];
      const initialTarget=snapshot?cumulativeCommission([{lineId:order.id,
        merchandiseCents:cents(snapshot.cash_merchandise_cents),allocatedDiscountCents:0,
        pointsTenderCents:0,cumulativeRefundCents:0}],snapshot.basis_points).commissionCents:0;
      if((!accrual&&initialTarget>0)||(accrual&&cents(accrual.amount_cents)!==initialTarget))
        return except("REFUND_ACCRUAL_MISMATCH");
      const priorReversal=(await client.query(`SELECT COALESCE(sum(amount_cents),0)::text AS amount_cents
        FROM commission_ledger_entry WHERE order_id=$1 AND kind='refund_reversal'`,[order.id])).rows[0];
      const currentCommission=(accrual?cents(accrual.amount_cents):0)+Number(priorReversal.amount_cents);
      const target=snapshot?cumulativeCommission([{lineId:order.id,merchandiseCents:cents(snapshot.cash_merchandise_cents),
        allocatedDiscountCents:0,pointsTenderCents:0,cumulativeRefundCents:eligibleTotal}],snapshot.basis_points).commissionCents:0;
      if(!Number.isSafeInteger(currentCommission)||currentCommission<0||target>currentCommission)
        return except("REFUND_LEDGER_MISMATCH");
      await client.query(`UPDATE commission_refund_inbox SET state='applied',applied_at=now(),lease_until=NULL WHERE id=$1`,[inboxId]);
      if(target<currentCommission&&snapshot&&accrual)await client.query(`INSERT INTO commission_ledger_entry(order_id,referrer_member_id,
        event_key,kind,amount_cents,reverse_of,source_fact_id,actor_principal_id)
        VALUES($1,$2,$3,'refund_reversal',$4,$5,$6,'worker:refund-inbox')`,
        [order.id,snapshot.referrer_member_id,`wechat-refund:${fact.provider_refund_id}`,
          target-currentCommission,accrual.id,inboxId]);
      const creditExposure=await freezeCreditExposureForRefund(client,order.id,inboxId);
      await client.query(`UPDATE commission_refund_intent SET state='succeeded',finalized_at=$2,
        reconcile_lease_until=NULL WHERE id=$1`,
        [intent.id,fact.succeeded_at]);
      await client.query(`INSERT INTO audit_log(principal_id,action,object_type,object_id,reason_code,
        after_state,trace_id) VALUES('worker:refund-inbox','commerce.refund_applied','commerce_order',
        $1,'WECHAT_REFUND_VERIFIED',$2,$3)`,[order.id,{outRefundNo:intent.out_refund_no,
          payerRefundCents:cents(intent.payer_refund_cents),eligibleRefundCents:cents(intent.eligible_merchandise_refund_cents),
          commissionTargetCents:target,creditExposure},`refund-inbox:${inboxId}`]);
      return "applied";
    });
  }
}
