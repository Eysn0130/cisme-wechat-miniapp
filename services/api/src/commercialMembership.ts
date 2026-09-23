import { createHash, randomBytes } from "node:crypto";
import type pg from "pg";
import { DomainError } from "@cisme/domain";
import { transaction, type DbClient } from "./db.js";
import { AuthorityService } from "./authority.js";
import { commissionOrderBuckets } from "./commissionPolicy.js";
import type { AppConfig } from "@cisme/config";
import { finishPage, pageLimit, pageScope, readPageCursor } from "./keysetPage.js";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const codePattern = /^CM[A-HJ-NP-Z2-9]{10}$/;
const codeAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const engineeringMembershipMonths=12;
const nextShanghaiMidnight="(date_trunc('day',clock_timestamp() AT TIME ZONE 'Asia/Shanghai')+interval '1 day') AT TIME ZONE 'Asia/Shanghai'";
function member(id: string | undefined): string {
  if (!id) throw new DomainError("AUTH_REQUIRED", "请先登录后继续", 401);
  return id;
}
function identifier(value: unknown): string {
  if (typeof value !== "string" || !uuid.test(value)) throw new DomainError("MEMBER_ID_INVALID", "会员编号无效", 422);
  return value;
}
function reason(value: unknown): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (text.length < 4 || text.length > 300) throw new DomainError("REASON_INVALID", "请填写 4–300 字的变更依据", 422);
  return text;
}
function codeValue(): string {
  const bytes = randomBytes(10);
  return `CM${Array.from(bytes, byte => codeAlphabet[byte! % codeAlphabet.length]).join("")}`;
}
function rate(value: unknown): number {
  if (!Number.isInteger(value) || ![2000,2500,3000,3500].includes(Number(value))) {
    throw new DomainError("COMMISSION_RATE_INVALID", "新费率仅支持 20%、25%、30%、35%", 422);
  }
  return Number(value);
}
function commandKey(value:unknown):string{
  if(typeof value!=="string"||!/^[A-Za-z0-9._:-]{8,200}$/.test(value))
    throw new DomainError("RATE_REQUEST_KEY_INVALID","费率提议编号无效",422);
  return value;
}

export class CommercialMembershipService {
  constructor(private readonly pool: pg.Pool, private readonly authority: AuthorityService,
    private readonly environment:AppConfig["env"]) {}

  private requireEngineeringRules(){
    if(this.environment!=="test"&&this.environment!=="development")
      throw new DomainError("COMMERCIAL_RULES_NOT_APPROVED","商业资格与推荐规则尚未正式启用",503);
  }

  private async balanceFor(referrerId:string){
    const rows=(await this.pool.query(`SELECT l.order_id,l.accrued,l.reversed,l.released,l.paid,l.converted,
      COALESCE(h.held,0)::text AS held FROM (
        SELECT order_id,
          COALESCE(sum(amount_cents) FILTER(WHERE kind='accrual'),0)::text AS accrued,
          COALESCE(-sum(amount_cents) FILTER(WHERE kind='refund_reversal'),0)::text AS reversed,
          COALESCE(sum(amount_cents) FILTER(WHERE kind='release'),0)::text AS released,
          COALESCE(sum(amount_cents) FILTER(WHERE kind='settlement'),0)::text AS paid,
          COALESCE(sum(amount_cents) FILTER(WHERE kind IN
            ('credit_conversion','credit_conversion_reversal')),0)::text AS converted
        FROM commission_ledger_entry WHERE referrer_member_id=$1 GROUP BY order_id
      ) l LEFT JOIN (
        SELECT a.order_id,sum(a.amount_cents) AS held FROM commission_settlement_allocation a
        JOIN commission_settlement_request r ON r.id=a.request_id WHERE r.member_id=$1
          AND r.state IN ('reserved','unknown','processing') GROUP BY a.order_id
      ) h ON h.order_id=l.order_id`,[referrerId])).rows;
    return commissionOrderBuckets(rows.map(row=>({accruedCents:Number(row.accrued),
      reversedCents:Number(row.reversed),releasedCents:Number(row.released),
      paidCents:Number(row.paid),heldCents:Number(row.held),convertedCents:Number(row.converted)})));
  }

  async myStatus(memberId: string | undefined) {
    const owner = member(memberId);
    const [status,balance] = await Promise.all([this.pool.query(`SELECT m.state,m.effective_at,m.expires_at,m.version,c.code,c.state AS code_state,a.status AS account_status,
      (a.status='active' AND m.state='active' AND m.effective_at<=now() AND (m.expires_at IS NULL OR m.expires_at>now())) AS eligible_now,
      (SELECT count(*)::int FROM commercial_referral_relation r WHERE r.referrer_member_id=$1) AS direct_referral_count,
      (SELECT count(*)::int FROM commission_order_snapshot s JOIN commerce_order o ON o.id=s.order_id
        WHERE s.referrer_member_id=$1 AND s.source_kind='verified_commerce' AND o.status='paid'
          AND EXISTS(SELECT 1 FROM commission_payment_inbox p WHERE p.order_id=o.id AND p.state='applied')) AS verified_order_count
      FROM commercial_membership m JOIN member a ON a.id=m.member_id LEFT JOIN commercial_referral_code c ON c.member_id=m.member_id WHERE m.member_id=$1`, [owner]),
      this.balanceFor(owner)]);
    const row = status.rows[0];
    const eligible = Boolean((this.environment==="test"||this.environment==="development") && row?.eligible_now===true);
    return { version: 1, eligible, membershipState: row?.state ?? "none", effectiveAt: row?.effective_at ?? null,
      expiresAt: row?.expires_at ?? null, referralCode: eligible && row.code_state === "active" ? row.code : null,
      referralCodeDisabled:row?.code_state === "disabled",
      directReferralCount: Number(row?.direct_referral_count ?? 0), verifiedOrderCount: Number(row?.verified_order_count ?? 0),
      commission: { ...balance, currency: "CNY", settlementAvailable: false },
      paymentAvailable: false };
  }

  async ensureCode(memberId: string | undefined) {
    this.requireEngineeringRules();
    const owner = member(memberId);
    return transaction(this.pool, async client => {
      const m = (await client.query(`SELECT m.state,m.effective_at,m.expires_at,a.status AS account_status,
        (m.effective_at<=clock_timestamp() AND (m.expires_at IS NULL OR m.expires_at>clock_timestamp())) AS eligible_now
        FROM commercial_membership m JOIN member a ON a.id=m.member_id WHERE m.member_id=$1 FOR UPDATE OF m`, [owner])).rows[0];
      if (!m || m.account_status !== "active" || m.state !== "active" || m.eligible_now!==true)
        throw new DomainError("COMMERCIAL_MEMBERSHIP_REQUIRED", "当前账号尚无有效推荐资格", 403);
      const existing = (await client.query("SELECT code,state FROM commercial_referral_code WHERE member_id=$1", [owner])).rows[0];
      if (existing) {
        if (existing.state !== "active") throw new DomainError("REFERRAL_CODE_DISABLED", "推荐码已停用，请联系平台", 409);
        return { code: existing.code, stable: true };
      }
      for (let attempt=0;attempt<5;attempt+=1) {
        const code = codeValue();
        const result = await client.query<{code:string}>(`INSERT INTO commercial_referral_code(member_id,code) VALUES($1,$2)
          ON CONFLICT DO NOTHING RETURNING code`, [owner,code]);
        if (result.rows[0]) {
          await client.query(`INSERT INTO audit_log(principal_id,action,object_type,object_id,reason_code,trace_id)
            VALUES($1,'commercial.referral_code_created','member',$2,'MEMBER_REQUEST',gen_random_uuid()::text)`,[`member:${owner}`,owner]);
          return { code: result.rows[0].code, stable: true };
        }
      }
      throw new DomainError("REFERRAL_CODE_RETRY", "推荐码暂未生成，请稍后重试", 503);
    });
  }

  async confirmReferral(memberId: string | undefined, principalId: string | undefined, codeInput: unknown, confirmationKey: unknown) {
    this.requireEngineeringRules();
    const buyer = member(memberId);
    const code = typeof codeInput === "string" ? codeInput.trim().toUpperCase() : "";
    const key = typeof confirmationKey === "string" ? confirmationKey.trim() : "";
    if (!codePattern.test(code) || !/^[A-Za-z0-9._:-]{8,200}$/.test(key)) throw new DomainError("REFERRAL_CONFIRMATION_INVALID", "推荐码或确认编号无效", 422);
    if (!principalId) throw new DomainError("AUTH_REQUIRED", "请重新登录后确认", 401);
    return transaction(this.pool, async client => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`referral:${buyer}`]);
      const already = (await client.query(`SELECT r.referrer_member_id,c.code FROM commercial_referral_relation r
        JOIN commercial_referral_code c ON c.id=r.referral_code_id WHERE r.referred_member_id=$1`, [buyer])).rows[0];
      if (already) {
        if (already.code !== code) throw new DomainError("REFERRAL_ALREADY_BOUND", "已确认过推荐关系，不能重复绑定", 409);
        return { confirmed: true, alreadyConfirmed: true, code };
      }
      const sponsor = (await client.query(`SELECT c.id,c.member_id,c.state,m.state AS membership_state,
        (m.effective_at<=clock_timestamp() AND (m.expires_at IS NULL OR m.expires_at>clock_timestamp())) AS eligible_now,
        a.status AS account_status
        FROM commercial_referral_code c JOIN commercial_membership m ON m.member_id=c.member_id
        JOIN member a ON a.id=c.member_id WHERE c.code=$1 FOR SHARE OF c,m,a`, [code])).rows[0];
      if (!sponsor || sponsor.state !== "active" || sponsor.membership_state !== "active" || sponsor.account_status !== "active"
        || sponsor.eligible_now !== true)
        throw new DomainError("REFERRAL_CODE_UNAVAILABLE", "推荐码无效或已停用", 409);
      if (sponsor.member_id === buyer) throw new DomainError("REFERRAL_SELF_FORBIDDEN", "不能确认自己的推荐码", 422);
      await client.query(`INSERT INTO commercial_referral_relation(referred_member_id,referrer_member_id,referral_code_id,confirmation_key,confirmed_by,confirmed_at)
        VALUES($1,$2,$3,$4,$5,clock_timestamp())`, [buyer,sponsor.member_id,sponsor.id,key,principalId]);
      await client.query(`INSERT INTO audit_log(principal_id,action,object_type,object_id,reason_code,after_state,trace_id)
        VALUES($1,'commercial.referral_confirmed','member',$2,'USER_CONFIRMED_DIRECT_RELATION',$3,$4)`,
        [principalId,buyer,{ referrerMemberId:sponsor.member_id,referralCodeId:sponsor.id },key]);
      return { confirmed:true, alreadyConfirmed:false, code };
    });
  }

  async previewReferral(memberId:string|undefined,codeInput:unknown){
    this.requireEngineeringRules();
    const buyer=member(memberId),code=typeof codeInput==="string"?codeInput.trim().toUpperCase():"";
    if(!codePattern.test(code))throw new DomainError("REFERRAL_CODE_INVALID","推荐码格式无效",422);
    const row=(await this.pool.query(`SELECT c.code,c.member_id,now() AS verified_at,
      (c.state='active' AND m.state='active' AND m.effective_at<=now()
        AND (m.expires_at IS NULL OR m.expires_at>now()) AND a.status='active') AS eligible_now,
      CASE WHEN profile.community_visible AND profile.public_status='approved' THEN a.display_name ELSE NULL END AS public_name,
      (SELECT r.referrer_member_id FROM commercial_referral_relation r WHERE r.referred_member_id=$2) AS current_referrer
      FROM commercial_referral_code c JOIN commercial_membership m ON m.member_id=c.member_id
      JOIN member a ON a.id=c.member_id LEFT JOIN member_profile profile ON profile.member_id=a.id
      WHERE c.code=$1`,[code,buyer])).rows[0];
    if(!row||!row.eligible_now)throw new DomainError("REFERRAL_CODE_UNAVAILABLE","推荐码无效或已停用",404);
    if(row.member_id===buyer)throw new DomainError("REFERRAL_SELF_FORBIDDEN","不能确认自己的推荐码",422);
    return {code,sponsorLabel:row.public_name??`CISME 商业会员 · ${code.slice(-4)}`,
      relationState:row.current_referrer?row.current_referrer===row.member_id?"already_bound_same":"already_bound_other":"unbound",
      attributionLevel:1,confirmationRequired:true,verifiedAt:row.verified_at};
  }

  async snapshotOrder(client: DbClient, orderId: string, buyerId: string, sourceKind: "synthetic_nonproduction" | "verified_commerce", cashMerchandiseCents: number, _requestedAt: Date) {
    // Relation/qualification timestamps are written by PostgreSQL. Compare
    // them with the same clock so a small API/DB clock skew cannot drop a
    // confirmed referral from the next order's immutable snapshot.
    const effectiveNow=(await client.query<{at:Date}>("SELECT clock_timestamp() AS at")).rows[0]!.at;
    const result = await client.query(`INSERT INTO commission_order_snapshot(order_id,buyer_member_id,referrer_member_id,referral_code_id,rate_rule_id,
      basis_points,cash_merchandise_cents,source_kind)
      SELECT $1,$2,r.referrer_member_id,r.referral_code_id,rate.id,rate.basis_points,$3,$4
      FROM commercial_referral_relation r JOIN commercial_membership m ON m.member_id=r.referrer_member_id
      JOIN commercial_referral_code c ON c.id=r.referral_code_id
      JOIN member sponsor ON sponsor.id=r.referrer_member_id
      LEFT JOIN LATERAL (SELECT id,action,basis_points FROM commission_rate_rule
        WHERE state='active' AND effective_at<=$5 AND member_id=r.referrer_member_id
          AND ($6::boolean OR created_by<>'migration')
        ORDER BY effective_at DESC,created_at DESC,id DESC LIMIT 1) member_rate ON true
      LEFT JOIN LATERAL (SELECT id,basis_points FROM commission_rate_rule
        WHERE state='active' AND effective_at<=$5 AND member_id IS NULL
          AND ($6::boolean OR created_by<>'migration')
        ORDER BY effective_at DESC,created_at DESC,id DESC LIMIT 1) global_rate ON true
      JOIN LATERAL (SELECT CASE WHEN member_rate.action='override' THEN member_rate.id ELSE global_rate.id END AS id,
        CASE WHEN member_rate.action='override' THEN member_rate.basis_points ELSE global_rate.basis_points END AS basis_points) rate
        ON rate.id IS NOT NULL
      WHERE r.referred_member_id=$2 AND r.confirmed_at<=$5 AND r.referrer_member_id<>$2
        AND NOT EXISTS (SELECT 1 FROM commercial_membership buyer_membership
          WHERE buyer_membership.member_id=$2 AND buyer_membership.state='active'
            AND buyer_membership.effective_at<=$5
            AND (buyer_membership.expires_at IS NULL OR buyer_membership.expires_at>$5))
        AND m.state='active' AND m.effective_at<=$5 AND (m.expires_at IS NULL OR m.expires_at>$5)
        AND c.state='active' AND sponsor.status='active'
      ON CONFLICT(order_id) DO NOTHING RETURNING order_id,basis_points,source_kind`,
      [orderId,buyerId,cashMerchandiseCents,sourceKind,effectiveNow,
        this.environment==='test'||this.environment==='development']);
    return result.rows[0] ?? null;
  }

  async listMembers(actorId: string | undefined, input: { q?: unknown; filter?: unknown; limit?: unknown; cursor?:unknown }) {
    await this.authority.require(actorId,"member.profile.read");
    const canReadCommission=await this.authority.has(actorId,"commission.read");
    const q = typeof input.q === "string" ? input.q.trim().slice(0,60) : "";
    const filter = input.filter === "members" || input.filter === "ordinary" ? input.filter : "all";
    const limit=pageLimit(input.limit),scope=pageScope(["members",q,filter,canReadCommission]),cursor=readPageCursor(input.cursor,scope);
    const rows = await this.pool.query(`SELECT a.id,a.display_name,a.status,a.created_at,a.created_at::text AS cursor_at,m.state AS membership_state,m.expires_at,
      (a.status='active' AND m.state='active' AND m.effective_at<=now()
        AND (m.expires_at IS NULL OR m.expires_at>now())) AS commercial_eligible,
      CASE WHEN $4::boolean THEN c.code ELSE NULL END AS code,
      CASE WHEN $4::boolean THEN c.state ELSE NULL END AS code_state,
      CASE WHEN $4::boolean THEN COALESCE(r.direct_count,0)::int ELSE NULL END AS direct_referral_count
      FROM member a LEFT JOIN commercial_membership m ON m.member_id=a.id
      LEFT JOIN commercial_referral_code c ON c.member_id=a.id
      LEFT JOIN LATERAL (SELECT count(*) AS direct_count FROM commercial_referral_relation WHERE referrer_member_id=a.id) r ON true
      WHERE a.status<>'deleted' AND ($1='' OR a.display_name ILIKE '%'||$1||'%' OR a.id::text ILIKE $1||'%' OR ($4::boolean AND c.code ILIKE $1||'%'))
        AND ($2='all' OR ($2='members' AND a.status='active' AND m.state='active' AND m.effective_at<=now() AND (m.expires_at IS NULL OR m.expires_at>now()))
          OR ($2='ordinary' AND NOT COALESCE(a.status='active' AND m.state='active' AND m.effective_at<=now()
            AND (m.expires_at IS NULL OR m.expires_at>now()),false)))
        AND ($5::timestamptz IS NULL OR (a.created_at,a.id)<($5::timestamptz,$6::uuid))
      ORDER BY a.created_at DESC,a.id DESC LIMIT $3`, [q,filter,limit+1,canReadCommission,cursor?.at??null,cursor?.id??null]);
    const matching=await this.pool.query(`SELECT count(*)::int AS total
      FROM member a LEFT JOIN commercial_membership m ON m.member_id=a.id
      LEFT JOIN commercial_referral_code c ON c.member_id=a.id
      WHERE a.status<>'deleted' AND ($1='' OR a.display_name ILIKE '%'||$1||'%' OR a.id::text ILIKE $1||'%' OR ($3::boolean AND c.code ILIKE $1||'%'))
        AND ($2='all' OR ($2='members' AND a.status='active' AND m.state='active' AND m.effective_at<=now() AND (m.expires_at IS NULL OR m.expires_at>now()))
          OR ($2='ordinary' AND NOT COALESCE(a.status='active' AND m.state='active' AND m.effective_at<=now()
            AND (m.expires_at IS NULL OR m.expires_at>now()),false)))`,[q,filter,canReadCommission]);
    const totals = await this.pool.query(`SELECT count(*)::int AS all_count,
      count(*) FILTER(WHERE a.status='active' AND m.state='active' AND m.effective_at<=now() AND (m.expires_at IS NULL OR m.expires_at>now()))::int AS member_count
      FROM member a LEFT JOIN commercial_membership m ON m.member_id=a.id WHERE a.status<>'deleted'`);
    const page=finishPage(rows.rows.map(row => ({ id:row.id,cursorAt:row.cursor_at, displayName:row.display_name, accountStatus:row.status,
      membershipState:row.membership_state ?? "none",commercialEligible:row.commercial_eligible===true,
      expiresAt:row.expires_at, referralCode:row.code_state==="active"?row.code:null,
      ...(canReadCommission?{directReferralCount:row.direct_referral_count}:{})})),limit,scope);
    return { ...page,items:page.items.map(({cursorAt:_,...item})=>item),matchingTotal:matching.rows[0]?.total??0,
      summary:{ all:totals.rows[0]?.all_count ?? 0,members:totals.rows[0]?.member_count ?? 0,
      ordinary:(totals.rows[0]?.all_count ?? 0)-(totals.rows[0]?.member_count ?? 0) } };
  }

  async memberDetail(actorId: string | undefined, memberId: string) {
    await this.authority.require(actorId,"member.profile.read");
    const [canReadCommission,canReadOrders]=await Promise.all([
      this.authority.has(actorId,"commission.read"),this.authority.has(actorId,"commerce.order.read")]);
    const id = identifier(memberId);
    const person = (await this.pool.query(`SELECT a.id,a.display_name,a.status,a.created_at,m.state AS membership_state,m.effective_at,m.expires_at,m.version,
      now() AS server_time,${nextShanghaiMidnight} AS rate_proposal_suggested_at,
      CASE WHEN m.member_id IS NOT NULL AND m.expires_at IS NULL THEN NULL ELSE
        ((GREATEST(COALESCE(m.expires_at,now()),now()) AT TIME ZONE 'Asia/Shanghai')+
          make_interval(months=>$3::int)) AT TIME ZONE 'Asia/Shanghai' END AS renewal_expires_at,
      (a.status='active' AND m.state='active' AND m.effective_at<=now()
        AND (m.expires_at IS NULL OR m.expires_at>now())) AS commercial_eligible,
      CASE WHEN $2::boolean THEN c.code ELSE NULL END AS code,
      CASE WHEN $2::boolean THEN c.state ELSE NULL END AS code_state
      FROM member a LEFT JOIN commercial_membership m ON m.member_id=a.id
      LEFT JOIN commercial_referral_code c ON c.member_id=a.id WHERE a.id=$1`, [id,canReadCommission,engineeringMembershipMonths])).rows[0];
    if (!person || person.status==="deleted") throw new DomainError("MEMBER_NOT_FOUND", "成员不存在", 404);
    const [rateRule,balance] = await Promise.all([
      canReadCommission?this.pool.query(`SELECT CASE WHEN member_rate.action='override' THEN member_rate.id ELSE global_rate.id END AS id,
        CASE WHEN member_rate.action='override' THEN member_rate.basis_points ELSE global_rate.basis_points END AS basis_points,
        CASE WHEN member_rate.action='override' THEN member_rate.effective_at ELSE global_rate.effective_at END AS effective_at,
        CASE WHEN member_rate.action='override' THEN 'member_override' ELSE 'global' END AS source,
        member_rate.action AS member_action,member_rate.effective_at AS member_action_effective_at
        FROM (SELECT 1) seed
        LEFT JOIN LATERAL (SELECT id,action,basis_points,effective_at FROM commission_rate_rule
          WHERE member_id=$1 AND state='active' AND effective_at<=now()
            AND ($2::boolean OR created_by<>'migration')
          ORDER BY effective_at DESC,created_at DESC,id DESC LIMIT 1) member_rate ON true
        LEFT JOIN LATERAL (SELECT id,basis_points,effective_at FROM commission_rate_rule
          WHERE member_id IS NULL AND state='active' AND effective_at<=now()
            AND ($2::boolean OR created_by<>'migration')
          ORDER BY effective_at DESC,created_at DESC,id DESC LIMIT 1) global_rate ON true`,
          [id,this.environment==='test'||this.environment==='development'])
        :Promise.resolve({rows:[]}),
      canReadCommission?this.balanceFor(id):Promise.resolve(null),
    ]);
    return { member:{ id:person.id,displayName:person.display_name,accountStatus:person.status,createdAt:person.created_at,
        membershipState:person.membership_state ?? "none",commercialEligible:person.commercial_eligible===true,
        effectiveAt:person.effective_at ?? null,expiresAt:person.expires_at ?? null,
        version:person.version ?? 0,referralCode:person.code_state==="active"?person.code:null },
      rate:canReadCommission?{ basisPoints:rateRule.rows[0]?.basis_points ?? null,effectiveAt:rateRule.rows[0]?.effective_at ?? null,
        source:rateRule.rows[0]?.id?rateRule.rows[0].source:"none",
        memberAction:rateRule.rows[0]?.member_action??null,memberActionEffectiveAt:rateRule.rows[0]?.member_action_effective_at??null }:null,
      scope:{referrals:canReadCommission,orders:canReadCommission&&canReadOrders,ownOrders:canReadOrders},
      commission:balance?{...balance,settlementAvailable:false}:null,
      membershipPolicy:{kind:"engineering_calendar_v2",termMonths:engineeringMembershipMonths,serverTime:person.server_time,
        renewalExpiresAt:person.renewal_expires_at,rateProposalSuggestedAt:person.rate_proposal_suggested_at} };
  }

  async memberSection(actorId:string|undefined,memberId:string,section:string,input:{limit?:unknown;cursor?:unknown}={}){
    await this.authority.require(actorId,"member.profile.read");
    const id=identifier(memberId);
    if(!["referrals","own-orders","attributed-orders","posts"].includes(section))
      throw new DomainError("MEMBER_SECTION_INVALID","成员资料分类无效",422);
    if(section==="referrals")await this.authority.require(actorId,"commission.read");
    if(section==="attributed-orders"){
      await this.authority.require(actorId,"commission.read");
      await this.authority.require(actorId,"commerce.order.read");
    }
    if(section==="own-orders")await this.authority.require(actorId,"commerce.order.read");
    const exists=(await this.pool.query("SELECT 1 FROM member WHERE id=$1 AND status<>'deleted'",[id])).rowCount;
    if(!exists)throw new DomainError("MEMBER_NOT_FOUND","成员不存在",404);
    const limit=pageLimit(input.limit),scope=pageScope(["member-section",id,section]),cursor=readPageCursor(input.cursor,scope);
    let rows:Array<Record<string,unknown>>,matchingTotal:number;
    if(section==="referrals"){
      const result=await this.pool.query(`SELECT r.referred_member_id AS id,a.display_name,r.confirmed_at,r.confirmed_at::text AS cursor_at,
        count(s.order_id) FILTER(WHERE s.source_kind='verified_commerce' AND o.status='paid'
          AND EXISTS(SELECT 1 FROM commission_payment_inbox pay WHERE pay.order_id=o.id AND pay.state='applied'))::int AS verified_order_count
        FROM commercial_referral_relation r JOIN member a ON a.id=r.referred_member_id
        LEFT JOIN commission_order_snapshot s ON s.buyer_member_id=r.referred_member_id AND s.referrer_member_id=$1
        LEFT JOIN commerce_order o ON o.id=s.order_id
        WHERE r.referrer_member_id=$1 AND ($2::timestamptz IS NULL OR (r.confirmed_at,r.referred_member_id)<($2::timestamptz,$3::uuid))
        GROUP BY r.referred_member_id,a.display_name,r.confirmed_at ORDER BY r.confirmed_at DESC,r.referred_member_id DESC LIMIT $4`,
        [id,cursor?.at??null,cursor?.id??null,limit+1]);
      rows=result.rows.map(row=>({id:row.id,cursorAt:row.cursor_at,displayName:row.display_name,
        confirmedAt:row.confirmed_at,verifiedOrderCount:row.verified_order_count}));
      matchingTotal=(await this.pool.query(`SELECT count(*)::int AS n FROM commercial_referral_relation WHERE referrer_member_id=$1`,[id])).rows[0]?.n??0;
    }else if(section==="posts"){
      const result=await this.pool.query(`SELECT p.id,p.published_at,p.published_at::text AS cursor_at,r.title
        FROM ugc_post p JOIN ugc_post_revision r ON r.post_id=p.id AND r.revision=p.published_revision
        WHERE p.author_member_id=$1 AND p.state='published' AND p.visibility='public'
          AND ($2::timestamptz IS NULL OR (p.published_at,p.id)<($2::timestamptz,$3::uuid))
        ORDER BY p.published_at DESC,p.id DESC LIMIT $4`,[id,cursor?.at??null,cursor?.id??null,limit+1]);
      rows=result.rows.map(row=>({id:row.id,cursorAt:row.cursor_at,title:row.title??"图片护理故事",publishedAt:row.published_at}));
      matchingTotal=(await this.pool.query(`SELECT count(*)::int AS n FROM ugc_post
        WHERE author_member_id=$1 AND state='published' AND visibility='public'`,[id])).rows[0]?.n??0;
    }else{
      const attributed=section==="attributed-orders";
      const result=await this.pool.query(`SELECT o.id,o.order_number,o.status,o.total_cents,o.created_at,o.created_at::text AS cursor_at,
        o.transaction_source_kind,l.product_name,s.basis_points,s.source_kind AS attribution_source_kind,s.cash_merchandise_cents,
        (SELECT COALESCE(sum(e.amount_cents),0)::bigint FROM commission_ledger_entry e WHERE e.order_id=o.id) AS commission_net_cents
        FROM commerce_order o LEFT JOIN commerce_order_line l ON l.order_id=o.id AND l.line_number=1
        LEFT JOIN commission_order_snapshot s ON s.order_id=o.id
        WHERE ${attributed?"s.referrer_member_id":"o.member_id"}=$1
          AND ($2::timestamptz IS NULL OR (o.created_at,o.id)<($2::timestamptz,$3::uuid))
        ORDER BY o.created_at DESC,o.id DESC LIMIT $4`,[id,cursor?.at??null,cursor?.id??null,limit+1]);
      rows=result.rows.map(row=>({id:row.id,cursorAt:row.cursor_at,orderNumber:row.order_number,status:row.status,
        totalCents:Number(row.total_cents),createdAt:row.created_at,transactionSourceKind:row.transaction_source_kind,
        productName:row.product_name,basisPoints:attributed?row.basis_points:null,
        attributionSourceKind:attributed?row.attribution_source_kind:null,
        cashMerchandiseCents:attributed?Number(row.cash_merchandise_cents):null,
        commissionNetCents:attributed?Number(row.commission_net_cents):null}));
      matchingTotal=(await this.pool.query(attributed
        ?`SELECT count(*)::int AS n FROM commission_order_snapshot WHERE referrer_member_id=$1`
        :`SELECT count(*)::int AS n FROM commerce_order WHERE member_id=$1`,[id])).rows[0]?.n??0;
    }
    const page=finishPage(rows as Array<{cursorAt:string;id:string}>,limit,scope);
    return {...page,items:page.items.map(({cursorAt:_,...item})=>item),matchingTotal,section};
  }

  async setMembership(actorId: string | undefined, principalId: string | undefined, memberId: string, input: {state?:unknown;expiresAt?:unknown;term?:unknown;expectedVersion?:unknown;reason?:unknown}) {
    this.requireEngineeringRules();
    const target = identifier(memberId);
    const state = input.state;
    if (state!=="active" && state!=="suspended" && state!=="expired") throw new DomainError("MEMBERSHIP_STATE_INVALID", "会员资格状态无效", 422);
    const fixtureTerm=input.term==="engineering_12_calendar_months"||input.term==="engineering_365_day";
    const expiry = typeof input.expiresAt === "string" && Number.isFinite(Date.parse(input.expiresAt)) ? new Date(input.expiresAt) : null;
    if(state==="active"&&!fixtureTerm&&!expiry)throw new DomainError("MEMBERSHIP_EXPIRY_REQUIRED","请设置资格有效期",422);
    if(fixtureTerm&&input.expiresAt!=null)throw new DomainError("MEMBERSHIP_TERM_CONFLICT","请选择一种资格期限方式",422);
    const expected = Number(input.expectedVersion);
    if (!Number.isSafeInteger(expected) || expected<0) throw new DomainError("MEMBERSHIP_VERSION_INVALID", "请刷新成员资料后重试", 422);
    const why = reason(input.reason); const actor=member(actorId);
    if (!principalId || actor===target) throw new DomainError("MEMBERSHIP_SELF_CHANGE_FORBIDDEN", "不能变更自己的商业会员资格", 403);
    return transaction(this.pool,async client=>{
      await this.authority.requireWithClient(client,actor,"member.manage");
      const account=(await client.query("SELECT status FROM member WHERE id=$1 FOR UPDATE",[target])).rows[0];
      if(!account || account.status!=="active")throw new DomainError("MEMBER_NOT_ACTIVE","账号不存在或不可用",409);
      const previous=(await client.query("SELECT * FROM commercial_membership WHERE member_id=$1 FOR UPDATE",[target])).rows[0];
      if((previous?.version ?? 0)!==expected)throw new DomainError("MEMBERSHIP_CHANGED","会员资格已变化，请刷新",409);
      const effective=(await client.query<{at:Date}>("SELECT clock_timestamp() AS at")).rows[0]!.at;
      let nextExpiry:Date|null=previous?.expires_at??null;
      if(state==="active"){
        if(previous&&previous.expires_at===null){nextExpiry=null;}
        else if(fixtureTerm){const row=(await client.query<{expires_at:Date}>(`SELECT
          ((GREATEST($1::timestamptz,$2::timestamptz) AT TIME ZONE 'Asia/Shanghai')+
            make_interval(months=>$3::int)) AT TIME ZONE 'Asia/Shanghai' AS expires_at`,
          [previous?.expires_at??effective,effective,engineeringMembershipMonths])).rows[0];nextExpiry=row!.expires_at;}
        else nextExpiry=expiry;
        if(nextExpiry&&nextExpiry<=effective)throw new DomainError("MEMBERSHIP_EXPIRY_REQUIRED","资格到期时间须晚于服务端当前时间",422);
        if(previous?.expires_at&&nextExpiry&&nextExpiry<previous.expires_at&&previous.expires_at>effective)
          throw new DomainError("MEMBERSHIP_EXPIRY_SHORTEN","续期不能缩短现有资格，请刷新后重试",409);
      }
      const effectiveAt=state==="active"?effective:previous?.effective_at??effective;
      const version=expected+1;
      await client.query(`INSERT INTO commercial_membership(member_id,state,effective_at,expires_at,version,changed_by,change_reason)
        VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(member_id) DO UPDATE SET
        state=$2,effective_at=$3,expires_at=$4,version=$5,changed_by=$6,change_reason=$7,updated_at=now()`,
        [target,state,effectiveAt,nextExpiry,version,principalId,why]);
      await client.query(`INSERT INTO commercial_membership_event(member_id,version,from_state,to_state,effective_at,expires_at,actor_principal_id,reason)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,[target,version,previous?.state ?? null,state,effectiveAt,nextExpiry,principalId,why]);
      await client.query(`INSERT INTO audit_log(principal_id,action,object_type,object_id,reason_code,before_state,after_state,trace_id)
        VALUES($1,'commercial.membership_change','member',$2,$3,$4,$5,$6)`,[principalId,target,why,
        {state:previous?.state ?? "none",expiresAt:previous?.expires_at ?? null},{state,expiresAt:nextExpiry},`commercial-membership:${target}:${version}`]);
      return {memberId:target,state,version,serverTime:effective,previousExpiresAt:previous?.expires_at??null,
        expiresAt:nextExpiry,policyKind:fixtureTerm?"engineering_calendar_v2":"operator_explicit"};
    });
  }

  async proposeRate(actorId: string | undefined, principalId: string | undefined, requestKey:unknown,
    input:{memberId?:unknown;basisPoints?:unknown;action?:unknown;effectiveAt?:unknown;reason?:unknown}) {
    this.requireEngineeringRules();
    const actor=await this.authority.require(actorId,"commission.rate.manage");
    const target=input.memberId==null?null:identifier(input.memberId);
    if(target===actor)throw new DomainError("RATE_SELF_CHANGE_FORBIDDEN","不能为自己提议费率",403);
    const action=input.action==null?"override":input.action;
    if(action!=="override"&&action!=="inherit")throw new DomainError("RATE_ACTION_INVALID","费率处理方式无效",422);
    if(action==="inherit"&&(target===null||input.basisPoints!=null))
      throw new DomainError("RATE_INHERIT_INVALID","恢复继承仅适用于单个会员，且无需填写费率",422);
    const basisPoints=action==="inherit"?null:rate(input.basisPoints);const why=reason(input.reason);
    const effective=input.effectiveAt==null?null:typeof input.effectiveAt==="string"?new Date(input.effectiveAt):new Date(NaN);
    if(effective&&!Number.isFinite(effective.getTime()))throw new DomainError("RATE_EFFECTIVE_INVALID","生效时间无效",422);
    if(!principalId)throw new DomainError("AUTH_REQUIRED","请重新登录后操作",401);
    const request=commandKey(requestKey),fingerprint=createHash("sha256")
      .update(JSON.stringify({target,action,basisPoints,proposedEffectiveAt:effective?.toISOString()??null,reason:why})).digest("hex");
    return transaction(this.pool,async client=>{
      await this.authority.requireWithClient(client,actor,"commission.rate.manage");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[`commission-rate:${principalId}:${request}`]);
      const prior=(await client.query(`SELECT id,member_id,action,basis_points,effective_at,state,request_fingerprint
        FROM commission_rate_rule WHERE created_by=$1 AND request_key=$2`,[principalId,request])).rows[0];
      if(prior){if(prior.request_fingerprint!==fingerprint)
        throw new DomainError("RATE_REQUEST_CONFLICT","同一提议编号对应不同内容，请核对原提议",409);
        return {id:prior.id,action:prior.action,basis_points:prior.basis_points,effective_at:prior.effective_at,state:prior.state,alreadyCreated:true};}
      const suggested=(await client.query<{at:Date}>(`SELECT ${nextShanghaiMidnight} AS at`)).rows[0]!.at;
      const proposed=effective??suggested;
      const result=await client.query(`INSERT INTO commission_rate_rule(member_id,action,basis_points,state,
        effective_at,proposed_effective_at,rule_version,created_by,reason,request_key,request_fingerprint)
        VALUES($1,$2,$3,'proposed',$4,$4,'commercial-rate-v2',$5,$6,$7,$8)
        RETURNING id,action,basis_points,effective_at,proposed_effective_at,state,version`,
        [target,action,basisPoints,proposed,principalId,why,request,fingerprint]);
      return {...result.rows[0],alreadyCreated:false};
    });
  }

  async proposalByRequest(actorId:string|undefined,principalId:string|undefined,requestKey:unknown){
    await this.authority.require(actorId,"commission.rate.manage");
    if(!principalId)throw new DomainError("AUTH_REQUIRED","请重新登录后查询",401);
    const request=commandKey(requestKey);
    const row=(await this.pool.query(`SELECT id,member_id,action,basis_points,effective_at,state,reason,created_at
      FROM commission_rate_rule WHERE created_by=$1 AND request_key=$2`,[principalId,request])).rows[0];
    if(!row)throw new DomainError("RATE_PROPOSAL_NOT_FOUND","原费率提议未找到",404);
    return row;
  }

  async currentGlobalRate(actorId:string|undefined){
    if(!await this.authority.has(actorId,"commission.read"))await this.authority.require(actorId,"commission.rate.manage");
    const row=(await this.pool.query(`SELECT rate.id,rate.basis_points,rate.effective_at,now() AS server_time,
      ${nextShanghaiMidnight} AS suggested_effective_at
      FROM (SELECT 1) seed LEFT JOIN LATERAL (SELECT id,basis_points,effective_at
        FROM commission_rate_rule WHERE member_id IS NULL AND action='override' AND state='active' AND effective_at<=now()
          AND ($1::boolean OR created_by<>'migration')
        ORDER BY effective_at DESC,created_at DESC,id DESC LIMIT 1) rate ON true`,
      [this.environment==='test'||this.environment==='development'])).rows[0];
    return {basisPoints:row?.basis_points??null,effectiveAt:row?.effective_at??null,
      serverTime:row?.server_time??null,suggestedEffectiveAt:row?.suggested_effective_at??null,
      policyKind:this.environment==='test'||this.environment==='development'?"engineering_fixture":
        row?.id?"approved_rule":"unconfigured",paymentAvailable:false};
  }

  async approveRate(actorId: string | undefined, principalId: string | undefined, ruleId: string,
    decisionKey:unknown,input:{decision?:unknown;expectedVersion?:unknown;reason?:unknown}) {
    this.requireEngineeringRules();
    const actor=await this.authority.require(actorId,"commission.rate.approve");
    const id=identifier(ruleId);
    if(input.decision!=="active" && input.decision!=="rejected")throw new DomainError("RATE_DECISION_INVALID","请选择批准或退回",422);
    if(!principalId)throw new DomainError("AUTH_REQUIRED","请重新登录后操作",401);
    const expectedVersion=Number(input.expectedVersion),request=commandKey(decisionKey),why=reason(input.reason);
    if(!Number.isSafeInteger(expectedVersion)||expectedVersion<1)
      throw new DomainError("RATE_VERSION_INVALID","请刷新待复核提议",422);
    const fingerprint=createHash("sha256").update(JSON.stringify({id,decision:input.decision,expectedVersion,why})).digest("hex");
    return transaction(this.pool,async client=>{
      await this.authority.requireWithClient(client,actor,"commission.rate.approve");
      const rule=(await client.query("SELECT * FROM commission_rate_rule WHERE id=$1 FOR UPDATE",[id])).rows[0];
      if(!rule)throw new DomainError("RATE_RULE_CHANGED","费率提议不存在，请刷新",409);
      if(rule.state!=="proposed"){
        if(rule.approved_by===principalId&&rule.decision_key===request&&rule.decision_hash===fingerprint)
          return {id:rule.id,member_id:rule.member_id,action:rule.action,basis_points:rule.basis_points,
            state:rule.state,effective_at:rule.effective_at,version:rule.version,alreadyDecided:true};
        throw new DomainError("RATE_RULE_CHANGED","费率提议已处理，请刷新",409);
      }
      if(rule.created_by===principalId || rule.member_id===actor)throw new DomainError("RATE_SELF_APPROVAL_FORBIDDEN","提议人或受益人不能批准该费率",403);
      if(rule.version!==expectedVersion)throw new DomainError("VERSION_CONFLICT","费率提议版本已变化",409);
      const updated=(await client.query(`UPDATE commission_rate_rule SET state=$2,approved_by=$3,
        decided_at=clock_timestamp(),version=version+1,decision_key=$4,decision_hash=$5,decision_reason=$6,
        effective_at=CASE WHEN $2='active' THEN GREATEST(proposed_effective_at,${nextShanghaiMidnight})
          ELSE effective_at END
        WHERE id=$1 RETURNING id,member_id,action,basis_points,state,effective_at,proposed_effective_at,version`,
        [id,input.decision,principalId,request,fingerprint,why])).rows[0];
      await client.query(`INSERT INTO audit_log(principal_id,action,object_type,object_id,reason_code,after_state,trace_id)
        VALUES($1,'commercial.rate_decision','commission_rate_rule',$2,$3,$4,$5)`,[principalId,id,why,updated,`commission-rate:${id}:${input.decision}`]);
      return updated;
    });
  }

  async pendingRates(actorId: string | undefined,input:{limit?:unknown;cursor?:unknown}={}) {
    await this.authority.require(actorId,"commission.rate.approve");
    const limit=pageLimit(input.limit),scope=pageScope(["pending-rates"]),cursor=readPageCursor(input.cursor,scope);
    const result=await this.pool.query(`SELECT r.id,r.member_id,m.display_name,r.action,r.basis_points,r.effective_at,r.version,r.created_at::text AS cursor_at,r.created_by,r.reason,r.created_at
      FROM commission_rate_rule r LEFT JOIN member m ON m.id=r.member_id
      WHERE r.state='proposed' AND ($2::timestamptz IS NULL OR (r.created_at,r.id)>($2::timestamptz,$3::uuid))
      ORDER BY r.created_at,r.id LIMIT $1`,[limit+1,cursor?.at??null,cursor?.id??null]);
    const page=finishPage(result.rows.map(row=>({id:row.id,cursorAt:row.cursor_at,memberId:row.member_id,
      displayName:row.display_name ?? "全局默认",action:row.action,basisPoints:row.basis_points,effectiveAt:row.effective_at,version:row.version,
      createdBy:row.created_by,reason:row.reason,createdAt:row.created_at})),limit,scope);
    const total=(await this.pool.query(`SELECT count(*)::int AS total FROM commission_rate_rule WHERE state='proposed'`)).rows[0]?.total??0;
    return {...page,items:page.items.map(({cursorAt:_,...item})=>item),matchingTotal:total};
  }
}
