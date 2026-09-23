import { listMemberRefundRequests } from "./commerceHistory.js";
import { createHash } from "node:crypto";
import type pg from "pg";
import { DomainError } from "@cisme/domain";
import { transaction } from "./db.js";
import { AuthorityService, requireActiveMemberWithClient } from "./authority.js";
import { VerifiedRefundInbox } from "./verifiedRefundInbox.js";
import { freezeCreditExposureForRefund } from "./shoppingCredit.js";
import { type RefundBinding, WechatPayV3Client } from "./wechatPayV3.js";
import { finishPage, pageLimit, pageScope, readPageCursor } from "./keysetPage.js";

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const KEY=/^[A-Za-z0-9._:-]{8,200}$/;
type RequestRow={id:string;order_id:string;requested_by_member_id:string;amount_cents:string;
  reason:string;state:"requested"|"approved"|"rejected";version:number;
  request_hash:string;decision_key:string|null;decision_hash:string|null;decided_by_member_id:string|null};
type IntentRow={id:string;order_id:string;out_refund_no:string;refund_cents:string;
  payer_refund_cents:string;submission_state:"prepared"|"unknown"|"accepted"|"closed";
  submission_attempt_count:number;submission_lease_until:Date|null;submission_lease_token:string|null;
  first_dispatch_started_at:Date|null;state:string;
  order_number:string;total_cents:string;provider_transaction_id:string;paid_cents:string;merchant_id:string;
  request_reason:string};
type Line={id:string;line_total_cents:string;credit_tender_cents:string};

function cents(value:unknown,code="REFUND_AMOUNT_INVALID"){
  const amount=Number(value);
  if(!Number.isSafeInteger(amount)||amount<1||amount>9_900_000_000)
    throw new DomainError(code,"退款金额须为正整数分",422);
  return amount;
}
function id(value:string){if(!UUID.test(value))throw new DomainError("REFUND_ID_INVALID","退款编号无效",422);return value;}
function key(value:string){if(!KEY.test(value))throw new DomainError("IDEMPOTENCY_KEY_INVALID","请求键无效",400);return value;}
function reason(value:unknown){
  if(typeof value!=="string"||Array.from(value.trim()).length<3||Array.from(value.trim()).length>500)
    throw new DomainError("REFUND_REASON_INVALID","请填写 3 至 500 字的原因",422);
  return value.trim();
}
function hash(value:unknown){return createHash("sha256").update(JSON.stringify(value)).digest("hex");}

/** Command routes are test-only until merchant authorization and commercial
 * policies are approved. Approval reserves a fixed CNY allocation before any
 * channel request. Channel acceptance is never treated as refund success. */
export class RefundCommandService{
  constructor(private readonly pool:pg.Pool,private readonly authority:AuthorityService,
    private readonly channel:WechatPayV3Client,private readonly inbox:VerifiedRefundInbox,
    private readonly options:{merchantId:string;notifyUrl:string}){}

  async request(memberId:string|undefined,orderIdInput:string,idempotencyKey:string,input:Record<string,unknown>){
    return transaction(this.pool,client=>this.requestWithClient(client,memberId,orderIdInput,idempotencyKey,input),"SERIALIZABLE");
  }

  /** Caller owns the transaction; no channel I/O. Used by the after-sale case
   * to link its reserved amount and the existing refund request atomically. */
  async requestWithClient(client:pg.PoolClient,memberId:string|undefined,orderIdInput:string,idempotencyKey:string,
    input:Record<string,unknown>,aftersaleCaseId?:string){
    if(!memberId)throw new DomainError("AUTH_REQUIRED","请先登录后继续",401);
    const orderId=id(orderIdInput),requestKey=key(idempotencyKey),amount=cents(input.amountCents),why=reason(input.reason);
    const fingerprint=hash({orderId,amount,why});

      await requireActiveMemberWithClient(client,memberId);
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[`refund-request:${memberId}:${requestKey}`]);
      const replay=(await client.query<RequestRow>(`SELECT * FROM commerce_refund_request
        WHERE requested_by_member_id=$1 AND idempotency_key=$2`,[memberId,requestKey])).rows[0];
      if(replay){
        if(replay.request_hash!==fingerprint)throw new DomainError("IDEMPOTENCY_CONFLICT","请求键对应不同退款内容",409);
        return {id:replay.id,orderId:replay.order_id,amountCents:Number(replay.amount_cents),state:replay.state,version:replay.version};
      }
      const order=(await client.query(`SELECT * FROM commerce_order WHERE id=$1 AND member_id=$2 FOR UPDATE`,
        [orderId,memberId])).rows[0];
      if(!order)throw new DomainError("ORDER_NOT_FOUND","订单不存在",404);
      if(order.status!=="paid"||order.transaction_source_kind!=="verified_commerce")
        throw new DomainError("REFUND_VERIFIED_PAYMENT_REQUIRED","仅已核验支付的订单可申请退款",409);
      const claim=aftersaleCaseId?(await client.query<{id:string;lines:unknown[];amount_cents:string}>(
        'SELECT id,lines,amount_cents FROM commerce_aftersale_case WHERE id=$1 AND order_id=$2 AND member_id=$3 FOR SHARE',
        [aftersaleCaseId,orderId,memberId])).rows[0]:null;
      if(aftersaleCaseId&&(!claim||Number(claim.amount_cents)!==amount))
        throw new DomainError('AFTERSALE_REFUND_MISMATCH','售后申请金额与退款申请不一致',409);
      const allocatedClaim=Boolean(claim?.lines?.length&&claim.lines.every(line=>
        typeof line==='object'&&line!==null&&(line as {allocationPolicyVersion?:string}).allocationPolicyVersion==='quantity-net-components-v1'));
      const historicalComponents=Number(order.shipping_cents)!==0||Number(order.member_discount_cents)!==0||
        Number(order.subtotal_cents)!==Number(order.total_cents);
      // A complete reversal uses the immutable paid order components. Partial
      // distribution of a historical discount or shipping charge still needs
      // its own explicit allocation rule.
      if(historicalComponents&&amount!==Number(order.total_cents)&&!allocatedClaim)
        throw new DomainError("REFUND_POLICY_UNSUPPORTED","该订单的部分金额分摊须人工核对，整单退款可按原支付构成处理",409);
      const payment=(await client.query(`SELECT id FROM commission_payment_inbox WHERE order_id=$1 AND state='applied'`,[orderId])).rows[0];
      if(!payment)throw new DomainError("REFUND_PAYMENT_FACT_MISSING","原支付事实尚未入账",409);
      const activeCase=(await client.query<{id:string}>(`SELECT c.id FROM commerce_aftersale_case c
        LEFT JOIN commission_refund_intent i ON i.request_id=c.refund_request_id
        WHERE c.order_id=$1 AND c.state NOT IN ('rejected','cancelled')
          AND NOT (c.state='refund_pending' AND i.state='succeeded')`,[orderId])).rows[0];
      if(activeCase && activeCase.id!==aftersaleCaseId)
        throw new DomainError('AFTERSALE_ACTIVE_CASE','本单已有售后案件，请在原案件中继续退款',409);
      const existing=(await client.query<{reserved:string}>(`SELECT COALESCE(sum(r.amount_cents),0)::text AS reserved
        FROM commerce_refund_request r LEFT JOIN commission_refund_intent i ON i.request_id=r.id
        WHERE r.order_id=$1 AND (r.state='requested' OR
          (r.state='approved' AND (i.id IS NULL OR i.state<>'closed')))`,[orderId])).rows[0];
      if(Number(existing?.reserved??0)+amount>Number(order.total_cents))
        throw new DomainError("REFUND_AMOUNT_EXCEEDS_REMAINING","累计申请金额超过可退订单金额",409);
      const row=(await client.query<RequestRow>(`INSERT INTO commerce_refund_request(order_id,requested_by_member_id,
        idempotency_key,request_hash,amount_cents,reason) VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,
        [orderId,memberId,requestKey,fingerprint,amount,why])).rows[0]!;
      await client.query(`INSERT INTO audit_log(principal_id,action,object_type,object_id,
        after_state,trace_id) VALUES($1,'commerce.refund.request','commerce_refund_request',$2,$3,$4)`,
        [`member:${memberId}`,row.id,{state:row.state,amountCents:amount},`refund-request:${row.id}`]);
      return {id:row.id,orderId,amountCents:amount,state:row.state,version:row.version};
  }

  async decide(memberId:string|undefined,requestIdInput:string,idempotencyKey:string,input:Record<string,unknown>){
    await this.authority.require(memberId,"commerce.refund.approve");
    const approver=memberId!,requestId=id(requestIdInput),decisionKey=key(idempotencyKey),
      decision=input.decision,why=reason(input.reason),expectedVersion=Number(input.expectedVersion);
    if(decision!=="approve"&&decision!=="reject")throw new DomainError("REFUND_DECISION_INVALID","退款决定无效",422);
    if(!Number.isSafeInteger(expectedVersion)||expectedVersion<1)
      throw new DomainError("VERSION_INVALID","退款申请版本无效",422);
    const fingerprint=hash({requestId,decision,why,expectedVersion});
    return transaction(this.pool,async client=>{
      await this.authority.requireWithClient(client,approver,"commerce.refund.approve");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[`refund-decision:${approver}:${decisionKey}`]);
      const used=(await client.query<RequestRow>(`SELECT * FROM commerce_refund_request
        WHERE decided_by_member_id=$1 AND decision_key=$2`,[approver,decisionKey])).rows[0];
      if(used&&used.id!==requestId)throw new DomainError("IDEMPOTENCY_CONFLICT","审批请求键已用于其他申请",409);
      const request=(await client.query<RequestRow>(`SELECT * FROM commerce_refund_request WHERE id=$1 FOR UPDATE`,[requestId])).rows[0];
      if(!request)throw new DomainError("REFUND_REQUEST_NOT_FOUND","退款申请不存在",404);
      if(request.requested_by_member_id===approver)
        throw new DomainError("REFUND_SELF_APPROVAL_FORBIDDEN","退款申请人与审批人必须不同",403);
      const exception=(await client.query<{exception_approved_by:string|null}>(
        'SELECT exception_approved_by FROM commerce_aftersale_case WHERE refund_request_id=$1',[requestId])).rows[0];
      if(exception?.exception_approved_by===approver)
        throw new DomainError("REFUND_EXCEPTION_DUAL_REVIEW_REQUIRED","无需寄回的例外决定与退款审批须由不同人员完成",403);
      if(request.state!=="requested"){
        if(request.decided_by_member_id===approver&&request.decision_key===decisionKey&&request.decision_hash===fingerprint)
          return this.decisionView(client,request);
        throw new DomainError("REFUND_REQUEST_ALREADY_DECIDED","退款申请已处理",409);
      }
      if(request.version!==expectedVersion)throw new DomainError("VERSION_CONFLICT","退款申请版本已变化",409);
      const order=(await client.query(`SELECT * FROM commerce_order WHERE id=$1 FOR UPDATE`,[request.order_id])).rows[0];
      if(!order||order.status!=="paid"||order.transaction_source_kind!=="verified_commerce")
        throw new DomainError("REFUND_ORDER_CHANGED","订单支付状态已变化",409);
      const beneficiary=(await client.query<{referrer_member_id:string}>(
        `SELECT referrer_member_id FROM commission_order_snapshot WHERE order_id=$1`,[order.id])).rows[0];
      if(beneficiary?.referrer_member_id===approver)
        throw new DomainError("REFUND_BENEFICIARY_DECISION_FORBIDDEN","佣金受益人不能审批关联订单退款",403);
      const amount=cents(request.amount_cents);
      let allocation:{lineId:string;eligibleCashRefundCents:number;otherCashRefundCents:number}[]=[];
      let localCreditIntent:{id:string;sources:{sourceId:string;originOrderId:string;amount:number}[]}|null=null;
      let eligible=0;
      if(decision==="approve"){
        const missingIntent=(await client.query<{has_gap:boolean}>(`SELECT EXISTS(
          SELECT 1 FROM commerce_refund_request r LEFT JOIN commission_refund_intent i
            ON i.request_id=r.id WHERE r.order_id=$1 AND r.state='approved' AND i.id IS NULL
        ) AS has_gap`,[order.id])).rows[0]?.has_gap;
        if(missingIntent)throw new DomainError("REFUND_APPROVED_INTENT_MISSING",
          "已有批准退款尚未形成渠道意图，请先核对并修复原申请",409);
        const payment=(await client.query(`SELECT * FROM commission_payment_inbox WHERE order_id=$1 AND state='applied'`,[order.id])).rows[0];
        const cashTotal=Number(payment?.amount_cents),grossTotal=Number(order.total_cents),
          creditTotal=Number(order.credit_tender_cents);
        if(!payment||!Number.isSafeInteger(cashTotal)||cashTotal!==grossTotal-creditTotal)
          throw new DomainError("REFUND_PAYMENT_FACT_MISMATCH","原支付金额不一致",409);
        const snapshot=(await client.query(`SELECT * FROM commission_order_snapshot WHERE order_id=$1`,[order.id])).rows[0];
        const prior=(await client.query(`SELECT i.line_allocation,i.payer_refund_cents,i.eligible_merchandise_refund_cents,
          i.shipping_cash_refund_cents,r.amount_cents AS gross_refund_cents FROM commission_refund_intent i
          LEFT JOIN commerce_refund_request r ON r.id=i.request_id
          WHERE i.order_id=$1 AND i.state<>'closed' FOR UPDATE OF i`,[order.id])).rows;
        const occupied=new Map<string,number>();let totalReserved=0,grossReserved=0,shippingReserved=0,eligibleReserved=0;
        for(const existing of prior){
          totalReserved+=Number(existing.payer_refund_cents);
          grossReserved+=Number(existing.gross_refund_cents??existing.payer_refund_cents);
          shippingReserved+=Number(existing.shipping_cash_refund_cents);
          eligibleReserved+=Number(existing.eligible_merchandise_refund_cents);
          for(const item of existing.line_allocation as {lineId:string;eligibleCashRefundCents:number;otherCashRefundCents:number}[])
            occupied.set(item.lineId,(occupied.get(item.lineId)??0)+item.eligibleCashRefundCents+item.otherCashRefundCents);
        }
        if(grossReserved+amount>grossTotal)
          throw new DomainError("REFUND_AMOUNT_EXCEEDS_REMAINING","累计核准金额超过原商品金额",409);
        const claim=(await client.query<{lines:Array<{lineId:string;amountCents:number;cashRefundCents:number;
          creditRefundCents:number;eligibleCashRefundCents:number;otherCashRefundCents:number;
          shippingRefundCents:number;allocationPolicyVersion:string}>}>(
          'SELECT lines FROM commerce_aftersale_case WHERE refund_request_id=$1',[request.id])).rows[0];
        const selected=claim?.lines?.length&&claim.lines.every(line=>line.allocationPolicyVersion==='quantity-net-components-v1')
          ?claim.lines:null;
        const cumulativeCash=Number((BigInt(grossReserved+amount)*BigInt(cashTotal)+BigInt(Math.floor(grossTotal/2)))/BigInt(grossTotal));
        const cashRefund=selected?selected.reduce((sum,line)=>sum+line.cashRefundCents+line.shippingRefundCents,0):cumulativeCash-totalReserved;
        const creditRefund=selected?selected.reduce((sum,line)=>sum+line.creditRefundCents,0):amount-cashRefund;
        if(cashRefund+creditRefund!==amount)
          throw new DomainError('REFUND_COMPONENT_MISMATCH','售后退款组成与申请金额不一致',409);
        if(cashRefund<0||cashRefund===0&&(!selected||creditRefund!==amount)||
          creditRefund<0||creditRefund>creditTotal)
          throw new DomainError("REFUND_CASH_COMPONENT_REQUIRED","本次金额无法形成可核验的原路现金退款，请调整退款金额",409);
        if(totalReserved+cashRefund>cashTotal)
          throw new DomainError("REFUND_AMOUNT_EXCEEDS_REMAINING","累计核准金额超过原支付",409);
        const lines=(await client.query<Line>(`SELECT id,line_total_cents,credit_tender_cents FROM commerce_order_line
          WHERE order_id=$1 ORDER BY line_number FOR UPDATE`,[order.id])).rows;
        const merchandiseCash=lines.reduce((sum,line)=>sum+Number(line.line_total_cents)-Number(line.credit_tender_cents),0);
        const shippingCash=Number(order.shipping_cents);
        if(!lines.length||merchandiseCash+shippingCash!==cashTotal||shippingReserved>shippingCash)
          throw new DomainError("REFUND_CASH_LINES_MISMATCH","订单商品现金分摊不一致",409);
        const historicalComponents=shippingCash!==0||Number(order.member_discount_cents)!==0||
          Number(order.subtotal_cents)!==grossTotal;
        if(snapshot&&(snapshot.source_kind!=="verified_commerce"||
          Number(snapshot.cash_merchandise_cents)<0||Number(snapshot.cash_merchandise_cents)>merchandiseCash||
          !historicalComponents&&Number(snapshot.cash_merchandise_cents)!==cashTotal))
          throw new DomainError("REFUND_POLICY_UNSUPPORTED","原订单计佣快照与支付构成不一致，请核对",409);
        if(historicalComponents&&!selected&&(amount!==grossTotal||grossReserved!==0||cashRefund!==cashTotal))
          throw new DomainError("REFUND_POLICY_UNSUPPORTED","历史优惠或运费订单只支持按完整原单金额冲回，请核对已退款记录",409);
        let shippingRefund=0;
        if(selected){
          if(new Set(selected.map(line=>line.lineId)).size!==selected.length||
            selected.some(line=>!Number.isSafeInteger(line.cashRefundCents)||line.cashRefundCents<0||
              !Number.isSafeInteger(line.creditRefundCents)||line.creditRefundCents<0||
              !Number.isSafeInteger(line.eligibleCashRefundCents)||line.eligibleCashRefundCents<0||
              !Number.isSafeInteger(line.otherCashRefundCents)||line.otherCashRefundCents<0||
              !Number.isSafeInteger(line.shippingRefundCents)||line.shippingRefundCents<0||
              line.cashRefundCents!==line.eligibleCashRefundCents+line.otherCashRefundCents||
              line.amountCents!==line.cashRefundCents+line.creditRefundCents))
            throw new DomainError('REFUND_COMPONENT_MISMATCH','售后商品分摊不一致',409);
          const orderLines=new Map(lines.map(line=>[line.id,line]));
          for(const item of selected){
            const source=orderLines.get(item.lineId),available=source?Number(source.line_total_cents)-Number(source.credit_tender_cents)-(occupied.get(item.lineId)??0):-1;
            if(!source||item.cashRefundCents>available)
              throw new DomainError('REFUND_LINE_OVERDRAW','退款商品分摊超过原单',409);
            allocation.push({lineId:item.lineId,eligibleCashRefundCents:item.eligibleCashRefundCents,
              otherCashRefundCents:item.otherCashRefundCents});
            eligible+=item.eligibleCashRefundCents;shippingRefund+=item.shippingRefundCents;
          }
          if(shippingReserved+shippingRefund>shippingCash||
            (snapshot?eligibleReserved+eligible>Number(snapshot.cash_merchandise_cents):eligible>0))
            throw new DomainError('REFUND_LINE_OVERDRAW','退款运费或计佣分摊超过原单',409);
        }else{
          let remaining=cashRefund,eligibleRemaining=snapshot?Number(snapshot.cash_merchandise_cents):0;
          for(const line of lines){
            const available=Number(line.line_total_cents)-Number(line.credit_tender_cents)-(occupied.get(line.id)??0),
              take=Math.min(remaining,available);
            if(take>0){const eligibleTake=Math.min(take,eligibleRemaining);
              allocation.push({lineId:line.id,eligibleCashRefundCents:eligibleTake,
                otherCashRefundCents:take-eligibleTake});remaining-=take;eligibleRemaining-=eligibleTake;eligible+=eligibleTake;}
          }
          shippingRefund=Math.min(remaining,shippingCash-shippingReserved);
          remaining-=shippingRefund;
          if(remaining!==0||historicalComponents&&eligibleRemaining!==0)
            throw new DomainError("REFUND_LINE_OVERDRAW","退款商品或运费分摊超过原单",409);
        }
        const sourceAllocations:{sourceId:string;originOrderId:string;amount:number}[]=[];
        if(creditTotal){
          const sources=(await client.query<{source_id:string;origin_order_id:string;amount_cents:string;returned:string;spent:string}>(`
            SELECT a.source_id,s.order_id AS origin_order_id,a.amount_cents,
              COALESCE((SELECT sum(x.amount_cents) FROM commission_credit_refund_allocation x
                JOIN commission_refund_intent i ON i.id=x.refund_intent_id
                WHERE x.source_id=a.source_id AND i.order_id=a.order_id AND i.state<>'closed'),0)::text AS returned,
              COALESCE((SELECT -sum(e.amount_cents) FROM commission_credit_entry e
                WHERE e.source_id=a.source_id AND e.purchase_order_id=a.order_id AND e.kind='spend'),0)::text AS spent
            FROM commission_credit_checkout_allocation a JOIN commission_credit_source s ON s.id=a.source_id
            WHERE a.order_id=$1 ORDER BY a.source_id`,[order.id])).rows;
          if(sources.reduce((n,source)=>n+Number(source.amount_cents),0)!==creditTotal||
            sources.some(source=>Number(source.spent)!==Number(source.amount_cents)))
            throw new DomainError("REFUND_CREDIT_SOURCE_DRIFT","原权益来源与核销事实不一致",409);
          let creditRemaining=creditRefund;
          for(const source of sources){
            const available=Number(source.amount_cents)-Number(source.returned),
              take=Math.min(available,creditRemaining);
            if(available<0)throw new DomainError("REFUND_CREDIT_OVERDRAW","权益退回已超过原批次",409);
            if(take){sourceAllocations.push({sourceId:source.source_id,originOrderId:source.origin_order_id,amount:take});creditRemaining-=take;}
          }
          if(creditRemaining)throw new DomainError("REFUND_CREDIT_OVERDRAW","权益退款批次不足",409);
        }
        const localCredit=cashRefund===0;
        const outRefundNo=`${localCredit?'LC':'CR'}${request.id.replaceAll("-","").toUpperCase()}`;
        const intent=(await client.query<{id:string}>(`INSERT INTO commission_refund_intent(order_id,payment_inbox_id,out_refund_no,
          refund_cents,payer_refund_cents,eligible_merchandise_refund_cents,
          other_merchandise_refund_cents,shipping_cash_refund_cents,line_allocation,
          allocation_policy_version,created_by,request_id,execution_kind,submission_state)
          VALUES($1,$2,$3,$4,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
          [order.id,payment.id,outRefundNo,cashRefund,eligible,cashRefund-eligible-shippingRefund,shippingRefund,
            JSON.stringify(localCredit?[]:allocation),
            selected?"quantity-net-components-v1":historicalComponents?"historical-full-components-v1":creditTotal?"isolated-split-tender-v1":"isolated-cash-lines-v1",
            `member:${approver}`,request.id,localCredit?'local_credit':'wechat',localCredit?'closed':'prepared'])).rows[0]!;
        for(const source of sourceAllocations)await client.query(`INSERT INTO commission_credit_refund_allocation
          (refund_intent_id,source_id,amount_cents) VALUES($1,$2,$3)`,[intent.id,source.sourceId,source.amount]);
        if(localCredit)localCreditIntent={id:intent.id,sources:sourceAllocations};
      }
      const updated=(await client.query<RequestRow>(`UPDATE commerce_refund_request SET
        state=$2,version=version+1,decided_by_member_id=$3,decision_key=$4,decision_hash=$5,
        decision_reason=$6,decided_at=clock_timestamp() WHERE id=$1 RETURNING *`,
        [request.id,decision==="approve"?"approved":"rejected",approver,decisionKey,fingerprint,why])).rows[0]!;
      await client.query(`INSERT INTO audit_log(principal_id,action,object_type,object_id,reason_code,
        after_state,trace_id) VALUES($1,'commerce.refund.decision','commerce_refund_request',$2,$3,$4,$5)`,
        [`member:${approver}`,request.id,decision.toUpperCase(),{amountCents:amount,eligibleCents:eligible},`refund-decision:${request.id}`]);
      if(localCreditIntent){
        // This is a local return of the exact original credit lots. The
        // approved request, terminal fact and immutable entries commit or
        // roll back together; no zero-value WeChat refund is created.
        await client.query(`UPDATE commission_refund_intent SET state='succeeded',finalized_at=clock_timestamp()
          WHERE id=$1 AND state='prepared'`,[localCreditIntent.id]);
        const originOrders=[...new Set(localCreditIntent.sources.map(source=>source.originOrderId))].sort();
        for(const originOrderId of originOrders)await client.query('SELECT id FROM commerce_order WHERE id=$1 FOR UPDATE',[originOrderId]);
        for(const source of localCreditIntent.sources)await client.query(`INSERT INTO commission_credit_entry
          (source_id,event_key,kind,amount_cents,purchase_order_id,actor_principal_id)
          VALUES($1,$2,'refund_return',$3,$4,$5)`,[source.sourceId,
            `credit-local-refund-return:${localCreditIntent.id}:${source.sourceId}`,source.amount,
            order.id,`member:${approver}`]);
        const creditExposure=[];
        for(const originOrderId of originOrders)creditExposure.push({originOrderId,
          ...await freezeCreditExposureForRefund(client,originOrderId,localCreditIntent.id,`member:${approver}`)});
        await client.query(`INSERT INTO audit_log(principal_id,action,object_type,object_id,reason_code,
          after_state,trace_id) VALUES($1,'commerce.credit_refund_applied','commission_refund_intent',
          $2,'ORIGINAL_CREDIT_RETURN',$3,$4)`,[`member:${approver}`,localCreditIntent.id,
          {orderId:order.id,creditReturnedCents:amount,sourceCount:localCreditIntent.sources.length,creditExposure},
          `credit-local-refund:${localCreditIntent.id}`]);
      }
      return this.decisionView(client,updated);
    },"SERIALIZABLE");
  }

  private async decisionView(client:pg.PoolClient,row:RequestRow){
    const intent=(await client.query<{id:string;out_refund_no:string;state:string;execution_kind:string;payer_refund_cents:string;
      credit_refund_cents:string}>(`SELECT i.id,i.out_refund_no,i.state,i.payer_refund_cents,
      i.execution_kind,
      COALESCE((SELECT sum(a.amount_cents) FROM commission_credit_refund_allocation a
        WHERE a.refund_intent_id=i.id),0)::text AS credit_refund_cents
      FROM commission_refund_intent i WHERE i.request_id=$1`,[row.id])).rows[0];
    return {id:row.id,orderId:row.order_id,state:row.state,version:row.version,
      amountCents:Number(row.amount_cents),intent:intent?{id:intent.id,outRefundNo:intent.out_refund_no,
        state:intent.state,executionKind:intent.execution_kind,cashRefundCents:Number(intent.payer_refund_cents),
        creditReturnCents:Number(intent.credit_refund_cents)}:null};
  }

  async listMine(memberId:string|undefined,query:{limit?:string;cursor?:string;orderId?:string}={}){
    return listMemberRefundRequests(this.pool,memberId,query);
  }

  async pending(memberId:string|undefined,query:{limit?:string;cursor?:string}={}){
    await this.authority.require(memberId,"commerce.refund.approve");
    const limit=pageLimit(query.limit),scope=pageScope(["refund-pending"]),cursor=readPageCursor(query.cursor,scope);
    return transaction(this.pool,async client=>{
      await this.authority.requireWithClient(client,memberId,"commerce.refund.approve");
      const count=(await client.query<{n:number}>(`SELECT count(*)::int AS n FROM commerce_refund_request
        WHERE state='requested'`)).rows[0]?.n??0;
      const rows=(await client.query(`SELECT id,order_id,requested_by_member_id,amount_cents,reason,
        version,created_at,to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_at
        FROM commerce_refund_request WHERE state='requested'
        AND ($1::timestamptz IS NULL OR (created_at,id)>($1::timestamptz,$2::uuid))
        ORDER BY created_at,id LIMIT $3`,[cursor?.at??null,cursor?.id??null,limit+1])).rows;
      const page=finishPage(rows.map(row=>({id:row.id,cursorAt:row.cursor_at,
        orderId:row.order_id,requestedByMemberId:row.requested_by_member_id,
        amountCents:Number(row.amount_cents),reason:row.reason,version:row.version,
        createdAt:row.created_at})),limit,scope);
      return {...page,totalCount:count};
    },"REPEATABLE READ");
  }

  async redrive(memberId:string|undefined,intentIdInput:string,input:Record<string,unknown>){
    await this.authority.require(memberId,"commerce.money.reconcile");
    const intentId=id(intentIdInput),why=reason(input.reason),expectedAttempts=Number(input.expectedAttempts);
    if(Array.from(why).length<8||!Number.isSafeInteger(expectedAttempts)||expectedAttempts<1||expectedAttempts>8)
      throw new DomainError("REFUND_REDRIVE_INPUT_INVALID","请核对重驱依据和任务尝试次数",422);
    return transaction(this.pool,async client=>{
      await this.authority.requireWithClient(client,memberId,"commerce.money.reconcile");
      const row=(await client.query(`UPDATE commission_refund_intent SET submission_quarantined_at=NULL,
        submission_attempt_count=0,submission_next_attempt_at=clock_timestamp(),
        submission_last_error_code=NULL,submission_lease_until=NULL,
        submission_state='unknown' WHERE id=$1 AND state='prepared'
          AND submission_state IN ('prepared','unknown') AND submission_quarantined_at IS NOT NULL
          AND submission_attempt_count=$2 RETURNING id`,[intentId,expectedAttempts])).rows[0];
      if(!row)throw new DomainError("REFUND_REDRIVE_CONFLICT","退款任务状态或次数已变化",409);
      await client.query(`INSERT INTO audit_log(principal_id,action,object_type,object_id,reason_code,
        after_state,trace_id) VALUES($1,'commerce.refund_submission_redrive','commission_refund_intent',
        $2,'AUTHORIZED_ORIGINAL_NUMBER_REQUERY',$3,$4)`,[`member:${memberId}`,intentId,
          {reason:why,expectedAttempts},`refund-submission-redrive:${intentId}:${Date.now()}`]);
      return {id:intentId,state:"requery_due" as const};
    });
  }

  private binding(row:IntentRow):RefundBinding{
    if(row.merchant_id!==this.options.merchantId)
      throw new DomainError("REFUND_MERCHANT_MISMATCH","退款商户号与原支付不符",409);
    return {merchantId:row.merchant_id,outTradeNo:row.order_number,
      providerTransactionId:row.provider_transaction_id,outRefundNo:row.out_refund_no,
      totalCents:cents(row.paid_cents),refundCents:cents(row.refund_cents),
      payerTotalCents:cents(row.paid_cents),payerRefundCents:cents(row.payer_refund_cents)};
  }

  private async recordChannelAcceptance(intentId:string,sourceKind:"signed_create"|"signed_query",
    evidence:Awaited<ReturnType<WechatPayV3Client["queryRefundByMerchantRefundNumberWithEvidence"]>>){
    await this.pool.query(`INSERT INTO commission_refund_channel_observation
      (refund_intent_id,source_kind,raw_sha256,provider_refund_id,accepted_at)
      VALUES($1,$2,$3,$4,$5) ON CONFLICT(refund_intent_id,raw_sha256) DO NOTHING`,
      [intentId,sourceKind,evidence.rawSha256,evidence.fact.providerRefundId,evidence.fact.acceptedAt]);
  }

  async processDue(limit=20){
    const claimed=(await this.pool.query<{id:string;submission_lease_token:string}>(`WITH due AS (
      SELECT id FROM commission_refund_intent WHERE state='prepared' AND
        submission_state IN ('prepared','unknown') AND submission_quarantined_at IS NULL
        AND submission_next_attempt_at<=clock_timestamp() AND
        (submission_lease_until IS NULL OR submission_lease_until<clock_timestamp())
      ORDER BY submission_next_attempt_at,id LIMIT $1 FOR UPDATE SKIP LOCKED
    ) UPDATE commission_refund_intent i SET submission_state='unknown',
      submission_lease_until=clock_timestamp()+interval '30 seconds',submission_lease_token=gen_random_uuid()
      FROM due WHERE i.id=due.id RETURNING i.id,i.submission_lease_token`,[limit])).rows;
    const results:{id:string;state:string}[]=[];
    for(const {id:targetId,submission_lease_token:leaseToken} of claimed){
      try{results.push({id:targetId,state:await this.processOne(targetId,leaseToken)});}
      catch(error){
        const code=error instanceof DomainError?error.code:"CHANNEL_UNAVAILABLE";
        const prior=(await this.pool.query<{submission_attempt_count:number}>(
          "SELECT submission_attempt_count FROM commission_refund_intent WHERE id=$1",[targetId])).rows[0];
        const count=Math.min(8,(prior?.submission_attempt_count??0)+1),delay=Math.min(300_000,5_000*2**(count-1));
        await this.pool.query(`UPDATE commission_refund_intent SET submission_lease_until=NULL,
          submission_attempt_count=$2,submission_next_attempt_at=clock_timestamp()+($3::integer*interval '1 millisecond'),
          submission_quarantined_at=CASE WHEN $2=8 THEN clock_timestamp() ELSE NULL END,
          submission_last_error_code=$4 WHERE id=$1 AND state='prepared'
          AND submission_lease_token=$5`,
          [targetId,count,delay,/^[A-Z0-9_]{3,80}$/.test(code)?code:"CHANNEL_UNAVAILABLE",leaseToken]);
        results.push({id:targetId,state:count===8?"quarantined":"retry_scheduled"});
      }
    }
    return results;
  }

  async processOne(intentId:string,leaseToken:string){
    const row=(await this.pool.query<IntentRow>(`SELECT i.*,o.order_number,o.total_cents,
      p.provider_transaction_id,p.amount_cents AS paid_cents,p.merchant_id,
      r.reason AS request_reason FROM commission_refund_intent i
      JOIN commerce_order o ON o.id=i.order_id JOIN commission_payment_inbox p ON p.id=i.payment_inbox_id
      JOIN commerce_refund_request r ON r.id=i.request_id WHERE i.id=$1`,[id(intentId)])).rows[0];
    if(!row||row.state!=="prepared"||row.submission_state!=="unknown")
      throw new DomainError("REFUND_SUBMISSION_NOT_PENDING","退款提交任务不在待处理状态",409);
    if(row.submission_lease_token!==leaseToken)
      throw new DomainError("REFUND_LEASE_LOST","退款任务租约已被接管",409);
    const binding=this.binding(row);
    let queried;
    try{
      const evidence=await this.channel.queryRefundByMerchantRefundNumberWithEvidence(binding);
      await this.recordChannelAcceptance(intentId,"signed_query",evidence);
      queried=evidence.fact;
    }
    catch(error){if(!(error instanceof DomainError&&error.code==="WECHAT_REFUND_NOT_FOUND"))throw error;}
    if(!queried){
      if(row.first_dispatch_started_at)
        throw new DomainError("REFUND_ORIGINAL_QUERY_REQUIRED","原退款单可能已发送，须继续查询并人工核对",409);
      const marked=await this.pool.query(`UPDATE commission_refund_intent SET
        first_dispatch_started_at=clock_timestamp() WHERE id=$1 AND state='prepared'
        AND submission_state='unknown' AND first_dispatch_started_at IS NULL
        AND submission_lease_token=$2 RETURNING id`,[intentId,leaseToken]);
      if(!marked.rowCount)throw new DomainError("REFUND_LEASE_LOST","退款任务租约已被接管",409);
      // This update is committed before the HTTP boundary. On crash, the
      // original number stays held and NOT_FOUND never authorizes resubmission.
      const accepted=await this.channel.createRefund(binding,row.request_reason.slice(0,80),this.options.notifyUrl);
      await this.recordChannelAcceptance(intentId,"signed_create",accepted);
      if(accepted.fact.status==="SUCCESS"||accepted.fact.status==="CLOSED"||accepted.fact.status==="ABNORMAL")
        queried=await this.channel.queryRefundByMerchantRefundNumber(binding);
      else queried=accepted.fact;
    }
    if(queried.status==="SUCCESS"||queried.status==="CLOSED"||queried.status==="ABNORMAL")
      await this.inbox.receiveQueried(this.channel,intentId);
    await this.pool.query(`UPDATE commission_refund_intent SET submission_state='accepted',
      submission_lease_until=NULL,submission_last_error_code=NULL,
      submission_next_attempt_at=clock_timestamp()+interval '1 minute'
      WHERE id=$1 AND state='prepared' AND submission_state='unknown'
        AND submission_lease_token=$2`,[intentId,leaseToken]);
    return queried.status==="PROCESSING"?"accepted_processing":"verified_fact_pending";
  }

  async reconcileAccepted(limit=20){
    const claimed=(await this.pool.query<{id:string}>(`WITH due AS (
      SELECT id FROM commission_refund_intent WHERE state='prepared' AND submission_state='accepted'
        AND submission_next_attempt_at<=clock_timestamp()
        AND (reconcile_lease_until IS NULL OR reconcile_lease_until<clock_timestamp())
      ORDER BY submission_next_attempt_at,id LIMIT $1 FOR UPDATE SKIP LOCKED
    ) UPDATE commission_refund_intent i SET reconcile_lease_until=clock_timestamp()+interval '30 seconds'
      FROM due WHERE i.id=due.id RETURNING i.id`,[limit])).rows;
    const results:{id:string;state:string}[]=[];
    for(const {id:targetId} of claimed){
      try{
        const row=(await this.pool.query<IntentRow>(`SELECT i.*,o.order_number,o.total_cents,
          p.provider_transaction_id,p.amount_cents AS paid_cents,p.merchant_id,
          r.reason AS request_reason FROM commission_refund_intent i
          JOIN commerce_order o ON o.id=i.order_id JOIN commission_payment_inbox p ON p.id=i.payment_inbox_id
          JOIN commerce_refund_request r ON r.id=i.request_id WHERE i.id=$1`,[targetId])).rows[0];
        if(!row||row.state!=="prepared"){
          results.push({id:targetId,state:"already_terminal"});continue;
        }
        const evidence=await this.channel.queryRefundByMerchantRefundNumberWithEvidence(this.binding(row));
        await this.recordChannelAcceptance(targetId,"signed_query",evidence);
        const fact=evidence.fact;
        const terminal=fact.status!=="PROCESSING";
        if(terminal)await this.inbox.receiveQueried(this.channel,targetId);
        await this.pool.query(`UPDATE commission_refund_intent SET reconcile_lease_until=NULL,
          reconcile_attempt_count=LEAST(1000,reconcile_attempt_count+1),reconcile_last_error_code=NULL,
          submission_next_attempt_at=clock_timestamp()+
            (LEAST(1800000,60000*POWER(2,LEAST(5,reconcile_attempt_count)))::integer*interval '1 millisecond')
          WHERE id=$1 AND state='prepared' AND submission_state='accepted'`,[targetId]);
        results.push({id:targetId,state:terminal?"verified_fact_pending":"processing"});
      }catch(error){
        const code=error instanceof DomainError&&/^[A-Z0-9_]{3,80}$/.test(error.code)?error.code:"CHANNEL_UNAVAILABLE";
        await this.pool.query(`UPDATE commission_refund_intent SET reconcile_lease_until=NULL,
          reconcile_attempt_count=LEAST(1000,reconcile_attempt_count+1),reconcile_last_error_code=$2,
          submission_next_attempt_at=clock_timestamp()+interval '5 minutes'
          WHERE id=$1 AND state='prepared' AND submission_state='accepted'`,[targetId,code]);
        results.push({id:targetId,state:"retry_scheduled"});
      }
    }
    return results;
  }
}
