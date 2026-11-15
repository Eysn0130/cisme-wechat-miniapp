import { createHash } from "node:crypto";
import {restoreRefundedCoupon} from './rewardLedger.js';
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
      JOIN commission_payment_inbox p ON p.id=i.payment_inbox_id
      WHERE i.id=$1 AND i.execution_kind='wechat'`,[intentId])).rows[0];
    if(!intent||intent.merchant_id!==this.binding.merchantId)
      throw new DomainError("REFUND_INTENT_UNMATCHED","退款意图与原支付事实未匹配",422);
    const binding={merchantId:this.binding.merchantId,outTradeNo:intent.order_number,
      providerTransactionId:intent.provider_transaction_id,outRefundNo:intent.out_refund_no,
      totalCents:cents(intent.amount_cents),refundCents:cents(intent.refund_cents),
      payerTotalCents:cents(intent.amount_cents),payerRefundCents:cents(intent.payer_refund_cents)};
    const {result,fact,rawSha256}=await channel.queryRefundByMerchantRefundNumberWithEvidence(binding);
    if(fact.status==="PROCESSING")
      throw new DomainError("REFUND_QUERY_PROCESSING","渠道退款仍在处理中",409);
    return this.persistRefund({...result,mchid:this.binding.merchantId,
      refund_status:fact.status},fact.status,`query:${fact.providerRefundId}:${fact.status}`,rawSha256);
  }

  /** Import an already completed merchant-portal full cash refund. This path
   * only sends a signed GET; it cannot approve or dispatch a refund command.
   * Partial/mixed-tender or competing claims require their existing workflow. */
  async receiveExternalQueried(channel:WechatPayV3Client,orderId:string,outRefundNo:string,
    authorize:(client:pg.PoolClient)=>Promise<string>){
    if(!/^[0-9a-f-]{36}$/i.test(orderId)||!refundPattern.test(outRefundNo))
      throw new DomainError('REFUND_ID_INVALID','请填写商户退款单号',422);
    const read=async(client:pg.PoolClient)=>{
      const order=(await client.query('SELECT * FROM commerce_order WHERE id=$1 FOR UPDATE',[orderId])).rows[0];
      if(!order)throw new DomainError('ORDER_NOT_FOUND','订单不存在',404);
      const paid=(await client.query(`SELECT * FROM commission_payment_inbox
        WHERE order_id=$1 AND state='applied'`,[orderId])).rows;
      const payment=paid[0];
      if(order.status!=='paid'||order.transaction_source_kind!=='verified_commerce'||paid.length!==1||
        payment.merchant_id!==this.binding.merchantId||cents(order.credit_tender_cents)!==0||
        cents(payment.amount_cents)!==cents(order.total_cents)||cents(order.total_cents)===0)
        throw new DomainError('EXTERNAL_REFUND_POLICY_UNSUPPORTED','请通过原售后流程核对该订单退款',409);
      return {order,payment};
    };
    const original=await transaction(this.pool,async client=>{
      const actor=await authorize(client),source=await read(client);
      await client.query(`INSERT INTO audit_log(principal_id,action,object_type,object_id,reason_code,after_state,trace_id)
        VALUES($1,'commerce.external_refund.query_admitted','commerce_order',$2,'SIGNED_REFUND_QUERY',
          jsonb_build_object('outRefundNo',$3::text),gen_random_uuid()::text)`,[`member:${actor}`,orderId,outRefundNo]);
      return source;
    });
    const total=cents(original.payment.amount_cents);
    // I/O is outside retried transactions; the client verifies response
    // signatures, merchant/order/transaction, currency and every cash amount.
    const evidence=await channel.queryRefundByMerchantRefundNumberWithEvidence({merchantId:this.binding.merchantId,
      outTradeNo:original.order.order_number,providerTransactionId:original.payment.provider_transaction_id,
      outRefundNo,totalCents:total,refundCents:total,payerTotalCents:total,payerRefundCents:total});
    if(evidence.fact.status!=='SUCCESS'||!evidence.fact.succeededAt||
      Date.parse(evidence.fact.succeededAt)<new Date(original.order.paid_at).getTime())
      throw new DomainError('EXTERNAL_REFUND_NOT_COMPLETED','微信尚未确认这笔整单退款完成',409);
    const intentId=await transaction(this.pool,async client=>{
      const actor=await authorize(client),{order,payment}=await read(client);
      if(payment.id!==original.payment.id||payment.provider_transaction_id!==original.payment.provider_transaction_id||
        order.order_number!==original.order.order_number||cents(payment.amount_cents)!==total)
        throw new DomainError('REFUND_PAYMENT_FACT_MISMATCH','原支付事实已变化，请重新核对',409);
      const existing=(await client.query(`SELECT * FROM commission_refund_intent
        WHERE out_refund_no=$1 FOR UPDATE`,[outRefundNo])).rows[0];
      if(existing){
        if(existing.order_id!==orderId||existing.payment_inbox_id!==payment.id||existing.execution_kind!=='wechat'||
          cents(existing.refund_cents)!==total||cents(existing.payer_refund_cents)!==total||
          existing.state==='closed'||existing.submission_state!=='accepted')
          throw new DomainError('REFUND_EVENT_CONFLICT','退款单与已有记录不一致',409);
        return existing.id as string;
      }
      if((await client.query(`SELECT 1 FROM commission_refund_intent WHERE order_id=$1 AND state<>'closed'
        UNION ALL SELECT 1 FROM commerce_refund_request WHERE order_id=$1 AND state IN ('requested','approved')
        UNION ALL SELECT 1 FROM commerce_aftersale_case WHERE order_id=$1 AND state NOT IN ('cancelled','rejected')`,[orderId])).rowCount)
        throw new DomainError('EXTERNAL_REFUND_EXISTING_CLAIM','本单已有退款或售后，请先核对原记录',409);
      if((await client.query(`SELECT 1 FROM commission_refund_inbox WHERE provider_refund_id=$1`,
        [evidence.fact.providerRefundId])).rowCount)
        throw new DomainError('REFUND_PROVIDER_ID_CONFLICT','微信退款单已关联其他记录',409);
      const lines=(await client.query(`SELECT id,line_total_cents,credit_tender_cents FROM commerce_order_line
        WHERE order_id=$1 ORDER BY line_number FOR UPDATE`,[orderId])).rows;
      const shipping=cents(order.shipping_cents),merchandise=lines.reduce((n,line)=>n+cents(line.line_total_cents),0);
      const snapshot=(await client.query(`SELECT * FROM commission_order_snapshot WHERE order_id=$1`,[orderId])).rows[0];
      let eligible=cents(snapshot?.cash_merchandise_cents??0);
      if(!lines.length||lines.some(line=>cents(line.credit_tender_cents)!==0)||merchandise+shipping!==total||
        eligible>merchandise||snapshot&&snapshot.source_kind!=='verified_commerce')
        throw new DomainError('REFUND_CASH_LINES_MISMATCH','原订单金额分摊须人工核对',409);
      const eligibleTotal=eligible;
      const lineAllocation=lines.map(line=>{const amount=cents(line.line_total_cents),take=Math.min(amount,eligible);
        eligible-=take;return {lineId:line.id,eligibleCashRefundCents:take,otherCashRefundCents:amount-take};});
      const inserted=(await client.query<{id:string}>(`INSERT INTO commission_refund_intent(order_id,payment_inbox_id,
        out_refund_no,refund_cents,payer_refund_cents,eligible_merchandise_refund_cents,
        other_merchandise_refund_cents,shipping_cash_refund_cents,line_allocation,allocation_policy_version,
        created_by,execution_kind,submission_state)
        VALUES($1,$2,$3,$4,$4,$5,$6,$7,$8,'wechat-external-full-cash-v1',$9,'wechat','accepted') RETURNING id`,
        [orderId,payment.id,outRefundNo,total,eligibleTotal,merchandise-eligibleTotal,shipping,
          JSON.stringify(lineAllocation),`member:${actor}`])).rows[0]!;
      await client.query(`INSERT INTO commission_refund_channel_observation(refund_intent_id,source_kind,
        raw_sha256,provider_refund_id,accepted_at) VALUES($1,'signed_query',$2,$3,$4)`,
        [inserted.id,evidence.rawSha256,evidence.fact.providerRefundId,evidence.fact.acceptedAt]);
      await client.query(`INSERT INTO audit_log(principal_id,action,object_type,object_id,reason_code,after_state,trace_id)
        VALUES($1,'commerce.external_refund.import','commission_refund_intent',$2,'VERIFIED_EXISTING_REFUND',
          $3,gen_random_uuid()::text)`,[`member:${actor}`,inserted.id,
          {orderId,amountCents:total,rawSha256:evidence.rawSha256,source:'signed_query'}]);
      return inserted.id;
    },'SERIALIZABLE');
    // Accepted intents cannot enter the POST submission worker. A crash here
    // is recovered by its existing query worker using this same refund number.
    const receipt=await this.persistRefund({...evidence.result,mchid:this.binding.merchantId,
      refund_status:'SUCCESS'},'SUCCESS',`query:${evidence.fact.providerRefundId}:SUCCESS`,evidence.rawSha256);
    return {...receipt,intentId};
  }

  private async persistRefund(source:RefundTransaction,status:"SUCCESS"|"CLOSED"|"ABNORMAL",eventId:string,rawHash:string){
    if(typeof source.out_refund_no!=="string"||!refundPattern.test(source.out_refund_no))
      throw new DomainError("REFUND_INTENT_UNMATCHED","商户退款单号未匹配",422);
    const row=(await this.pool.query(`SELECT i.id AS intent_id,i.order_id,i.out_refund_no,i.refund_cents,
      i.payer_refund_cents,o.order_number,o.total_cents,p.amount_cents AS paid_cents,
      p.provider_transaction_id,p.merchant_id,p.state AS payment_state
      FROM commission_refund_intent i JOIN commerce_order o ON o.id=i.order_id
      JOIN commission_payment_inbox p ON p.id=i.payment_inbox_id
      WHERE i.out_refund_no=$1 AND i.execution_kind='wechat'`,[source.out_refund_no])).rows[0];
    if(!row||row.merchant_id!==this.binding.merchantId||row.payment_state!=="applied")
      throw new DomainError("REFUND_INTENT_UNMATCHED","退款单或原支付事实未匹配",422);
    const fact=assertRefundBinding(source,{merchantId:this.binding.merchantId,
      outTradeNo:row.order_number,providerTransactionId:row.provider_transaction_id,
      outRefundNo:row.out_refund_no,totalCents:cents(row.paid_cents),
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
    const claims=await claimDueMoneyInbox(this.pool,"refund",limit);
    const results=[];
    for(const {id,leaseToken} of claims){
      try{results.push({id,state:await this.processOne(id,leaseToken)});}
      catch(error){results.push({id,state:await recordMoneyInboxFailure(this.pool,"refund",id,error,leaseToken)});}
    }
    return results;
  }

  async processOne(inboxId:string,leaseToken?:string):Promise<"pending"|"applied"|"exception">{
    return transaction(this.pool,async client=>{
      const fact=(await client.query(`SELECT * FROM commission_refund_inbox WHERE id=$1 FOR UPDATE`,[inboxId])).rows[0];
      if(!fact)throw new DomainError("REFUND_FACT_NOT_FOUND","退款事实不存在",404);
      if(fact.state!=="pending")return fact.state;
      if(fact.lease_token!==(leaseToken??null))
        throw new DomainError("REFUND_INBOX_LEASE_LOST","退款事实已由其他工作进程领取",409);
      const intent=(await client.query(`SELECT * FROM commission_refund_intent WHERE id=$1 FOR UPDATE`,[fact.refund_intent_id])).rows[0];
      if(!intent)throw new DomainError("REFUND_INTENT_NOT_FOUND","退款单不存在",404);
      const order=(await client.query(`SELECT * FROM commerce_order WHERE id=$1 FOR UPDATE`,[intent.order_id])).rows[0];
      const except=async(code:string)=>{
        await client.query(`UPDATE commission_refund_inbox SET state='exception',exception_code=$2,
          lease_until=NULL,lease_token=NULL WHERE id=$1`,[inboxId,code]);
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
        await client.query(`UPDATE commission_refund_inbox SET state='applied',applied_at=now(),
          lease_until=NULL,lease_token=NULL WHERE id=$1`,[inboxId]);
        return "applied";
      }
      if(fact.refund_status!=="SUCCESS"||!fact.succeeded_at||
        new Date(fact.succeeded_at)<new Date(order.paid_at))return except("REFUND_SUCCESS_TIME_INVALID");
      if(cents(intent.refund_cents)!==cents(intent.payer_refund_cents))
        return except("VOUCHER_REFUND_UNSUPPORTED");
      const creditTotal=cents(order.credit_tender_cents),cashTotal=cents(payment.amount_cents);
      if(cashTotal+creditTotal!==cents(order.total_cents))
        return except("REFUND_ORIGINAL_COMPOSITION_DRIFT");
      const request=intent.request_id?(await client.query<{amount_cents:string}>(`
        SELECT amount_cents FROM commerce_refund_request WHERE id=$1 AND order_id=$2 AND state='approved'`,
        [intent.request_id,order.id])).rows[0]:undefined;
      if(creditTotal&&!request)return except("REFUND_CREDIT_REQUEST_MISSING");
      const expectedCredit=request?cents(request.amount_cents)-cents(intent.payer_refund_cents):0;
      const creditAllocations=(await client.query<{source_id:string;amount_cents:string;origin_order_id:string}>(`
        SELECT a.source_id,a.amount_cents,s.order_id AS origin_order_id
        FROM commission_credit_refund_allocation a JOIN commission_credit_source s ON s.id=a.source_id
        JOIN commission_credit_checkout_allocation c ON c.source_id=a.source_id AND c.order_id=$2
        WHERE a.refund_intent_id=$1 ORDER BY s.order_id,a.source_id`,[intent.id,order.id])).rows;
      if(expectedCredit<0||expectedCredit>creditTotal||
        creditAllocations.reduce((n,row)=>n+cents(row.amount_cents),0)!==expectedCredit)
        return except("REFUND_CREDIT_ALLOCATION_MISMATCH");
      const snapshot=(await client.query(`SELECT * FROM commission_order_snapshot WHERE order_id=$1`,[order.id])).rows[0];
      if(snapshot&&snapshot.source_kind!=="verified_commerce")return except("REFUND_COMMISSION_SNAPSHOT_MISMATCH");
      if(!snapshot&&cents(intent.eligible_merchandise_refund_cents)>0)
        return except("REFUND_ELIGIBLE_WITHOUT_SNAPSHOT");
      let current:LineAllocation[];
      try{current=allocations(intent.line_allocation);}catch{return except("REFUND_ALLOCATION_INVALID");}
      if(current.reduce((sum,line)=>sum+line.eligibleCashRefundCents,0)!==cents(intent.eligible_merchandise_refund_cents)||
        current.reduce((sum,line)=>sum+line.otherCashRefundCents,0)!==cents(intent.other_merchandise_refund_cents))
        return except("REFUND_ALLOCATION_SUM_MISMATCH");
      const lines=(await client.query(`SELECT id,line_total_cents,credit_tender_cents
        FROM commerce_order_line WHERE order_id=$1`,[order.id])).rows;
      const lineCaps=new Map<string,number>(lines.map(line=>[line.id,
        cents(line.line_total_cents)-cents(line.credit_tender_cents)]));
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
      const previousCredit=(await client.query<{amount_cents:string}>(`
        SELECT COALESCE(sum(a.amount_cents),0)::text AS amount_cents
        FROM commission_credit_refund_allocation a JOIN commission_refund_intent i ON i.id=a.refund_intent_id
        WHERE i.order_id=$1 AND i.state='succeeded'`,[order.id])).rows[0]!;
      if(cents(previousCredit.amount_cents)+expectedCredit>creditTotal)
        return except("REFUND_CREDIT_CUMULATIVE_OVERDRAW");
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
      await client.query(`UPDATE commission_refund_inbox SET state='applied',applied_at=now(),
        lease_until=NULL,lease_token=NULL WHERE id=$1`,[inboxId]);
      if(target<currentCommission&&snapshot&&accrual)await client.query(`INSERT INTO commission_ledger_entry(order_id,referrer_member_id,
        event_key,kind,amount_cents,reverse_of,source_fact_id,actor_principal_id)
        VALUES($1,$2,$3,'refund_reversal',$4,$5,$6,'worker:refund-inbox')`,
        [order.id,snapshot.referrer_member_id,`wechat-refund:${fact.provider_refund_id}`,
          target-currentCommission,accrual.id,inboxId]);
      for(const credit of creditAllocations){
        await client.query("SELECT id FROM commerce_order WHERE id=$1 FOR UPDATE",[credit.origin_order_id]);
        await client.query(`INSERT INTO commission_credit_entry
          (source_id,event_key,kind,amount_cents,purchase_order_id,actor_principal_id)
          VALUES($1,$2,'refund_return',$3,$4,'worker:refund-inbox')`,[credit.source_id,
            `credit-refund-return:${inboxId}:${credit.source_id}`,credit.amount_cents,order.id]);
        await freezeCreditExposureForRefund(client,credit.origin_order_id,inboxId);
      }
      const creditExposure=await freezeCreditExposureForRefund(client,order.id,inboxId);
      await client.query(`UPDATE commission_refund_intent SET state='succeeded',finalized_at=$2,
        reconcile_lease_until=NULL WHERE id=$1`,
        [intent.id,fact.succeeded_at]);
      await restoreRefundedCoupon(client,order.id,new Date(fact.succeeded_at));
      await client.query(`INSERT INTO audit_log(principal_id,action,object_type,object_id,reason_code,
        after_state,trace_id) VALUES('worker:refund-inbox','commerce.refund_applied','commerce_order',
        $1,'WECHAT_REFUND_VERIFIED',$2,$3)`,[order.id,{outRefundNo:intent.out_refund_no,
          payerRefundCents:cents(intent.payer_refund_cents),eligibleRefundCents:cents(intent.eligible_merchandise_refund_cents),
          commissionTargetCents:target,creditReturnedCents:expectedCredit,creditExposure},`refund-inbox:${inboxId}`]);
      return "applied";
    });
  }
}
