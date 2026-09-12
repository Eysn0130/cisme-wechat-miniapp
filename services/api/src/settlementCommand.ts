import { createHash } from "node:crypto";
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
  created_at:Date;attempt_count:number};
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
    private readonly options:{appId:string;merchantId:string;sceneId:string;notifyUrl:string}){}
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
          const unresolved=(await client.query<{n:number}>(`SELECT count(*)::int AS n FROM commerce_refund_request r
            LEFT JOIN commission_refund_intent i ON i.request_id=r.id WHERE r.order_id=$1 AND
            (r.state='requested' OR (r.state='approved' AND i.state IN ('prepared','abnormal')))`,[order_id])).rows[0]?.n??0;
          if(unresolved)throw new DomainError("SETTLEMENT_REFUND_UNRESOLVED","关联订单仍有待决或在途退款",409);
          const entries=ledger.filter(entry=>entry.order_id===order_id),sum=(kind:string)=>
            entries.filter(entry=>entry.kind===kind).reduce((n,entry)=>n+Number(entry.amount_cents),0);
          const accrued=sum("accrual"),net=accrued+sum("refund_reversal"),released=sum("release"),
            settled=sum("settlement"),heldCents=holdMap.get(order_id)??0;
          if(![accrued,net,released,settled,heldCents].every(Number.isSafeInteger)||
            net<0||released>accrued||settled>released)
            throw new DomainError("COMMISSION_LEDGER_INVARIANT","佣金账本需先核对",409);
          const available=Math.max(0,Math.min(net,released)-settled-heldCents),take=Math.min(remaining,available);
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

  private view(row:Row){return {id:row.id,memberId:row.member_id,amountCents:Number(row.amount_cents),
    state:row.state,version:row.version,outBillNo:row.out_bill_no,channelState:undefined};}
  private binding(row:Row):TransferBinding{
    if(!row.out_bill_no||!row.payee_openid||row.app_id!==this.options.appId||
      row.merchant_id!==this.options.merchantId||row.scene_id!==this.options.sceneId||
      !row.transfer_remark)throw new DomainError("SETTLEMENT_BINDING_INVALID","转账意图绑定不完整",409);
    return {appId:row.app_id,merchantId:row.merchant_id,outBillNo:row.out_bill_no,
      payeeOpenid:row.payee_openid,amountCents:amount(row.amount_cents),sceneId:row.scene_id,
      remark:row.transfer_remark,notifyUrl:this.options.notifyUrl};
  }

  private async allocationStillEarned(client:pg.PoolClient,row:Row){
    const allocations=(await client.query<{order_id:string;amount_cents:string}>(
      `SELECT order_id,amount_cents FROM commission_settlement_allocation WHERE request_id=$1 ORDER BY order_id`,
      [row.id])).rows;
    if(allocations.reduce((sum,item)=>sum+Number(item.amount_cents),0)!==Number(row.amount_cents))return false;
    for(const allocation of allocations){
      await client.query(`SELECT id FROM commerce_order WHERE id=$1 FOR UPDATE`,[allocation.order_id]);
      const unresolved=(await client.query<{n:number}>(`SELECT count(*)::int AS n FROM commerce_refund_request r
        LEFT JOIN commission_refund_intent i ON i.request_id=r.id WHERE r.order_id=$1 AND
        (r.state='requested' OR (r.state='approved' AND i.state IN ('prepared','abnormal')))`,
        [allocation.order_id])).rows[0]?.n??0;
      if(unresolved)return false;
      const sums=(await client.query<{net:string;released:string;settled:string}>(`SELECT
        COALESCE(sum(amount_cents) FILTER (WHERE kind IN ('accrual','refund_reversal')),0)::text AS net,
        COALESCE(sum(amount_cents) FILTER (WHERE kind='release'),0)::text AS released,
        COALESCE(sum(amount_cents) FILTER (WHERE kind='settlement'),0)::text AS settled
        FROM commission_ledger_entry WHERE order_id=$1 AND referrer_member_id=$2`,
        [allocation.order_id,row.member_id])).rows[0]!;
      const available=Math.min(Number(sums.net),Number(sums.released))-Number(sums.settled);
      if(!Number.isSafeInteger(available)||available<Number(allocation.amount_cents))return false;
    }
    return true;
  }

  async processDue(limit=20){
    this.gate();
    const claimed=(await this.pool.query<{id:string}>(`WITH due AS (
      SELECT id FROM commission_settlement_request WHERE state IN ('reserved','unknown','processing')
        AND quarantined_at IS NULL AND next_attempt_at<=clock_timestamp()
        AND (lease_until IS NULL OR lease_until<clock_timestamp())
      ORDER BY next_attempt_at,id LIMIT $1 FOR UPDATE SKIP LOCKED
    ) UPDATE commission_settlement_request r SET state=CASE WHEN r.state='reserved' THEN 'unknown' ELSE r.state END,
      lease_until=clock_timestamp()+interval '30 seconds' FROM due WHERE r.id=due.id RETURNING r.id`,
      [limit])).rows;
    const results:{id:string;state:string}[]=[];
    for(const {id:targetId} of claimed){
      try{results.push({id:targetId,state:await this.processOne(targetId)});}
      catch(error){
        const code=error instanceof DomainError&&/^[A-Z0-9_]{3,80}$/.test(error.code)?error.code:
          "CHANNEL_UNAVAILABLE";
        await this.pool.query(`UPDATE commission_settlement_request SET lease_until=NULL,
          attempt_count=LEAST(1000,attempt_count+1),last_error_code=$2,
          next_attempt_at=clock_timestamp()+
            (LEAST(1800000,5000*POWER(2,LEAST(8,attempt_count)))::integer*interval '1 millisecond'),
          quarantined_at=CASE WHEN attempt_count>=7 THEN clock_timestamp() ELSE NULL END
          WHERE id=$1 AND state IN ('unknown','processing')`,[targetId,code]);
        results.push({id:targetId,state:"retry_scheduled"});
      }
    }
    return results;
  }

  async processOne(requestId:string){
    const row=(await this.pool.query<Row>(`SELECT * FROM commission_settlement_request WHERE id=$1`,
      [id(requestId)])).rows[0];
    if(!row||!["unknown","processing"].includes(row.state))
      throw new DomainError("SETTLEMENT_NOT_DUE","结算转账任务不在待处理状态",409);
    const binding=this.binding(row);
    let queried;
    try{queried=await this.channel.queryTransferByMerchantBillNumber(binding);}
    catch(error){
      if(!(error instanceof DomainError&&error.code==="WECHAT_TRANSFER_NOT_FOUND"))throw error;
      if(row.state==="processing"||Date.now()-new Date(row.created_at).getTime()>29*86400_000)
        throw new DomainError("SETTLEMENT_ORIGINAL_QUERY_REQUIRED","原单状态尚不明确，暂停重发",409);
      return transaction(this.pool,async client=>{
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[`settlement-member:${row.member_id}`]);
        const locked=(await client.query<Row>(`SELECT * FROM commission_settlement_request WHERE id=$1 FOR UPDATE`,
          [row.id])).rows[0];
        if(!locked||locked.state!=="unknown")throw new DomainError("SETTLEMENT_NOT_DUE","结算状态已变化",409);
        if(!await this.allocationStillEarned(client,locked)){
          // After an earlier outbound attempt, NOT_FOUND may be transient. Keep
          // the hold for operator requery instead of declaring it unpaid.
          if(locked.attempt_count>0)throw new DomainError("SETTLEMENT_REQUERY_REQUIRED","已尝试发起的原单需人工复核",409);
          await client.query(`UPDATE commission_settlement_request SET state='cancelled',lease_until=NULL,
            last_error_code='SETTLEMENT_ALLOCATION_INVALID',finalized_at=clock_timestamp(),version=version+1
            WHERE id=$1`,[locked.id]);
          await client.query(`INSERT INTO audit_log(principal_id,action,object_type,object_id,reason_code,
            after_state,trace_id) VALUES('worker:transfer-query','commission.transfer_cancelled',
            'commission_settlement_request',$1,'SETTLEMENT_ALLOCATION_INVALID',$2,$3)`,
            [locked.id,{amountCents:Number(locked.amount_cents)},`settlement-invalid:${locked.id}`]);
          return "cancelled_invalid_allocation";
        }
        // Order locks span the final check and bounded outbound call; refund
        // requests and decisions take the same locks before changing exposure.
        await this.channel.createTransfer(this.binding(locked));
        // Creation response is never booked as paid, even if it says SUCCESS.
        await client.query(`UPDATE commission_settlement_request SET state='processing',lease_until=NULL,
          next_attempt_at=clock_timestamp()+interval '1 minute',last_error_code=NULL
          WHERE id=$1 AND state='unknown'`,[locked.id]);
        return "submitted_query_due";
      },"READ COMMITTED",1,10_000);
    }
    return this.applyQueried(row.id,queried);
  }

  async confirmCallback(requestId:string){
    this.gate();
    const row=(await this.pool.query<Row>(`SELECT * FROM commission_settlement_request WHERE id=$1`,
      [id(requestId)])).rows[0];
    if(!row)throw new DomainError("SETTLEMENT_NOT_FOUND","结算申请不存在",404);
    const fact=await this.channel.queryTransferByMerchantBillNumber(this.binding(row));
    await this.applyQueried(row.id,fact);
    return {state:fact.state,providerBillNo:fact.providerBillNo};
  }

  private async applyQueried(requestId:string,fact:Awaited<ReturnType<WechatPayV3Client["queryTransferByMerchantBillNumber"]>>){
    return transaction(this.pool,async client=>{
      const pre=(await client.query<Row>(`SELECT * FROM commission_settlement_request WHERE id=$1`,
        [requestId])).rows[0];
      if(!pre)return "missing";
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[`settlement-member:${pre.member_id}`]);
      const row=(await client.query<Row>(`SELECT * FROM commission_settlement_request WHERE id=$1 FOR UPDATE`,
        [requestId])).rows[0]!;
      if(["succeeded","failed","cancelled"].includes(row.state))return "already_terminal";
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
    this.gate();if(!memberId)throw new DomainError("AUTH_REQUIRED","请先登录后继续",401);
    const limit=pageLimit(query.limit),scope=pageScope(["settlement-mine",memberId]),cursor=readPageCursor(query.cursor,scope);
    const totalCount=(await this.pool.query<{n:number}>(`SELECT count(*)::int AS n FROM commission_settlement_request
      WHERE member_id=$1`,[memberId])).rows[0]?.n??0;
    const rows=(await this.pool.query<Row>(`SELECT * FROM commission_settlement_request WHERE member_id=$1
      AND ($2::timestamptz IS NULL OR (created_at,id)<($2::timestamptz,$3::uuid))
      ORDER BY created_at DESC,id DESC LIMIT $4`,[memberId,cursor?.at??null,cursor?.id??null,limit+1])).rows;
    return {...finishPage(rows.map(row=>({...this.view(row),cursorAt:new Date(row.created_at).toISOString(),
      channelState:(row as Row&{channel_state:string|null}).channel_state??null,
      packageInfo:(row as Row&{package_info:string|null}).package_info??null,
      createdAt:row.created_at})),limit,scope),totalCount};
  }

  async pending(actorId:string|undefined,query:{limit?:string;cursor?:string}={}){
    this.gate();await this.authority.require(actorId,"commission.settlement.approve");
    const limit=pageLimit(query.limit),scope=pageScope(["settlement-pending"]),cursor=readPageCursor(query.cursor,scope);
    const totalCount=(await this.pool.query<{n:number}>(`SELECT count(*)::int AS n FROM commission_settlement_request
      WHERE state='requested'`)).rows[0]?.n??0;
    const rows=(await this.pool.query<Row>(`SELECT * FROM commission_settlement_request WHERE state='requested'
      AND ($1::timestamptz IS NULL OR (created_at,id)>($1::timestamptz,$2::uuid))
      ORDER BY created_at,id LIMIT $3`,[cursor?.at??null,cursor?.id??null,limit+1])).rows;
    return {...finishPage(rows.map(row=>({...this.view(row),cursorAt:new Date(row.created_at).toISOString(),
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
