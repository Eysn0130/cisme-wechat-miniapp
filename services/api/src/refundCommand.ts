import { createHash } from "node:crypto";
import type pg from "pg";
import { DomainError } from "@cisme/domain";
import { transaction } from "./db.js";
import { AuthorityService } from "./authority.js";
import { VerifiedRefundInbox } from "./verifiedRefundInbox.js";
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
type Line={id:string;line_total_cents:string};

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

/** All routes are test-only until merchant authorization and commercial
 * policies are approved. Approval reserves a fixed CNY allocation before any
 * channel request. Channel acceptance is never treated as refund success. */
export class RefundCommandService{
  constructor(private readonly pool:pg.Pool,private readonly authority:AuthorityService,
    private readonly channel:WechatPayV3Client,private readonly inbox:VerifiedRefundInbox,
    private readonly options:{merchantId:string;notifyUrl:string}){}

  async request(memberId:string|undefined,orderIdInput:string,idempotencyKey:string,input:Record<string,unknown>){
    if(!memberId)throw new DomainError("AUTH_REQUIRED","请先登录后继续",401);
    const orderId=id(orderIdInput),requestKey=key(idempotencyKey),amount=cents(input.amountCents),why=reason(input.reason);
    const fingerprint=hash({orderId,amount,why});
    return transaction(this.pool,async client=>{
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
      if(Number(order.shipping_cents)!==0||Number(order.member_discount_cents)!==0||
        Number(order.subtotal_cents)!==Number(order.total_cents))
        throw new DomainError("REFUND_POLICY_UNSUPPORTED","当前优惠或运费分摊尚无批准规则",409);
      const payment=(await client.query(`SELECT id FROM commission_payment_inbox WHERE order_id=$1 AND state='applied'`,[orderId])).rows[0];
      if(!payment)throw new DomainError("REFUND_PAYMENT_FACT_MISSING","原支付事实尚未入账",409);
      const existing=(await client.query<{reserved:string}>(`SELECT COALESCE(sum(r.amount_cents),0)::text AS reserved
        FROM commerce_refund_request r LEFT JOIN commission_refund_intent i ON i.request_id=r.id
        WHERE r.order_id=$1 AND (r.state='requested' OR (r.state='approved' AND i.state<>'closed'))`,[orderId])).rows[0];
      if(Number(existing?.reserved??0)+amount>Number(order.total_cents))
        throw new DomainError("REFUND_AMOUNT_EXCEEDS_REMAINING","累计申请金额超过可退现金",409);
      const row=(await client.query<RequestRow>(`INSERT INTO commerce_refund_request(order_id,requested_by_member_id,
        idempotency_key,request_hash,amount_cents,reason) VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,
        [orderId,memberId,requestKey,fingerprint,amount,why])).rows[0]!;
      return {id:row.id,orderId,amountCents:amount,state:row.state,version:row.version};
    },"SERIALIZABLE");
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
      let eligible=0;
      if(decision==="approve"){
        const payment=(await client.query(`SELECT * FROM commission_payment_inbox WHERE order_id=$1 AND state='applied'`,[order.id])).rows[0];
        if(!payment||Number(payment.amount_cents)!==Number(order.total_cents))
          throw new DomainError("REFUND_PAYMENT_FACT_MISMATCH","原支付金额不一致",409);
        const snapshot=(await client.query(`SELECT * FROM commission_order_snapshot WHERE order_id=$1`,[order.id])).rows[0];
        if(snapshot&&(snapshot.source_kind!=="verified_commerce"||
          Number(snapshot.cash_merchandise_cents)!==Number(order.total_cents)))
          throw new DomainError("REFUND_POLICY_UNSUPPORTED","计佣基数与订单现金不一致，不能自动分摊",409);
        const prior=(await client.query(`SELECT i.line_allocation,i.payer_refund_cents FROM commission_refund_intent i
          WHERE i.order_id=$1 AND i.state<>'closed' FOR UPDATE`,[order.id])).rows;
        const occupied=new Map<string,number>();let totalReserved=0;
        for(const existing of prior){
          totalReserved+=Number(existing.payer_refund_cents);
          for(const item of existing.line_allocation as {lineId:string;eligibleCashRefundCents:number;otherCashRefundCents:number}[])
            occupied.set(item.lineId,(occupied.get(item.lineId)??0)+item.eligibleCashRefundCents+item.otherCashRefundCents);
        }
        if(totalReserved+amount>Number(payment.amount_cents))
          throw new DomainError("REFUND_AMOUNT_EXCEEDS_REMAINING","累计核准金额超过原支付",409);
        const lines=(await client.query<Line>(`SELECT id,line_total_cents FROM commerce_order_line
          WHERE order_id=$1 ORDER BY line_number FOR UPDATE`,[order.id])).rows;
        if(!lines.length||lines.reduce((sum,line)=>sum+Number(line.line_total_cents),0)!==Number(order.total_cents))
          throw new DomainError("REFUND_CASH_LINES_MISMATCH","订单商品现金分摊不一致",409);
        let remaining=amount;eligible=snapshot?amount:0;
        for(const line of lines){
          const available=Number(line.line_total_cents)-(occupied.get(line.id)??0),take=Math.min(remaining,available);
          if(take>0){allocation.push({lineId:line.id,eligibleCashRefundCents:snapshot?take:0,
            otherCashRefundCents:snapshot?0:take});remaining-=take;}
        }
        if(remaining!==0)throw new DomainError("REFUND_LINE_OVERDRAW","退款商品分摊超过原单",409);
        const outRefundNo=`CR${request.id.replaceAll("-","").toUpperCase()}`;
        await client.query(`INSERT INTO commission_refund_intent(order_id,payment_inbox_id,out_refund_no,
          refund_cents,payer_refund_cents,eligible_merchandise_refund_cents,
          other_merchandise_refund_cents,shipping_cash_refund_cents,line_allocation,
          allocation_policy_version,created_by,request_id)
          VALUES($1,$2,$3,$4,$4,$5,$6,0,$7,'isolated-cash-lines-v1',$8,$9)`,
          [order.id,payment.id,outRefundNo,amount,eligible,amount-eligible,JSON.stringify(allocation),
            `member:${approver}`,request.id]);
      }
      const updated=(await client.query<RequestRow>(`UPDATE commerce_refund_request SET
        state=$2,version=version+1,decided_by_member_id=$3,decision_key=$4,decision_hash=$5,
        decision_reason=$6,decided_at=clock_timestamp() WHERE id=$1 RETURNING *`,
        [request.id,decision==="approve"?"approved":"rejected",approver,decisionKey,fingerprint,why])).rows[0]!;
      await client.query(`INSERT INTO audit_log(principal_id,action,object_type,object_id,reason_code,
        after_state,trace_id) VALUES($1,'commerce.refund.decision','commerce_refund_request',$2,$3,$4,$5)`,
        [`member:${approver}`,request.id,decision.toUpperCase(),{amountCents:amount,eligibleCents:eligible},`refund-decision:${request.id}`]);
      return this.decisionView(client,updated);
    },"SERIALIZABLE");
  }

  private async decisionView(client:pg.PoolClient,row:RequestRow){
    const intent=(await client.query<{id:string;out_refund_no:string;state:string}>(
      "SELECT id,out_refund_no,state FROM commission_refund_intent WHERE request_id=$1",[row.id])).rows[0];
    return {id:row.id,orderId:row.order_id,state:row.state,version:row.version,
      amountCents:Number(row.amount_cents),intent:intent?{id:intent.id,outRefundNo:intent.out_refund_no,
        state:intent.state}:null};
  }

  async listMine(memberId:string|undefined,query:{limit?:string;cursor?:string;orderId?:string}={}){
    if(!memberId)throw new DomainError("AUTH_REQUIRED","请先登录后继续",401);
    const orderId=query.orderId?id(query.orderId):null;
    const limit=pageLimit(query.limit),scope=pageScope(["refund-mine",memberId,orderId]),cursor=readPageCursor(query.cursor,scope);
    const count=(await this.pool.query<{n:number}>(`SELECT count(*)::int AS n FROM commerce_refund_request
      WHERE requested_by_member_id=$1 AND ($2::uuid IS NULL OR order_id=$2)`,[memberId,orderId])).rows[0]?.n??0;
    const rows=(await this.pool.query(`SELECT r.id,r.order_id,r.amount_cents,r.state,r.reason,
      r.created_at,i.state AS refund_state FROM commerce_refund_request r
      LEFT JOIN commission_refund_intent i ON i.request_id=r.id
      WHERE r.requested_by_member_id=$1 AND ($2::uuid IS NULL OR r.order_id=$2)
        AND ($3::timestamptz IS NULL OR (r.created_at,r.id)<($3::timestamptz,$4::uuid))
      ORDER BY r.created_at DESC,r.id DESC LIMIT $5`,[memberId,orderId,cursor?.at??null,cursor?.id??null,limit+1])).rows;
    const page=finishPage(rows.map(row=>({id:row.id,cursorAt:new Date(row.created_at).toISOString(),
      orderId:row.order_id,amountCents:Number(row.amount_cents),state:row.state,
      refundState:row.refund_state??null,reason:row.reason,createdAt:row.created_at})),limit,scope);
    return {...page,totalCount:count};
  }

  async pending(memberId:string|undefined,query:{limit?:string;cursor?:string}={}){
    await this.authority.require(memberId,"commerce.refund.approve");
    const limit=pageLimit(query.limit),scope=pageScope(["refund-pending"]),cursor=readPageCursor(query.cursor,scope);
    const count=(await this.pool.query<{n:number}>(`SELECT count(*)::int AS n FROM commerce_refund_request
      WHERE state='requested'`)).rows[0]?.n??0;
    const rows=(await this.pool.query(`SELECT id,order_id,requested_by_member_id,amount_cents,reason,
      version,created_at FROM commerce_refund_request WHERE state='requested'
      AND ($1::timestamptz IS NULL OR (created_at,id)>($1::timestamptz,$2::uuid))
      ORDER BY created_at,id LIMIT $3`,[cursor?.at??null,cursor?.id??null,limit+1])).rows;
    const page=finishPage(rows.map(row=>({id:row.id,cursorAt:new Date(row.created_at).toISOString(),
      orderId:row.order_id,requestedByMemberId:row.requested_by_member_id,
      amountCents:Number(row.amount_cents),reason:row.reason,version:row.version,
      createdAt:row.created_at})),limit,scope);
    return {...page,totalCount:count};
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
      totalCents:cents(row.total_cents),refundCents:cents(row.refund_cents),
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
