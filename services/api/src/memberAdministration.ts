import type pg from 'pg';
import type {AppConfig} from '@cisme/config';
import type {Capability} from '@cisme/contracts';
import {createHash,randomUUID} from 'node:crypto';
import {AuthorityService,requireActiveMemberWithClient} from './authority.js';
import {transaction,type DbClient} from './db.js';
import {userProjectionSql} from './memberAdministrationSql.js';
import {userInput,userQuery,userQueryAccess,userId,userPhoneHash,userCursorScope,userCursor,userNext,userNumber,userReason,userFail,type UserScope,type UserQuery} from './memberAdministrationPolicy.js';
import {DeliveryAddressService} from './deliveryAddress.js';
import {openContact} from './privacyPortableData.js';
import {careQuestions,careProfilePortableQuery,openCareAnswers} from './careOnboarding.js';
import {memberAdministrationSection} from './memberAdministrationSections.js';
import {csvCell} from './sharingOfficerPolicy.js';
type Row=Record<string,any>;
export class MemberAdministration{
 readonly authority:AuthorityService;
 constructor(readonly pool:pg.Pool,readonly config:AppConfig){this.authority=new AuthorityService(pool,config.env);}
 async context(c:DbClient,actorId:string|undefined){
  const actor=await requireActiveMemberWithClient(c,actorId);
  const grants=(await c.query<{capability:Capability;expires_at:Date|null}>("SELECT capability,expires_at FROM authority_grant WHERE member_id=$1 AND environment=$2 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>clock_timestamp()) ORDER BY capability,id FOR SHARE",[actor,this.config.env])).rows;
  const clock=(await c.query<{at:Date}>('SELECT clock_timestamp() AS at')).rows[0]!.at;
  const caps=grants.filter(g=>g.expires_at===null||g.expires_at>clock).map(r=>r.capability);
  if(!caps.includes('member.profile.read'))userFail('CAPABILITY_REQUIRED','当前账号没有用户管理权限',403);
  const has=(cap:Capability)=>caps.includes(cap),scope:UserScope={profile:true,contact:has('member.contact.read'),care:has('member.care.read'),orders:has('commerce.order.read'),points:has('commerce.money.reconcile'),rewards:has('commerce.fulfillment.manage')||has('commerce.product.manage')&&has('member.manage'),issueRewards:has('commerce.product.manage')&&has('member.manage'),sharing:has('commission.read')||has('member.manage')||has('commission.settlement.approve'),commission:has('commission.read')||has('commission.settlement.approve'),finance:has('commission.settlement.approve'),support:has('support.read'),privacy:has('privacy.request.manage'),moderate:has('community.moderate')||has('editorial.manage'),manage:has('member.manage'),export:has('member.export')};
  // All currently granted scopes remain locked until projection and audit commit.
  return {actor,scope,caps};
 }
 async audit(c:DbClient,actor:string,target:string|null,action:string,details:Row={}){await c.query(`INSERT INTO audit_log(principal_id,action,object_type,object_id,reason_code,after_state,trace_id)
 VALUES($1,$2,'member',$3,'MEMBER_ADMINISTRATION',$4,$5)`,[`member:${actor}`,action,target,details,randomUUID()]);}
 row(r:Row,s:UserScope){
  const unlock=userNumber(r.unlock_frozen),expired=userNumber(r.expired_available),expiredFrozen=userNumber(r.expired_frozen),base=userNumber(r.points_available)-expired+unlock,
   offset=unlock>0?Math.min(userNumber(r.points_debt),Math.max(0,base)):0;
  return {id:r.id,displayName:r.display_name,cardNumber:r.card_number?`No. ${r.card_number.padStart(5,'0')}`:null,avatar:r.avatar_data_url??null,avatarRevision:r.avatar_revision??null,profileVersion:r.profile_revision??0,accountStatus:r.account_status,createdAt:r.created_at,
   phoneMasked:r.phone_masked??null,onboarding:r.care_erased_at?'erased':r.onboarding_completed_at?'complete':'incomplete',
   points:s.points?{available:Math.max(0,base-offset),frozen:Math.max(0,userNumber(r.points_frozen)-expiredFrozen-unlock),reserved:userNumber(r.points_reserved),debt:Math.max(0,userNumber(r.points_debt)-offset),updatedAt:r.wallet_updated_at??null,projected:unlock+expired+expiredFrozen>0}:null,
   commerce:s.orders?{orderCount:userNumber(r.order_count),paidOrderCount:userNumber(r.paid_count),paidCents:userNumber(r.paid_cents),refundedCents:userNumber(r.refunded_cents),netCents:userNumber(r.paid_cents)-userNumber(r.refunded_cents),openAftersales:userNumber(r.aftersale_count)}:null,
   activity:{careDays:s.care?userNumber(r.care_days):null,streak:s.care?userNumber(r.streak):null,publicPosts:userNumber(r.post_count),recentAt:r.recent_at??null},
   rewards:s.rewards?{availableCoupons:userNumber(r.usable_coupons),unclaimedRewards:userNumber(r.unclaimed_rewards)}:null,
   sharing:s.sharing?{state:r.officer_state??'none',code:r.officer_code??null,version:r.officer_version??null,referrerCode:r.referrer_code??null,referrerSource:r.referrer_source??null,directCount:userNumber(r.direct_count)}:null};
 }
 private canonicalOnly(){return !['test','development'].includes(this.config.env);}
 private search(query:UserQuery,scope:UserScope,args:unknown[]){
  const p=(v:unknown)=>{args.push(v);return '$'+args.length;};const conds=[] as string[];
  if(query.account!=='all')conds.push(`u.account_status=${p(query.account)}`);
  if(query.onboarding!=='all')conds.push(query.onboarding==='complete'?`u.onboarding_completed_at IS NOT NULL AND u.care_erased_at IS NULL`:`(u.onboarding_completed_at IS NULL OR u.care_erased_at IS NOT NULL)`);
  if(query.officer!=='all')conds.push(query.officer==='none'?'u.officer_state IS NULL':`u.officer_state=${p(query.officer)}`);
  if(query.q){const phone=userPhoneHash(query.q,this.config,scope),number=/^(?:No\.?\s*)?0*(\d{1,10})$/i.exec(query.q);
   if(phone)conds.push(`EXISTS(SELECT 1 FROM member_contact x WHERE x.member_id=u.id AND x.phone_hmac=${p(phone)})`);
   else if(number)conds.push(`u.card_number::bigint=${p(number[1])}::bigint`);
   else if(/^[0-9a-f-]{36}$/i.test(query.q))conds.push(`u.id=${p(userId(query.q))}::uuid`);
   else conds.push(`strpos(lower(u.display_name),lower(${p(query.q)}))>0`);
  }return conds.length?conds.map(c=>'('+c+')').join(' AND '):'true';
 }
 private sort(query:UserQuery){return ({registered:'u.created_at',number:'COALESCE(u.card_number::bigint,0)',paid:'u.paid_cents::bigint',points:'GREATEST(u.points_available-u.expired_available+u.unlock_frozen-CASE WHEN u.unlock_frozen>0 THEN LEAST(u.points_debt,GREATEST(0,u.points_available-u.expired_available+u.unlock_frozen)) ELSE 0 END,0)',care:'u.care_days',recent:"COALESCE(u.recent_at,'1970-01-01'::timestamptz)"} as Record<string,string>)[query.sort]!;}
 async list(actorId:string|undefined,input:Record<string,unknown>={}){
  const query=userQuery(input);return transaction(this.pool,async c=>{
   const {actor,scope}=await this.context(c,actorId);userQueryAccess(query,scope);
   const now=new Date(),args:unknown[]=[now],where=this.search(query,scope,args),base=userProjectionSql(scope,this.canonicalOnly()),key=userCursorScope(actor,query,scope),cursor=userCursor(query.cursor,key,query.sort),sort=this.sort(query),order=query.direction==='asc'?'ASC':'DESC';
   const totalArgs=[...args],boundary=cursor?`AND (${sort},u.id)${order==='ASC'?'>':'<'}($${args.push(cursor.value)}::${['registered','recent'].includes(query.sort)?'timestamptz':'bigint'},$${args.push(cursor.id)}::uuid)`:'';
   args.push(query.limit+1);
   const rows=(await c.query(`WITH u AS(${base}) SELECT u.*,(${sort})::text AS sort_value FROM u WHERE ${where} ${boundary} ORDER BY ${sort} ${order},u.id ${order} LIMIT $${args.length}`,args)).rows;
   const count=(await c.query(`WITH u AS(${base}) SELECT count(*)::int AS count FROM u WHERE ${where}`,totalArgs)).rows[0].count;
   const page=rows.slice(0,query.limit),last=page.at(-1);await this.audit(c,actor,null,'member.admin.list',{view:query.view,resultCount:page.length,searchUsed:Boolean(query.q),phoneSearch:Boolean(userPhoneHash(query.q,this.config,scope))});
   return {scope,query:{...query,cursor:undefined,q:query.q},items:page.map(r=>this.row(r,scope)),total:count,nextCursor:rows.length>query.limit&&last?userNext(key,last.sort_value,last.id):null,asOf:now};
  },'REPEATABLE READ');
 }
 async target(c:DbClient,target:string,scope:UserScope){const r=(await c.query(`WITH u AS(${userProjectionSql(scope,this.canonicalOnly())})SELECT * FROM u WHERE id=$2`,[new Date(),userId(target)])).rows[0];if(!r)userFail('MEMBER_NOT_FOUND','会员不存在或已注销',404);return this.row(r,scope);}
 async overview(actorId:string|undefined,target:string){return transaction(this.pool,async c=>{const{actor,scope}=await this.context(c,actorId),member=await this.target(c,target,scope);
  await this.audit(c,actor,member.id,'member.admin.view');return {member,scope};
 },'REPEATABLE READ');}
 async profile(c:DbClient,target:string,scope:UserScope){
  const base=(await c.query(`SELECT mp.wechat_handle,mp.completed_at,mp.updated_at,mp.profile_revision,b.birthday_month_day,c.bound_at,
   cp.erased_at,cp.version AS care_version FROM member m LEFT JOIN member_profile mp ON mp.member_id=m.id LEFT JOIN member_points_profile b ON b.member_id=m.id
   LEFT JOIN member_contact c ON c.member_id=m.id LEFT JOIN member_care_profile cp ON cp.member_id=m.id WHERE m.id=$1`,[target])).rows[0];
  const care=(await c.query(careProfilePortableQuery,[target])).rows[0];
  const answers=care&&base.erased_at==null?openCareAnswers(this.config,care):null;
  const questions=careQuestions.filter(q=>!q.sensitive||scope.care).map(q=>{const a=answers?.[q.id];return {id:q.id,title:q.title,sensitive:q.sensitive,status:a?.status??'unanswered',values:a?.values.map(v=>q.options.find(o=>o.value===v)?.label??v)??[]};});
  const agreements=(await c.query(`SELECT DISTINCT ON(document_type) document_type AS type,document_version AS version,accepted_at AS "acceptedAt" FROM consent_acceptance WHERE member_id=$1 AND document_type IN ('terms','privacy') ORDER BY document_type,accepted_at DESC,id DESC`,[target])).rows;
  const grants=scope.manage?(await c.query("SELECT capability FROM authority_grant WHERE member_id=$1 AND environment=$2 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>clock_timestamp()) ORDER BY capability",[target,this.config.env])).rows.map(r=>r.capability):undefined;
  return {agreements,...(grants?{capabilities:grants}:{}),birthday:base.birthday_month_day??null,wechatHandle:scope.contact?base.wechat_handle??null:null,profileVersion:base.profile_revision??0,updatedAt:base.updated_at??null,phoneBoundAt:base.bound_at??null,
   questionnaire:care?{version:care.version,completedAt:care.completed_at,erasedAt:base.erased_at??null,healthChoice:scope.care?care.health_choice:undefined,questions:base.erased_at?[]:questions}:null};
 }
 async section(actorId:string|undefined,targetInput:string,section:string,input:Record<string,unknown>={}){const target=userId(targetInput);return transaction(this.pool,async c=>{
  const{actor,scope,caps}=await this.context(c,actorId);await this.target(c,target,scope);
  const result=await memberAdministrationSection(this,c,actor,target,section,input,scope,caps);await this.audit(c,actor,target,'member.admin.section',{section,purpose:section==='care'||section==='profile'&&scope.care?'care_profile_and_sample_selection':undefined});return result;
 },'REPEATABLE READ');}
 async contact(actorId:string|undefined,targetInput:string,input:Record<string,unknown>={}){input=userInput(input,['kind','addressId','reason']);const target=userId(targetInput),reason=userReason(input.reason);return transaction(this.pool,async c=>{
  const{actor,scope}=await this.context(c,actorId);if(!scope.contact)userFail('CAPABILITY_REQUIRED','当前账号没有联系资料查看权限',403);await this.target(c,target,scope);
  if(input.kind==='address'){
   const address=await new DeliveryAddressService(this.pool,this.config).administrationAddress(c,target,userId(input.addressId));
   await this.audit(c,actor,target,'member.admin.contact.view',{reason,fields:['address'],addressId:input.addressId});return {address,expiresInSeconds:60};
  }
  if(input.kind!==undefined&&input.kind!=='phone')userFail('USER_CONTACT_KIND_INVALID','联系资料分类无效');
  const row=(await c.query('SELECT phone_encrypted,key_version FROM member_contact WHERE member_id=$1',[target])).rows[0];const phone=openContact(this.config,target,row);
  await this.audit(c,actor,target,'member.admin.contact.view',{reason,fields:phone?['phone']:[]});return {phone,expiresInSeconds:60};
 });}
 async export(actorId:string|undefined,input:Record<string,unknown>={}){
  input=userInput(input,['query','ids']);const query=userQuery((input.query===undefined?{}:input.query) as Record<string,unknown>);let ids:string[]|null=null;
  if(input.ids!==undefined){if(!Array.isArray(input.ids)||!input.ids.length||input.ids.length>500)userFail('USER_EXPORT_SELECTION_INVALID','请核对所选用户');ids=[...new Set(input.ids.map(userId))];}
  return transaction(this.pool,async c=>{const{actor,scope}=await this.context(c,actorId);if(!scope.export)userFail('CAPABILITY_REQUIRED','当前账号没有用户导出权限',403);userQueryAccess(query,scope);
   const args:unknown[]=[new Date()],where=this.search(query,scope,args),selection=ids?`AND u.id=ANY($${args.push(ids)}::uuid[])`:'';
   const rows=(await c.query(`WITH u AS(${userProjectionSql(scope,this.canonicalOnly())})SELECT * FROM u WHERE ${where} ${selection} ORDER BY ${this.sort(query)} ${query.direction==='asc'?'ASC':'DESC'},u.id LIMIT 10001`,args)).rows;
   if(rows.length>10000)userFail('USER_EXPORT_TOO_LARGE','结果较多，请缩小筛选后导出；没有导出部分结果');if(ids&&rows.length!==ids.length)userFail('USER_EXPORT_SELECTION_CHANGED','所选用户已变化，请刷新后重新选择',409);
   const heads=['会员编号','昵称','账号状态','建档状态','注册时间',...(scope.orders?['已付订单','实付金额','退款金额']:[]),...(scope.points?['可用积分','冻结积分','订单预占']:[]),...(scope.care?['护理天数','当前连续天数']:[]),...(scope.rewards?['可用正装券','待领取活动奖励']:[]),...(scope.sharing?['分享官状态','分享官编号']:[])];
   const data=rows.map(r=>{const m=this.row(r,scope);return [m.cardNumber??'',m.displayName,m.accountStatus,m.onboarding,new Date(m.createdAt).toISOString(),...(m.commerce?[m.commerce.paidOrderCount,(m.commerce.paidCents/100).toFixed(2),(m.commerce.refundedCents/100).toFixed(2)]:[]),...(m.points?[m.points.available,m.points.frozen,m.points.reserved]:[]),...(scope.care?[m.activity.careDays,m.activity.streak]:[]),...(m.rewards?[m.rewards.availableCoupons,m.rewards.unclaimedRewards]:[]),...(m.sharing?[m.sharing.state,m.sharing.code??'']:[])];});
   const csv='\uFEFF'+[heads,...data].map(row=>row.map(csvCell).join(',')).join('\r\n');if(Buffer.byteLength(csv)>4*1024*1024)userFail('USER_EXPORT_TOO_LARGE','导出文件较大，请缩小筛选；没有导出部分结果');
   await this.audit(c,actor,null,'member.admin.export',{count:rows.length,selection:Boolean(ids),view:query.view,sha256:createHash('sha256').update(csv).digest('hex'),fields:heads});return {csv,count:rows.length,asOf:args[0]};
  },'REPEATABLE READ');
 }
}
