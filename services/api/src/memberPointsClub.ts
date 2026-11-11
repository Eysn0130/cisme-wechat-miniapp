import {saveMemberBirthday} from './memberBirthday.js';
import {createHash,createHmac,createCipheriv,createDecipheriv,randomBytes,randomUUID} from 'node:crypto';
import type pg from 'pg';
import type {AppConfig} from '@cisme/config';
import {DomainError} from '@cisme/domain';
import {transaction,type DbClient} from './db.js';
import {AuthorityService} from './authority.js';
import {activePointPolicy,pointPolicyByVersion,clubRulesV1,validClubRules,pointDay,lockPointWallet,grantMemberPoints,reverseMemberGrant,sweepMemberPoints,returnOrderPoints,type PointsPolicy} from './pointsLedger.js';
const digest=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
function fail(code:string,title:string,status=422):never{throw new DomainError(code,title,status);}
const uuid=(v:unknown)=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v)?v:fail('POINTS_ID_INVALID','记录编号无效');
const operation=(v:string)=>typeof v==='string'&&/^[A-Za-z0-9._:-]{8,200}$/.test(v)?v:fail('IDEMPOTENCY_KEY_INVALID','操作编号无效');
const object=(v:unknown,keys:string[])=>{if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).some(k=>!keys.includes(k)))fail('POINTS_INPUT_INVALID','请核对提交内容');return v as Record<string,unknown>;};
const owner=(v:string|undefined)=>v||fail('MEMBER_REQUIRED','请先登录',401);
function textKey(config:AppConfig){if(!/^[a-f0-9]{64}$/i.test(config.contacts.encryptionKey??''))fail('POINTS_PRIVATE_STORAGE_UNAVAILABLE','私人记录存储暂不可用',503);return Buffer.from(config.contacts.encryptionKey!,'hex');}
function sealNote(config:AppConfig,memberId:string,id:string,note:string){if(!note)return '';const iv=randomBytes(12),c=createCipheriv('aes-256-gcm',textKey(config),iv);c.setAAD(Buffer.from(`points-checkin:${memberId}:${id}`));const b=Buffer.concat([c.update(note,'utf8'),c.final()]);return Buffer.concat([iv,c.getAuthTag(),b]).toString('base64');}
export function openPointsNote(config:AppConfig,row:{id:string;member_id:string;note_encrypted:string;key_version:string|null}){
  if(!row.note_encrypted)return '';if(row.key_version!==config.contacts.keyVersion)fail('POINTS_PRIVATE_KEY_UNAVAILABLE','私人记录暂无法读取',503);
  try{const b=Buffer.from(row.note_encrypted,'base64'),d=createDecipheriv('aes-256-gcm',textKey(config),b.subarray(0,12));d.setAAD(Buffer.from(`points-checkin:${row.member_id}:${row.id}`));d.setAuthTag(b.subarray(12,28));return Buffer.concat([d.update(b.subarray(28)),d.final()]).toString('utf8');}
  catch{fail('POINTS_PRIVATE_RECORD_UNREADABLE','私人记录暂无法读取',503);}
}
export async function memberPointsExtras(client:DbClient,memberId:string,now:Date){
  const policy=await activePointPolicy(client,now);
  const counts=(await client.query(`SELECT count(*)::int AS total_count,
    COALESCE(sum(available_delta+frozen_delta) FILTER(WHERE entry_type IN ('grant_available','grant_frozen')),0)::text AS lifetime_earned,
    COALESCE(sum(used_delta),0)::text AS used,COALESCE(sum(expired_delta),0)::text AS expired FROM points_entry WHERE member_id=$1`,[memberId])).rows[0];
  const expiry=(await client.query(`SELECT COALESCE(sum(l.available_amount),0)::int AS points,min(l.expires_at) AS earliest_at
    FROM points_lot l JOIN points_grant g ON g.id=l.grant_id WHERE g.member_id=$1 AND l.available_amount>0 AND l.expires_at>$2
      AND l.expires_at<=$2::timestamptz+($3::int*interval '1 day')`,[memberId,now,policy?.rules.reminderDays??30])).rows[0];
  const expired=(await client.query(`SELECT COALESCE(sum(l.expired_amount),0)::text AS n FROM points_lot l JOIN points_grant g ON g.id=l.grant_id WHERE g.member_id=$1`,[memberId])).rows[0].n;
  return {totalCount:counts.total_count,lifetimeEarned:Number(counts.lifetime_earned),used:Number(counts.used),expired:Number(expired),
    expiring:{points:expiry.points,earliestAt:expiry.earliest_at?.toISOString()??null,withinDays:policy?.rules.reminderDays??30},clubPolicy:policy?{version:policy.version,rules:policy.rules,startsAt:policy.starts_at.toISOString(),endsAt:policy.ends_at?.toISOString()??null}:null};
}
async function streakFor(client:DbClient,memberId:string,day:string){
  const rows=(await client.query<{care_day:string}>(`SELECT care_day::text FROM member_points_attendance WHERE member_id=$1 AND care_day<=$2::date
    ORDER BY care_day DESC`,[memberId,day])).rows;let count=0,expected=Date.parse(day+'T00:00:00Z');
  for(const row of rows){if(Date.parse(row.care_day+'T00:00:00Z')!==expected)break;count++;expected-=86400000;}return count;
}
async function attendance(client:DbClient,memberId:string,day:string,sourceId:string,policy:PointsPolicy,now:Date){
  await lockPointWallet(client,memberId,true);
  await client.query(`INSERT INTO member_points_attendance(member_id,care_day,first_source,qualified_at) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`,[memberId,day,sourceId,now]);
  const count=await streakFor(client,memberId,day);
  await grantMemberPoints(client,{owner:memberId,sourceType:'care_day',sourceId:day,component:'daily',amount:policy.rules.daily,policy,now});
  for(const [period,amount] of [[7,policy.rules.streak7],[30,policy.rules.streak30]] as const)if(count&&count%period===0){
    await grantMemberPoints(client,{owner:memberId,sourceType:'care_streak',sourceId:day,component:`streak${period}`,amount,policy,now});
    if(period===30)await client.query(`INSERT INTO member_points_badge(member_id,code,earned_at) VALUES($1,'scalp-care-explorer',$2) ON CONFLICT DO NOTHING`,[memberId,now]);
  }
  return count;
}
export class MemberPointsClub{
  constructor(private pool:pg.Pool,private config:AppConfig,private authority:AuthorityService){}
  async publicPolicy(now=new Date()) {
    // Managed pool queries await request-budget cleanup before returning.
    // A detached manual release can let response cancellation outlive a lease.
    const p=await activePointPolicy(this.pool,now);
    return p?{version:p.version,rules:p.rules,startsAt:p.starts_at,endsAt:p.ends_at}:null;
  }
  async overview(memberId:string|undefined,now=new Date()){
    const id=owner(memberId);return transaction(this.pool,async c=>{
      await lockPointWallet(c,id,true);await sweepMemberPoints(c,id,now);
      const p=await activePointPolicy(c,now),day=pointDay(now);
      const today=(await c.query(`SELECT *,care_day::text FROM member_points_checkin WHERE member_id=$1 AND care_day=$2`,[id,day])).rows[0];
      const profile=(await c.query('SELECT birthday_month_day,birthday_change_after FROM member_points_profile WHERE member_id=$1',[id])).rows[0];
      const upcoming=(await c.query(`SELECT version,rules,starts_at,ends_at FROM member_points_policy WHERE approved_at IS NOT NULL AND starts_at>$1 AND (retired_at IS NULL OR retired_at>starts_at) ORDER BY starts_at LIMIT 10`,[now])).rows;
      const pending=(await c.query(`SELECT count(*)::int AS n FROM member_points_source_event WHERE member_id=$1 AND state='pending'`,[id])).rows[0].n;
      const badges=(await c.query('SELECT code,earned_at FROM member_points_badge WHERE member_id=$1',[id])).rows;
      const questionnaire=(await c.query('SELECT completed_at FROM member_care_profile WHERE member_id=$1',[id])).rows[0];
      const attending=((await c.query('SELECT 1 FROM member_points_attendance WHERE member_id=$1 AND care_day=$2',[id,day])).rowCount??0)>0;
      const streakDay=attending?day:pointDay(new Date(now.getTime()-86400000));
      return {memberId:id,upcomingPolicies:upcoming,enabled:Boolean(p),policy:p?{version:p.version,rules:p.rules,startsAt:p.starts_at,endsAt:p.ends_at}:null,
        serverDay:day,today:today?{id:today.id,operationId:today.operation_id,products:today.products,note:openPointsNote(this.config,today),version:today.version}:null,
        checkedIn:attending,streak:await streakFor(c,id,streakDay),badges,pendingRewardSources:pending,questionnaireCompleted:Boolean(questionnaire?.completed_at),
        birthday:profile?.birthday_month_day??null,birthdayChangeAfter:profile?.birthday_change_after??null,...await memberPointsExtras(c,id,now)};
    });
  }
  async checkin(memberId:string|undefined,keyInput:string,input:unknown,now=new Date()){
    return transaction(this.pool,c=>saveMemberUsage(c,this.config,memberId,keyInput,input,now));
  }
  async birthday(memberId:string|undefined,input:unknown,now=new Date()){
    const id=owner(memberId),body=object(input,['monthDay']);
    return transaction(this.pool,c=>saveMemberBirthday(c,id,body.monthDay,now,this.config));
  }
  async usageHistory(memberId:string|undefined,options:{before?:unknown;limit?:unknown}={}){
    const id=owner(memberId),before=options.before??null,limit=options.limit===undefined?20:Number(options.limit);
    if(before!==null&&(typeof before!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(before)||!Number.isFinite(+new Date(before+'T00:00:00Z'))||new Date(before+'T00:00:00Z').toISOString().slice(0,10)!==before)
      ||!Number.isInteger(limit)||limit<1||limit>50)fail('CARE_USAGE_PAGE_INVALID','请重新加载护理记录');
    return transaction(this.pool,async c=>{
      if(!(await c.query("SELECT 1 FROM member WHERE id=$1 AND status='active' FOR SHARE",[id])).rowCount)fail('AUTH_REVOKED','账号状态已变化',401);
      const rows=(await c.query(`SELECT *,care_day::text AS day FROM member_points_checkin WHERE member_id=$1
        AND ($2::date IS NULL OR care_day<$2::date) ORDER BY care_day DESC LIMIT $3`,[id,before,limit+1])).rows;
      const total=(await c.query('SELECT count(*)::int AS n FROM member_points_checkin WHERE member_id=$1',[id])).rows[0].n;
      const items=rows.slice(0,limit).map(r=>({id:r.id,careDay:r.day,products:r.products,note:openPointsNote(this.config,r),version:r.version,
        completedAt:r.created_at.toISOString(),updatedAt:r.updated_at.toISOString()}));
      return {items,totalCount:total,nextBefore:rows.length>limit?items.at(-1)!.careDay:null};
    });
  }
  async policies(memberId:string|undefined){await this.authority.require(memberId,'commerce.money.reconcile');return (await this.pool.query(`SELECT p.*,COALESCE((SELECT jsonb_agg(jsonb_build_object('month',b.month_bucket,'issued',b.issued::text,'overReminder',p.monthly_budget IS NOT NULL AND b.issued>=p.monthly_budget) ORDER BY b.month_bucket DESC) FROM member_points_budget b WHERE b.policy_version=p.version),'[]'::jsonb) AS monthly_issuance FROM member_points_policy p ORDER BY p.created_at DESC LIMIT 50`)).rows;}
  async proposePolicy(memberId:string|undefined,input:unknown,now=new Date()){
    const b=object(input,['version','rules','monthlyBudget','startsAt','endsAt']);
    if(typeof b.version!=='string'||!/^[A-Za-z0-9._-]{8,80}$/.test(b.version)||b.monthlyBudget!=null&&(!Number.isSafeInteger(b.monthlyBudget)||Number(b.monthlyBudget)<1||Number(b.monthlyBudget)>100000000))fail('POINTS_POLICY_INVALID','请核对规则版本与可选预算提醒值');
    const rules=validClubRules(b.rules??clubRulesV1),starts=new Date(String(b.startsAt)),ends=b.endsAt==null?null:new Date(String(b.endsAt));
    if(!Number.isFinite(+starts)||ends!==null||starts<now)fail('POINTS_POLICY_WINDOW_INVALID','会员积分持续生效，请设置未来生效时间，结束日期留空');
    return transaction(this.pool,async c=>{const actor=await this.authority.requireWithClient(c,memberId,'commerce.money.reconcile');
      const row=(await c.query(`INSERT INTO member_points_policy(version,rules,monthly_budget,starts_at,ends_at,created_by)
        VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING RETURNING *`,[b.version,rules,b.monthlyBudget??null,starts,ends,actor])).rows[0];
      if(!row)fail('POINTS_POLICY_EXISTS','规则版本已存在，请核对',409);return row;
    });
  }
  async approvePolicy(memberId:string|undefined,version:string,input:unknown,now=new Date()){
    const b=object(input,['evidence']);if(typeof b.evidence!=='string'||b.evidence.trim().length<8||b.evidence.length>2000)fail('POINTS_APPROVAL_EVIDENCE_REQUIRED','请填写规则与会员权益的复核依据');
    const evidence=b.evidence.trim();return transaction(this.pool,async c=>{
      const actor=await this.authority.requireWithClient(c,memberId,'commerce.money.reconcile');
      await c.query("SELECT pg_advisory_xact_lock(hashtextextended('member-points-policy',0))");
      const p=(await c.query(`SELECT * FROM member_points_policy WHERE version=$1 FOR UPDATE`,[version])).rows[0];
      if(!p||p.state!=='draft'||p.created_by===actor||p.starts_at<now)fail('POINTS_INDEPENDENT_APPROVAL_REQUIRED','需要另一名授权人员在生效前复核',409);
      validClubRules(p.rules);
      const tail=(await c.query('SELECT starts_at FROM member_points_policy WHERE state=\'active\' FOR UPDATE')).rows[0];
      if(tail&&p.starts_at<=tail.starts_at)fail('POINTS_POLICY_SEQUENCE_CONFLICT','已有更晚生效的公示规则，请在该版之后安排新规则',409);
      await c.query(`UPDATE member_points_policy SET state='retired',retired_at=$1 WHERE state='active'`,[p.starts_at]);
      return (await c.query(`UPDATE member_points_policy SET state='active',approved_by=$2,approved_at=$3,approval_evidence=$4 WHERE version=$1 RETURNING *`,[version,actor,now,evidence])).rows[0];
    });
  }
  async selectFeatured(memberId:string|undefined,postId:string,input:unknown,at?:Date){
    const b=object(input,['reason']);if(typeof b.reason!=='string'||b.reason.trim().length<4||b.reason.trim().length>500)fail('POINTS_FEATURE_REASON_REQUIRED','请填写4至500字精选依据');
    const reason=b.reason.trim();return transaction(this.pool,async c=>{const actor=await this.authority.requireWithClient(c,memberId,'community.moderate');
      const now=at??(await c.query<{now:Date}>('SELECT clock_timestamp() AS now')).rows[0]!.now;
      const post=(await c.query(`SELECT * FROM ugc_post WHERE id=$1 AND state='published' AND visibility='public' FOR SHARE`,[uuid(postId)])).rows[0];
      if(!post)fail('POINTS_FEATURE_POST_UNAVAILABLE','只能精选当前公开的会员笔记',409);
      const selected=(await c.query(`INSERT INTO member_points_featured(post_id,selected_by,selected_at,reason) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING post_id`,[postId,actor,now,reason])).rowCount;
      if(selected)await c.query(`INSERT INTO member_points_source_event(kind,source_id,member_id,occurred_at) VALUES('featured',$1,$2,$3) ON CONFLICT DO NOTHING`,[postId,post.author_member_id,now]);
      return {selected:true,replayed:!selected};
    });
  }
}

async function contentReward(client:DbClient,event:any,policy:PointsPolicy){
  const {kind,source_id:sourceId,member_id:memberId,occurred_at:at}=event;
  let fingerprint:string,quota:number,bucket:string;
  if(kind==='post'||kind==='featured'){
    const p=(await client.query(`SELECT p.*,r.body FROM ugc_post p JOIN ugc_post_revision r ON r.post_id=p.id AND r.revision=p.published_revision WHERE p.id=$1`,[sourceId])).rows[0];
    if(!p||p.author_member_id!==memberId||p.state!=='published'||p.visibility!=='public')return;
    if(kind==='featured'&&!(await client.query('SELECT 1 FROM member_points_featured WHERE post_id=$1',[sourceId])).rowCount)return;
    const media=(await client.query<{sha256:string|null}>(`SELECT a.sha256 FROM ugc_post_media m JOIN ugc_media_asset a ON a.id=m.media_asset_id WHERE m.post_id=$1 AND m.revision=$2 ORDER BY a.sha256`,[sourceId,p.published_revision])).rows;
    if(!p.body&&!p.title&&!media.length)return;
    fingerprint=digest([(p.title??'').replace(/\s/g,''),(p.body??'').replace(/\s/g,''),media.map(m=>m.sha256)]);const d=new Date(pointDay(at)+'T00:00:00Z');d.setUTCDate(d.getUTCDate()-(d.getUTCDay()+6)%7);bucket=d.toISOString().slice(0,10);quota=kind==='post'?policy.rules.postWeeklyLimit:Number.POSITIVE_INFINITY;
  }else{
    const table=event.payload.table;if(!['ugc_comment','editorial_comment'].includes(table))throw new Error('POINTS_COMMENT_SOURCE_INVALID');
    const row=(await client.query(`SELECT c.*,p.author_member_id AS parent_author,${table==='ugc_comment'?"p.state='published' AND p.visibility='public'":"p.status='published'"} AS parent_public FROM ${table} c JOIN ${table==='ugc_comment'?'ugc_post':'editorial_article'} p ON p.id=c.${table==='ugc_comment'?'post_id':'article_id'} WHERE c.id=$1`,[event.payload.id])).rows[0];
    if(!row||row.author_member_id!==memberId||row.state!=='published'||!row.parent_public||row.parent_author===memberId||Array.from((row.body??'').replace(/\s/g,'')).length<5)return;
    fingerprint=digest(row.body.replace(/\s/g,''));quota=policy.rules.commentDailyLimit;bucket=pointDay(at);
  }
  await lockPointWallet(client,memberId,true);
  const prior=(await client.query('SELECT source_id FROM member_points_reward_fingerprint WHERE member_id=$1 AND kind=$2 AND fingerprint=$3',[memberId,kind,fingerprint])).rows[0];
  if(prior&&prior.source_id!==sourceId)return;
  const count=(await client.query(`SELECT count(*)::int AS n FROM points_grant WHERE member_id=$1 AND source_type=$2 AND rule_snapshot IS NOT NULL
    AND id IN (SELECT grant_id FROM points_entry WHERE entry_type='grant_available' AND metadata->>'bucket'=$3)`,[memberId,kind,bucket])).rows[0].n;
  if(count>=quota)return;
  await client.query(`INSERT INTO member_points_reward_fingerprint(member_id,kind,fingerprint,source_id) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`,[memberId,kind,fingerprint,sourceId]);
  await grantMemberPoints(client,{owner:memberId,sourceType:kind,sourceId,component:'base',amount:policy.rules[kind as 'post'|'featured'|'comment'],policy,now:at,bucket});
}
async function orderRewards(client:DbClient,orderId:string,now:Date,refundKey?:string){
  const row=(await client.query(`SELECT o.*,s.receipt_confirmed_at,p.verified_paid_at,p.amount_cents AS paid_cents,
    COALESCE((SELECT sum(i.eligible_merchandise_refund_cents+i.other_merchandise_refund_cents) FROM commission_refund_intent i JOIN commission_refund_inbox f ON f.refund_intent_id=i.id
      WHERE i.order_id=o.id AND f.state='applied' AND f.refund_status='SUCCESS'),0)::text AS refunded_cents
    FROM commerce_order o JOIN commission_payment_inbox p ON p.order_id=o.id AND p.state='applied'
    LEFT JOIN commerce_shipment s ON s.order_id=o.id WHERE o.id=$1 AND o.status='paid' AND o.transaction_source_kind='verified_commerce' FOR UPDATE OF o`,[orderId])).rows[0];
  if(!row)return;
  const policy=await pointPolicyByVersion(client,row.points_policy_version);if(!policy)return;
  const refunded=Number(row.refunded_cents),net=Math.max(0,Number(row.paid_cents)-refunded-Number(row.shipping_cents));
  if(refundKey)await returnOrderPoints(client,orderId,Math.min(refunded,Number(row.total_cents)-Number(row.shipping_cents)),now);
  const existing=(await client.query<{id:string;member_id:string;amount:number;component:string}>(`SELECT * FROM points_grant WHERE source_type='order' AND source_id=$1 ORDER BY member_id,id`,[orderId])).rows;
  if(refundKey){
    for(const g of existing){let target=net>0?g.amount:0;
      if(g.component==='shopping')target=Math.floor(net/100)*row.shopping_points_multiplier;
      if(g.component==='birthday')target=Math.floor(net/100)*row.shopping_points_multiplier*(policy.rules.birthdayMultiplier-1);
      await reverseMemberGrant(client,g.id,Math.max(0,g.amount-Math.min(g.amount,target)),refundKey,now,'订单退款撤回相应奖励');
    }
    return;
  }
  if(!row.receipt_confirmed_at||net<1)return;
  const memberId=row.member_id,rules=policy.rules;
  const grant=async(beneficiary:string,component:string,amount:number)=>grantMemberPoints(client,{owner:beneficiary,sourceType:'order',sourceId:orderId,component,amount,policy,now});
  await grant(memberId,'shopping',Math.floor(net/100)*row.shopping_points_multiplier);
  // First *verified paid* order, deterministic even if receipt events arrive out of order.
  const first=(await client.query<{id:string}>(`SELECT o.id FROM commerce_order o JOIN commission_payment_inbox p ON p.order_id=o.id AND p.state='applied'
    WHERE o.member_id=$1 AND o.status='paid' AND o.transaction_source_kind='verified_commerce' ORDER BY p.verified_paid_at,o.id LIMIT 1`,[memberId])).rows[0];
  if(first?.id===orderId)await grant(memberId,'first_order',rules.firstOrder);
  if(row.points_birthday_month===Number(pointDay(row.verified_paid_at).slice(5,7))){
    const month=pointDay(row.verified_paid_at).slice(0,7);
    const firstMonth=(await client.query<{id:string}>(`SELECT o.id FROM commerce_order o JOIN commission_payment_inbox p ON p.order_id=o.id AND p.state='applied'
      WHERE o.member_id=$1 AND o.status='paid' AND to_char(p.verified_paid_at AT TIME ZONE 'Asia/Shanghai','YYYY-MM')=$2 ORDER BY p.verified_paid_at,o.id LIMIT 1`,[memberId,month])).rows[0];
    if(firstMonth?.id===orderId)await grant(memberId,'birthday',Math.floor(net/100)*row.shopping_points_multiplier*(rules.birthdayMultiplier-1));
  }
  if(first?.id===orderId){
    const ref=(await client.query(`SELECT * FROM member_points_referral WHERE member_id=$1 AND created_at<=$2`,[memberId,row.verified_paid_at])).rows[0];
    if(ref){const active=(await client.query("SELECT 1 FROM member WHERE id=$1 AND status='active'",[ref.referrer_member_id])).rowCount;
      if(active){await grant(ref.referrer_member_id,'invite_sponsor',rules.inviteSponsor);await grant(memberId,'invite_friend',rules.inviteFriend);}}
  }
}
async function applySource(client:DbClient,event:any){
  const {member_id:id,source_id:source,kind,occurred_at:now}=event;
  if(kind==='refund'){await orderRewards(client,event.payload.orderId,now,source);return;}
  if(kind.endsWith('_removed')){
    const type=kind==='post_removed'?'post':'comment';
    const grants=(await client.query<{id:string;amount:number}>(`SELECT id,amount FROM points_grant WHERE member_id=$1 AND source_id=$2 AND source_type=ANY($3::text[])`,[id,source,type==='post'?['post','featured']:['comment']])).rows;
    for(const g of grants)await reverseMemberGrant(client,g.id,g.amount,`${kind}:${source}`,now,'计分内容已删除或下架');return;
  }
  const member=(await client.query("SELECT status FROM member WHERE id=$1",[id])).rows[0];if(member?.status!=='active')return;
  if(kind==='receipt'){await orderRewards(client,source,now);return;}
  const policy=await activePointPolicy(client,now);if(!policy)return;
  if(kind==='care_cycle'){
    const r=(await client.query(`SELECT r.self_assessment,array_agg(s.step_code ORDER BY s.sequence) AS steps
      FROM care_record r JOIN care_cycle c ON c.id=r.cycle_id JOIN care_record_step s ON s.record_id=r.id
      WHERE r.id=$1 AND c.member_id=$2 GROUP BY r.id`,[source,id])).rows[0];
    if(r?.self_assessment&&r.steps?.join()==='00,01,02,03')await attendance(client,id,pointDay(now),source,policy,now);
  }else if(kind==='care'){
    const r=(await client.query(`SELECT * FROM daily_care_record WHERE id=$1 AND member_id=$2 AND suppressed_at IS NULL`,[source,id])).rows[0];
    if(r&&r.step_codes?.join()==='00,01,02,03')await attendance(client,id,pointDay(now),source,policy,now);
  }else if(kind==='questionnaire'){
    const r=(await client.query('SELECT completed_at FROM member_care_profile WHERE member_id=$1',[id])).rows[0];
    if(r?.completed_at)await grantMemberPoints(client,{owner:id,sourceType:'questionnaire',sourceId:id,component:'base',amount:policy.rules.questionnaire,policy,now});
  }else if(['post','featured','comment'].includes(kind))await contentReward(client,event,policy);
}
export async function processMemberPointSources(pool:pg.Pool,now=new Date(),limit=30){
  const ids=(await pool.query<{id:string}>(`SELECT id FROM member_points_source_event WHERE state='pending' AND next_attempt_at<=$1 ORDER BY id LIMIT $2`,[now,limit])).rows;
  let processed=0;
  for(const {id} of ids){
    try{await transaction(pool,async c=>{
      const e=(await c.query(`SELECT * FROM member_points_source_event WHERE id=$1 AND state='pending' AND next_attempt_at<=$2 FOR UPDATE SKIP LOCKED`,[id,now])).rows[0];if(!e)return;
      await applySource(c,e);await c.query(`UPDATE member_points_source_event SET state='applied',processed_at=$2,attempts=attempts+1,last_error=NULL WHERE id=$1`,[id,now]);processed++;
    });}catch(error){const code=error instanceof DomainError?error.code:typeof (error as {code?:unknown}).code==='string'?'POINTS_SOURCE_SQL_'+(error as {code:string}).code:'POINTS_SOURCE_RETRY';
      await pool.query(`UPDATE member_points_source_event SET attempts=attempts+1,last_error=$2,next_attempt_at=$3::timestamptz+interval '1 minute' WHERE id=$1 AND state='pending'`,[id,code,now]);}
  }
  const members=(await pool.query<{member_id:string}>(`SELECT DISTINCT g.member_id FROM points_lot l JOIN points_grant g ON g.id=l.grant_id
    WHERE (l.available_amount>0 OR l.frozen_amount>0) AND (l.expires_at<=$1 OR l.frozen_amount>0 AND g.available_after<=$1) LIMIT $2`,[now,limit])).rows;
  for(const row of members)await transaction(pool,c=>sweepMemberPoints(c,row.member_id,now));
  return processed;
}

export async function saveMemberUsage(c:DbClient,config:AppConfig,memberId:string|undefined,keyInput:string,input:unknown,now:Date){
    const id=owner(memberId),key=operation(keyInput),b=object(input,['products','note','serverDay','expectedVersion']);
    if(!Array.isArray(b.products)||b.products.length<1||b.products.length>3||new Set(b.products).size!==b.products.length||b.products.some(x=>!['net_run','net_xie','essence'].includes(String(x))))fail('POINTS_PRODUCTS_INVALID','请如实选择今天使用的产品');
    const products=(b.products as string[]).sort(),note=typeof b.note==='string'?b.note.trim():'';
    if(Array.from(note).length>500||b.note!==undefined&&typeof b.note!=='string')fail('POINTS_NOTE_INVALID','护理感受最多500字');
    const requestHash=createHmac('sha256',textKey(config)).update(JSON.stringify(['points-checkin-command',id,products,note,b.serverDay,b.expectedVersion??null])).digest('hex');
      await lockPointWallet(c,id,true);
      const priorCommand=(await c.query('SELECT action,request_sha256 FROM member_points_command WHERE member_id=$1 AND operation_id=$2',[id,key])).rows[0];
      if(priorCommand&&(priorCommand.action!=='checkin'||priorCommand.request_sha256!==requestHash))fail('IDEMPOTENCY_CONFLICT','本次操作编号已用于其他内容',409);
      const replay=(await c.query(`SELECT m.*,r.care_day::text FROM member_points_command m JOIN member_points_checkin r ON r.id=m.source_id WHERE m.member_id=$1 AND m.operation_id=$2`,[id,key])).rows[0];
      if(replay){if(replay.request_sha256!==requestHash||replay.action!=='checkin')fail('IDEMPOTENCY_CONFLICT','本次操作编号已用于其他内容',409);return {recordId:replay.source_id,operationId:key,replayed:true,careDay:replay.care_day};}
      const day=pointDay(now);if(b.serverDay!==day)fail('POINTS_DAY_CHANGED','日期已更新，请重新加载后打卡',409);
      const policy=await activePointPolicy(c,now);
      const old=(await c.query(`SELECT * FROM member_points_checkin WHERE member_id=$1 AND care_day=$2 FOR UPDATE`,[id,day])).rows[0];
      if(old&&old.version!==b.expectedVersion||!old&&b.expectedVersion!==undefined)fail('POINTS_CHECKIN_CHANGED','今天的记录已有更新，请重新加载',409);
      const recordId=old?.id??randomUUID(),encrypted=sealNote(config,id,recordId,note),chars=Array.from(note.replace(/\s/g,''));
      const noteQualifies=chars.length>=10&&new Set(chars).size>=4;
      const row=(await c.query(`INSERT INTO member_points_checkin(id,member_id,care_day,products,note_encrypted,key_version,note_qualifies,operation_id,request_sha256,created_at,updated_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10) ON CONFLICT(member_id,care_day) DO UPDATE SET products=$4,note_encrypted=$5,key_version=$6,
          note_qualifies=$7,operation_id=$8,request_sha256=$9,version=member_points_checkin.version+1,updated_at=$10 RETURNING *`,
        [recordId,id,day,products,encrypted,encrypted?config.contacts.keyVersion:null,noteQualifies,key,requestHash,now])).rows[0];
      const streak=policy?await attendance(c,id,day,recordId,policy,now):await streakFor(c,id,day);
      if(noteQualifies&&policy)await grantMemberPoints(c,{owner:id,sourceType:'care_day',sourceId:day,component:'note',amount:policy.rules.note,policy,now});
      await c.query(`INSERT INTO member_points_command(member_id,operation_id,action,source_id,request_sha256,created_at) VALUES($1,$2,'checkin',$3,$4,$5)`,[id,key,recordId,requestHash,now]);
      return {recordId:row.id,operationId:key,replayed:false,careDay:day,version:row.version,streak};
}

export function privateUsageDigest(config:AppConfig,memberId:string,input:unknown){
  return createHmac('sha256',textKey(config)).update(JSON.stringify(['care-usage',memberId,input])).digest('hex');
}
