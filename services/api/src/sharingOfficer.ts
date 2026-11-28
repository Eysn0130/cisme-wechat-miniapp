import {sealSharingPayload,openSharingPayload,sharingCommandDigest} from './sharingOfficerCrypto.js';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import type pg from 'pg';
import type {AppConfig} from '@cisme/config';
import {sharingOfficerAgreement,type Capability} from '@cisme/contracts';
import {AuthorityService,memberAdministrationCapabilities,matchesMemberAdministrationRoot,requireActiveMemberWithClient} from './authority.js';
import {transaction,type DbClient} from './db.js';
import {commissionBuckets} from './commissionPolicy.js';
import {sharingFail as fail,sharingText as text,sharingId as id,sharingInt as int,sharingPolicyInput} from './sharingOfficerPolicy.js';
import {pageLimit,pageScope,readPageCursor,finishPage} from './keysetPage.js';
import {bindSharingV2ReleasedOrder,clearSharingV2Referrals,setSharingV2Intent,sharingV2BasisPoints} from './sharingOfficerV2.js';
import {changeSharingCustomer} from './sharingOfficerCustomerAdmin.js';

type Row=Record<string,any>;
function commandCapability(action:string):Capability|null{
 if(action==='officer_state'||action==='customer_relation')return 'member.manage';if(action==='policy')return 'commission.rate.manage';
 return ['prepare_month','review_line','void_line','record_payment','record_recovery'].includes(action)?'commission.settlement.approve':null;
}
export const sharingHash=(input:unknown)=>createHash('sha256').update(JSON.stringify(input)).digest('hex');
type AgreementAcceptance={version:string;digest:string;effectiveOn:string;acceptedAt:string};
const approvalRevisionEffectiveOn='2026-11-28';
function applicationAgreement(effectiveOn:string|null){
 const document=effectiveOn?{
  ...sharingOfficerAgreement,draftNotice:'',
  closing:[sharingOfficerAgreement.closing[0],`协议版本：${sharingOfficerAgreement.version}`,`生效日期：${effectiveOn}`]
 }:sharingOfficerAgreement;
 return {...document,effectiveOn,digest:sharingHash({...document,effectiveOn})};
}
export const currentSharingPolicySql=`SELECT p.* FROM sharing_policy p ORDER BY p.version DESC LIMIT 1`;
export const sharingQualificationProduct='aigerong-scalp-repair-essence-100';
export async function pendingSharingReferrer(client:DbClient,buyer:string,enabled:boolean){
 const row=(await client.query(`SELECT o.referral_code AS code,m.display_name AS label,i.id AS id,
     $2::boolean AND o.state='active' AND m.status='active'
       AND (o.v2_application_version IS NULL OR sharing_v2_approval_at(o.member_id,o.v2_application_version) IS NOT NULL) AS eligible
   FROM sharing_v2_referral_intent i JOIN sharing_officer o ON o.member_id=i.officer_id
   JOIN member m ON m.id=i.officer_id WHERE i.buyer_id=$1 AND i.state='pending' AND i.source='member_choice'`,[buyer,enabled])).rows[0];
 return row??null;
}
async function sharingRootException(client:DbClient,config:AppConfig,owner:string){
 if(!await matchesMemberAdministrationRoot(client,config,owner))return false;
 const capabilities=await memberAdministrationCapabilities(client,config.env,owner);
 return capabilities.includes('member.manage')&&capabilities.includes('member.profile.read');
}
export async function canPromoteSharingOfficer(client:DbClient,config:AppConfig,owner:string,state:string|undefined){
 return state==='active'||state==='promotion_only'&&await sharingRootException(client,config,owner);
}
/** A referral shared from published content or a gift has no catalog target.
 * The empty product code keeps one canonical referral link per officer while
 * preserving every existing product link and its visit history. */
export async function officerShareLink(client: DbClient, owner: string, productCode = ""): Promise<string> {
 const row = (await client.query<{share_id:string}>(`INSERT INTO sharing_link(share_id,officer_id,product_code) VALUES($1,$2,$3)
  ON CONFLICT(officer_id,product_code) DO UPDATE SET officer_id=EXCLUDED.officer_id RETURNING share_id`,
  [randomUUID().replaceAll('-',''),owner,productCode])).rows[0]!;
 return row.share_id;
}
/** Paid canonical product units, excluding units reserved by an open return or
 * already refunded. Unallocated external refunds require reconciliation first. */
export async function sharingQualification(client:DbClient,memberId:string){
 const row=(await client.query<{met:boolean}>(`SELECT EXISTS(SELECT 1 FROM commerce_order_line l
   JOIN commerce_order o ON o.id=l.order_id JOIN commission_payment_inbox p ON p.order_id=o.id AND p.state='applied'
   WHERE o.member_id=$1 AND o.status='paid' AND o.transaction_source_kind='verified_commerce' AND l.product_code=$2 AND l.unit_price_cents>0
   AND l.quantity>COALESCE((SELECT sum((x->>'quantity')::integer) FROM commerce_aftersale_case c
     LEFT JOIN commission_refund_intent i ON i.request_id=c.refund_request_id
     CROSS JOIN LATERAL jsonb_array_elements(c.lines) x
     WHERE c.order_id=o.id AND c.state NOT IN ('cancelled','rejected') AND x->>'lineId'=l.id::text),0)
   AND NOT EXISTS(SELECT 1 FROM commerce_aftersale_case c WHERE c.order_id=o.id AND c.state NOT IN ('cancelled','rejected') AND jsonb_array_length(c.lines)=0)
   AND NOT EXISTS(SELECT 1 FROM commission_refund_intent i WHERE i.order_id=o.id AND i.request_id IS NULL AND i.state<>'closed')
   AND NOT EXISTS(SELECT 1 FROM commerce_refund_request r WHERE r.order_id=o.id AND r.state IN ('requested','approved')
     AND NOT EXISTS(SELECT 1 FROM commerce_aftersale_case c WHERE c.refund_request_id=r.id))
 ) AS met`,[memberId,sharingQualificationProduct])).rows[0];
 return {met:row?.met===true,productCode:sharingQualificationProduct,quantity:1,priceCents:29800};
}
export const sharingDisputeSql=(alias:string)=>`(EXISTS(SELECT 1 FROM commission_payment_composition_observation x WHERE x.order_id=${alias}.order_id)
 OR EXISTS(SELECT 1 FROM commerce_wechat_receipt_observation w WHERE w.order_id=${alias}.order_id AND w.in_complaint=true)
 OR EXISTS(SELECT 1 FROM commerce_aftersale_case c LEFT JOIN commission_refund_intent ci ON ci.request_id=c.refund_request_id
 WHERE c.order_id=${alias}.order_id AND c.state NOT IN ('cancelled','rejected') AND NOT(c.state='refund_pending' AND COALESCE(ci.state='succeeded',false)))
 OR EXISTS(SELECT 1 FROM commerce_refund_request r LEFT JOIN commission_refund_intent i ON i.request_id=r.id
 WHERE r.order_id=${alias}.order_id AND (r.state='requested' OR r.state='approved' AND (i.id IS NULL OR i.state IN ('prepared','abnormal')))))`;

export function officerPolicyView(p:Row|undefined){return p?{id:p.id,version:p.version,enabled:p.enabled,attributionDays:p.attribution_days,
 priority:p.priority,selfPurchase:p.self_purchase,basisPoints:p.basis_points,releaseDays:p.release_days}:null;}
export function officerView(r:Row|undefined){return r?{state:r.state,version:r.version,applicationNote:r.application_note,
 reviewReason:r.review_reason,appliedAt:r.created_at,updatedAt:r.updated_at,referralCode:r.referral_code,
 ...(r.agreement_version?{agreementVersion:r.agreement_version}:{})}:null;}
export function sharingOrderView(r:Row){
 const buckets=commissionBuckets({accruedCents:Number(r.accrued),reversedCents:Number(r.reversed),releasedCents:Number(r.released),paidCents:Number(r.paid),heldCents:Number(r.held)});
 return {id:r.order_id,orderNumber:r.order_number,createdAt:r.created_at,paidAt:r.paid_at,orderStatus:r.order_status,
  officerCode:r.officer_code,productName:r.product_name,quantity:r.quantity,basisPoints:r.basis_points,policyVersion:r.policy_version,
  ...(r.agreement_version?{agreementVersion:r.agreement_version}:{}),
  cashMerchandiseCents:Number(r.cash_merchandise_cents),refundedMerchandiseCents:Number(r.refunded),
  ...buckets,recoveredCents:Number(r.recovered),outstandingRecoveryCents:Math.max(0,buckets.recoveryCents-Number(r.recovered)),
  disputed:r.disputed===true,receiptAt:r.receipt_confirmed_at,eligibleAt:r.receipt_confirmed_at?new Date(new Date(r.receipt_confirmed_at).getTime()+r.release_days*86400_000).toISOString():null};
}
export const sharingOrderProjection=`SELECT s.order_id,o.order_number,s.created_at,o.paid_at,o.status AS order_status,
 so.referral_code AS officer_code,s.basis_points,s.cash_merchandise_cents,s.sharing_v2_application_version,agreement.agreement_version,p.version AS policy_version,p.release_days,
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
 LEFT JOIN commerce_shipment ship ON ship.order_id=s.order_id
 LEFT JOIN sharing_v2_application agreement ON agreement.member_id=s.referrer_member_id AND agreement.application_version=s.sharing_v2_application_version`;

export class SharingOfficerService {
 constructor(readonly pool:pg.Pool,readonly authority:AuthorityService,private config:AppConfig){}
 private effectiveAgreementDate(){
  const configured=this.config.sharingAgreementV2EffectiveOn;
  const date=configured&&configured<approvalRevisionEffectiveOn?approvalRevisionEffectiveOn:configured;
  const today=new Date(Date.now()+8*3600_000).toISOString().slice(0,10);
  return date&&date<=today?date:null;
 }
 seal(value:unknown,scope:string){return sealSharingPayload(this.config,value,scope);}
 unseal(value:string,scope:string):Row{return openSharingPayload(this.config,value,scope);}
 async command(actorId:string|undefined,keyInput:string,action:string,input:Row,operation:(client:DbClient,actor:string)=>Promise<unknown>){
  const key=text(keyInput,'请求编号',8,160);
  return transaction(this.pool,async client=>{
   const actor=await requireActiveMemberWithClient(client,actorId);
   const required=commandCapability(action);if(required)await this.require(client,actor,required);
   if(action==='customer_relation')await this.require(client,actor,'member.profile.read');
   const fingerprint=sharingCommandDigest(this.config,{action,input});
   await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`sharing-command:${actor}:${key}`]);
   const prior=(await client.query('SELECT request_hash,response FROM sharing_command WHERE actor_id=$1 AND request_key=$2',[actor,key])).rows[0];
   if(prior){if(prior.request_hash!==fingerprint)fail('IDEMPOTENCY_CONFLICT','同一请求编号对应了不同内容');return prior.response;}
   const result=await operation(client,actor);
   await client.query('INSERT INTO sharing_command(actor_id,request_key,request_hash,response,required_capability) VALUES($1,$2,$3,$4,$5)',[actor,key,fingerprint,JSON.stringify(result),required]);
   const application=action==='apply' ? result as {version:number;agreement?:AgreementAcceptance;rootException?:boolean} : undefined;
   const evidence={requestHash:fingerprint,...(application?.agreement?{applicationVersion:application.version-(application.rootException?1:0),agreement:application.agreement}:{}),
    ...(application?.rootException?{rootException:true,approvalVersion:application.version}:{})};
   await client.query(`INSERT INTO audit_log(principal_id,action,object_type,object_id,after_state,trace_id)
    VALUES($1,$2,'sharing_officer',$3,$4,$5)`,[`member:${actor}`,`sharing.${action}`,actor,evidence,key]);
   return result;
  },'SERIALIZABLE');
 }
 async require(client:DbClient,actor:string,cap:Capability){await this.authority.requireWithClient(client,actor,cap);}
 canPromote(client:DbClient,actor:string,state:string|undefined){return canPromoteSharingOfficer(client,this.config,actor,state);}
 async mine(actorId:string|undefined){
  return transaction(this.pool,async client=>{
   const actor=await requireActiveMemberWithClient(client,actorId),p=(await client.query(currentSharingPolicySql)).rows[0];
   const officer=(await client.query(`SELECT o.*,a.agreement_version FROM sharing_officer o
    LEFT JOIN sharing_v2_application a ON a.member_id=o.member_id AND a.application_version=o.v2_application_version
    WHERE o.member_id=$1`,[actor])).rows[0];
   const payee=(await client.query('SELECT version,updated_at FROM sharing_payee WHERE member_id=$1',[actor])).rows[0];
   const rows=(await client.query(`${sharingOrderProjection} WHERE s.referrer_member_id=$1 AND s.program='sharing_officer'`,[actor])).rows.map(sharingOrderView);
   const metrics={pendingCents:0,availableCents:0,paymentHeldCents:0,settledCents:0,outstandingRecoveryCents:0,paidMerchandiseCents:0,refundedMerchandiseCents:0,orderCount:0};
   for(const row of rows){for(const k of ['pendingCents','availableCents','paymentHeldCents','settledCents','outstandingRecoveryCents'] as const)metrics[k]+=row[k];
    if(row.paidAt){metrics.paidMerchandiseCents+=row.cashMerchandiseCents;metrics.refundedMerchandiseCents+=row.refundedMerchandiseCents;metrics.orderCount++;}}
   const paid=(await client.query(`SELECT COALESCE(sum(tax_cents),0)::text AS tax,COALESCE(sum(net_cents),0)::text AS net
    FROM sharing_settlement_line WHERE member_id=$1 AND state='paid'`,[actor])).rows[0];
   const relation=await this.relationWithClient(client,actor);
   const pendingReferrer=await pendingSharingReferrer(client,actor,p?.enabled===true);
   const linkReferrer=!relation&&!pendingReferrer&&p?.enabled ? await this.linkReferrer(client,actor,p) : null;
   const qualification=await sharingQualification(client,actor);
   const promotionOnly=officer?.state==='promotion_only';
   const offersApplication=Boolean(p?.enabled&&(!officer||['rejected','terminated','promotion_only'].includes(officer.state)));
   const rootException=offersApplication&&await sharingRootException(client,this.config,actor);
   const canApply=offersApplication&&(rootException||!promotionOnly&&qualification.met);
   return {memberId:actor,officer:officerView(officer),policy:officerPolicyView(officer?.v2_application_version&&p?{...p,basis_points:sharingV2BasisPoints}:p),relation,
    pendingReferrer,linkReferrer,
    qualification,canApply,...(rootException?{rootException:true}:{}),
    ...(offersApplication?{applicationAgreement:applicationAgreement(this.effectiveAgreementDate())}:{}),
    canShare:Boolean(p?.enabled&&(officer?.state==='active'||promotionOnly&&rootException)),payee:payee?{version:payee.version,updatedAt:payee.updated_at}:null,
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
   const officer=(await client.query('SELECT * FROM sharing_officer WHERE member_id=$1 FOR UPDATE',[actor])).rows[0];
   if(action==='apply'){
    if(!p?.enabled)fail('SHARING_APPLICATION_UNAVAILABLE','分享官申请尚未开放',503);
    if(officer&&!['rejected','terminated','promotion_only'].includes(officer.state))fail('SHARING_APPLICATION_EXISTS','申请已提交，请查看当前状态');
    const rootException=await sharingRootException(client,this.config,actor);
    if(officer?.state==='promotion_only'&&!rootException)fail('SHARING_OFFICER_INACTIVE','分享官资格当前不可推广',403);
    if(!rootException&&!(await sharingQualification(client,actor)).met)fail('SHARING_PURCHASE_REQUIRED','购买精华套组1组后可申请；退款或售后中的商品暂不计入',409);
    const effectiveOn=this.effectiveAgreementDate();
    const agreement=input.agreement as {accepted?:unknown;version?:unknown;digest?:unknown;effectiveOn?:unknown}|null|undefined;
    const document=effectiveOn?applicationAgreement(effectiveOn):null;
    if(document){
     if(agreement?.accepted!==true)fail('SHARING_AGREEMENT_REQUIRED','请先阅读并勾选分享官合作协议',409);
     if(agreement.version!==document?.version||agreement.digest!==document.digest||agreement.effectiveOn!==effectiveOn)
      fail('SHARING_AGREEMENT_CHANGED','合作协议已更新，请重新阅读并确认',409);
    }else if(rootException||input.agreement!==undefined||officer?.v2_application_version)fail('SHARING_AGREEMENT_NOT_EFFECTIVE','合作协议尚未启用',409);
    const note=input.note===undefined?'':text(input.note,'申请说明',0,500);
    const row=(await client.query(`INSERT INTO sharing_officer(member_id,state,application_note,referral_code) VALUES($1,'pending',$2,$3)
     ON CONFLICT(member_id) DO UPDATE SET state='pending',application_note=$2,review_reason='',version=sharing_officer.version+1,updated_at=clock_timestamp() RETURNING *`,[actor,note,(await client.query('SELECT user_code FROM member_card_number WHERE member_id=$1',[actor])).rows[0].user_code])).rows[0];
    if(effectiveOn&&document){
     const {digest,...snapshot}=document;
     await client.query(`INSERT INTO sharing_v2_agreement_document(agreement_version,agreement_digest,effective_on,body_snapshot)
      VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`,[document.version,digest,effectiveOn,JSON.stringify(snapshot)]);
     await client.query(`INSERT INTO sharing_v2_application(member_id,application_version,agreement_version,agreement_digest,effective_on,accepted_at)
      VALUES($1,$2,$3,$4,$5,$6)`,[actor,row.version,document.version,digest,effectiveOn,row.updated_at]);
     await client.query('UPDATE sharing_officer SET v2_application_version=$2 WHERE member_id=$1',[actor,row.version]);
    }
    await this.event(client,actor,row,officer?.state??null,rootException?'最高管理员本人确认合作协议':'购买条件已核验，提交申请');
    const reason='最高管理员特例，免购买及二次审核';
    const opened=rootException?(await client.query(`UPDATE sharing_officer SET state='active',review_reason=$2,
      version=version+1,updated_at=clock_timestamp() WHERE member_id=$1 RETURNING *`,[actor,reason])).rows[0]:row;
    if(rootException)await this.event(client,actor,opened,'pending',reason,true);
    return {state:opened.state,version:opened.version,referralCode:opened.referral_code,...(rootException?{rootException:true}:{}),
     ...(effectiveOn&&document?{agreement:{version:document.version,digest:document.digest,effectiveOn,acceptedAt:row.updated_at.toISOString()}}:{})};
   }
   if(!officer)fail('SHARING_OFFICER_REQUIRED','请先申请分享官资格',403);
   if(action==='payee'){
    if(officer.state==='promotion_only')fail('SHARING_AGREEMENT_REQUIRED','请本人确认分享官合作协议',409);
    const payload={legalName:text(input.legalName,'收款人姓名',2,80),channel:text(input.channel,'收款方式',1,60),account:text(input.account,'收款账号',3,160)};
    const expected=int(input.expectedVersion,'资料版本',0,2_000_000_000),current=(await client.query('SELECT version FROM sharing_payee WHERE member_id=$1 FOR UPDATE',[actor])).rows[0];
    if((current?.version??0)!==expected)fail('VERSION_CONFLICT','结算资料已更新，请重新打开');
    const updated=(await client.query(`INSERT INTO sharing_payee(member_id,encrypted_payload) VALUES($1,$2)
     ON CONFLICT(member_id) DO UPDATE SET encrypted_payload=$2,version=sharing_payee.version+1,updated_at=clock_timestamp() RETURNING version`,[actor,this.seal(payload,`sharing-payee:${actor}`)])).rows[0];return {saved:true,version:updated.version};
   }
   if(!p?.enabled||!await this.canPromote(client,actor,officer.state))fail('SHARING_OFFICER_INACTIVE','分享官资格当前不可推广',403);
   const code=text(input.productCode,'商品',3,64);
   const product=(await client.query("SELECT code FROM catalog_product WHERE code=$1 AND publication_status='published' AND qualification_status='eligible'",[code])).rows[0];
   if(!product)fail('SHARING_PRODUCT_UNAVAILABLE','该商品当前不可推广',404);
   const shareId=await officerShareLink(client,actor,code);
   return {shareId,productCode:code,path:`/pages/product/index?id=${encodeURIComponent(code)}&officer_share=${shareId}`};
  });
 }
 async event(client:DbClient,actor:string,row:Row,from:string|null,reason:string,rootException=false){await client.query(`INSERT INTO sharing_officer_event(member_id,version,from_state,to_state,actor_id,reason,root_exception)
  VALUES($1,$2,$3,$4,$5,$6,$7)`,[row.member_id,row.version,from,row.state,actor,reason,rootException]);}
 async visit(shareId:string,visitKeyInput:unknown){
  if(!/^[0-9a-f]{32}$/.test(shareId))fail('SHARING_LINK_NOT_FOUND','分享链接不可用',404);
  const visitKey=text(visitKeyInput,'访问凭据',16,160);
  return transaction(this.pool,async client=>{
   const link=(await client.query(`SELECT l.product_code,o.state,p.publication_status,p.qualification_status,m.status AS member_status
    FROM sharing_link l JOIN sharing_officer o ON o.member_id=l.officer_id JOIN member m ON m.id=o.member_id
    LEFT JOIN catalog_product p ON p.code=l.product_code WHERE l.share_id=$1`,[shareId])).rows[0];
   if(!link||link.product_code&&(link.publication_status!=='published'||link.qualification_status!=='eligible'))
    fail('SHARING_LINK_NOT_FOUND','分享内容当前不可查看',404);
   const productCode: string | null = link.product_code || null;
   const policy=(await client.query(currentSharingPolicySql)).rows[0];
   if(link.state!=='active'||link.member_status!=='active'||!policy?.enabled)return {productCode,visitToken:null};
   const token=randomBytes(32).toString('base64url');
   const visit=(await client.query(`INSERT INTO sharing_visit(share_id,visit_key,token_hash,token_ciphertext)
    VALUES($1,$2,$3,$4) ON CONFLICT(share_id,visit_key) DO UPDATE SET visit_key=EXCLUDED.visit_key RETURNING token_ciphertext`,
    [shareId,visitKey,sharingHash(token),this.seal({token},`sharing-visit:${shareId}:${visitKey}`)])).rows[0];
   return {productCode,visitToken:this.unseal(visit.token_ciphertext,`sharing-visit:${shareId}:${visitKey}`).token};
  });
 }
 private async bindVisit(client:DbClient,actor:string,input:Row){
  const token=text(input.visitToken,'访问凭据',43,43),hash=sharingHash(token);
  const visit=(await client.query('SELECT id,visitor_id FROM sharing_visit WHERE token_hash=$1 FOR UPDATE',[hash])).rows[0];
  if(!visit)fail('SHARING_VISIT_NOT_FOUND','访问凭据无效',404);
  if(visit.visitor_id&&visit.visitor_id!==actor)fail('SHARING_VISIT_ALREADY_BOUND','访问凭据已使用',409);
  await client.query('UPDATE sharing_visit SET visitor_id=$1,bound_at=COALESCE(bound_at,clock_timestamp()) WHERE id=$2',[actor,visit.id]);
  // A chat forward can preserve the original link. This proves a visit, not who recommended the buyer.
  return {recorded:true};
 }
 private async linkReferrer(client:DbClient,buyer:string,policy:Row){
  const sort=policy.priority==='first'?'ASC':'DESC';
  const result=await client.query<{code:string;label:string}>(`SELECT o.referral_code AS code,m.display_name AS label
   FROM sharing_visit v JOIN sharing_link l ON l.share_id=v.share_id
   JOIN sharing_officer o ON o.member_id=l.officer_id JOIN member m ON m.id=o.member_id
   WHERE v.visitor_id=$1 AND v.bound_at IS NOT NULL AND o.member_id<>$1 AND o.state='active' AND m.status='active'
     AND ($2::int IS NULL OR v.visited_at>transaction_timestamp()-make_interval(days=>$2))
     AND (o.v2_application_version IS NULL OR sharing_v2_approval_at(o.member_id,o.v2_application_version)<=v.visited_at)
     AND (l.product_code='' OR EXISTS(SELECT 1 FROM catalog_product p WHERE p.code=l.product_code
       AND p.publication_status='published' AND p.qualification_status='eligible'))
     AND NOT EXISTS(SELECT 1 FROM sharing_customer_relation r
       WHERE r.buyer_id=$1 AND r.officer_id=o.member_id AND r.removed_at IS NOT NULL)
   ORDER BY v.visited_at ${sort},v.id ${sort} LIMIT 1`,[buyer,policy.attribution_days]);
  return result.rows[0]??null;
 }
 private async setChosenRelation(client:DbClient,buyer:string,officer:string,at:Date,p:Row,prior:Row|undefined){
  const version=(await client.query('SELECT COALESCE(max(version),0)+1 AS version FROM sharing_relation_event WHERE buyer_id=$1',[buyer])).rows[0].version;
  const expiry=p.attribution_days===null?null:new Date(at.getTime()+p.attribution_days*86400_000);
  await client.query(`INSERT INTO sharing_relation_event(buyer_id,version,from_officer_id,to_officer_id,visit_id,source)
   VALUES($1,$2,$3,$4,NULL,'member_choice')`,[buyer,version,prior?.officer_id??null,officer]);
  await client.query(`INSERT INTO sharing_customer_relation(buyer_id,officer_id,visit_id,source,effective_at,expires_at,policy_id,version)
   VALUES($1,$2,NULL,'member_choice',$3,$4,$5,$6) ON CONFLICT(buyer_id) DO UPDATE
   SET officer_id=EXCLUDED.officer_id,visit_id=NULL,source='member_choice',effective_at=EXCLUDED.effective_at,
       expires_at=EXCLUDED.expires_at,policy_id=EXCLUDED.policy_id,version=EXCLUDED.version,removed_at=NULL`,
   [buyer,officer,at,expiry,p.id,version]);
 }
 async relationWithClient(client:DbClient,buyer:string){
  const r=(await client.query(`SELECT r.*,o.referral_code,o.state,a.agreement_version,m.display_name FROM sharing_customer_relation r
   JOIN sharing_officer o ON o.member_id=r.officer_id JOIN member m ON m.id=o.member_id
   LEFT JOIN sharing_v2_application a ON a.member_id=o.member_id AND a.application_version=o.v2_application_version
   WHERE r.buyer_id=$1 AND r.removed_at IS NULL AND r.effective_at<=clock_timestamp()
     AND (r.expires_at IS NULL OR r.expires_at>clock_timestamp())`,[buyer])).rows[0];
  return r?{code:r.referral_code,label:r.display_name,displayName:r.display_name,version:r.version,state:r.state,expiresAt:r.expires_at,source:r.source,
   ...(r.agreement_version?{agreementVersion:r.agreement_version}:{})}:null;
 }
 async previewReferrer(actorId:string|undefined,codeInput:unknown){
  const code=text(codeInput,'用户编号',12,12).toUpperCase();
  return transaction(this.pool,async client=>{
   const actor=await requireActiveMemberWithClient(client,actorId);
   const row=(await client.query(`SELECT n.member_id,n.user_code,m.display_name,o.state,o.v2_application_version,
    (o.v2_application_version IS NULL OR sharing_v2_approval_at(o.member_id,o.v2_application_version) IS NOT NULL) AS approved FROM member_card_number n
    JOIN member m ON m.id=n.member_id LEFT JOIN sharing_officer o ON o.member_id=n.member_id
    WHERE n.user_code=$1 AND m.status='active'`,[code])).rows[0];
   if(!row)fail('SHARING_REFERRER_UNAVAILABLE','未找到此用户编号',404);
   if(row.member_id===actor)fail('SHARING_SELF_REFERRAL','不能将自己设为推荐人',422);
   const p=(await client.query(currentSharingPolicySql)).rows[0];
   const current=await this.relationWithClient(client,actor);
  const pending=await pendingSharingReferrer(client,actor,p?.enabled===true);
  const unchanged=current?.code===row.user_code;
  return {code:row.user_code,label:row.display_name,displayName:row.display_name,
    eligible:row.state==='active'&&row.approved===true&&p?.enabled===true,unchanged,
    onFirstValidOrder:!unchanged&&(!!row.v2_application_version||!!current?.agreementVersion||!!pending),current};
  });
 }
 private async changeReferrer(client:DbClient,actor:string,input:Row){
  if(input.confirmed!==true)fail('SHARING_REFERRER_CONFIRM_REQUIRED','请确认更换后的推荐人',422);
  const code=text(input.code,'用户编号',12,12).toUpperCase(),p=(await client.query(currentSharingPolicySql)).rows[0];
  if(!p?.enabled)fail('SHARING_UNAVAILABLE','当前暂不可更换推荐人',503);
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`sharing-relation:${actor}`]);
  const prior=(await client.query(`SELECT r.*,o.v2_application_version,
    r.removed_at IS NULL AND r.effective_at<=clock_timestamp()
      AND (r.expires_at IS NULL OR r.expires_at>clock_timestamp()) AS is_current
   FROM sharing_customer_relation r
   JOIN sharing_officer o ON o.member_id=r.officer_id WHERE r.buyer_id=$1 FOR UPDATE OF r`,[actor])).rows[0];
  const current=prior?.is_current?prior:undefined;
  if((current?.version??0)!==int(input.expectedVersion,'推荐关系版本',0,2_000_000_000))fail('VERSION_CONFLICT','推荐人已更新，请重新确认');
  const pending=await pendingSharingReferrer(client,actor,true);
  if((pending?.id??null)!==(input.expectedPendingId??null))fail('VERSION_CONFLICT','待生效推荐人已更新，请重新确认');
  const officer=(await client.query(`SELECT o.member_id,o.v2_application_version FROM sharing_officer o JOIN member m ON m.id=o.member_id
   WHERE o.referral_code=$1 AND o.state='active' AND m.status='active'
   AND (o.v2_application_version IS NULL OR sharing_v2_approval_at(o.member_id,o.v2_application_version) IS NOT NULL)
   FOR SHARE OF o,m`,[code])).rows[0];
  if(!officer)fail('SHARING_REFERRER_UNAVAILABLE','该分享官当前不可选择',404);
  if(officer.member_id===actor)fail('SHARING_SELF_REFERRAL','不能将自己设为推荐人',422);
  if(current?.officer_id===officer.member_id){
   await client.query("UPDATE sharing_v2_referral_intent SET state='superseded' WHERE buyer_id=$1 AND state='pending' AND source='member_choice'",[actor]);
   return this.relationWithClient(client,actor);
  }
  if(officer.v2_application_version||current?.v2_application_version||pending){
   await setSharingV2Intent(client,actor,officer.member_id);
   return {pendingReferrer:await pendingSharingReferrer(client,actor,true),current:await this.relationWithClient(client,actor)};
  }
  const at=(await client.query('SELECT clock_timestamp() AS at')).rows[0].at;
  await this.setChosenRelation(client,actor,officer.member_id,at,p,prior);
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
   if(action==='customer_relation')return changeSharingCustomer(client,actor,input);
   if(action==='policy'){
    await this.require(client,actor,'commission.rate.manage');const p=sharingPolicyInput(input);
    const current=(await client.query(currentSharingPolicySql)).rows[0];if((current?.version??0)!==int(input.expectedVersion,'规则版本',0,2_000_000_000))fail('VERSION_CONFLICT','规则已更新，请重新加载');
    const row=(await client.query(`INSERT INTO sharing_policy(enabled,attribution_days,priority,self_purchase,basis_points,release_days,reason,created_by,created_principal)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,[p.enabled,p.attributionDays,p.priority,p.selfPurchase,p.basisPoints,p.releaseDays,p.reason,actor,`member:${actor}`])).rows[0];return officerPolicyView(row);
   }
   if(action==='officer_state'){
    await this.require(client,actor,'member.manage');const target=id(input.memberId).toLowerCase(),desired=text(input.state,'资格状态'),expected=int(input.expectedVersion,'申请版本',1,2_000_000_000);
    if(target===actor)fail('SHARING_SELF_REVIEW_FORBIDDEN','不能审核自己的分享官资格',403);
    const targetMember=await requireActiveMemberWithClient(client,target);
    const row=(await client.query('SELECT * FROM sharing_officer WHERE member_id=$1 FOR UPDATE',[targetMember])).rows[0];
    if(!row||row.version!==expected)fail('VERSION_CONFLICT','申请已更新，请重新加载');
    const allowed:Record<string,string[]>={pending:['active','rejected'],active:['suspended','terminated'],suspended:['active','terminated'],promotion_only:['terminated'],rejected:[],terminated:[]};
    if(!allowed[row.state]?.includes(desired))fail('SHARING_STATE_INVALID','当前不能切换到此资格状态');
    const approving=row.state==='pending'&&desired==='active';
    if(approving&&!(await sharingQualification(client,target)).met)
      fail('SHARING_PURCHASE_REQUIRED','该会员的精华套组购买条件未达成，请核对退款及售后状态',409);
    const reason=text(approving?input.reason??'':input.reason,'处理依据',approving?0:2);
    const updated=(await client.query('UPDATE sharing_officer SET state=$2,review_reason=$3,version=version+1,updated_at=clock_timestamp() WHERE member_id=$1 RETURNING *',[target,desired,reason])).rows[0];
    if(desired==='terminated'){
     if(row.v2_application_version)await clearSharingV2Referrals(client,target);
     else await client.query("UPDATE sharing_v2_referral_intent SET state='released' WHERE officer_id=$1 AND state='pending'",[target]);
    }
    await this.event(client,actor,updated,row.state,reason);return {state:updated.state,version:updated.version,referralCode:updated.referral_code};
   }
   fail('SHARING_ACTION_INVALID','操作无效',422);
  });
 }
}

/** Same transaction as order creation; explicit customer ownership is independent of points/legacy referral. */
export async function snapshotSharingOfficer(client:DbClient,orderId:string,buyerId:string,sourceKind:string,cashMerchandiseCents:number){
 const policy=(await client.query(currentSharingPolicySql)).rows[0];if(!policy?.enabled)return null;
 await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`sharing-relation:${buyerId}`]);
 const intent=(await client.query(`SELECT i.officer_id,i.visit_id,i.id AS intent_id,o.v2_application_version,NULL::uuid AS relation_event_id,
   o.state='active' AND m.status='active'
     AND (o.v2_application_version IS NULL OR sharing_v2_approval_at(o.member_id,o.v2_application_version) IS NOT NULL) AS eligible
  FROM sharing_v2_referral_intent i JOIN sharing_officer o ON o.member_id=i.officer_id JOIN member m ON m.id=o.member_id
  WHERE i.buyer_id=$1 AND i.state='pending' AND i.source='member_choice'
  FOR SHARE OF i,o,m`,[buyerId])).rows[0];
 // Keep the confirmed choice visible during suspension. New orders must not silently revert to a different officer.
 if(intent&&(!intent.eligible||sourceKind!=='verified_commerce'))return null;
 const relation=intent??(await client.query(`SELECT r.officer_id,r.visit_id,e.id AS relation_event_id,NULL::uuid AS intent_id,o.v2_application_version FROM sharing_customer_relation r
  JOIN sharing_relation_event e ON e.buyer_id=r.buyer_id AND e.version=r.version
  JOIN sharing_officer o ON o.member_id=r.officer_id JOIN member m ON m.id=o.member_id
  WHERE r.buyer_id=$1 AND r.removed_at IS NULL AND r.officer_id<>$1 AND o.state='active' AND m.status='active'
   AND r.effective_at<=clock_timestamp() AND (r.expires_at IS NULL OR r.expires_at>clock_timestamp())
   AND (o.v2_application_version IS NULL OR sharing_v2_approval_at(o.member_id,o.v2_application_version) IS NOT NULL)
  FOR SHARE OF r,o,m`,[buyerId])).rows[0];
 if(!relation||sourceKind!=='verified_commerce'&&relation.v2_application_version)return null;
 return (await client.query(`INSERT INTO commission_order_snapshot(order_id,buyer_member_id,referrer_member_id,basis_points,
  cash_merchandise_cents,source_kind,program,sharing_policy_id,sharing_visit_id,sharing_relation_event_id,sharing_v2_application_version,sharing_v2_intent_id)
  VALUES($1,$2,$3,$4,$5,$6,'sharing_officer',$7,$8,$9,$10,$11) ON CONFLICT(order_id) DO NOTHING RETURNING order_id`,
  [orderId,buyerId,relation.officer_id,relation.v2_application_version?sharingV2BasisPoints:policy.basis_points,cashMerchandiseCents,sourceKind,policy.id,
   relation.visit_id,relation.relation_event_id,relation.v2_application_version,relation.intent_id])).rows[0]??null;
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
    AND COALESCE((SELECT sum(e.amount_cents) FROM commission_ledger_entry e
      WHERE e.order_id=s.order_id AND e.kind IN ('accrual','refund_reversal')),0)>0
   ORDER BY ship.receipt_confirmed_at,s.order_id LIMIT $1 FOR UPDATE OF o SKIP LOCKED`,[limit])).rows;
  let released=0;
  for(const row of candidates){
   const sums=(await client.query(`SELECT COALESCE(sum(amount_cents) FILTER(WHERE kind IN ('accrual','refund_reversal')),0)::text AS net
    FROM commission_ledger_entry WHERE order_id=$1`,[row.order_id])).rows[0];
   const amount=Number(sums.net);if(amount<=0)continue;
   const release=await client.query(`INSERT INTO commission_ledger_entry(order_id,referrer_member_id,event_key,kind,amount_cents,source_fact_id,actor_principal_id)
    SELECT order_id,referrer_member_id,$2,'release',$3,sharing_policy_id,'worker:sharing-release' FROM commission_order_snapshot WHERE order_id=$1
    ON CONFLICT(event_key) DO NOTHING`,[row.order_id,`sharing-release:${row.order_id}`,amount]);
   if(release.rowCount){await bindSharingV2ReleasedOrder(client,row.order_id);released++;}
  }return released;
 });
}
