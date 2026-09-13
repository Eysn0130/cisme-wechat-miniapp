import type pg from "pg";
import type { AppEnvironment } from "@cisme/config";
import { DomainError } from "@cisme/domain";
import { AuthorityService } from "./authority.js";
import { transaction } from "./db.js";

const monthEnd = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
function period(value: unknown): string {
  if (typeof value !== "string" || !monthEnd.test(value))
    throw new DomainError("SETTLEMENT_CYCLE_PERIOD_INVALID", "请输入自然月最后一天", 422);
  const date = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value ||
    new Date(date.getTime() + 86_400_000).getUTCDate() !== 1)
    throw new DomainError("SETTLEMENT_CYCLE_PERIOD_INVALID", "请输入自然月最后一天", 422);
  return value;
}

type CycleRow = {id:string;cutoff_at:Date;prepared_at:Date;state:string;
  threshold_cents:string;policy_version:string};
type CandidateRow = {member_id:string;order_id:string;gross_cents:string};

/** A non-payable preview persisted on/after the 15th. It deliberately has no
 * approval, reservation, tax default, conversion or transfer endpoint. */
export class SettlementCycleService {
  constructor(private readonly pool:pg.Pool,private readonly authority:AuthorityService,
    private readonly environment:AppEnvironment) {}
  private gate(){
    if (this.environment!=="test" && this.environment!=="development")
      throw new DomainError("SETTLEMENT_CYCLE_POLICY_NOT_APPROVED", "周期结算尚未获得正式政策批准", 503);
  }
  async prepare(actorId:string|undefined,periodEndInput:unknown){
    this.gate();await this.authority.require(actorId,"commission.settlement.approve");
    const periodEnd=period(periodEndInput);
    return transaction(this.pool,async client=>{
      await this.authority.requireWithClient(client,actorId,"commission.settlement.approve");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[`settlement-cycle:${periodEnd}`]);
      const window=(await client.query<{cutoff_at:Date;preparation_at:Date;allowed:boolean}>(`SELECT
        ($1::date + interval '1 day') AT TIME ZONE 'Asia/Shanghai' AS cutoff_at,
        clock_timestamp() AS preparation_at,
        clock_timestamp() >= ($1::date + interval '15 days') AT TIME ZONE 'Asia/Shanghai' AS allowed`,
        [periodEnd])).rows[0]!;
      if(!window.allowed)throw new DomainError("SETTLEMENT_CYCLE_TOO_EARLY",
        "上一自然月的结算候选最早在上海时间本月 15 日准备",409);
      const existing=(await client.query<CycleRow>(`SELECT * FROM commission_settlement_cycle WHERE period_end=$1`,
        [periodEnd])).rows[0];
      if(existing)return this.detailWithClient(client,existing,periodEnd,true);
      const cycle=(await client.query<CycleRow>(`INSERT INTO commission_settlement_cycle
        (period_end,cutoff_at,policy_version,threshold_cents,state,prepared_by_member_id)
        VALUES($1,$2,'engineering-monthly-15-v1',10000,'blocked_tax_and_payout_policy',$3) RETURNING *`,
        [periodEnd,window.cutoff_at,actorId])).rows[0]!;
      // Only releases observed by the previous month's end count. Current
      // reversals/paid entries/holds are subtracted too: a delayed refund may
      // invalidate an otherwise eligible historical source. Disputed sources
      // are excluded individually, not used to freeze the whole member.
      const candidates=(await client.query<CandidateRow>(`WITH source AS (
        SELECT s.order_id,s.referrer_member_id AS member_id,
          COALESCE(sum(e.amount_cents) FILTER (WHERE e.kind IN ('accrual','refund_reversal')),0) AS net,
          COALESCE(sum(e.amount_cents) FILTER (WHERE e.kind='release' AND e.occurred_at<$1),0) AS released_at_cutoff,
          COALESCE(sum(e.amount_cents) FILTER (WHERE e.kind='settlement'),0) AS paid,
          COALESCE(sum(e.amount_cents) FILTER (WHERE e.kind IN
            ('credit_conversion','credit_conversion_reversal')),0) AS converted
        FROM commission_order_snapshot s JOIN commission_ledger_entry e ON e.order_id=s.order_id
          AND e.referrer_member_id=s.referrer_member_id
        WHERE s.source_kind='verified_commerce' AND s.created_at<$1
        GROUP BY s.order_id,s.referrer_member_id
      ), holds AS (
        SELECT a.order_id,COALESCE(sum(a.amount_cents),0) AS held
        FROM commission_settlement_allocation a JOIN commission_settlement_request r ON r.id=a.request_id
        WHERE r.state IN ('reserved','unknown','processing') GROUP BY a.order_id
      ), available AS (
        SELECT source.member_id,source.order_id,
          GREATEST(0,LEAST(source.net,source.released_at_cutoff)-source.paid-source.converted-
            COALESCE(holds.held,0)) AS gross_cents
        FROM source LEFT JOIN holds ON holds.order_id=source.order_id
        WHERE NOT EXISTS (SELECT 1 FROM commission_payment_composition_observation c
          WHERE c.order_id=source.order_id)
          AND NOT EXISTS (SELECT 1 FROM commerce_refund_request r
          LEFT JOIN commission_refund_intent i ON i.request_id=r.id
          WHERE r.order_id=source.order_id AND
            (r.state='requested' OR r.state='approved' AND (i.id IS NULL OR i.state IN ('prepared','abnormal'))))
      ), qualified AS (
        SELECT member_id,order_id,gross_cents,
          sum(gross_cents) OVER (PARTITION BY member_id) AS member_gross
        FROM available WHERE gross_cents>0
      ) SELECT member_id,order_id,gross_cents::text FROM qualified
        WHERE member_gross>=10000
        ORDER BY member_id,order_id`,[window.cutoff_at])).rows;
      for(const row of candidates){
        const cents=Number(row.gross_cents);
        if(!Number.isSafeInteger(cents)||cents>9_900_000_000)
          throw new DomainError("COMMISSION_LEDGER_INVARIANT","周期候选金额需要人工核对",409);
        await client.query(`INSERT INTO commission_settlement_cycle_candidate
          (cycle_id,member_id,order_id,gross_cents) VALUES($1,$2,$3,$4)`,
          [cycle.id,row.member_id,row.order_id,cents]);
      }
      await client.query(`INSERT INTO audit_log(principal_id,action,object_type,object_id,reason_code,after_state,trace_id)
        VALUES($1,'commission.cycle_candidate_prepared','commission_settlement_cycle',$2,
          'NON_PAYABLE_ENGINEERING_SNAPSHOT',$3,$4)`, [`member:${actorId}`,cycle.id,
          {periodEnd,candidateOrderCount:candidates.length,withholdingPolicyVersion:null},`cycle:${cycle.id}`]);
      return this.detailWithClient(client,cycle,periodEnd,false);
    },"SERIALIZABLE");
  }
  private async detailWithClient(client:pg.PoolClient,cycle:CycleRow,periodEnd:string,replay:boolean){
    const rows=(await client.query<{member_id:string;gross_cents:string;order_count:number}>(`SELECT
      member_id,sum(gross_cents)::text AS gross_cents,count(*)::int AS order_count
      FROM commission_settlement_cycle_candidate WHERE cycle_id=$1 GROUP BY member_id ORDER BY member_id`,
      [cycle.id])).rows;
    return {id:cycle.id,periodEnd,cutoffAt:cycle.cutoff_at,
      preparedAt:cycle.prepared_at,policyVersion:cycle.policy_version,
      thresholdCents:Number(cycle.threshold_cents),state:cycle.state,
      payable:false,withholdingPolicyVersion:null,netCents:null,replay,
      members:rows.map(row=>({memberId:row.member_id,grossCents:Number(row.gross_cents),
        orderCount:row.order_count,withholdingCents:null,netCents:null}))};
  }
}
