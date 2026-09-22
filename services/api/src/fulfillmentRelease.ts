import { createHash } from "node:crypto";
import type pg from "pg";
import type { AppEnvironment } from "@cisme/config";
import { DomainError } from "@cisme/domain";
import { AuthorityService } from "./authority.js";
import { transaction } from "./db.js";
import { finishPage, pageLimit, pageScope, readPageCursor } from "./keysetPage.js";

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const KEY=/^[A-Za-z0-9._:-]{8,200}$/;
const SHA=/^[0-9a-f]{64}$/;
const REF=/^[A-Za-z0-9._:-]{8,120}$/;
type Row={id:string;order_id:string;state:"submitted"|"verified"|"rejected";version:number;
  proposed_by_member_id:string;reviewed_by_member_id:string|null;request_key:string;request_hash:string;
  decision_key:string|null;decision_hash:string|null;delivered_at:Date};
const digest=(value:unknown)=>createHash("sha256").update(JSON.stringify(value)).digest("hex");
function id(value:string){if(!UUID.test(value))throw new DomainError("FULFILLMENT_ID_INVALID","履约编号无效",422);return value;}
function key(value:string){if(!KEY.test(value))throw new DomainError("IDEMPOTENCY_KEY_INVALID","请求键无效",400);return value;}

/** Test-only two-person attestation. It is an explicit engineering policy,
 * not a substitute for carrier integration or approved after-sales terms. */
export class FulfillmentReleaseService{
  constructor(private readonly pool:pg.Pool,private readonly authority:AuthorityService,
    private readonly environment:AppEnvironment){}

  private gate(){if(this.environment!=="test")throw new DomainError("FULFILLMENT_POLICY_NOT_APPROVED",
    "履约与售后释放政策尚未获正式批准",503);}

  async submit(actorId:string|undefined,orderIdInput:string,requestKeyInput:string,input:Record<string,unknown>){
    this.gate();await this.authority.require(actorId,"commerce.fulfillment.manage");
    const actor=actorId!,orderId=id(orderIdInput),requestKey=key(requestKeyInput);
    const sourceReference=String(input.sourceReference??""),evidenceSha256=String(input.evidenceSha256??"");
    if(!REF.test(sourceReference)||!SHA.test(evidenceSha256))throw new DomainError("FULFILLMENT_EVIDENCE_INVALID",
      "隔离履约凭据编号或摘要无效",422);
    const deliveredAt=String(input.deliveredAt??"");
    if(!Number.isFinite(Date.parse(deliveredAt))||new Date(deliveredAt).toISOString()!==deliveredAt)
      throw new DomainError("FULFILLMENT_TIME_INVALID","签收时间无效",422);
    const fingerprint=digest({orderId,sourceReference,evidenceSha256,deliveredAt});
    return transaction(this.pool,async client=>{
      await this.authority.requireWithClient(client,actor,"commerce.fulfillment.manage");
      const order=(await client.query(`SELECT id,status,transaction_source_kind,paid_at FROM commerce_order
        WHERE id=$1 FOR UPDATE`,[orderId])).rows[0];
      if(!order)throw new DomainError("ORDER_NOT_FOUND","订单不存在",404);
      const existing=(await client.query<Row>(`SELECT * FROM commerce_fulfillment_attestation
        WHERE order_id=$1`,[orderId])).rows[0];
      if(existing){
        if(existing.proposed_by_member_id===actor&&existing.request_key===requestKey&&existing.request_hash===fingerprint)
          return {id:existing.id,orderId,state:existing.state,version:existing.version};
        throw new DomainError("FULFILLMENT_ALREADY_SUBMITTED","该订单已有履约核验",409);
      }
      if(order.status!=="paid"||order.transaction_source_kind!=="verified_commerce"||
        new Date(deliveredAt)<new Date(order.paid_at)||new Date(deliveredAt)>new Date())
        throw new DomainError("FULFILLMENT_PAYMENT_OR_TIME_INVALID","订单支付或签收事实不符合核验条件",409);
      const row=(await client.query<Row>(`INSERT INTO commerce_fulfillment_attestation(order_id,source_kind,
        source_reference,evidence_sha256,request_key,request_hash,delivered_at,release_policy_version,
        proposed_by_member_id) VALUES($1,'isolated_manual_fixture',$2,$3,$4,$5,$6,
        'isolated-delivery-v1',$7) RETURNING *`,
        [orderId,sourceReference,evidenceSha256,requestKey,fingerprint,deliveredAt,actor])).rows[0]!;
      return {id:row.id,orderId,state:row.state,version:row.version};
    },"SERIALIZABLE");
  }

  async decide(actorId:string|undefined,attestationIdInput:string,decisionKeyInput:string,input:Record<string,unknown>){
    this.gate();await this.authority.require(actorId,"commerce.fulfillment.manage");
    const actor=actorId!,attestationId=id(attestationIdInput),decisionKey=key(decisionKeyInput),
      decision=input.decision,expectedVersion=Number(input.expectedVersion),reason=String(input.reason??"").trim();
    if(decision!=="verify"&&decision!=="reject"||!Number.isSafeInteger(expectedVersion)||expectedVersion<1||
      Array.from(reason).length<4||Array.from(reason).length>500)
      throw new DomainError("FULFILLMENT_DECISION_INVALID","履约核验决定、版本或依据无效",422);
    const fingerprint=digest({attestationId,decision,expectedVersion,reason});
    return transaction(this.pool,async client=>{
      await this.authority.requireWithClient(client,actor,"commerce.fulfillment.manage");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[`fulfillment:${actor}:${decisionKey}`]);
      const preliminary=(await client.query<Row>(`SELECT * FROM commerce_fulfillment_attestation WHERE id=$1`,
        [attestationId])).rows[0];
      if(!preliminary)throw new DomainError("FULFILLMENT_NOT_FOUND","履约核验不存在",404);
      const order=(await client.query(`SELECT * FROM commerce_order WHERE id=$1 FOR UPDATE`,
        [preliminary.order_id])).rows[0];
      const row=(await client.query<Row>(`SELECT * FROM commerce_fulfillment_attestation WHERE id=$1 FOR UPDATE`,
        [attestationId])).rows[0]!;
      if(row.proposed_by_member_id===actor)throw new DomainError("FULFILLMENT_SELF_REVIEW_FORBIDDEN",
        "履约提交人与核验人必须不同",403);
      if(row.state!=="submitted"){
        if(row.reviewed_by_member_id===actor&&row.decision_key===decisionKey&&row.decision_hash===fingerprint)
          return {id:row.id,orderId:row.order_id,state:row.state,version:row.version};
        throw new DomainError("FULFILLMENT_ALREADY_DECIDED","履约核验已处理",409);
      }
      if(row.version!==expectedVersion)throw new DomainError("VERSION_CONFLICT","履约核验版本已变化",409);
      if(!order||order.status!=="paid"||order.transaction_source_kind!=="verified_commerce")
        throw new DomainError("FULFILLMENT_ORDER_CHANGED","订单支付状态已变化",409);
      const beneficiary=(await client.query<{referrer_member_id:string}>(
        `SELECT referrer_member_id FROM commission_order_snapshot WHERE order_id=$1`,[order.id])).rows[0];
      if(decision==="verify"&&beneficiary?.referrer_member_id===actor)
        throw new DomainError("FULFILLMENT_BENEFICIARY_REVIEW_FORBIDDEN","佣金受益人不能核验自己的释放依据",403);
      let releasedCents=0;
      if(decision==="verify"){
        const compositionConflict=(await client.query<{n:number}>(`SELECT count(*)::int AS n
          FROM commission_payment_composition_observation WHERE order_id=$1`,[order.id])).rows[0]?.n??0;
        if(compositionConflict)throw new DomainError("PAYMENT_COMPOSITION_RECONCILIATION_REQUIRED",
          "支付组成事实相互冲突，暂停佣金释放",409);
        const unresolved=(await client.query<{n:number}>(`SELECT count(*)::int AS n FROM commerce_refund_request r
          LEFT JOIN commission_refund_intent i ON i.request_id=r.id WHERE r.order_id=$1 AND
          (r.state='requested' OR (r.state='approved' AND (i.id IS NULL OR i.state IN ('prepared','abnormal'))))`,
          [order.id])).rows[0]?.n??0;
        if(unresolved)throw new DomainError("FULFILLMENT_REFUND_UNRESOLVED",
          "仍有待决或在途退款，不能释放佣金",409);
        const snapshot=(await client.query(`SELECT * FROM commission_order_snapshot WHERE order_id=$1`,
          [order.id])).rows[0];
        if(snapshot){
          const ledger=(await client.query(`SELECT kind,amount_cents FROM commission_ledger_entry
            WHERE order_id=$1 FOR UPDATE`,[order.id])).rows;
          if(ledger.some(entry=>entry.kind==="release"))throw new DomainError("COMMISSION_ALREADY_RELEASED",
            "该订单佣金已释放",409);
          const accrued=ledger.filter(entry=>entry.kind==="accrual").reduce((s,e)=>s+Number(e.amount_cents),0);
          const reversed=ledger.filter(entry=>entry.kind==="refund_reversal").reduce((s,e)=>s-Number(e.amount_cents),0);
          if(!Number.isSafeInteger(accrued)||!Number.isSafeInteger(reversed)||reversed>accrued)
            throw new DomainError("COMMISSION_LEDGER_INVARIANT","佣金账本需先核对",409);
          releasedCents=accrued-reversed;
        }
      }
      const updated=(await client.query<Row>(`UPDATE commerce_fulfillment_attestation SET state=$2,
        reviewed_by_member_id=$3,decision_key=$4,decision_hash=$5,decision_reason=$6,
        version=version+1,decided_at=clock_timestamp() WHERE id=$1 RETURNING *`,
        [row.id,decision==="verify"?"verified":"rejected",actor,decisionKey,fingerprint,reason])).rows[0]!;
      if(releasedCents>0){
        const snapshot=(await client.query(`SELECT referrer_member_id FROM commission_order_snapshot
          WHERE order_id=$1`,[order.id])).rows[0]!;
        await client.query(`INSERT INTO commission_ledger_entry(order_id,referrer_member_id,event_key,kind,
          amount_cents,source_fact_id,actor_principal_id) VALUES($1,$2,$3,'release',$4,$5,$6)`,
          [order.id,snapshot.referrer_member_id,`fulfillment:${row.id}`,releasedCents,row.id,`member:${actor}`]);
      }
      await client.query(`INSERT INTO audit_log(principal_id,action,object_type,object_id,reason_code,
        after_state,trace_id) VALUES($1,'commerce.fulfillment_decision','commerce_fulfillment_attestation',
        $2,$3,$4,$5)`,[`member:${actor}`,row.id,decision.toUpperCase(),
          {orderId:order.id,policyVersion:"isolated-delivery-v1",releasedCents},`fulfillment:${row.id}`]);
      return {id:updated.id,orderId:updated.order_id,state:updated.state,version:updated.version,releasedCents};
    },"SERIALIZABLE");
  }

  async pending(actorId:string|undefined,query:{limit?:string;cursor?:string}={}){
    this.gate();await this.authority.require(actorId,"commerce.fulfillment.manage");
    const limit=pageLimit(query.limit),scope=pageScope(["fulfillment-pending"]),cursor=readPageCursor(query.cursor,scope);
    return transaction(this.pool,async client=>{
      await this.authority.requireWithClient(client,actorId,"commerce.fulfillment.manage");
      const totalCount=(await client.query<{n:number}>(`SELECT count(*)::int AS n FROM
        commerce_fulfillment_attestation WHERE state='submitted'`)).rows[0]?.n??0;
      const rows=(await client.query(`SELECT id,order_id,source_reference,evidence_sha256,delivered_at,
        proposed_by_member_id,version,created_at FROM commerce_fulfillment_attestation WHERE state='submitted'
        AND ($1::timestamptz IS NULL OR (created_at,id)>($1::timestamptz,$2::uuid))
        ORDER BY created_at,id LIMIT $3`,[cursor?.at??null,cursor?.id??null,limit+1])).rows;
      return {...finishPage(rows.map(row=>({id:row.id,cursorAt:new Date(row.created_at).toISOString(),
        orderId:row.order_id,sourceReference:row.source_reference,evidenceSha256:row.evidence_sha256,
        deliveredAt:row.delivered_at,proposedByMemberId:row.proposed_by_member_id,
        version:row.version,createdAt:row.created_at})),limit,scope),totalCount};
    },"REPEATABLE READ");
  }
}
