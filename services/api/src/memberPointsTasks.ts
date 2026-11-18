import {createCipheriv,createDecipheriv,createHash,randomBytes,randomUUID} from 'node:crypto';
import type pg from 'pg';
import type {AppConfig} from '@cisme/config';
import {DomainError} from '@cisme/domain';
import {transaction,type DbClient} from './db.js';
import {AuthorityService,requireActiveMemberWithClient} from './authority.js';
import {activePointPolicy,pointRulesV2,pointDay,hanCount,lockPointWallet,grantMemberPoints,type PointsPolicy} from './pointsLedger.js';
const fail=(code:string,title:string,status=422):never=>{throw new DomainError(code,title,status);};
const digest=(v:string)=>createHash('sha256').update(v).digest('hex');
const id=(v:unknown)=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(v)?v:fail('POINTS_ID_INVALID','记录编号无效');
export async function taskGrantCount(c:DbClient,owner:string,type:string,component:string,bucket:string){
 return (await c.query<{n:number}>(`SELECT count(*)::int AS n FROM points_grant g WHERE g.member_id=$1 AND g.source_type=$2 AND g.component=$3
  AND EXISTS(SELECT 1 FROM points_entry e WHERE e.grant_id=g.id AND e.entry_type='grant_available' AND ($4='' OR e.metadata->>'bucket'=$4))`,[owner,type,component,bucket])).rows[0]!.n;
}
export async function rewardV2Post(c:DbClient,event:any,p:PointsPolicy,post:any,fingerprint:string){
 const owner=event.member_id,source=event.source_id,now=event.occurred_at,day=pointDay(now),month=day.slice(0,7),r=p.rules;
 await lockPointWallet(c,owner,true);
 const duplicate=(await c.query('SELECT source_id FROM member_points_reward_fingerprint WHERE member_id=$1 AND kind=\'post\' AND fingerprint=$2',[owner,fingerprint])).rows[0];
 if(duplicate&&duplicate.source_id!==source)return;
 await c.query(`INSERT INTO member_points_reward_fingerprint(member_id,kind,fingerprint,source_id) VALUES($1,'post',$2,$3) ON CONFLICT DO NOTHING`,[owner,fingerprint,source]);
 const first=(await c.query('SELECT id FROM ugc_post WHERE author_member_id=$1 AND published_at IS NOT NULL ORDER BY published_at,id LIMIT 1',[owner])).rows[0];
 if(first?.id===source)await grantMemberPoints(c,{owner,sourceType:'post',sourceId:source,component:'first_post',amount:r.firstPost??0,policy:p,now,bucket:'once'});
 if(hanCount(post.body??'')<(r.postMinHan??15)||post.ai_usage==='generated')return;
 const experience=post.reward_kind==='experience';
 if(experience&&(!post.experience_product_code||!post.experience_days||hanCount(post.body??'')<(r.experienceMinHan??30)))return;
 if(experience&&!(await c.query("SELECT 1 FROM catalog_product WHERE code=$1 AND qualification_status='eligible'",[post.experience_product_code])).rowCount)return;
 const component=experience?'experience':'original',limit=experience?r.experienceMonthlyLimit:r.originalMonthlyLimit;
 if(!limit||await taskGrantCount(c,owner,'post',component,month)>=limit)return;
 await grantMemberPoints(c,{owner,sourceType:'post',sourceId:source,component,amount:(experience?r.experiencePost:r.originalPost)??0,policy:p,now,bucket:month});
}
export async function captureValidContentShare(c:DbClient,row:{visit_id:string;sharer_member_id:string;target_type:string;target_ref:string},visitor:string,now:Date){
 const policy=await activePointPolicy(c,now);if(!policy||!pointRulesV2(policy.rules)||!policy.rules.share||row.target_type!=='post'||row.sharer_member_id===visitor)return;
 const source=`${row.sharer_member_id}:${row.target_ref}:${pointDay(now)}`;
 await c.query(`INSERT INTO member_points_source_event(kind,source_id,member_id,occurred_at,payload) VALUES('share',$1,$2,$3,$4) ON CONFLICT DO NOTHING`,
 [source,row.sharer_member_id,now,{visitId:row.visit_id,visitorId:visitor,postId:row.target_ref}]);
}
export async function rewardV2Other(c:DbClient,event:any,p:PointsPolicy){
 if(!pointRulesV2(p.rules))return;
 const owner=event.member_id,source=event.source_id,now=event.occurred_at,r=p.rules;
 await lockPointWallet(c,owner,true);
 if(event.kind==='profile'){
  const row=(await c.query(`SELECT m.display_name,p.completed_at,p.avatar_data_url,
      m.registration_completed_at<=e.occurred_at AS reward_eligible
    FROM member m JOIN member_profile p ON p.member_id=m.id
    JOIN member_points_source_event e ON e.member_id=m.id AND e.id=$2 WHERE m.id=$1`,[owner,event.id])).rows[0];
  // Initial login saves the required profile before registration completes.
  // It is identity confirmation, not a rewarded optional member action.
  // Earlier promised profile-completion tasks and earned points stay intact.
  if(row?.reward_eligible&&row.completed_at&&row.avatar_data_url&&!/^CISME\s*会员(?:\s*\d+)?$/i.test(row.display_name))await grantMemberPoints(c,{owner,sourceType:'profile',sourceId:owner,component:'base',amount:r.profile??0,policy:p,now});
 }else if(event.kind==='suggestion'){
  const row=(await c.query("SELECT 1 FROM member_points_suggestion WHERE id=$1 AND member_id=$2 AND state='approved'",[source,owner])).rowCount;
  const bucket=pointDay(now).slice(0,7);if(row&&r.suggestionMonthlyLimit&&await taskGrantCount(c,owner,'suggestion','base',bucket)<r.suggestionMonthlyLimit)
   await grantMemberPoints(c,{owner,sourceType:'suggestion',sourceId:source,component:'base',amount:r.suggestion??0,policy:p,now,bucket});
 }else if(event.kind==='share'){
  const b=event.payload,row=(await c.query(`SELECT 1 FROM share_visit v JOIN share_link l ON l.id=v.share_link_id JOIN member m ON m.id=v.visitor_member_id
   WHERE v.id=$1 AND v.visitor_member_id=$2 AND l.member_id=$3 AND l.target_type='post' AND l.target_ref=$4 AND l.state<>'revoked'
    AND m.status='active' AND v.visitor_member_id<>l.member_id AND (
     EXISTS(SELECT 1 FROM ugc_post p JOIN member a ON a.id=p.author_member_id WHERE p.id::text=l.target_ref AND p.state='published' AND p.visibility='public' AND a.status='active')
     OR EXISTS(SELECT 1 FROM editorial_article a WHERE a.id::text=l.target_ref AND a.status='published'))`,[b.visitId,b.visitorId,owner,b.postId])).rowCount;
  const bucket=pointDay(now);if(row&&r.shareDailyLimit&&await taskGrantCount(c,owner,'share','base',bucket)<r.shareDailyLimit)
   await grantMemberPoints(c,{owner,sourceType:'share',sourceId:source,component:'base',amount:r.share??0,policy:p,now,bucket});
 }
}
export function pointsTaskDefinitions(p:PointsPolicy,now:Date){const r=p.rules;if(!pointRulesV2(r))return [];const day=pointDay(now),month=day.slice(0,7);
 return [
  {id:'daily',title:'记录今日护理',amount:r.daily,limit:1,type:'care_day',component:'daily',bucket:day,condition:'每日首次有效记录',destination:'care'},
  {id:'note',title:'记下护理感受',amount:r.note,limit:1,type:'care_day',component:'note',bucket:day,condition:'每日首次有效感受，至少10个有效字',destination:'care'},
  {id:'streak7',title:'连续护理7天',amount:r.streak7,limit:1,type:'care_streak',component:'streak7',bucket:day,condition:'连续7天，每周期一次',destination:'care'},
  {id:'streak30',title:'连续护理30天',amount:r.streak30,limit:1,type:'care_streak',component:'streak30',bucket:day,condition:'连续30天，每周期一次',destination:'care'},
  {id:'questionnaire',title:'完成护理问卷',amount:r.questionnaire,limit:1,type:'questionnaire',component:'base',bucket:'',condition:'首次完整提交',destination:'questionnaire'},
  {id:'profile',title:'原会员资料补全',amount:r.profile,limit:1,type:'profile',component:'base',bucket:'',condition:'已建档会员首次补全，首次登录不计分',destination:'profile'},
  {id:'firstPost',title:'第一次分享',amount:r.firstPost,limit:1,type:'post',component:'first_post',bucket:'',condition:'首次发布，通过安全检查',destination:'post'},
  {id:'original',title:'原创护理心得',amount:r.originalPost,limit:r.originalMonthlyLimit,type:'post',component:'original',bucket:month,condition:`每月${r.originalMonthlyLimit}篇，至少${r.postMinHan}个汉字`,destination:'post'},
  {id:'experience',title:'产品使用体验',amount:r.experiencePost,limit:r.experienceMonthlyLimit,type:'post',component:'experience',bucket:month,condition:`每月${r.experienceMonthlyLimit}篇，关联产品、使用时长与真实感受`,destination:'experience'},
  {id:'comment',title:'认真参与讨论',amount:r.comment,limit:r.commentDailyLimit,type:'comment',component:'base',bucket:day,condition:`不少于${r.commentMinHan}个汉字，每日${r.commentDailyLimit}条`,destination:'community'},
  {id:'share',title:'分享一篇好内容',amount:r.share,limit:r.shareDailyLimit,type:'share',component:'base',bucket:day,condition:`他人有效访问，每日${r.shareDailyLimit}篇`,destination:'community'},
  {id:'suggestion',title:'提出改进建议',amount:r.suggestion,limit:r.suggestionMonthlyLimit,type:'suggestion',component:'base',bucket:month,condition:`有效、不重复，审核后到账；每月${r.suggestionMonthlyLimit}次`,destination:'suggestion'},
  {id:'firstOrder',title:'首次购买',amount:r.firstOrder,limit:1,type:'order',component:'first_order',bucket:'',condition:`首笔有效支付；受邀新会员改得${r.inviteFriend}分`,destination:'shop'},
  {id:'invite',title:'邀请朋友首购',amount:r.inviteSponsor,limit:0,type:'order',component:'invite_sponsor',bucket:'',condition:`朋友通过分享注册并首购，朋友得${r.inviteFriend}分`,destination:'invite'}
 ];
}
export async function pointsTaskStatus(c:DbClient,owner:string,p:PointsPolicy,now:Date,streakDay:string){
 const definitions=pointsTaskDefinitions(p,now);

 const counts=(await c.query<{source_type:string;component:string;bucket:string;n:number;amount:number}>(`SELECT g.source_type,g.component,
   CASE WHEN g.source_type IN ('care_day','care_streak') THEN g.source_id ELSE COALESCE(e.metadata->>'bucket','') END AS bucket,
   count(*)::int AS n,max(g.amount)::int AS amount
   FROM points_grant g JOIN points_entry e ON e.grant_id=g.id AND e.entry_type='grant_available'
   WHERE g.member_id=$1 GROUP BY 1,2,3`,[owner])).rows;
 const pending=(await c.query<{kind:string;day:string;note_qualifies:boolean|null}>(`SELECT DISTINCT kind,
   (occurred_at AT TIME ZONE 'Asia/Shanghai')::date::text AS day,
   payload->>'noteQualifies'='true' AS note_qualifies
   FROM member_points_source_event WHERE member_id=$1 AND state='pending'`,[owner])).rows;
 const suggestionPending=(await c.query("SELECT 1 FROM member_points_suggestion WHERE member_id=$1 AND state='pending' LIMIT 1",[owner])).rowCount;
 const loginProfile=(await c.query(`SELECT 1 FROM member_points_source_event e JOIN member m ON m.id=e.member_id
   WHERE e.member_id=$1 AND e.kind='profile' AND e.occurred_at<m.registration_completed_at LIMIT 1`,[owner])).rowCount;
 return definitions.filter(d=>(d.amount??0)>0&&(d.id!=='profile'||!loginProfile||counts.some(x=>x.source_type==='profile'&&x.n>0))).map(d=>{
  const bucket=d.type==='care_streak'?streakDay:d.bucket;
  const matched=counts.filter(x=>x.source_type===d.type&&(x.component===d.component||d.id==='firstOrder'&&x.component==='invite_friend')
   &&(!bucket||x.bucket===bucket));
  const count=matched.reduce((n,x)=>n+x.n,0);
  const firstOrderGrant=d.id==='firstOrder'?(matched.find(x=>x.component==='first_order')??matched[0]):undefined;
  const atLimit=(d.limit??0)>0&&count>=(d.limit??0);
  const reviewing=(d.id==='suggestion'&&suggestionPending)||pending.some(event=>{
   if(bucket&&!event.day.startsWith(bucket))return false;
   if(d.type==='care_day')return ['care','care_cycle','care_usage'].includes(event.kind)&&(d.id==='daily'||event.note_qualifies);
   if(d.id==='firstOrder')return event.kind==='payment'||event.kind==='receipt';
   return event.kind===d.type;
  });
  return {...d,amount:firstOrderGrant?.amount??d.amount,bucket,count,state:atLimit?(bucket&&d.type!=='care_streak'?'limit':'completed'):reviewing?'pending':'available'};
 });
}
function suggestionKey(config:AppConfig){const key=config.contacts.encryptionKey;if(!key||!/^[a-f0-9]{64}$/i.test(key))fail('POINTS_PRIVATE_STORAGE_UNAVAILABLE','私人记录暂不可用',503);return Buffer.from(key!,'hex');}
export function openPointsSuggestion(config:AppConfig,row:any){
 if(!row.encrypted_body)return '';if(row.key_version!==config.contacts.keyVersion)fail('POINTS_PRIVATE_KEY_UNAVAILABLE','私人记录暂不可读取',503);
 const b=Buffer.from(row.encrypted_body,'base64'),d=createDecipheriv('aes-256-gcm',suggestionKey(config),b.subarray(0,12));d.setAAD(Buffer.from(`points-suggestion:${row.member_id}:${row.id}`));d.setAuthTag(b.subarray(12,28));return Buffer.concat([d.update(b.subarray(28)),d.final()]).toString('utf8');
}
export class MemberPointsTasks{
 constructor(private pool:pg.Pool,private config:AppConfig,private authority:AuthorityService){}
 async guide(now=new Date()){const p=await activePointPolicy(this.pool,now);return {policy:p?{version:p.version,rules:p.rules}:null,tasks:p?pointsTaskDefinitions(p,now).filter(d=>(d.amount??0)>0).map(d=>({...d,count:null,state:'login'})):[]};}
 async receipts(memberId:string|undefined,now=new Date()){
  return transaction(this.pool,async c=>{const owner=await requireActiveMemberWithClient(c,memberId);
   const rows=(await c.query<{id:string;source_type:string;source_id:string;amount:number;created_at:Date}>(`SELECT g.id,g.source_type,g.source_id,g.amount-g.reversed_total AS amount,g.created_at FROM points_grant g
    WHERE g.member_id=$1 AND g.rule_snapshot->>'taskVersion'='2' AND g.source_type NOT IN ('care_day','care_streak','questionnaire')
     AND g.amount>g.reversed_total AND g.created_at>=$2::timestamptz-interval '30 days' ORDER BY g.created_at DESC,g.id DESC LIMIT 32`,[owner,now])).rows;
   const pending=(await c.query("SELECT 1 FROM member_points_source_event WHERE member_id=$1 AND state='pending' LIMIT 1",[owner])).rowCount;
   return {memberId:owner,pending:Boolean(pending),receipts:rows.reverse().map(r=>({id:r.id,sourceType:r.source_type,sourceId:r.source_id,points:r.amount,createdAt:r.created_at}))};
  },'REPEATABLE READ');
 }
 async suggestions(memberId:string|undefined,management=false){
  return transaction(this.pool,async c=>{const owner=await requireActiveMemberWithClient(c,memberId);if(management)await this.authority.requireWithClient(c,owner,'community.moderate');
   const rows=(await c.query(`SELECT s.*,m.display_name,n.user_code FROM member_points_suggestion s JOIN member m ON m.id=s.member_id LEFT JOIN member_card_number n ON n.member_id=m.id
    WHERE ($2::boolean AND s.state='pending' OR NOT $2::boolean AND s.member_id=$1) ORDER BY s.created_at DESC,s.id DESC LIMIT 50`,[owner,management])).rows;
   return {items:rows.map(r=>({id:r.id,memberId:r.member_id,name:r.display_name,userCode:r.user_code,body:openPointsSuggestion(this.config,r),state:r.state,version:r.version,reason:r.review_reason,createdAt:r.created_at}))};
  });
 }
 async submitSuggestion(memberId:string|undefined,key:string,input:any,now=new Date()){
  if(!/^[A-Za-z0-9._:-]{8,200}$/.test(key)||!input||typeof input.body!=='string'||Object.keys(input).some(k=>k!=='body'))fail('POINTS_SUGGESTION_INVALID','请填写改进建议');
  const body=input.body.trim();if(body.length>2000||hanCount(body)<15)fail('POINTS_SUGGESTION_INVALID','请填写至少15个汉字，最多2000字的具体建议');
  return transaction(this.pool,async c=>{const owner=await requireActiveMemberWithClient(c,memberId);await lockPointWallet(c,owner,true);const policy=await activePointPolicy(c,now);
   if(!policy||!pointRulesV2(policy.rules)||!policy.rules.suggestion)fail('POINTS_TASK_UNAVAILABLE','这项任务暂未开放',409);
   const sha=digest(body.replace(/\s/g,'')),old=(await c.query('SELECT * FROM member_points_suggestion WHERE member_id=$1 AND (operation_id=$2 OR body_sha256=$3)',[owner,key,sha])).rows[0];
   if(old){if(old.operation_id===key&&old.body_sha256!==sha)fail('IDEMPOTENCY_CONFLICT','请先核对上次提交',409);return {id:old.id,state:old.state,replayed:true};}
   const month=pointDay(now).slice(0,7),count=(await c.query<{n:number}>(`SELECT count(*)::int AS n FROM member_points_suggestion WHERE member_id=$1 AND state<>'rejected' AND to_char(created_at AT TIME ZONE 'Asia/Shanghai','YYYY-MM')=$2`,[owner,month])).rows[0]!.n;
   if(count>=(policy!.rules.suggestionMonthlyLimit??0))fail('POINTS_TASK_LIMIT','本月建议次数已达上限',409);
   const suggestionId=randomUUID(),iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',suggestionKey(this.config),iv);cipher.setAAD(Buffer.from(`points-suggestion:${owner}:${suggestionId}`));const encrypted=Buffer.concat([cipher.update(body),cipher.final()]);
   await c.query(`INSERT INTO member_points_suggestion(id,member_id,operation_id,encrypted_body,body_sha256,key_version,created_at) VALUES($1,$2,$3,$4,$5,$6,$7)`,[suggestionId,owner,key,Buffer.concat([iv,cipher.getAuthTag(),encrypted]).toString('base64'),sha,this.config.contacts.keyVersion,now]);
   return {id:suggestionId,state:'pending',replayed:false};
  });
 }
 async reviewSuggestion(memberId:string|undefined,suggestionId:string,input:any){
  if(!input||!['approved','rejected'].includes(input.state)||!Number.isInteger(input.expectedVersion)||typeof input.reason!=='string'||input.reason.trim().length<4||input.reason.length>500)fail('POINTS_SUGGESTION_REVIEW_INVALID','请填写审核结论与至少4字依据');
  return transaction(this.pool,async c=>{const actor=await this.authority.requireWithClient(c,memberId,'community.moderate'),row=(await c.query('SELECT * FROM member_points_suggestion WHERE id=$1 FOR UPDATE',[id(suggestionId)])).rows[0];
   if(!row||row.state!=='pending'||row.version!==input.expectedVersion)fail('POINTS_SUGGESTION_CHANGED','建议已有更新，请刷新',409);if(row.member_id===actor)fail('POINTS_SELF_REVIEW_FORBIDDEN','请另一名管理员审核自己的建议',403);
   await c.query('UPDATE member_points_suggestion SET state=$2,version=version+1,review_reason=$3,reviewed_by=$4,reviewed_at=clock_timestamp() WHERE id=$1',[suggestionId,input.state,input.reason.trim(),actor]);
   await c.query(`INSERT INTO audit_log(principal_id,action,object_type,object_id,reason_code,after_state,trace_id) VALUES($1,'points.suggestion_reviewed','member_points_suggestion',$2,'EXPLICIT_REVIEW',$3,gen_random_uuid()::text)`,[`member:${actor}`,suggestionId,{state:input.state,reason:input.reason.trim()}]);
   return {id:suggestionId,state:input.state};
  });
 }
}
