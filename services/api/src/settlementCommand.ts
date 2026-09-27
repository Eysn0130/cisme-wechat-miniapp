import { listMemberSettlements } from "./commerceHistory.js";
import { createHash, randomUUID } from "node:crypto";
import type pg from "pg";
import type { AppEnvironment } from "@cisme/config";
import { DomainError } from "@cisme/domain";
import { AuthorityService } from "./authority.js";
import { transaction } from "./db.js";
import { finishPage, pageLimit, pageScope, readPageCursor } from "./keysetPage.js";
import { type TransferBinding, WechatPayV3Client } from "./wechatPayV3.js";

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const KEY=/^[A-Za-z0-9._:-]{8,200}$/;
type Row={id:string;member_id:string;requested_by_member_id:string;idempotency_key:string;
  request_hash:string;amount_cents:string;state:string;version:number;approved_by_member_id:string|null;
  decision_key:string|null;decision_hash:string|null;app_id:string|null;merchant_id:string|null;
  payee_openid:string|null;out_bill_no:string|null;scene_id:string|null;transfer_remark:string|null;
  created_at:Date;attempt_count:number;first_dispatch_started_at:Date|null;lease_token:string|null;
  cycle_id:string|null;gross_cents:string|null;withholding_cents:string|null;tax_policy_version:string|null};
const hash=(value:unknown)=>createHash("sha256").update(JSON.stringify(value)).digest("hex");
function id(value:string){if(!UUID.test(value))throw new DomainError("SETTLEMENT_ID_INVALID","结算编号无效",422);return value;}
function key(value:string){if(!KEY.test(value))throw new DomainError("IDEMPOTENCY_KEY_INVALID","请求键无效",400);return value;}
function amount(value:unknown){const n=Number(value);if(!Number.isSafeInteger(n)||n<1||n>9_900_000_000)
  throw new DomainError("SETTLEMENT_AMOUNT_INVALID","结算金额须为正整数分",422);return n;}
function reason(value:unknown){const s=String(value??"").trim();if(Array.from(s).length<4||Array.from(s).length>300)
  throw new DomainError("SETTLEMENT_REASON_INVALID","请填写 4 至 300 字的依据",422);return s;}

/** Test-only, fully durable transfer path. Production stays closed until a
 * signed scene/tax/payout policy and merchant authorization exist. */
export class SettlementCommandService{
  constructor(private readonly pool:pg.Pool,private readonly authority:AuthorityService,
    private readonly channel:WechatPayV3Client,private readonly environment:AppEnvironment,
    private readonly options:{appId:string;merchantId:string;sceneId:string;notifyUrl:string;
      legacyDirectFixture?:boolean}){}
  private gate(){if(this.environment!=="test")throw new DomainError("SETTLEMENT_POLICY_NOT_APPROVED",
    "结算场景、税务与发款政策尚未正式批准",503);}

  async request(memberId:string|undefined,requestKeyInput:string,input:Record<string,unknown>){
    this.gate();if(!memberId)throw new DomainError("AUTH_REQUIRED","请先登录后继续",401);
    const requestKey=key(requestKeyInput),cents=amount(input.amountCents),why=reason(input.reason),
      fingerprint=hash({memberId,cents,why});
    return transaction(this.pool,async client=>{
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[`settlement-request:${memberId}:${requestKey}`]);
      const existing=(await client.query<Row>(`SELECT * FROM commission_settlement_request WHERE
        requested_by_member_id=$1 AND idempotency_key=$2`,[memberId,requestKey])).rows[0];
      if(existing){
        if(existing.request_hash!==fingerprint)throw new DomainError("IDEMPOTENCY_CONFLICT",
          "请求键对应不同结算金额或原因",409);
        return this.view(existing);
      }
      const identity=(await client.query<{openid:string}>(`SELECT openid FROM wechat_identity WHERE member_id=$1
        AND provider='wechat_miniprogram' AND app_id=$2 AND adapter='wechat'
        ORDER BY created_at DESC,id DESC LIMIT 1`,[memberId,this.options.appId])).rows[0];
      if(!identity?.openid)throw new DomainError("SETTLEMENT_WECHAT_IDENTITY_REQUIRED",
        "当前会员尚无已核验的小程序收款身份",409);
      const row=(await client.query<Row>(`INSERT INTO commission_settlement_request(member_id,
        requested_by_member_id,idempotency_key,request_hash,amount_cents,reason,policy_version,
        payee_openid) VALUES($1,$1,$2,$3,$4,$5,'isolated-settlement-v1',$6) RETURNING *`,
        [memberId,requestKey,fingerprint,cents,why,identity.openid])).rows[0]!;
      return this.view(row);
    },"SERIALIZABLE");
  }

  async decide(actorId:string|undefined,requestIdInput:string,decisionKeyInput:string,input:Record<string,unknown>){
    this.gate();await this.authority.require(actorId,"commission.settlement.approve");
    const actor=actorId!,requestId=id(requestIdInput),decisionKey=key(decisionKeyInput),
      decision=input.decision,expectedVersion=Number(input.expectedVersion),why=reason(input.reason);
    if(decision!=="approve"&&decision!=="reject"||!Number.isSafeInteger(expectedVersion)||expectedVersion<1)
      throw new DomainError("SETTLEMENT_DECISION_INVALID","结算决定或版本无效",422);
    if(decision==="approve"&&!this.options.legacyDirectFixture)
      throw new DomainError("SETTLEMENT_CYCLE_REQUIRED","会员申请仅为结算意向，须走周期批次复核",409);
    const fingerprint=hash({requestId,decision,expectedVersion,why});
    return transaction(this.pool,async client=>{
      await this.authority.requireWithClient(client,actor,"commission.settlement.approve");
      const preliminary=(await client.query<Row>(`SELECT * FROM commission_settlement_request WHERE id=$1`,
        [requestId])).rows[0];
      if(!preliminary)throw new DomainError("SETTLEMENT_NOT_FOUND","结算申请不存在",404);
      // This lock serializes all approvals and reserve calculations for one payee.
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[`settlement-member:${preliminary.member_id}`]);
      const row=(await client.query<Row>(`SELECT * FROM commission_settlement_request WHERE id=$1 FOR UPDATE`,
        [requestId])).rows[0]!;
      if(row.member_id!==preliminary.member_id)throw new DomainError("SETTLEMENT_MEMBER_CHANGED","结算会员已变化",409);
      if(row.requested_by_member_id===actor)throw new DomainError("SETTLEMENT_SELF_APPROVAL_FORBIDDEN",
        "结算申请人与审批人必须不同",403);
      if(row.state!=="requested"){
        if(row.approved_by_member_id===actor&&row.decision_key===decisionKey&&row.decision_hash===fingerprint)
          return this.view(row);
        throw new DomainError("SETTLEMENT_ALREADY_DECIDED","结算申请已处理",409);
      }
      if(row.version!==expectedVersion)throw new DomainError("VERSION_CONFLICT","结算申请版本已变化",409);
      let allocations:{orderId:string;amountCents:number}[]=[];
      if(decision==="approve"){
        const orders=(await client.query<{order_id:string}>(`SELECT order_id FROM commission_order_snapshot
          WHERE referrer_member_id=$1 ORDER BY created_at,order_id`,[row.member_id])).rows;
        for(const {order_id} of orders)await client.query(`SELECT id FROM commerce_order WHERE id=$1 FOR UPDATE`,[order_id]);
        const ledger=(await client.query<{order_id:string;kind:string;amount_cents:string}>(`SELECT order_id,
          kind,amount_cents FROM commission_ledger_entry WHERE referrer_member_id=$1`,[row.member_id])).rows;
        const held=(await client.query<{order_id:string;held:string}>(`SELECT a.order_id,
          COALESCE(sum(a.amount_cents),0)::text AS held FROM commission_settlement_allocation a
          JOIN commission_settlement_request r ON r.id=a.request_id WHERE r.member_id=$1
            AND r.state IN ('reserved','unknown','processing') GROUP BY a.order_id`,[row.member_id])).rows;
        const holdMap=new Map(held.map(item=>[item.order_id,Number(item.held)]));
        let remaining=Number(row.amount_cents);
        for(const {order_id} of orders){
          const compositionConflict=(await client.query<{n:number}>(`SELECT count(*)::int AS n
            FROM commission_payment_composition_observation WHERE order_id=$1`,[order_id])).rows[0]?.n??0;
          if(compositionConflict)continue;
          const unresolved=(await client.query<{n:number}>(`SELECT count(*)::int AS n FROM commerce_refund_request r
            LEFT JOIN commission_refund_intent i ON i.request_id=r.id WHERE r.order_id=$1 AND
            (r.state='requested' OR (r.state='approved' AND (i.id IS NULL OR i.state IN ('prepared','abnormal'))))`,[order_id])).rows[0]?.n??0;
          // Freeze only this source order; an unrelated disputed refund must
          // not freeze the entire member's otherwise-earned allocations.
          if(unresolved)continue;
          const entries=ledger.filter(entry=>entry.order_id===order_id),sum=(kind:string)=>
            entries.filter(entry=>entry.kind===kind).reduce((n,entry)=>n+Number(entry.amount_cents),0);
          const accrued=sum("accrual"),net=accrued+sum("refund_reversal"),released=sum("release"),
            settled=sum("settlement"),converted=sum("credit_conversion")+sum("credit_conversion_reversal"),
            heldCents=holdMap.get(order_id)??0;
          if(![accrued,net,released,settled,converted,heldCents].every(Number.isSafeInteger)||
            net<0||released>accrued||converted<0||settled+converted>released)
            throw new DomainError("COMMISSION_LEDGER_INVARIANT","佣金账本需先核对",409);
          const available=Math.max(0,Math.min(net,released)-settled-converted-heldCents),take=Math.min(remaining,available);
          if(take>0){allocations.push({orderId:order_id,amountCents:take});remaining-=take;}
          if(remaining===0)break;
        }
        if(remaining>0)throw new DomainError("SETTLEMENT_AVAILABLE_INSUFFICIENT",
          "可结算金额不足或仍有在途预占",409);
      }
      const outBillNo=decision==="approve"?`CS${row.id.replaceAll("-","").slice(0,30).toUpperCase()}`:null;
      const updated=(await client.query<Row>(`UPDATE commission_settlement_request SET state=$2,
        version=version+1,approved_by_member_id=$3,decision_key=$4,decision_hash=$5,
        decision_reason=$6,decided_at=clock_timestamp(),
        finalized_at=CASE WHEN $2='rejected' THEN clock_timestamp() ELSE NULL END,
        app_id=$7,merchant_id=$8,out_bill_no=$9,scene_id=$10,transfer_remark=$11
        WHERE id=$1 RETURNING *`,[row.id,decision==="approve"?"reserved":"rejected",actor,
          decisionKey,fingerprint,why,decision==="approve"?this.options.appId:null,
          decision==="approve"?this.options.merchantId:null,outBillNo,
          decision==="approve"?this.options.sceneId:null,
          decision==="approve"?"熹丝密隔离佣金测试":null])).rows[0]!;
      for(const allocation of allocations)await client.query(`INSERT INTO commission_settlement_allocation
        (request_id,order_id,amount_cents) VALUES($1,$2,$3)`,
        [row.id,allocation.orderId,allocation.amountCents]);
      await client.query(`INSERT INTO audit_log(principal_id,action,object_type,object_id,reason_code,
        after_state,trace_id) VALUES($1,'commission.settlement_decision','commission_settlement_request',
        $2,$3,$4,$5)`,[`member:${actor}`,row.id,decision.toUpperCase(),
          {amountCents:Number(row.amount_cents),allocations:allocations.length},`settlement:${row.id}`]);
      return this.view(updated);
    },"SERIALIZABLE");
  }

  /** Independent batch approval exists only in a synthetic test environment.
   * Tax zero is a named fixture, not a production exemption or payable fact. */
  async approveCycleMember(actorId:string|undefined,cycleIdInput:string,decisionKeyInput:string,
    input:Record<string,unknown>){
    this.gate();await this.authority.require(actorId,"commission.settlement.approve");
    if(Object.keys(input).some(field=>!["memberId","reason","taxPolicyVersion"].includes(field)))
      throw new DomainError("SETTLEMENT_CYCLE_INPUT_UNSUPPORTED","周期复核包含未批准的参数",422);
    const actor=actorId!,cycleId=id(cycleIdInput),memberId=id(String(input.memberId??"")),
      decisionKey=key(decisionKeyInput),why=reason(input.reason),
      taxPolicyVersion=input.taxPolicyVersion;
    if(taxPolicyVersion!=="isolated-synthetic-zero-withholding-v1")
      throw new DomainError("SETTLEMENT_TAX_POLICY_NOT_APPROVED","仅允许隔离合成税务口径",409);
    const fingerprint=hash({cycleId,memberId,why,taxPolicyVersion});
    return transaction(this.pool,async client=>{
      await this.authority.requireWithClient(client,actor,"commission.settlement.approve");
      const cycle=(await client.query<{id:string;prepared_by_member_id:string;state:string}>(
        "SELECT id,prepared_by_member_id,state FROM commission_settlement_cycle WHERE id=$1",[cycleId])).rows[0];
      if(!cycle||cycle.state!=="blocked_tax_and_payout_policy")
        throw new DomainError("SETTLEMENT_CYCLE_NOT_FOUND","周期候选不存在或不可核对",404);
      if(actor===cycle.prepared_by_member_id||actor===memberId||cycle.prepared_by_member_id===memberId)
        throw new DomainError("SETTLEMENT_CYCLE_SELF_APPROVAL_FORBIDDEN","批次准备人、复核人和收款人须不同",403);
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[`settlement-member:${memberId}`]);
      const prior=(await client.query<{approved_by_member_id:string;decision_key:string;
        decision_hash:string;request_id:string}>(`SELECT * FROM commission_settlement_cycle_member
        WHERE cycle_id=$1 AND member_id=$2`,[cycleId,memberId])).rows[0];
      if(prior){
        if(prior.approved_by_member_id===actor&&prior.decision_key===decisionKey&&prior.decision_hash===fingerprint){
          const existing=(await client.query<Row>("SELECT * FROM commission_settlement_request WHERE id=$1",
            [prior.request_id])).rows[0];
          if(!existing)throw new DomainError("SETTLEMENT_CYCLE_RECORD_DRIFT","周期复核记录不完整",409);
          return {...this.view(existing),replay:true};
        }
        throw new DomainError("SETTLEMENT_CYCLE_ALREADY_APPROVED","同一周期与会员只能复核一次",409);
      }
      const used=(await client.query<{id:string}>(`SELECT id FROM commission_settlement_cycle_member
        WHERE approved_by_member_id=$1 AND decision_key=$2`,[actor,decisionKey])).rows[0];
      if(used)throw new DomainError("IDEMPOTENCY_CONFLICT","复核请求键已用于其他批次",409);
      const candidates=(await client.query<{order_id:string;gross_cents:string}>(`SELECT order_id,gross_cents
        FROM commission_settlement_cycle_candidate WHERE cycle_id=$1 AND member_id=$2
        ORDER BY order_id`,[cycleId,memberId])).rows;
      const gross=candidates.reduce((n,row)=>n+Number(row.gross_cents),0);
      if(!Number.isSafeInteger(gross)||gross<10000||gross>9_900_000_000)
        throw new DomainError("SETTLEMENT_CYCLE_THRESHOLD_NOT_MET","本期税前候选不足一百元",409);
      for(const candidate of candidates)
        await client.query("SELECT id FROM commerce_order WHERE id=$1 FOR UPDATE",[candidate.order_id]);
      const identity=(await client.query<{openid:string}>(`SELECT openid FROM wechat_identity
        WHERE member_id=$1 AND provider='wechat_miniprogram' AND app_id=$2 AND adapter='wechat'
        ORDER BY created_at DESC,id DESC LIMIT 1`,[memberId,this.options.appId])).rows[0];
      if(!identity?.openid)throw new DomainError("SETTLEMENT_WECHAT_IDENTITY_REQUIRED","收款人缺少已核对的测试身份",409);
      const requestId=randomUUID(),outBillNo=`CS${requestId.replaceAll("-","").slice(0,30).toUpperCase()}`;
      const created=(await client.query<Row>(`INSERT INTO commission_settlement_request
        (id,member_id,requested_by_member_id,idempotency_key,request_hash,amount_cents,reason,
        policy_version,state,version,cycle_id,gross_cents,withholding_cents,tax_policy_version,
        approved_by_member_id,decision_key,decision_hash,decision_reason,decided_at,
        app_id,merchant_id,payee_openid,out_bill_no,scene_id,transfer_remark)
        VALUES($1,$2,$3,$4,$5,$6,$7,'engineering-monthly-15-test-v1','reserved',2,$8,$6,0,$9,
          $10,$11,$12,$7,clock_timestamp(),$13,$14,$15,$16,$17,'熹丝密周期结算隔离测试') RETURNING *`,
        [requestId,memberId,cycle.prepared_by_member_id,`cycle:${cycleId}:${memberId}`,
          fingerprint,gross,why,cycleId,taxPolicyVersion,actor,decisionKey,fingerprint,
          this.options.appId,this.options.merchantId,identity.openid,outBillNo,this.options.sceneId])).rows[0]!;
      for(const candidate of candidates)await client.query(`INSERT INTO commission_settlement_allocation
        (request_id,order_id,amount_cents) VALUES($1,$2,$3)`,[requestId,candidate.order_id,candidate.gross_cents]);
      if(!await this.allocationStillEarned(client,created))
        throw new DomainError("SETTLEMENT_CYCLE_SOURCE_CHANGED","候选后来源有新退款、追偿或其他预占；重新核对",409);
      await client.query(`INSERT INTO commission_settlement_cycle_member
        (cycle_id,member_id,request_id,prepared_by_member_id,approved_by_member_id,
          decision_key,decision_hash,decision_reason,gross_cents,withholding_cents,net_cents,tax_policy_version)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,0,$9,$10)`,[cycleId,memberId,requestId,
          cycle.prepared_by_member_id,actor,decisionKey,fingerprint,why,gross,taxPolicyVersion]);
      await client.query(`INSERT INTO audit_log(principal_id,action,object_type,object_id,
        reason_code,after_state,trace_id) VALUES($1,'commission.cycle_member_approved',
        'commission_settlement_cycle_member',$2,'SYNTHETIC_TAX_ONLY',$3,$4)`,
        [`member:${actor}`,requestId,{cycleId,memberId,grossCents:gross,withholdingCents:0,
          netCents:gross,taxPolicyVersion},`cycle-approval:${requestId}`]);
      return {...this.view(created),replay:false};
    },"SERIALIZABLE");
  }

  private view(row:Row){return {id:row.id,memberId:row.member_id,amountCents:Number(row.amount_cents),
    cycleId:row.cycle_id??null,grossCents:row.gross_cents===null?null:Number(row.gross_cents),
    withholdingCents:row.withholding_cents===null?null:Number(row.withholding_cents),
    taxPolicyVersion:row.tax_policy_version??null,
    state:row.state,version:row.version,outBillNo:row.out_bill_no,channelState:undefined};}
  private binding(row:Row):TransferBinding{
    if(!row.out_bill_no||!row.payee_openid||row.app_id!==this.options.appId||
      row.merchant_id!==this.options.merchantId||row.scene_id!==this.options.sceneId||
      !row.transfer_remark)throw new DomainError("SETTLEMENT_BINDING_INVALID","转账意图绑定不完整",409);
    return {appId:row.app_id,merchantId:row.merchant_id,outBillNo:row.out_bill_no,
      payeeOpenid:row.payee_openid,amountCents:amount(row.amount_cents),sceneId:row.scene_id,
      remark:row.transfer_remark,notifyUrl:this.options.notifyUrl,
      ...(this.environment==="test"?{sceneReportInfos:[{info_type:"活动名称",info_content:"隔离佣金测试"}]}:{})};
  }

  private async requireCycleApproval(row:Row,db:pg.Pool|pg.PoolClient=this.pool){
    if(!row.cycle_id){
      if(this.options.legacyDirectFixture)return;
      throw new DomainError("SETTLEMENT_CYCLE_REQUIRED","历史意向不能旁路周期批次发款",409);
    }
    const approved=(await db.query<{id:string}>(`SELECT m.id FROM commission_settlement_cycle_member m
      WHERE m.request_id=$1 AND m.cycle_id=$2 AND m.member_id=$3 AND m.net_cents=$4
        AND m.gross_cents=$5 AND m.withholding_cents=$6 AND m.tax_policy_version=$7`,
      [row.id,row.cycle_id,row.member_id,row.amount_cents,row.gross_cents,
        row.withholding_cents,row.tax_policy_version])).rows[0];
    if(!approved||row.tax_policy_version!=="isolated-synthetic-zero-withholding-v1")
      throw new DomainError("SETTLEMENT_CYCLE_APPROVAL_DRIFT","周期复核或合成税务绑定不完整",409);
  }

  private async allocationStillEarned(client:pg.PoolClient,row:Row){
    const allocations=(await client.query<{order_id:string;amount_cents:string}>(
      `SELECT order_id,amount_cents FROM commission_settlement_allocation WHERE request_id=$1 ORDER BY order_id`,
      [row.id])).rows;
    if(allocations.reduce((sum,item)=>sum+Number(item.amount_cents),0)!==Number(row.amount_cents))return false;
    for(const allocation of allocations){
      await client.query(`SELECT id FROM commerce_order WHERE id=$1 FOR UPDATE`,[allocation.order_id]);
      const compositionConflict=(await client.query<{n:number}>(`SELECT count(*)::int AS n
        FROM commission_payment_composition_observation WHERE order_id=$1`,[allocation.order_id])).rows[0]?.n??0;
      if(compositionConflict)return false;
      const unresolved=(await client.query<{n:number}>(`SELECT count(*)::int AS n FROM commerce_refund_request r
        LEFT JOIN commission_refund_intent i ON i.request_id=r.id WHERE r.order_id=$1 AND
        (r.state='requested' OR (r.state='approved' AND (i.id IS NULL OR i.state IN ('prepared','abnormal'))))`,
        [allocation.order_id])).rows[0]?.n??0;
      if(unresolved)return false;
      const sums=(await client.query<{net:string;released:string;settled:string;converted:string}>(`SELECT
        COALESCE(sum(amount_cents) FILTER (WHERE kind IN ('accrual','refund_reversal')),0)::text AS net,
        COALESCE(sum(amount_cents) FILTER (WHERE kind='release'),0)::text AS released,
        COALESCE(sum(amount_cents) FILTER (WHERE kind='settlement'),0)::text AS settled,
        COALESCE(sum(amount_cents) FILTER (WHERE kind IN
          ('credit_conversion','credit_conversion_reversal')),0)::text AS converted
        FROM commission_ledger_entry WHERE order_id=$1 AND referrer_member_id=$2`,
        [allocation.order_id,row.member_id])).rows[0]!;
      const available=Math.min(Number(sums.net),Number(sums.released))-
        Number(sums.settled)-Number(sums.converted);
      // A signed transfer in flight owns its source ahead of a not-yet-sent
      // candidate. Among unsent candidates the oldest reservation wins.
      const others=(await client.query<{request_id:string;amount_cents:string;state:string;created_at:Date;
        first_dispatch_started_at:Date|null}>(`SELECT a.request_id,a.amount_cents,r.state,r.created_at,r.first_dispatch_started_at
        FROM commission_settlement_allocation a JOIN commission_settlement_request r ON r.id=a.request_id
        WHERE a.order_id=$1 AND r.member_id=$2 AND r.id<>$3
          AND r.state IN ('reserved','unknown','processing')`,
        [allocation.order_id,row.member_id,row.id])).rows;
      const prioritized=others.filter(other=>other.first_dispatch_started_at!==null||
        (!row.first_dispatch_started_at &&
          (new Date(other.created_at).getTime()<new Date(row.created_at).getTime()||
            new Date(other.created_at).getTime()===new Date(row.created_at).getTime()&&other.request_id<row.id)));
      const occupied=prioritized.reduce((sum,other)=>sum+Number(other.amount_cents),0);
      if(!Number.isSafeInteger(available)||!Number.isSafeInteger(occupied)||
        available-occupied<Number(allocation.amount_cents))return false;
    }
    return true;
  }

  async processDue(limit=20){
    this.gate();
    const claimed=(await this.pool.query<{id:string;lease_token:string}>(`WITH due AS (
      SELECT id FROM commission_settlement_request r WHERE state IN ('reserved','unknown','processing')
        AND (cycle_id IS NOT NULL AND EXISTS
          (SELECT 1 FROM commission_settlement_cycle_member m WHERE m.request_id=r.id) OR $2::boolean)
        AND quarantined_at IS NULL AND next_attempt_at<=clock_timestamp()
        AND (lease_until IS NULL OR lease_until<clock_timestamp())
      ORDER BY next_attempt_at,id LIMIT $1 FOR UPDATE SKIP LOCKED
    ) UPDATE commission_settlement_request r SET state=CASE WHEN r.state='reserved' THEN 'unknown' ELSE r.state END,
      lease_until=clock_timestamp()+interval '30 seconds',lease_token=gen_random_uuid()
      FROM due WHERE r.id=due.id RETURNING r.id,r.lease_token`,
      [limit,this.options.legacyDirectFixture===true])).rows;
    const results:{id:string;state:string}[]=[];
    for(const {id:targetId,lease_token:leaseToken} of claimed){
      try{results.push({id:targetId,state:await this.processOne(targetId,leaseToken)});}
      catch(error){
        const code=error instanceof DomainError&&/^[A-Z0-9_]{3,80}$/.test(error.code)?error.code:
          "CHANNEL_UNAVAILABLE";
        await this.pool.query(`UPDATE commission_settlement_request SET lease_until=NULL,
          attempt_count=LEAST(1000,attempt_count+1),last_error_code=$2,
          next_attempt_at=clock_timestamp()+
            (LEAST(1800000,5000*POWER(2,LEAST(8,attempt_count)))::integer*interval '1 millisecond'),
          quarantined_at=CASE WHEN attempt_count>=7 THEN clock_timestamp() ELSE NULL END
          WHERE id=$1 AND lease_token=$3 AND state IN ('unknown','processing')`,[targetId,code,leaseToken]);
        results.push({id:targetId,state:"retry_scheduled"});
      }
    }
    return results;
  }

  async processOne(requestId:string,leaseToken:string){
    const row=(await this.pool.query<Row>(`SELECT * FROM commission_settlement_request WHERE id=$1`,
      [id(requestId)])).rows[0];
    if(!row||!["unknown","processing"].includes(row.state))
      throw new DomainError("SETTLEMENT_NOT_DUE","结算转账任务不在待处理状态",409);
    await this.requireCycleApproval(row);
    if(row.lease_token!==leaseToken)
      throw new DomainError("SETTLEMENT_LEASE_LOST","结算租约已经被其他任务接管",409);
    const binding=this.binding(row);
    let queried;
    try{queried=await this.channel.queryTransferByMerchantBillNumber(binding);}
    catch(error){
      if(!(error instanceof DomainError&&error.code==="WECHAT_TRANSFER_NOT_FOUND"))throw error;
      if(row.first_dispatch_started_at||row.state==="processing"||
        Date.now()-new Date(row.created_at).getTime()>29*86400_000)
        throw new DomainError("SETTLEMENT_ORIGINAL_QUERY_REQUIRED","原单状态尚不明确，暂停重发",409);
      return transaction(this.pool,async client=>{
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[`settlement-member:${row.member_id}`]);
        const locked=(await client.query<Row>(`SELECT * FROM commission_settlement_request WHERE id=$1 FOR UPDATE`,
          [row.id])).rows[0];
        if(!locked||locked.state!=="unknown"||locked.lease_token!==leaseToken)
          throw new DomainError("SETTLEMENT_LEASE_LOST","结算租约已经被其他任务接管",409);
        if(!await this.allocationStillEarned(client,locked)){
          // After an earlier outbound attempt, NOT_FOUND may be transient. Keep
          // the hold for operator requery instead of declaring it unpaid.
          if(locked.first_dispatch_started_at)throw new DomainError("SETTLEMENT_REQUERY_REQUIRED","可能已发起的原单需人工复核",409);
          await client.query(`UPDATE commission_settlement_request SET state='cancelled',lease_until=NULL,
            last_error_code='SETTLEMENT_ALLOCATION_INVALID',finalized_at=clock_timestamp(),version=version+1
            WHERE id=$1`,[locked.id]);
          await client.query(`INSERT INTO audit_log(principal_id,action,object_type,object_id,reason_code,
            after_state,trace_id) VALUES('worker:transfer-query','commission.transfer_cancelled',
            'commission_settlement_request',$1,'SETTLEMENT_ALLOCATION_INVALID',$2,$3)`,
            [locked.id,{amountCents:Number(locked.amount_cents)},`settlement-invalid:${locked.id}`]);
          return "cancelled_invalid_allocation";
        }
        // Commit the durable may-have-been-sent boundary BEFORE any HTTP call.
        // A crash after this commit remains a requery, never a fresh payout.
        await client.query(`UPDATE commission_settlement_request SET state='processing',
          first_dispatch_started_at=clock_timestamp(),next_attempt_at=clock_timestamp()+interval '1 minute'
          WHERE id=$1 AND state='unknown'`,[locked.id]);
        return this.binding(locked);
      },"READ COMMITTED",1,10_000).then(async dispatchBinding=>{
        if(typeof dispatchBinding==="string")return dispatchBinding;
        await this.channel.createTransfer(dispatchBinding);
        // Creation response is never booked as paid, even if it says SUCCESS.
        await this.pool.query(`UPDATE commission_settlement_request SET lease_until=NULL,last_error_code=NULL
          WHERE id=$1 AND lease_token=$2 AND state='processing'`,[row.id,leaseToken]);
        return "submitted_query_due";
      });
    }
    return this.applyQueried(row.id,queried,leaseToken);
  }

  async confirmCallback(requestId:string){
    this.gate();
    const row=(await this.pool.query<Row>(`SELECT * FROM commission_settlement_request WHERE id=$1`,
      [id(requestId)])).rows[0];
    if(!row)throw new DomainError("SETTLEMENT_NOT_FOUND","结算申请不存在",404);
    await this.requireCycleApproval(row);
    const fact=await this.channel.queryTransferByMerchantBillNumber(this.binding(row));
    await this.applyQueried(row.id,fact);
    return {state:fact.state,providerBillNo:fact.providerBillNo};
  }

  async receiptConfirmation(memberId:string|undefined,requestIdInput:string){
    this.gate();if(!memberId)throw new DomainError("AUTH_REQUIRED","请先登录后继续",401);
    const row=(await this.pool.query<Row>(`SELECT * FROM commission_settlement_request
      WHERE id=$1 AND member_id=$2`,[id(requestIdInput),memberId])).rows[0];
    if(!row)throw new DomainError("SETTLEMENT_NOT_FOUND","结算申请不存在",404);
    await this.requireCycleApproval(row);
    if(row.state!=="processing"||!row.first_dispatch_started_at)
      throw new DomainError("TRANSFER_CONFIRMATION_UNAVAILABLE","原转账单尚未进入待确认状态",409);
    const binding=this.binding(row);
    const fact=await this.channel.queryTransferByMerchantBillNumber(binding);
    await this.applyQueried(row.id,fact);
    if(fact.state!=="WAIT_USER_CONFIRM"||!fact.packageInfo)
      throw new DomainError("TRANSFER_CONFIRMATION_UNAVAILABLE","原转账单不再需要确认，请刷新状态",409);
    return {requestId:row.id,state:fact.state,appId:binding.appId,mchId:binding.merchantId,
      package:fact.packageInfo,simulation:true};
  }

  private async applyQueried(requestId:string,fact:Awaited<ReturnType<WechatPayV3Client["queryTransferByMerchantBillNumber"]>>,
    leaseToken?:string){
    return transaction(this.pool,async client=>{
      const pre=(await client.query<Row>(`SELECT * FROM commission_settlement_request WHERE id=$1`,
        [requestId])).rows[0];
      if(!pre)return "missing";
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[`settlement-member:${pre.member_id}`]);
      const row=(await client.query<Row>(`SELECT * FROM commission_settlement_request WHERE id=$1 FOR UPDATE`,
        [requestId])).rows[0]!;
      if(leaseToken&&row.lease_token!==leaseToken)
        throw new DomainError("SETTLEMENT_LEASE_LOST","结算租约已经被其他任务接管",409);
      if(["succeeded","failed","cancelled"].includes(row.state))return "already_terminal";
      await this.requireCycleApproval(row,client);
      const allocations=(await client.query<{order_id:string;amount_cents:string}>(`SELECT order_id,
        amount_cents FROM commission_settlement_allocation WHERE request_id=$1 ORDER BY order_id`,
        [row.id])).rows;
      for(const allocation of allocations)await client.query(`SELECT id FROM commerce_order WHERE id=$1 FOR UPDATE`,
        [allocation.order_id]);
      const binding=this.binding(row);
      if(!fact.providerBillNo||!fact.rawSha256||!fact.state)
        throw new DomainError("SETTLEMENT_FACT_INVALID","渠道转账事实无效",409);
      const inserted=(await client.query<{id:string}>(`INSERT INTO commission_transfer_fact(request_id,
        source_kind,raw_sha256,provider_bill_no,state) VALUES($1,'signed_query',$2,$3,$4)
        ON CONFLICT(request_id,raw_sha256) DO NOTHING RETURNING id`,
        [row.id,fact.rawSha256,fact.providerBillNo,fact.state])).rows[0];
      // The exact signed response may repeat; select its immutable fact.
      const factId=inserted?.id??(await client.query<{id:string}>(`SELECT id FROM commission_transfer_fact
        WHERE request_id=$1 AND raw_sha256=$2`,[row.id,fact.rawSha256])).rows[0]!.id;
      const terminal=fact.state==="SUCCESS"||fact.state==="FAIL"||fact.state==="CANCELLED";
      if(fact.state==="SUCCESS"){
        if(allocations.reduce((sum,item)=>sum+Number(item.amount_cents),0)!==Number(row.amount_cents))
          throw new DomainError("SETTLEMENT_ALLOCATION_MISMATCH","预占金额与转账金额不一致",409);
        for(const allocation of allocations)await client.query(`INSERT INTO commission_ledger_entry
          (order_id,referrer_member_id,event_key,kind,amount_cents,source_fact_id,actor_principal_id)
          VALUES($1,$2,$3,'settlement',$4,$5,'worker:transfer-query') ON CONFLICT(event_key) DO NOTHING`,
          [allocation.order_id,row.member_id,`wechat-transfer:${binding.outBillNo}:${allocation.order_id}`,
            allocation.amount_cents,factId]);
      }
      await client.query(`UPDATE commission_settlement_request SET state=$2,channel_state=$3,
        provider_bill_no=$4,package_info=$5,lease_until=NULL,last_error_code=NULL,
        next_attempt_at=clock_timestamp()+interval '1 minute',
        finalized_at=CASE WHEN $6 THEN clock_timestamp() ELSE NULL END,
        version=version+1 WHERE id=$1`,[row.id,fact.state==="SUCCESS"?"succeeded":
          fact.state==="FAIL"?"failed":fact.state==="CANCELLED"?"cancelled":"processing",
          fact.state,fact.providerBillNo,fact.packageInfo,terminal]);
      await client.query(`INSERT INTO audit_log(principal_id,action,object_type,object_id,reason_code,
        after_state,trace_id) VALUES('worker:transfer-query','commission.transfer_fact',
        'commission_settlement_request',$1,$2,$3,$4)`,[row.id,fact.state,
          {amountCents:Number(row.amount_cents),providerBillNo:fact.providerBillNo},
          `transfer-query:${row.id}:${fact.rawSha256.slice(0,16)}`]);
      return fact.state==="SUCCESS"?"succeeded":terminal?"terminal_without_payment":"processing";
    },"SERIALIZABLE");
  }

  async listMine(memberId:string|undefined,query:{limit?:string;cursor?:string}={}){
    return listMemberSettlements(this.pool,memberId,query);
  }

  async pending(actorId:string|undefined,query:{limit?:string;cursor?:string}={}){
    this.gate();await this.authority.require(actorId,"commission.settlement.approve");
    const limit=pageLimit(query.limit),scope=pageScope(["settlement-pending"]),cursor=readPageCursor(query.cursor,scope);
    const totalCount=(await this.pool.query<{n:number}>(`SELECT count(*)::int AS n FROM commission_settlement_request
      WHERE state='requested'`)).rows[0]?.n??0;
    const rows=(await this.pool.query<Row & {cursor_at:string}>(`SELECT *,to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_at
      FROM commission_settlement_request WHERE state='requested'
      AND ($1::timestamptz IS NULL OR (created_at,id)>($1::timestamptz,$2::uuid))
      ORDER BY created_at,id LIMIT $3`,[cursor?.at??null,cursor?.id??null,limit+1])).rows;
    return {...finishPage(rows.map(row=>({...this.view(row),cursorAt:row.cursor_at,
      createdAt:row.created_at})),limit,scope),totalCount};
  }

  async redrive(actorId:string|undefined,requestIdInput:string,input:Record<string,unknown>){
    this.gate();await this.authority.require(actorId,"commission.settlement.approve");
    const requestId=id(requestIdInput),why=reason(input.reason),expectedAttempts=Number(input.expectedAttempts);
    if(!Number.isSafeInteger(expectedAttempts)||expectedAttempts<0)
      throw new DomainError("SETTLEMENT_REDRIVE_VERSION_INVALID","重驱尝试次数无效",422);
    return transaction(this.pool,async client=>{
      await this.authority.requireWithClient(client,actorId,"commission.settlement.approve");
      const row=(await client.query(`UPDATE commission_settlement_request SET quarantined_at=NULL,
        attempt_count=0,next_attempt_at=clock_timestamp(),last_error_code=NULL,lease_until=NULL
        WHERE id=$1 AND state IN ('unknown','processing') AND quarantined_at IS NOT NULL
          AND attempt_count=$2 RETURNING id`,[requestId,expectedAttempts])).rows[0];
      if(!row)throw new DomainError("SETTLEMENT_REDRIVE_CONFLICT","任务状态或次数已变化",409);
      await client.query(`INSERT INTO audit_log(principal_id,action,object_type,object_id,reason_code,
        after_state,trace_id) VALUES($1,'commission.transfer_redrive','commission_settlement_request',
        $2,'AUTHORIZED_REQUERY',$3,$4)`,[`member:${actorId}`,requestId,{reason:why,expectedAttempts},
          `settlement-redrive:${requestId}:${Date.now()}`]);
      return {id:requestId,state:"requery_due"};
    });
  }
}
