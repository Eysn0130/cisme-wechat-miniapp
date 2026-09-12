import { randomBytes } from "node:crypto";
import type pg from "pg";
import { DomainError } from "@cisme/domain";
import { transaction, type DbClient } from "./db.js";
import { AuthorityService } from "./authority.js";
import { commissionBuckets } from "./commissionPolicy.js";
import type { AppConfig } from "@cisme/config";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const codePattern = /^CM[A-HJ-NP-Z2-9]{10}$/;
const codeAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
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
  if (!Number.isInteger(value) || Number(value) < 2000 || Number(value) > 3500) {
    throw new DomainError("COMMISSION_RATE_INVALID", "返佣比例须在 20%–35% 之间", 422);
  }
  return Number(value);
}

export class CommercialMembershipService {
  constructor(private readonly pool: pg.Pool, private readonly authority: AuthorityService,
    private readonly environment:AppConfig["env"]) {}

  private requireEngineeringRules(){
    if(this.environment!=="test"&&this.environment!=="development")
      throw new DomainError("COMMERCIAL_RULES_NOT_APPROVED","商业资格与推荐规则尚未正式启用",503);
  }

  private async balanceFor(referrerId:string){
    const row=(await this.pool.query(`SELECT
      COALESCE(sum(amount_cents) FILTER(WHERE kind='accrual'),0)::text AS accrued,
      COALESCE(-sum(amount_cents) FILTER(WHERE kind='refund_reversal'),0)::text AS reversed,
      COALESCE(sum(amount_cents) FILTER(WHERE kind='release'),0)::text AS released,
      COALESCE(sum(amount_cents) FILTER(WHERE kind='settlement'),0)::text AS paid
      FROM commission_ledger_entry WHERE referrer_member_id=$1`,[referrerId])).rows[0];
    return commissionBuckets({accruedCents:Number(row.accrued),reversedCents:Number(row.reversed),
      releasedCents:Number(row.released),paidCents:Number(row.paid)});
  }

  async myStatus(memberId: string | undefined) {
    const owner = member(memberId);
    const [status,balance] = await Promise.all([this.pool.query(`SELECT m.state,m.effective_at,m.expires_at,m.version,c.code,c.state AS code_state,a.status AS account_status,
      (SELECT count(*)::int FROM commercial_referral_relation r WHERE r.referrer_member_id=$1) AS direct_referral_count,
      (SELECT count(*)::int FROM commission_order_snapshot s JOIN commerce_order o ON o.id=s.order_id
        WHERE s.referrer_member_id=$1 AND s.source_kind='verified_commerce' AND o.status='paid'
          AND EXISTS(SELECT 1 FROM commission_payment_inbox p WHERE p.order_id=o.id AND p.state='applied')) AS verified_order_count
      FROM commercial_membership m JOIN member a ON a.id=m.member_id LEFT JOIN commercial_referral_code c ON c.member_id=m.member_id WHERE m.member_id=$1`, [owner]),
      this.balanceFor(owner)]);
    const row = status.rows[0];
    const eligible = Boolean((this.environment==="test"||this.environment==="development") && row && row.account_status === "active" && row.state === "active" && new Date(row.effective_at).getTime() <= Date.now()
      && (!row.expires_at || new Date(row.expires_at).getTime() > Date.now()));
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
      const m = (await client.query(`SELECT m.state,m.effective_at,m.expires_at,a.status AS account_status
        FROM commercial_membership m JOIN member a ON a.id=m.member_id WHERE m.member_id=$1 FOR UPDATE OF m`, [owner])).rows[0];
      if (!m || m.account_status !== "active" || m.state !== "active" || new Date(m.effective_at)>new Date()
        || (m.expires_at && new Date(m.expires_at)<=new Date())) throw new DomainError("COMMERCIAL_MEMBERSHIP_REQUIRED", "当前账号尚无有效推荐资格", 403);
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
      JOIN LATERAL (SELECT id,basis_points FROM commission_rate_rule
        WHERE state='active' AND effective_at<=$5 AND (member_id=r.referrer_member_id OR member_id IS NULL)
        ORDER BY (member_id IS NOT NULL) DESC,effective_at DESC,created_at DESC LIMIT 1) rate ON true
      WHERE r.referred_member_id=$2 AND r.confirmed_at<=$5 AND r.referrer_member_id<>$2
        AND m.state='active' AND m.effective_at<=$5 AND (m.expires_at IS NULL OR m.expires_at>$5)
        AND c.state='active' AND sponsor.status='active'
      ON CONFLICT(order_id) DO NOTHING RETURNING order_id,basis_points,source_kind`,
      [orderId,buyerId,cashMerchandiseCents,sourceKind,effectiveNow]);
    return result.rows[0] ?? null;
  }

  async listMembers(actorId: string | undefined, input: { q?: unknown; filter?: unknown; limit?: unknown }) {
    await this.authority.require(actorId,"member.profile.read");
    const canReadCommission=await this.authority.has(actorId,"commission.read");
    const q = typeof input.q === "string" ? input.q.trim().slice(0,60) : "";
    const filter = input.filter === "members" || input.filter === "ordinary" ? input.filter : "all";
    const limit = Number.isInteger(Number(input.limit)) ? Math.min(50,Math.max(1,Number(input.limit))) : 30;
    const rows = await this.pool.query(`SELECT a.id,a.display_name,a.status,a.created_at,m.state AS membership_state,m.expires_at,
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
      ORDER BY a.created_at DESC,a.id DESC LIMIT $3`, [q,filter,limit,canReadCommission]);
    const totals = await this.pool.query(`SELECT count(*)::int AS all_count,
      count(*) FILTER(WHERE a.status='active' AND m.state='active' AND m.effective_at<=now() AND (m.expires_at IS NULL OR m.expires_at>now()))::int AS member_count
      FROM member a LEFT JOIN commercial_membership m ON m.member_id=a.id WHERE a.status<>'deleted'`);
    return { items: rows.rows.map(row => ({ id:row.id, displayName:row.display_name, accountStatus:row.status,
      membershipState:row.membership_state ?? "none",commercialEligible:row.commercial_eligible===true,
      expiresAt:row.expires_at, referralCode:row.code_state==="active"?row.code:null,
      directReferralCount:row.direct_referral_count })), summary:{ all:totals.rows[0]?.all_count ?? 0,members:totals.rows[0]?.member_count ?? 0,
      ordinary:(totals.rows[0]?.all_count ?? 0)-(totals.rows[0]?.member_count ?? 0) } };
  }

  async memberDetail(actorId: string | undefined, memberId: string) {
    await this.authority.require(actorId,"member.profile.read");
    const [canReadCommission,canReadOrders]=await Promise.all([
      this.authority.has(actorId,"commission.read"),this.authority.has(actorId,"commerce.order.read")]);
    const id = identifier(memberId);
    const person = (await this.pool.query(`SELECT a.id,a.display_name,a.status,a.created_at,m.state AS membership_state,m.effective_at,m.expires_at,m.version,
      (a.status='active' AND m.state='active' AND m.effective_at<=now()
        AND (m.expires_at IS NULL OR m.expires_at>now())) AS commercial_eligible,
      CASE WHEN $2::boolean THEN c.code ELSE NULL END AS code,
      CASE WHEN $2::boolean THEN c.state ELSE NULL END AS code_state
      FROM member a LEFT JOIN commercial_membership m ON m.member_id=a.id
      LEFT JOIN commercial_referral_code c ON c.member_id=a.id WHERE a.id=$1`, [id,canReadCommission])).rows[0];
    if (!person || person.status==="deleted") throw new DomainError("MEMBER_NOT_FOUND", "成员不存在", 404);
    const [referrals,orders,posts,rateRule,balance] = await Promise.all([
      canReadCommission?this.pool.query(`SELECT r.referred_member_id AS id,a.display_name,r.confirmed_at,
        count(s.order_id)::int AS order_count,COALESCE(sum(s.cash_merchandise_cents),0)::bigint AS cash_merchandise_cents
        FROM commercial_referral_relation r JOIN member a ON a.id=r.referred_member_id
        LEFT JOIN commission_order_snapshot s ON s.buyer_member_id=r.referred_member_id AND s.referrer_member_id=$1
        WHERE r.referrer_member_id=$1 GROUP BY r.referred_member_id,a.display_name,r.confirmed_at
        ORDER BY r.confirmed_at DESC LIMIT 30`, [id]):Promise.resolve({rows:[]}),
      canReadCommission&&canReadOrders?this.pool.query(`SELECT s.order_id,o.order_number,o.status,s.cash_merchandise_cents,s.basis_points,s.source_kind,
        l.product_name,o.created_at FROM commission_order_snapshot s JOIN commerce_order o ON o.id=s.order_id
        LEFT JOIN commerce_order_line l ON l.order_id=o.id AND l.line_number=1
        WHERE s.referrer_member_id=$1 ORDER BY o.created_at DESC LIMIT 30`, [id]):Promise.resolve({rows:[]}),
      this.pool.query(`SELECT p.id,p.state,p.visibility,p.updated_at,r.title FROM ugc_post p
        JOIN ugc_post_revision r ON r.post_id=p.id AND r.revision=p.published_revision
        WHERE p.author_member_id=$1 AND p.state='published' AND p.visibility='public'
        ORDER BY p.updated_at DESC LIMIT 30`, [id]),
      canReadCommission?this.pool.query(`SELECT id,basis_points,effective_at FROM commission_rate_rule WHERE state='active' AND effective_at<=now()
        AND (member_id=$1 OR member_id IS NULL) ORDER BY (member_id IS NOT NULL) DESC,effective_at DESC,created_at DESC LIMIT 1`, [id])
        :Promise.resolve({rows:[]}),
      canReadCommission?this.balanceFor(id):Promise.resolve(null),
    ]);
    return { member:{ id:person.id,displayName:person.display_name,accountStatus:person.status,createdAt:person.created_at,
        membershipState:person.membership_state ?? "none",commercialEligible:person.commercial_eligible===true,
        effectiveAt:person.effective_at ?? null,expiresAt:person.expires_at ?? null,
        version:person.version ?? 0,referralCode:person.code_state==="active"?person.code:null },
      rate:canReadCommission?{ basisPoints:rateRule.rows[0]?.basis_points ?? 2000,effectiveAt:rateRule.rows[0]?.effective_at ?? null }:null,
      referrals:referrals.rows.map(row=>({id:row.id,displayName:row.display_name,confirmedAt:row.confirmed_at,
        orderCount:row.order_count,syntheticMerchandiseCents:Number(row.cash_merchandise_cents)})),
      orders:orders.rows.map(row=>({id:row.order_id,orderNumber:row.order_number,status:row.status,productName:row.product_name,
        cashMerchandiseCents:Number(row.cash_merchandise_cents),basisPoints:row.basis_points,sourceKind:row.source_kind,createdAt:row.created_at})),
      publicPosts:posts.rows,scope:{referrals:canReadCommission,orders:canReadCommission&&canReadOrders},
      commission:balance?{...balance,settlementAvailable:false}:null };
  }

  async setMembership(actorId: string | undefined, principalId: string | undefined, memberId: string, input: {state?:unknown;expiresAt?:unknown;expectedVersion?:unknown;reason?:unknown}) {
    this.requireEngineeringRules();
    const target = identifier(memberId);
    const state = input.state;
    if (state!=="active" && state!=="suspended" && state!=="expired") throw new DomainError("MEMBERSHIP_STATE_INVALID", "会员资格状态无效", 422);
    const expiry = typeof input.expiresAt === "string" && Number.isFinite(Date.parse(input.expiresAt)) ? new Date(input.expiresAt) : null;
    if (state==="active" && (!expiry || expiry<=new Date())) throw new DomainError("MEMBERSHIP_EXPIRY_REQUIRED", "请设置未来的会员资格有效期", 422);
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
      const version=expected+1;
      await client.query(`INSERT INTO commercial_membership(member_id,state,effective_at,expires_at,version,changed_by,change_reason)
        VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(member_id) DO UPDATE SET
        state=$2,effective_at=$3,expires_at=$4,version=$5,changed_by=$6,change_reason=$7,updated_at=now()`,
        [target,state,effective,state==="active"?expiry:null,version,principalId,why]);
      await client.query(`INSERT INTO commercial_membership_event(member_id,version,from_state,to_state,effective_at,expires_at,actor_principal_id,reason)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,[target,version,previous?.state ?? null,state,effective,state==="active"?expiry:null,principalId,why]);
      await client.query(`INSERT INTO audit_log(principal_id,action,object_type,object_id,reason_code,before_state,after_state,trace_id)
        VALUES($1,'commercial.membership_change','member',$2,$3,$4,$5,$6)`,[principalId,target,why,
        {state:previous?.state ?? "none",expiresAt:previous?.expires_at ?? null},{state,expiresAt:state==="active"?expiry:null},`commercial-membership:${target}:${version}`]);
      return {memberId:target,state,version,expiresAt:state==="active"?expiry:null};
    });
  }

  async proposeRate(actorId: string | undefined, principalId: string | undefined, input:{memberId?:unknown;basisPoints?:unknown;effectiveAt?:unknown;reason?:unknown}) {
    this.requireEngineeringRules();
    const actor=await this.authority.require(actorId,"commission.rate.manage");
    const target=input.memberId==null?null:identifier(input.memberId);
    if(target===actor)throw new DomainError("RATE_SELF_CHANGE_FORBIDDEN","不能为自己提议费率",403);
    const basisPoints=rate(input.basisPoints);const why=reason(input.reason);
    const effective=typeof input.effectiveAt==="string"?new Date(input.effectiveAt):new Date(NaN);
    if(!Number.isFinite(effective.getTime()) || effective.getTime()<Date.now()+60_000)throw new DomainError("RATE_EFFECTIVE_INVALID","生效时间须晚于当前至少 1 分钟",422);
    if(!principalId)throw new DomainError("AUTH_REQUIRED","请重新登录后操作",401);
    const result=await this.pool.query(`INSERT INTO commission_rate_rule(member_id,basis_points,state,effective_at,created_by,reason)
      VALUES($1,$2,'proposed',$3,$4,$5) RETURNING id,basis_points,effective_at,state`,[target,basisPoints,effective,principalId,why]);
    return result.rows[0];
  }

  async approveRate(actorId: string | undefined, principalId: string | undefined, ruleId: string, input:{decision?:unknown}) {
    this.requireEngineeringRules();
    const actor=await this.authority.require(actorId,"commission.rate.approve");
    const id=identifier(ruleId);
    if(input.decision!=="active" && input.decision!=="rejected")throw new DomainError("RATE_DECISION_INVALID","请选择批准或退回",422);
    if(!principalId)throw new DomainError("AUTH_REQUIRED","请重新登录后操作",401);
    return transaction(this.pool,async client=>{
      await this.authority.requireWithClient(client,actor,"commission.rate.approve");
      const rule=(await client.query("SELECT * FROM commission_rate_rule WHERE id=$1 FOR UPDATE",[id])).rows[0];
      if(!rule || rule.state!=="proposed")throw new DomainError("RATE_RULE_CHANGED","费率提议已处理，请刷新",409);
      if(rule.created_by===principalId || rule.member_id===actor)throw new DomainError("RATE_SELF_APPROVAL_FORBIDDEN","提议人或受益人不能批准该费率",403);
      const updated=(await client.query(`UPDATE commission_rate_rule SET state=$2,approved_by=$3,decided_at=now()
        WHERE id=$1 RETURNING id,member_id,basis_points,state,effective_at`,[id,input.decision,principalId])).rows[0];
      await client.query(`INSERT INTO audit_log(principal_id,action,object_type,object_id,reason_code,after_state,trace_id)
        VALUES($1,'commercial.rate_decision','commission_rate_rule',$2,$3,$4,$5)`,[principalId,id,rule.reason,updated,`commission-rate:${id}:${input.decision}`]);
      return updated;
    });
  }

  async pendingRates(actorId: string | undefined) {
    await this.authority.require(actorId,"commission.rate.approve");
    const result=await this.pool.query(`SELECT r.id,r.member_id,m.display_name,r.basis_points,r.effective_at,r.created_by,r.reason,r.created_at
      FROM commission_rate_rule r LEFT JOIN member m ON m.id=r.member_id
      WHERE r.state='proposed' ORDER BY r.created_at,r.id LIMIT 30`);
    return {items:result.rows.map(row=>({id:row.id,memberId:row.member_id,displayName:row.display_name ?? "全局默认",
      basisPoints:row.basis_points,effectiveAt:row.effective_at,createdBy:row.created_by,reason:row.reason,createdAt:row.created_at}))};
  }
}
