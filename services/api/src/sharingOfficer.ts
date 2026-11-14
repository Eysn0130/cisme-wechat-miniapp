import {sealSharingPayload,openSharingPayload} from './sharingOfficerCrypto.js';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import type pg from 'pg';
import type {AppConfig} from '@cisme/config';
import type {Capability} from '@cisme/contracts';
import {AuthorityService,requireActiveMemberWithClient} from './authority.js';
import {transaction,type DbClient} from './db.js';
import {commissionBuckets} from './commissionPolicy.js';
import {sharingFail as fail,sharingText as text,sharingId as id,sharingInt as int,sharingPolicyInput} from './sharingOfficerPolicy.js';
import {pageLimit,pageScope,readPageCursor,finishPage} from './keysetPage.js';

type Row=Record<string,any>;
function commandCapability(action:string):Capability|null{
 if(action==='officer_state')return 'member.manage';if(action==='policy')return 'commission.rate.manage';
 return ['prepare_month','review_line','void_line','record_payment','record_recovery'].includes(action)?'commission.settlement.approve':null;
}
export const sharingHash=(input:unknown)=>createHash('sha256').update(JSON.stringify(input)).digest('hex');
export const currentSharingPolicySql=`SELECT p.* FROM sharing_policy p ORDER BY p.version DESC LIMIT 1`;
export const sharingDisputeSql=(alias:string)=>`(EXISTS(SELECT 1 FROM commission_payment_composition_observation x WHERE x.order_id=${alias}.order_id)
 OR EXISTS(SELECT 1 FROM commerce_wechat_receipt_observation w WHERE w.order_id=${alias}.order_id AND w.in_complaint=true)
 OR EXISTS(SELECT 1 FROM commerce_aftersale_case c LEFT JOIN commission_refund_intent ci ON ci.request_id=c.refund_request_id
 WHERE c.order_id=${alias}.order_id AND c.state NOT IN ('cancelled','rejected') AND NOT(c.state='refund_pending' AND ci.state='succeeded'))
 OR EXISTS(SELECT 1 FROM commerce_refund_request r LEFT JOIN commission_refund_intent i ON i.request_id=r.id
 WHERE r.order_id=${alias}.order_id AND (r.state='requested' OR r.state='approved' AND (i.id IS NULL OR i.state IN ('prepared','abnormal')))))`;

export function officerPolicyView(p:Row|undefined){return p?{id:p.id,version:p.version,enabled:p.enabled,attributionDays:p.attribution_days,
 priority:p.priority,selfPurchase:p.self_purchase,basisPoints:p.basis_points,releaseDays:p.release_days}:null;}
export function officerView(r:Row|undefined){return r?{state:r.state,version:r.version,applicationNote:r.application_note,
 reviewReason:r.review_reason,appliedAt:r.created_at,updatedAt:r.updated_at,referralCode:r.referral_code}:null;}
export function sharingOrderView(r:Row){
 const buckets=commissionBuckets({accruedCents:Number(r.accrued),reversedCents:Number(r.reversed),releasedCents:Number(r.released),paidCents:Number(r.paid),heldCents:Number(r.held)});
 return {id:r.order_id,orderNumber:r.order_number,createdAt:r.created_at,paidAt:r.paid_at,orderStatus:r.order_status,
  officerCode:r.officer_code,productName:r.product_name,quantity:r.quantity,basisPoints:r.basis_points,policyVersion:r.policy_version,
  cashMerchandiseCents:Number(r.cash_merchandise_cents),refundedMerchandiseCents:Number(r.refunded),
  ...buckets,recoveredCents:Number(r.recovered),outstandingRecoveryCents:Math.max(0,buckets.recoveryCents-Number(r.recovered)),
  disputed:r.disputed===true,receiptAt:r.receipt_confirmed_at,eligibleAt:r.receipt_confirmed_at?new Date(new Date(r.receipt_confirmed_at).getTime()+r.release_days*86400_000).toISOString():null};
}
export const sharingOrderProjection=`SELECT s.order_id,o.order_number,s.created_at,o.paid_at,o.status AS order_status,
 so.referral_code AS officer_code,s.basis_points,s.cash_merchandise_cents,p.version AS policy_version,p.release_days,
 (SELECT string_agg(l.product_name,'、' ORDER BY l.line_number) FROM commerce_order_line l WHERE l.order_id=s.order_id) AS product_name,
 (SELECT sum(l.quantity)::int FROM commerce_order_line l WHERE l.order_id=s.order_id) AS quantity,
 ship.receipt_confirmed_at,
 COALESCE((SELECT sum(i.eligible_merchandise_refund_cents) FROM commission_refund_intent i WHERE i.order_id=s.order_id AND i.state='succeeded'),0)::text AS refunded,
 COALESCE((SELECT sum(e.amount_cents) FROM commission_ledger_entry e WHERE e.order_id=s.order_id AND e.kind='accrual'),0)::text AS accrued,
 COALESCE((SELECT -sum(e.amount_cents) FROM commission_ledger_entry e WHERE e.order_id=s.order_id AND e.kind='refund_reversal'),0)::text AS reversed,
 COALESCE((SELECT sum(e.amount_cents) FROM commission_ledger_entry e WHERE e.order_id=s.order_id AND e.kind='release'),0)::text AS released,
 COALESCE((SELECT sum(e.amount_cents) FROM commission_ledger_entry e WHERE e.order_id=s.order_id AND e.kind='settlement'),0)::text AS paid,
 COALESCE((SELECT sum(a.amount_cents) FROM sharing_settlement_allocation a JOIN sharing_settlement_line l ON l.id=a.line_id WHERE a.order_id=s.order_id AND l.state IN ('prepared','reviewed')),0)::text AS held,
 COALESCE((SELECT sum(r.amount_cents) FROM sharing_recovery r WHERE r.order_id=s.order_id),0)::text AS recovered,
 ${sharingDisputeSql('s')} AS disputed
 FROM commission_order_snapshot s JOIN commerce_order o ON o.id=s.order_id JOIN sharing_policy p ON p.id=s.sharing_policy_id JOIN sharing_officer so ON so.member_id=s.referrer_member_id
 LEFT JOIN commerce_shipment ship ON ship.order_id=s.order_id`;

export class SharingOfficerService {
 constructor(readonly pool:pg.Pool,readonly authority:AuthorityService,private config:AppConfig){}
 seal(value:unknown,scope:string){return sealSharingPayload(this.config,value,scope);}
 unseal(value:string,scope:string):Row{return openSharingPayload(this.config,value,scope);}
 async command(actorId:string|undefined,keyInput:string,action:string,input:Row,operation:(client:DbClient,actor:string)=>Promise<unknown>){
  const key=text(keyInput,'请求编号',8,160),fingerprint=sharingHash({action,input});
  return transaction(this.pool,async client=>{
   const actor=await requireActiveMemberWithClient(client,actorId);
   const required=commandCapability(action);if(required)await this.require(client,actor,required);
   await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`sharing-command:${actor}:${key}`]);
   const prior=(await client.query('SELECT request_hash,response FROM sharing_command WHERE actor_id=$1 AND request_key=$2',[actor,key])).rows[0];
   if(prior){if(prior.request_hash!==fingerprint)fail('IDEMPOTENCY_CONFLICT','同一请求编号对应了不同内容');return prior.response;}
   const result=await operation(client,actor);
   await client.query('INSERT INTO sharing_command(actor_id,request_key,request_hash,response,required_capability) VALUES($1,$2,$3,$4,$5)',[actor,key,fingerprint,JSON.stringify(result),required]);
   await client.query(`INSERT INTO audit_log(principal_id,action,object_type,object_id,after_state,trace_id)
    VALUES($1,$2,'sharing_officer',$3,$4,$5)`,[`member:${actor}`,`sharing.${action}`,actor,{requestHash:fingerprint},key]);
   return result;
  },'SERIALIZABLE');
 }
 async require(client:DbClient,actor:string,cap:Capability){await this.authority.requireWithClient(client,actor,cap);}
 async mine(actorId:string|undefined){
  return transaction(this.pool,async client=>{
   const actor=await requireActiveMemberWithClient(client,actorId),p=(await client.query(currentSharingPolicySql)).rows[0];
   const officer=(await client.query('SELECT * FROM sharing_officer WHERE member_id=$1',[actor])).rows[0];
   const payee=(await client.query('SELECT version,updated_at FROM sharing_payee WHERE member_id=$1',[actor])).rows[0];
   const rows=(await client.query(`${sharingOrderProjection} WHERE s.referrer_member_id=$1 AND s.program='sharing_officer'`,[actor])).rows.map(sharingOrderView);
   const metrics={pendingCents:0,availableCents:0,paymentHeldCents:0,settledCents:0,outstandingRecoveryCents:0,paidMerchandiseCents:0,refundedMerchandiseCents:0,orderCount:0};
   for(const row of rows){for(const k of ['pendingCents','availableCents','paymentHeldCents','settledCents','outstandingRecoveryCents'] as const)metrics[k]+=row[k];
    if(row.paidAt){metrics.paidMerchandiseCents+=row.cashMerchandiseCents;metrics.refundedMerchandiseCents+=row.refundedMerchandiseCents;metrics.orderCount++;}}
   const paid=(await client.query(`SELECT COALESCE(sum(tax_cents),0)::text AS tax,COALESCE(sum(net_cents),0)::text AS net
    FROM sharing_settlement_line WHERE member_id=$1 AND state='paid'`,[actor])).rows[0];
   const relation=await this.relationWithClient(client,actor);
   return {memberId:actor,officer:officerView(officer),policy:officerPolicyView(p),relation,
    canApply:Boolean(p?.enabled&&(!officer||['rejected','terminated'].includes(officer.state))),
    canShare:Boolean(p?.enabled&&officer?.state==='active'),payee:payee?{version:payee.version,updatedAt:payee.updated_at}:null,
    metrics:{...metrics,settledTaxCents:Number(paid.tax),settledNetCents:Number(paid.net)}};
  },'REPEATABLE READ');
 }
 async commandStatus(actorId:string|undefined,keyInput:string,abandon=false){
  const key=text(keyInput,'请求编号',8,160);
  return transaction(this.pool,async client=>{
   const actor=await requireActiveMemberWithClient(client,actorId);
   await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`sharing-command:${actor}:${key}`]);
   const prior=(await client.query('SELECT request_hash,response,required_capability FROM sharing_command WHERE actor_id=$1 AND request_key=$2',[actor,key])).rows[0];
   if(prior){const allowed=!prior.required_capability||await this.authority.has(actor,prior.required_capability);return {state:prior.request_hash==='abandoned'?'abandoned':'completed',...(allowed?{result:prior.response}:{redacted:true})};}
   if(abandon){await client.query(`INSERT INTO sharing_command(actor_id,request_key,request_hash,response) VALUES($1,$2,'abandoned','{"abandoned":true}')`,[actor,key]);return {state:'abandoned'};}
   return {state:'not_found'};
  });
 }
 async memberCommand(actorId:string|undefined,key:string,action:string,input:Row){
  if(!['apply','payee','share','bind_visit','change_referrer'].includes(action))fail('SHARING_ACTION_INVALID','操作无效',422);
  return this.command(actorId,key,action,input,async(client,actor)=>{
   if(action==='bind_visit')return this.bindVisit(client,actor,input);
   if(action==='change_referrer')return this.changeReferrer(client,actor,input);
   const p=(await client.query(currentSharingPolicySql)).rows[0];
   let officer=(await client.query('SELECT * FROM sharing_officer WHERE member_id=$1 FOR UPDATE',[actor])).rows[0];
   if(action==='apply'){
    if(!p?.enabled)fail('SHARING_APPLICATION_UNAVAILABLE','分享官申请尚未开放',503);
    if(officer&&!['rejected','terminated'].includes(officer.state))fail('SHARING_APPLICATION_EXISTS','申请已提交，请查看当前状态');
    const note=input.note===undefined?'':text(input.note,'申请说明',0,500);
    const row=(await client.query(`INSERT INTO sharing_officer(member_id,state,application_note,referral_code) VALUES($1,'pending',$2,$3)
     ON CONFLICT(member_id) DO UPDATE SET state='pending',application_note=$2,review_reason='',version=sharing_officer.version+1,updated_at=clock_timestamp() RETURNING *`,[actor,note,'SO'+randomBytes(5).toString('hex').toUpperCase()])).rows[0];
    await this.event(client,actor,row,officer?.state??null,'免费申请');return officerView(row);
   }
   if(!officer)fail('SHARING_OFFICER_REQUIRED','请先申请分享官资格',403);
   if(action==='payee'){
    const payload={legalName:text(input.legalName,'收款人姓名',2,80),channel:text(input.channel,'收款方式',1,60),account:text(input.account,'收款账号',3,160)};
    const expected=int(input.expectedVersion,'资料版本',0,2_000_000_000),current=(await client.query('SELECT version FROM sharing_payee WHERE member_id=$1 FOR UPDATE',[actor])).rows[0];
    if((current?.version??0)!==expected)fail('VERSION_CONFLICT','结算资料已更新，请重新打开');
    const updated=(await client.query(`INSERT INTO sharing_payee(member_id,encrypted_payload) VALUES($1,$2)
     ON CONFLICT(member_id) DO UPDATE SET encrypted_payload=$2,version=sharing_payee.version+1,updated_at=clock_timestamp() RETURNING version`,[actor,this.seal(payload,`sharing-payee:${actor}`)])).rows[0];return {saved:true,version:updated.version};
   }
   if(!p?.enabled||officer.state!=='active')fail('SHARING_OFFICER_INACTIVE','分享官资格当前不可推广',403);
   const code=text(input.productCode,'商品',3,64);
   const product=(await client.query("SELECT code FROM catalog_product WHERE code=$1 AND publication_status='published' AND qualification_status='eligible'",[code])).rows[0];
   if(!product)fail('SHARING_PRODUCT_UNAVAILABLE','该商品当前不可推广',404);
   const link=(await client.query(`INSERT INTO sharing_link(share_id,officer_id,product_code) VALUES($1,$2,$3)
    ON CONFLICT(officer_id,product_code) DO UPDATE SET officer_id=EXCLUDED.officer_id RETURNING *`,[randomUUID().replaceAll('-',''),actor,code])).rows[0];
   return {shareId:link.share_id,productCode:code,path:`/pages/product/index?id=${encodeURIComponent(code)}&officer_share=${link.share_id}`};
  });
 }
 async event(client:DbClient,actor:string,row:Row,from:string|null,reason:string){await client.query(`INSERT INTO sharing_officer_event(member_id,version,from_state,to_state,actor_id,reason)
  VALUES($1,$2,$3,$4,$5,$6)`,[row.member_id,row.version,from,row.state,actor,reason]);}
 async visit(shareId:string,visitKeyInput:unknown){
  if(!/^[0-9a-f]{32}$/.test(shareId))fail('SHARING_LINK_NOT_FOUND','分享链接不可用',404);
  const visitKey=text(visitKeyInput,'访问凭据',16,160);
  return transaction(this.pool,async client=>{
   const link=(await client.query(`SELECT l.product_code,o.state,p.publication_status,p.qualification_status,m.status AS member_status
    FROM sharing_link l JOIN sharing_officer o ON o.member_id=l.officer_id JOIN member m ON m.id=o.member_id
    JOIN catalog_product p ON p.code=l.product_code WHERE l.share_id=$1`,[shareId])).rows[0];
   if(!link||link.publication_status!=='published'||link.qualification_status!=='eligible')fail('SHARING_LINK_NOT_FOUND','商品当前不可查看',404);
   const policy=(await client.query(currentSharingPolicySql)).rows[0];
   if(link.state!=='active'||link.member_status!=='active'||!policy?.enabled)return {productCode:link.product_code,visitToken:null};
   const token=randomBytes(32).toString('base64url');
   const visit=(await client.query(`INSERT INTO sharing_visit(share_id,visit_key,token_hash,token_ciphertext)
    VALUES($1,$2,$3,$4) ON CONFLICT(share_id,visit_key) DO UPDATE SET visit_key=EXCLUDED.visit_key RETURNING token_ciphertext`,
    [shareId,visitKey,sharingHash(token),this.seal({token},`sharing-visit:${shareId}:${visitKey}`)])).rows[0];
   return {productCode:link.product_code,visitToken:this.unseal(visit.token_ciphertext,`sharing-visit:${shareId}:${visitKey}`).token};
  });
 }
 private async bindVisit(client:DbClient,actor:string,input:Row){
  const token=text(input.visitToken,'访问凭据',43,43),hash=sharingHash(token);
  const visit=(await client.query('SELECT * FROM sharing_visit WHERE token_hash=$1 FOR UPDATE',[hash])).rows[0];
  if(!visit)fail('SHARING_VISIT_NOT_FOUND','访问凭据无效',404);
  if(visit.visitor_id&&visit.visitor_id!==actor)fail('SHARING_VISIT_ALREADY_BOUND','访问凭据已使用',409);
  await client.query('UPDATE sharing_visit SET visitor_id=$1,bound_at=COALESCE(bound_at,clock_timestamp()) WHERE id=$2',[actor,visit.id]);
  const p=(await client.query(currentSharingPolicySql)).rows[0];
  const link=(await client.query(`SELECT l.officer_id FROM sharing_link l JOIN sharing_officer o ON o.member_id=l.officer_id
   JOIN member m ON m.id=o.member_id WHERE l.share_id=$1 AND o.state='active' AND m.status='active' FOR SHARE OF o,m`,[visit.share_id])).rows[0];
  if(p?.enabled&&link&&link.officer_id!==actor){
   await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`sharing-relation:${actor}`]);
   const current=(await client.query('SELECT * FROM sharing_customer_relation WHERE buyer_id=$1 FOR UPDATE',[actor])).rows[0];
   const now=(await client.query('SELECT clock_timestamp() AS at')).rows[0].at as Date;
   const inWindow=p.attribution_days===null||new Date(visit.visited_at).getTime()>now.getTime()-p.attribution_days*86400_000;
   const expired=current?.expires_at&&new Date(current.expires_at)<=now;
   const correctEarlier=current?.source==='first_touch'&&p.priority==='first'&&new Date(visit.visited_at)<new Date(current.effective_at);
   const later=current?.source!=='member_choice'&&p.priority==='last'&&new Date(visit.visited_at)>new Date(current?.effective_at??0);
   if(inWindow&&(!current||expired||correctEarlier||later))await this.setRelation(client,actor,link.officer_id,visit.id,
    p.priority==='first'?'first_touch':'last_touch',visit.visited_at,p,current);
  }
  return {recorded:true};
 }
 private async setRelation(client:DbClient,buyer:string,officer:string,visit:string|null,source:string,at:Date,p:Row,prior:Row|undefined){
  const version=(prior?.version??0)+1,expiry=p.attribution_days===null?null:new Date(new Date(at).getTime()+p.attribution_days*86400_000);
  await client.query(`INSERT INTO sharing_relation_event(buyer_id,version,from_officer_id,to_officer_id,visit_id,source)
   VALUES($1,$2,$3,$4,$5,$6)`,[buyer,version,prior?.officer_id??null,officer,visit,source]);
  await client.query(`INSERT INTO sharing_customer_relation(buyer_id,officer_id,visit_id,source,effective_at,expires_at,policy_id,version)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(buyer_id) DO UPDATE SET officer_id=$2,visit_id=$3,source=$4,effective_at=$5,expires_at=$6,policy_id=$7,version=$8`,
   [buyer,officer,visit,source,at,expiry,p.id,version]);
 }
 async relationWithClient(client:DbClient,buyer:string){
  const r=(await client.query(`SELECT r.*,o.referral_code,o.state FROM sharing_customer_relation r JOIN sharing_officer o ON o.member_id=r.officer_id WHERE r.buyer_id=$1`,[buyer])).rows[0];
  return r?{code:r.referral_code,label:`CISME 分享官 · ${r.referral_code.slice(-4)}`,version:r.version,state:r.state,expiresAt:r.expires_at,source:r.source}:null;
 }
 async previewReferrer(actorId:string|undefined,codeInput:unknown){
  const code=text(codeInput,'分享官编号',12,12).toUpperCase();
  return transaction(this.pool,async client=>{
   const actor=await requireActiveMemberWithClient(client,actorId);
   const row=(await client.query(`SELECT o.member_id,o.referral_code FROM sharing_officer o JOIN member m ON m.id=o.member_id
    WHERE o.referral_code=$1 AND o.state='active' AND m.status='active'`,[code])).rows[0];
   if(!row)fail('SHARING_REFERRER_UNAVAILABLE','分享官编号无效或资格已停用',404);
   if(row.member_id===actor)fail('SHARING_SELF_REFERRAL','不能将自己设为推荐人',422);
   return {code:row.referral_code,label:`CISME 分享官 · ${row.referral_code.slice(-4)}`,current:await this.relationWithClient(client,actor)};
  });
 }
 private async changeReferrer(client:DbClient,actor:string,input:Row){
  if(input.confirmed!==true)fail('SHARING_REFERRER_CONFIRM_REQUIRED','请确认更换后的推荐人',422);
  const code=text(input.code,'分享官编号',12,12).toUpperCase(),p=(await client.query(currentSharingPolicySql)).rows[0];
  if(!p?.enabled)fail('SHARING_UNAVAILABLE','当前暂不可更换推荐人',503);
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`sharing-relation:${actor}`]);
  const prior=(await client.query('SELECT * FROM sharing_customer_relation WHERE buyer_id=$1 FOR UPDATE',[actor])).rows[0];
  if((prior?.version??0)!==int(input.expectedVersion,'推荐关系版本',0,2_000_000_000))fail('VERSION_CONFLICT','推荐人已更新，请重新确认');
  const officer=(await client.query(`SELECT o.member_id FROM sharing_officer o JOIN member m ON m.id=o.member_id
   WHERE o.referral_code=$1 AND o.state='active' AND m.status='active' FOR SHARE OF o,m`,[code])).rows[0];
  if(!officer)fail('SHARING_REFERRER_UNAVAILABLE','该分享官当前不可选择',404);
  if(officer.member_id===actor)fail('SHARING_SELF_REFERRAL','不能将自己设为推荐人',422);
  if(prior?.officer_id===officer.member_id)return this.relationWithClient(client,actor);
  const at=(await client.query('SELECT clock_timestamp() AS at')).rows[0].at;
  await this.setRelation(client,actor,officer.member_id,null,'member_choice',at,p,prior);
  return this.relationWithClient(client,actor);
 }
 async readPayee(actorId:string|undefined,targetInput:string){
  return transaction(this.pool,async client=>{
   const actor=await this.authority.requireWithClient(client,actorId,'commission.settlement.approve'),target=id(targetInput);
   const row=(await client.query('SELECT * FROM sharing_payee WHERE member_id=$1',[target])).rows[0];
   if(!row)fail('SHARING_PAYEE_MISSING','会员尚未提交收款资料');
   await client.query(`INSERT INTO audit_log(principal_id,action,object_type,object_id,trace_id)
    VALUES($1,'sharing.payee_read','sharing_payee',$2,$3)`,[`member:${actor}`,target,randomUUID()]);
   return {...this.unseal(row.encrypted_payload,`sharing-payee:${target}`),version:row.version};
  });
 }
 async orders(actorId:string|undefined,query:{limit?:unknown;cursor?:unknown;id?:string;lineId?:string}={}){
  return transaction(this.pool,async client=>{
   const actor=await requireActiveMemberWithClient(client,actorId),scope=pageScope(['officer-orders',actor,query.id??'',query.lineId??'']),limit=pageLimit(query.limit),cursor=readPageCursor(query.cursor,scope);
   const rows=(await client.query(`${sharingOrderProjection} WHERE s.program='sharing_officer' AND s.referrer_member_id=$1
    AND ($2::uuid IS NULL OR s.order_id=$2) AND ($3::timestamptz IS NULL OR (s.created_at,s.order_id)<($3,$4::uuid))
    AND ($6::uuid IS NULL OR EXISTS(SELECT 1 FROM sharing_settlement_allocation a JOIN sharing_settlement_line l ON l.id=a.line_id WHERE a.order_id=s.order_id AND a.line_id=$6 AND l.member_id=$1))
    ORDER BY s.created_at DESC,s.order_id DESC LIMIT $5`,[actor,query.id?id(query.id):null,cursor?.at??null,cursor?.id??null,limit+1,query.lineId?id(query.lineId):null])).rows;
   const page=finishPage(rows.map(r=>({...sharingOrderView(r),cursorAt:r.created_at.toISOString()})),limit,scope);
   return {...page,items:page.items.map(({cursorAt:_,...row})=>row)};
  },'REPEATABLE READ');
 }
 async adminCommand(actorId:string|undefined,key:string,action:string,input:Row){
  return this.command(actorId,key,action,input,async(client,actor)=>{
   if(action==='policy'){
    await this.require(client,actor,'commission.rate.manage');const p=sharingPolicyInput(input);
    const current=(await client.query(currentSharingPolicySql)).rows[0];if((current?.version??0)!==int(input.expectedVersion,'规则版本',0,2_000_000_000))fail('VERSION_CONFLICT','规则已更新，请重新加载');
    const row=(await client.query(`INSERT INTO sharing_policy(enabled,attribution_days,priority,self_purchase,basis_points,release_days,reason,created_by,created_principal)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,[p.enabled,p.attributionDays,p.priority,p.selfPurchase,p.basisPoints,p.releaseDays,p.reason,actor,`member:${actor}`])).rows[0];return officerPolicyView(row);
   }
   if(action==='officer_state'){
    await this.require(client,actor,'member.manage');const target=id(input.memberId),desired=text(input.state,'资格状态'),reason=text(input.reason,'处理依据',2),expected=int(input.expectedVersion,'申请版本',1,2_000_000_000);
    if(target===actor)fail('SHARING_SELF_REVIEW_FORBIDDEN','不能审核自己的分享官资格',403);
    const targetMember=await requireActiveMemberWithClient(client,target);
    const row=(await client.query('SELECT * FROM sharing_officer WHERE member_id=$1 FOR UPDATE',[targetMember])).rows[0];
    if(!row||row.version!==expected)fail('VERSION_CONFLICT','申请已更新，请重新加载');
    const allowed:Record<string,string[]>={pending:['active','rejected'],active:['suspended','terminated'],suspended:['active','terminated'],rejected:[],terminated:[]};
    if(!allowed[row.state]?.includes(desired))fail('SHARING_STATE_INVALID','当前不能切换到此资格状态');
    const updated=(await client.query('UPDATE sharing_officer SET state=$2,review_reason=$3,version=version+1,updated_at=clock_timestamp() WHERE member_id=$1 RETURNING *',[target,desired,reason])).rows[0];
    await this.event(client,actor,updated,row.state,reason);return officerView(updated);
   }
   fail('SHARING_ACTION_INVALID','操作无效',422);
  });
 }
}

/** Same transaction as order creation; explicit customer ownership is independent of points/legacy referral. */
export async function snapshotSharingOfficer(client:DbClient,orderId:string,buyerId:string,sourceKind:string,cashMerchandiseCents:number){
 const policy=(await client.query(currentSharingPolicySql)).rows[0];if(!policy?.enabled)return null;
 const relation=(await client.query(`SELECT r.officer_id,r.visit_id,e.id AS relation_event_id FROM sharing_customer_relation r
  JOIN sharing_relation_event e ON e.buyer_id=r.buyer_id AND e.version=r.version
  JOIN sharing_officer o ON o.member_id=r.officer_id JOIN member m ON m.id=o.member_id
  WHERE r.buyer_id=$1 AND r.officer_id<>$1 AND o.state='active' AND m.status='active'
   AND (r.expires_at IS NULL OR r.expires_at>clock_timestamp()) FOR SHARE OF r,o,m`,[buyerId])).rows[0];
 if(!relation)return null;
 return (await client.query(`INSERT INTO commission_order_snapshot(order_id,buyer_member_id,referrer_member_id,basis_points,
  cash_merchandise_cents,source_kind,program,sharing_policy_id,sharing_visit_id,sharing_relation_event_id)
  VALUES($1,$2,$3,$4,$5,$6,'sharing_officer',$7,$8,$9) ON CONFLICT(order_id) DO NOTHING RETURNING order_id`,
  [orderId,buyerId,relation.officer_id,policy.basis_points,cashMerchandiseCents,sourceKind,policy.id,relation.visit_id,relation.relation_event_id])).rows[0]??null;
}

/** Immutable release based on recorded receipt and the order's locked company policy. */
export async function releaseSharingCommissions(pool:pg.Pool,limit=50){
 return transaction(pool,async client=>{
  const candidates=(await client.query(`SELECT s.order_id FROM commission_order_snapshot s
   JOIN sharing_policy p ON p.id=s.sharing_policy_id JOIN commerce_order o ON o.id=s.order_id
   JOIN commerce_shipment ship ON ship.order_id=s.order_id
   WHERE s.program='sharing_officer' AND s.source_kind='verified_commerce' AND o.status='paid'
    AND ship.receipt_confirmed_at<=clock_timestamp()-make_interval(days=>p.release_days)
    AND NOT ${sharingDisputeSql('s')}
    AND NOT EXISTS(SELECT 1 FROM commission_ledger_entry e WHERE e.order_id=s.order_id AND e.kind='release')
    AND EXISTS(SELECT 1 FROM commission_ledger_entry e WHERE e.order_id=s.order_id AND e.kind='accrual')
   ORDER BY ship.receipt_confirmed_at,s.order_id LIMIT $1 FOR UPDATE OF o SKIP LOCKED`,[limit])).rows;
  let released=0;
  for(const row of candidates){
   const sums=(await client.query(`SELECT COALESCE(sum(amount_cents) FILTER(WHERE kind IN ('accrual','refund_reversal')),0)::text AS net
    FROM commission_ledger_entry WHERE order_id=$1`,[row.order_id])).rows[0];
   const amount=Number(sums.net);if(amount<=0)continue;
   await client.query(`INSERT INTO commission_ledger_entry(order_id,referrer_member_id,event_key,kind,amount_cents,source_fact_id,actor_principal_id)
    SELECT order_id,referrer_member_id,$2,'release',$3,sharing_policy_id,'worker:sharing-release' FROM commission_order_snapshot WHERE order_id=$1
    ON CONFLICT(event_key) DO NOTHING`,[row.order_id,`sharing-release:${row.order_id}`,amount]);released++;
  }return released;
 });
}
