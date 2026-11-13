import {createHash,createHmac,createCipheriv,createDecipheriv,randomBytes,randomUUID} from 'node:crypto';
import type pg from 'pg';
import type {AppConfig} from '@cisme/config';
import {transaction,type DbClient} from './db.js';
import {AuthorityService,requireActiveMemberWithClient} from './authority.js';
import {DeliveryAddressService} from './deliveryAddress.js';
import {openCareAnswers,careQuestionnaireVersion} from './careOnboarding.js';
import {launchFulfillmentPolicy} from './fulfillmentPolicy.js';
import {fulfillmentWorkbook} from './fulfillmentWorkbook.js';
import {rewardBundles,rewardBundle,rewardTerms,rewardId,rewardKey,rewardBody,rewardInt,rewardText,rewardRecommendation,visibleVoucherState,rewardFailure as fail,type RewardTerms} from './rewardPolicy.js';
import {reserveRewardComponents,settleRewardClaim} from './rewardLedger.js';

/** Caller must already hold owner/fulfillment/export authority. */
export function openRewardShipment(config:AppConfig,r:Record<string,any>):string|null{
 if(!r.shipment_encrypted)return null;
 try{if(r.key_version!==config.contacts.keyVersion||!config.contacts.encryptionKey||!(/^[0-9a-f]{64}$/i.test(config.contacts.encryptionKey)))throw Error();
  const bytes=Buffer.from(r.shipment_encrypted,'base64'),decipher=createDecipheriv('aes-256-gcm',Buffer.from(config.contacts.encryptionKey,'hex'),bytes.subarray(0,12));
  decipher.setAAD(Buffer.from(`reward-shipment:${r.member_id}:${r.id}`));decipher.setAuthTag(bytes.subarray(12,28));return Buffer.concat([decipher.update(bytes.subarray(28)),decipher.final()]).toString('utf8');
 }catch{fail('REWARD_SHIPMENT_UNREADABLE','物流资料暂不可用，请联系客服',503);}
}

/** Brand-award goods are independent entitlements. Their zero-cash claims never
 * manufacture channel payment facts, consume points or accrue commissions. */
export class ActivityRewardService {
 constructor(private pool:pg.Pool,private config:AppConfig,private authority:AuthorityService,private addresses:DeliveryAddressService){}
 private fingerprint(value:unknown){const key=this.config.contacts.hashKey;if(!key||!(/^[a-f0-9]{64}$/i.test(key)))fail('REWARD_STORAGE_UNAVAILABLE','奖励资料暂不可用',503);return createHmac('sha256',Buffer.from(key,'hex')).update('reward-command\0').update(JSON.stringify(value)).digest('hex');}
 private async enabled(c:DbClient){if(!(await c.query("SELECT enabled FROM emergency_switch WHERE key='rewards' FOR SHARE")).rows[0]?.enabled)fail('SWITCH_REWARDS_OFF','奖励领取暂不可用，请联系客服',503);}
 private async command<T>(actor:string|undefined,keyInput:string,action:string,input:unknown,work:(c:DbClient,owner:string)=>Promise<T>,cap?:'commerce.product.manage'|'commerce.inventory.manage'|'commerce.fulfillment.manage'){
  const operation=rewardKey(keyInput),fingerprint=this.fingerprint({action,input});
  return transaction(this.pool,async c=>{
   const owner=await requireActiveMemberWithClient(c,actor);if(cap)await this.authority.requireWithClient(c,owner,cap);
   await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`reward-command:${owner}:${operation}`]);
   const old=(await c.query('SELECT * FROM reward_event WHERE actor_member_id=$1 AND operation_id=$2',[owner,operation])).rows[0];
   if(old){if(old.action==='reward.command.abandoned')fail('REWARD_COMMAND_ABANDONED','本次待确认操作已取消，请重新核对',409);if(old.request_sha256!==fingerprint||old.action!==action)fail('IDEMPOTENCY_CONFLICT','操作编号已用于其他内容',409);return old.details.result as T;}
   const result=await work(c,owner);
   const source=input&&typeof input==='object'?input as Record<string,unknown>:{};
   const evidence=action==='reward.activity.configure'?{code:source.code,title:source.title,terms:source.terms,action:source.action,reason:source.reason}:
    action==='reward.stock.adjust'?{code:source.code,delta:source.delta,reason:source.reason}:
    ['reward.voucher.revoke','reward.resolve_return','reward.reject_return'].includes(action)?{reason:source.reason}:{};
   await c.query('INSERT INTO reward_event(actor_member_id,action,object_id,operation_id,request_sha256,details) VALUES($1,$2,$3,$4,$5,$6)',[owner,action,(result as any)?.id??owner,operation,fingerprint,{result,...evidence}]);
   if(cap)await this.authority.requireWithClient(c,owner,cap);return result;
  },'SERIALIZABLE');
 }
 private voucherView(r:any,now:Date){return {id:r.id,activityId:r.activity_id,activityTitle:r.title,name:'旅行洗护套兑换券',state:visibleVoucherState(r,now),version:r.version,claimId:r.claim_id,issuedAt:r.issued_at.toISOString(),expiresAt:r.expires_at.toISOString(),terms:r.terms_snapshot};}
 private claimView(r:any){return {id:r.id,claimNumber:r.claim_number,memberId:r.member_id,voucherId:r.voucher_id,state:r.state,version:r.version,item:r.item_snapshot,terms:r.terms_snapshot,
  shippingCents:r.shipping_cents,questionnaireVersion:r.questionnaire_version,surveyVersion:r.survey_version,recommendation:r.recommendation,
  carrierName:r.carrier_name,shippedAt:r.shipped_at?.toISOString()??null,receivedAt:r.received_at?.toISOString()??null,createdAt:r.created_at.toISOString(),updatedAt:r.updated_at.toISOString(),aftersaleReason:r.aftersale_reason};}
 private async bundleViews(c:DbClient){const stock=(await c.query('SELECT * FROM reward_component_inventory ORDER BY code')).rows;return rewardBundles.map(b=>({...b,availableQuantity:Math.min(...b.components.map(code=>{const r=stock.find(r=>r.code===code);return r?.confirmed?r.stock_on_hand-r.reserved_quantity:0;})),stockConfirmed:b.components.every(code=>stock.some(r=>r.code===code&&r.confirmed))}));}
 async mine(actor:string|undefined,now=new Date(),claimsCursor?:string){
  const cursor=claimsCursor?rewardId(claimsCursor):null;
  return transaction(this.pool,async c=>{const owner=await requireActiveMemberWithClient(c,actor);
   const vouchers=(await c.query('SELECT v.*,a.title FROM reward_voucher v JOIN reward_activity a ON a.id=v.activity_id WHERE v.member_id=$1 ORDER BY issued_at DESC,v.id DESC',[owner])).rows;
   const claims=(await c.query('SELECT * FROM activity_reward_claim WHERE member_id=$1 AND ($2::uuid IS NULL OR (created_at,id)<(SELECT created_at,id FROM activity_reward_claim WHERE id=$2 AND member_id=$1)) ORDER BY created_at DESC,id DESC LIMIT 26',[owner,cursor])).rows;
   const coupons=(await c.query('SELECT id,state,threshold_cents,discount_cents,issued_at,expires_at,order_id FROM member_purchase_coupon WHERE member_id=$1 ORDER BY issued_at DESC,id DESC',[owner])).rows;
   const eligible=(await c.query(`SELECT cp.id AS coupon_id,p.id,p.code,p.name,p.image_path,min(pr.amount_cents)::int AS price_cents FROM member_purchase_coupon cp JOIN catalog_product p ON p.id=ANY(cp.eligible_product_ids)
    JOIN catalog_sku s ON s.product_id=p.id JOIN catalog_price pr ON pr.sku_id=s.id WHERE cp.member_id=$1 AND p.publication_status='published' AND p.qualification_status='eligible' AND s.active GROUP BY cp.id,p.id ORDER BY p.name,p.id`,[owner])).rows;
   return {memberId:owner,vouchers:vouchers.map(r=>this.voucherView(r,now)),claims:claims.slice(0,25).map(r=>this.claimView(r)),moreClaims:claims.length>25,claimsNextCursor:claims.length>25?claims[24].id:null,coupons:coupons.map(r=>({id:r.id,state:r.state==='available'&&r.expires_at<=now?'expired':r.state,thresholdCents:r.threshold_cents,discountCents:r.discount_cents,issuedAt:r.issued_at.toISOString(),expiresAt:r.expires_at.toISOString(),orderId:r.order_id,products:eligible.filter(p=>p.coupon_id===r.id).map(p=>({id:p.id,code:p.code,name:p.name,image:p.image_path,priceCents:p.price_cents}))}))};
  },'REPEATABLE READ');
 }
 async selection(actor:string|undefined,voucherId:string,now=new Date()){
  return transaction(this.pool,async c=>{const owner=await requireActiveMemberWithClient(c,actor),v=(await c.query('SELECT v.*,a.title FROM reward_voucher v JOIN reward_activity a ON a.id=v.activity_id WHERE v.id=$1 AND v.member_id=$2',[rewardId(voucherId),owner])).rows[0];
   if(!v)fail('REWARD_NOT_FOUND','兑换券不存在',404);
   const survey=(await c.query('SELECT * FROM member_care_profile WHERE member_id=$1 AND erased_at IS NULL',[owner])).rows[0];
   const completed=survey?.completed_at&&survey.questionnaire_version===careQuestionnaireVersion;
   const recommendation=completed?rewardRecommendation(openCareAnswers(this.config,survey),survey.health_choice):null;
   return {memberId:owner,voucher:this.voucherView(v,now),bundles:await this.bundleViews(c),survey:{completed:Boolean(completed),version:survey?.version??0,questionnaireVersion:careQuestionnaireVersion,recommendation}};
  },'REPEATABLE READ');
 }
 async quote(actor:string|undefined,keyInput:string,input:unknown,now=new Date()){
  const b=rewardBody(input,['voucherId','bundleCode','addressId','addressVersion','surveyVersion']);
  const args={voucherId:rewardId(b.voucherId),bundleCode:rewardBundle(b.bundleCode).code,addressId:rewardId(b.addressId),addressVersion:rewardInt(b.addressVersion),surveyVersion:rewardInt(b.surveyVersion)};
  const operation=rewardKey(keyInput),fingerprint=this.fingerprint(args);
  return transaction(this.pool,async c=>{const owner=await requireActiveMemberWithClient(c,actor);await this.enabled(c);
   await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`reward-quote:${owner}:${operation}`]);
   const old=(await c.query('SELECT * FROM reward_quote WHERE member_id=$1 AND operation_id=$2',[owner,operation])).rows[0];
   if(old){if(old.request_sha256!==fingerprint)fail('IDEMPOTENCY_CONFLICT','请使用新的操作重新确认',409);return this.quoteView(old,now);}
   const v=(await c.query('SELECT * FROM reward_voucher WHERE id=$1 AND member_id=$2 FOR SHARE',[args.voucherId,owner])).rows[0];
   if(!v||visibleVoucherState(v,now)!=='unused')fail('REWARD_VOUCHER_UNAVAILABLE','兑换券当前不可用，请返回我的奖励核对',409);
   const survey=(await c.query('SELECT * FROM member_care_profile WHERE member_id=$1 AND erased_at IS NULL FOR SHARE',[owner])).rows[0];
   if(!survey?.completed_at||survey.questionnaire_version!==careQuestionnaireVersion||survey.version!==args.surveyVersion)fail('REWARD_SURVEY_CHANGED','请先完成或重新确认护理问卷',409);
   const address=await this.addresses.checkoutSnapshot(c,owner,args.addressId,args.addressVersion);launchFulfillmentPolicy(address.payload);
   const bundles=await this.bundleViews(c),bundle=bundles.find(x=>x.code===args.bundleCode)!;
   if(!bundle.stockConfirmed)fail('REWARD_STOCK_UNCONFIRMED','奖励库存待确认，请联系客服',409);
   if(bundle.availableQuantity<1)fail('REWARD_SOLD_OUT','这套暂时兑完，请选择另一套',409);
   const expiresAt=new Date(Math.min(v.expires_at.getTime(),now.getTime()+10*60000));
   const row=(await c.query(`INSERT INTO reward_quote(member_id,voucher_id,voucher_version,bundle_code,item_snapshot,survey_version,questionnaire_version,recommendation,address_id,address_version,shipping_cents,expires_at,operation_id,request_sha256)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,0,$11,$12,$13) RETURNING *`,[owner,v.id,v.version,args.bundleCode,rewardBundle(args.bundleCode),survey.version,careQuestionnaireVersion,rewardRecommendation(openCareAnswers(this.config,survey),survey.health_choice),args.addressId,args.addressVersion,expiresAt,operation,fingerprint])).rows[0];
   return this.quoteView(row,now);
  },'SERIALIZABLE');
 }
 private quoteView(r:any,now:Date){return {id:r.id,voucherId:r.voucher_id,bundleCode:r.bundle_code,item:r.item_snapshot,surveyVersion:r.survey_version,addressId:r.address_id,addressVersion:r.address_version,shippingCents:0,totalCents:0,expiresAt:r.expires_at.toISOString(),serverTime:now.toISOString()};}
 async claim(actor:string|undefined,keyInput:string,input:unknown,now=new Date()){
  const b=rewardBody(input,['quoteId']),quoteId=rewardId(b.quoteId);
  return this.command(actor,keyInput,'reward.claim',{quoteId},async(c,owner)=>{
   await this.enabled(c);
   const q=(await c.query('SELECT * FROM reward_quote WHERE id=$1 AND member_id=$2 FOR UPDATE',[quoteId,owner])).rows[0];
   if(!q)fail('REWARD_QUOTE_NOT_FOUND','领取资料不存在，请重新确认',404);
   if(q.consumed_at){const prior=(await c.query('SELECT id,state,version FROM activity_reward_claim WHERE quote_id=$1',[q.id])).rows[0];if(prior)return prior;fail('REWARD_QUOTE_CHANGED','领取记录需核对',409);}
   if(q.expires_at<=now)fail('REWARD_QUOTE_EXPIRED','领取资料已过期，请重新确认',409);
   const voucher=(await c.query('SELECT * FROM reward_voucher WHERE id=$1 AND member_id=$2 FOR UPDATE',[q.voucher_id,owner])).rows[0];
   if(!voucher||visibleVoucherState(voucher,now)!=='unused'||voucher.version!==q.voucher_version)fail('REWARD_VOUCHER_UNAVAILABLE','兑换券当前不可用，请返回我的奖励核对',409);
   const survey=(await c.query('SELECT version,completed_at,questionnaire_version FROM member_care_profile WHERE member_id=$1 AND erased_at IS NULL FOR SHARE',[owner])).rows[0];
   if(!survey?.completed_at||survey.version!==q.survey_version||survey.questionnaire_version!==q.questionnaire_version)fail('REWARD_SURVEY_CHANGED','问卷已有更新，请重新确认套装',409);
   const address=await this.addresses.checkoutSnapshot(c,owner,q.address_id,q.address_version);launchFulfillmentPolicy(address.payload);
   const claimId=randomUUID(),sealed=this.addresses.sealOrderSnapshot(owner,claimId,address.payload),fingerprint=this.fingerprint({quoteId});
   const claim=(await c.query(`INSERT INTO activity_reward_claim(id,claim_number,member_id,voucher_id,quote_id,state,bundle_code,item_snapshot,terms_snapshot,survey_version,questionnaire_version,recommendation,shipping_cents,encrypted_address,address_hmac,key_version,operation_id,request_sha256,created_at,updated_at)
    VALUES($1,$2,$3,$4,$5,'placed',$6,$7,$8,$9,$10,$11,0,$12,$13,$14,$15,$16,$17,$17) RETURNING *`,[claimId,`CR${now.toISOString().slice(0,10).replaceAll('-','')}${claimId.replaceAll('-','').slice(0,12).toUpperCase()}`,owner,voucher.id,q.id,q.bundle_code,q.item_snapshot,voucher.terms_snapshot,q.survey_version,q.questionnaire_version,q.recommendation,sealed.encryptedPayload,sealed.payloadHmac,sealed.keyVersion,keyInput,fingerprint,now])).rows[0];
   await c.query("UPDATE reward_voucher SET state='locked',claim_id=$2,version=version+1 WHERE id=$1",[voucher.id,claimId]);
   await reserveRewardComponents(c,claimId,q.bundle_code);
   // Inventory row waits may cross the expiry boundary; recheck the database wall clock after all locks.
   if((await c.query('SELECT LEAST($1::timestamptz,$2::timestamptz)<=clock_timestamp() AS expired',[q.expires_at,voucher.expires_at])).rows[0].expired)fail('REWARD_QUOTE_EXPIRED','领取资料已过期，请重新确认',409);
   await settleRewardClaim(c,claim,'consume',now);
   await c.query('UPDATE reward_quote SET consumed_at=$2 WHERE id=$1',[q.id,now]);
   return {id:claimId,state:'placed',version:1};
  });
 }
 async commandReceipt(actor:string|undefined,keyInput:string){
  const operation=rewardKey(keyInput);return transaction(this.pool,async c=>{const owner=await requireActiveMemberWithClient(c,actor);
   const r=(await c.query('SELECT action,details FROM reward_event WHERE actor_member_id=$1 AND operation_id=$2',[owner,operation])).rows[0];
   return !r?{status:'not_found'}:r.action==='reward.command.abandoned'?{status:'abandoned'}:{status:'found',action:r.action,record:{id:r.details.result?.id,state:r.details.result?.state,version:r.details.result?.version}};
  });
 }
 async abandonCommand(actor:string|undefined,keyInput:string){
  const operation=rewardKey(keyInput);return transaction(this.pool,async c=>{const owner=await requireActiveMemberWithClient(c,actor);
   await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`reward-command:${owner}:${operation}`]);
   const prior=(await c.query('SELECT action,details FROM reward_event WHERE actor_member_id=$1 AND operation_id=$2',[owner,operation])).rows[0];
   if(prior)return {status:prior.action==='reward.command.abandoned'?'abandoned':'found',action:prior.action,record:{id:prior.details.result?.id,state:prior.details.result?.state,version:prior.details.result?.version}};
   await c.query("INSERT INTO reward_event(actor_member_id,action,object_id,operation_id,request_sha256,details) VALUES($1::uuid,'reward.command.abandoned',$1::uuid::text,$2,$3,'{}')",[owner,operation,this.fingerprint({abandoned:operation})]);
   return {status:'abandoned'};
  });
 }
 private shipmentKey(){const raw=this.config.contacts.encryptionKey;if(!raw||!(/^[0-9a-f]{64}$/i.test(raw)))fail('REWARD_STORAGE_UNAVAILABLE','物流资料暂不可用',503);return Buffer.from(raw,'hex');}
 private sealShipment(member:string,claim:string,tracking:string){const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',this.shipmentKey(),iv);cipher.setAAD(Buffer.from(`reward-shipment:${member}:${claim}`));const encrypted=Buffer.concat([cipher.update(tracking,'utf8'),cipher.final()]);return Buffer.concat([iv,cipher.getAuthTag(),encrypted]).toString('base64');}
 private openShipment(r:any){return openRewardShipment(this.config,r);}
 async detail(actor:string|undefined,claimId:string,management=false){
  return transaction(this.pool,async c=>{const owner=await requireActiveMemberWithClient(c,actor);if(management)await this.authority.requireWithClient(c,owner,'commerce.fulfillment.manage');
   const r=(await c.query('SELECT * FROM activity_reward_claim WHERE id=$1 AND ($2::uuid IS NULL OR member_id=$2)',[rewardId(claimId),management?null:owner])).rows[0];if(!r)fail('REWARD_NOT_FOUND','领取订单不存在',404);
   if(management)await c.query("INSERT INTO audit_log(principal_id,action,object_type,object_id,trace_id) VALUES($1,'reward.fulfillment.read','activity_reward_claim',$2,$3)",[ `member:${owner}`,r.id,randomUUID()]);
   const coupon=(await c.query('SELECT id FROM member_purchase_coupon WHERE source_claim_id=$1',[r.id])).rows[0];
   return {...this.claimView(r),address:this.addresses.openOrderSnapshot(r.member_id,r.id,r.encrypted_address,r.address_hmac,r.key_version),trackingNumber:this.openShipment(r),couponId:coupon?.id??null};
  });
 }
 async operate(actor:string|undefined,claimId:string,keyInput:string,action:string,input:unknown,now=new Date()){
  const b=rewardBody(input,['expectedVersion','carrierName','trackingNumber','reason']),id=rewardId(claimId),version=rewardInt(b.expectedVersion);
  if(!['cancel','receive','ship','request_return','resolve_return','reject_return'].includes(action))fail('REWARD_ACTION_INVALID','请选择有效操作');
  const management=['ship','resolve_return','reject_return'].includes(action);
  return this.command(actor,keyInput,`reward.${action}`,{id,...b},async(c,owner)=>{
   const r=(await c.query('SELECT * FROM activity_reward_claim WHERE id=$1 FOR UPDATE',[id])).rows[0];
   if(!r||!management&&r.member_id!==owner)fail('REWARD_NOT_FOUND','领取订单不存在',404);
   if(r.version!==version)fail('REWARD_CHANGED','领取状态已更新，请刷新后重试',409);
   let next=r.state;const patch:any={};
   if(action==='cancel'){
    if(r.state!=='placed')fail('REWARD_ALREADY_DISPATCHED','请通过售后处理这笔领取',409);
    await settleRewardClaim(c,r,'cancel_unshipped',now);next='cancelled';
   }else if(action==='ship'){
    if(r.state!=='placed')fail('REWARD_STATE_INVALID','当前订单不可发货',409);
    const carrier=rewardText(b.carrierName,1,50),tracking=rewardText(b.trackingNumber,6,80);
    if(!/^[A-Za-z0-9-]{6,80}$/.test(tracking))fail('REWARD_TRACKING_INVALID','请填写真实物流单号');
    patch.carrier=carrier;patch.shipment=this.sealShipment(r.member_id,r.id,tracking);patch.shipped=now;next='shipped';
   }else if(action==='receive'){
    if(r.state!=='shipped')fail('REWARD_STATE_INVALID','请在收到包裹后确认收货',409);
    next='received';patch.received=now;
    await c.query(`INSERT INTO member_purchase_coupon(member_id,source_claim_id,eligible_product_ids,issued_at,expires_at)
     VALUES($1,$2,$3,$4,$5) ON CONFLICT(member_id,template_code) DO NOTHING`,[r.member_id,r.id,(r.terms_snapshot as RewardTerms).eligibleProductIds,now,new Date(now.getTime()+30*86400000)]);
   }else if(action==='request_return'){
    if(!['placed','shipped','received'].includes(r.state))fail('REWARD_STATE_INVALID','当前订单已有售后处理',409);
    patch.reason=rewardText(b.reason,3,500);patch.previous=r.state;next='aftersale_requested';
   }else{
    if(r.state!=='aftersale_requested')fail('REWARD_STATE_INVALID','当前没有待处理售后',409);
    rewardText(b.reason,3,500);
    if(action==='reject_return')next=r.previous_state;
    else {
     if(r.previous_state==='placed')await settleRewardClaim(c,r,'cancel_unshipped',now);
     next=r.previous_state==='placed'?'cancelled':'closed';
     // Inspected returns do not automatically become saleable or a new award.
     await c.query("UPDATE member_purchase_coupon SET state='revoked',version=version+1 WHERE source_claim_id=$1 AND state='available'",[r.id]);
    }
   }
   const updated=(await c.query(`UPDATE activity_reward_claim SET state=$2,version=version+1,updated_at=$3,carrier_name=COALESCE($4,carrier_name),shipment_encrypted=COALESCE($5,shipment_encrypted),shipped_at=COALESCE($6,shipped_at),received_at=COALESCE($7,received_at),aftersale_reason=COALESCE($8,aftersale_reason),previous_state=COALESCE($9,previous_state) WHERE id=$1 RETURNING id,state,version`,[r.id,next,now,patch.carrier??null,patch.shipment??null,patch.shipped??null,patch.received??null,patch.reason??null,patch.previous??null])).rows[0];return updated;
  },management?'commerce.fulfillment.manage':undefined);
 }
 async configure(actor:string|undefined,keyInput:string,input:unknown){
  const b=rewardBody(input,['id','code','title','expectedVersion','terms','action','reason']),title=rewardText(b.title,1,80),code=rewardText(b.code,3,64);
  if(!/^[a-z0-9][a-z0-9-]{2,63}$/.test(code))fail('REWARD_CODE_INVALID','活动编号请使用小写字母、数字和连字符');
  if(!['save','publish','pause'].includes(String(b.action)))fail('REWARD_ACTION_INVALID','请选择保存、发布或暂停');
  const terms=b.terms===null?null:rewardTerms(b.terms),why=rewardText(b.reason,4,500);
  return this.command(actor,keyInput,'reward.activity.configure',{...b,title,code,terms,reason:why},async(c,owner)=>{
   const id=b.id?rewardId(b.id):randomUUID(),row=(await c.query('SELECT * FROM reward_activity WHERE id=$1 FOR UPDATE',[id])).rows[0];
   if((row?.version??0)!==rewardInt(b.expectedVersion,0))fail('REWARD_CHANGED','活动已有更新，请重新核对',409);
   if(row&&row.code!==code)fail('REWARD_CODE_IMMUTABLE','已创建活动的编号不能更改',409);
   const duplicate=(await c.query('SELECT id FROM reward_activity WHERE code=$1 AND id<>$2',[code,id])).rows[0];if(duplicate)fail('REWARD_CODE_EXISTS','活动编号已使用，请更换编号',409);
   const state=b.action==='publish'?'published':b.action==='pause'?'paused':row?.state??'draft';
   if(state==='published'){
    if(!terms)fail('REWARD_TERMS_REQUIRED','请确认活动规则与适用商品');
    const inventory=(await c.query('SELECT confirmed FROM reward_component_inventory ORDER BY code FOR SHARE')).rows;
    if(inventory.length!==3||inventory.some(r=>!r.confirmed))fail('REWARD_STOCK_UNCONFIRMED','请先确认三个组件的真实库存',409);
    const products=(await c.query(`SELECT id FROM catalog_product WHERE id=ANY($1::uuid[]) AND qualification_status='eligible' AND publication_status='published' AND ($2::boolean OR source_kind='admin') FOR SHARE`,[terms.eligibleProductIds,this.config.env==='test'])).rows;
    if(products.length!==terms.eligibleProductIds.length)fail('REWARD_COUPON_PRODUCTS_INVALID','请选择已上架的正装或套组',409);
   }
   if(state!=='draft'&&!terms)fail('REWARD_TERMS_REQUIRED','已发布活动需要完整规则');
   const result=(await c.query(`INSERT INTO reward_activity(id,code,title,terms,state,created_by,updated_by) VALUES($1,$2,$3,$4,$5,$6,$6)
    ON CONFLICT(id) DO UPDATE SET title=$3,terms=$4,state=$5,version=reward_activity.version+1,updated_by=$6,updated_at=now() RETURNING id,version,state`,[id,code,title,terms,state,owner])).rows[0];return result;
  },'commerce.product.manage');
 }
 async inventory(actor:string|undefined,keyInput:string,input:unknown){
  const b=rewardBody(input,['code','expectedVersion','delta','reason']),code=rewardText(b.code),version=rewardInt(b.expectedVersion),delta=rewardInt(b.delta,-2_000_000_000,2_000_000_000),reason=rewardText(b.reason,4,500);
  if(!['moisture100','dandruff50','conditioner100'].includes(code))fail('REWARD_COMPONENT_INVALID','请选择正确的组件');
  return this.command(actor,keyInput,'reward.stock.adjust',{code,version,delta,reason},async(c)=>{const r=(await c.query('SELECT * FROM reward_component_inventory WHERE code=$1 FOR UPDATE',[code])).rows[0];
   if(r.version!==version)fail('REWARD_CHANGED','库存已有更新，请重新核对',409);
   if(r.stock_on_hand+delta<r.reserved_quantity||r.stock_on_hand+delta>2_000_000_000)fail('REWARD_STOCK_INVALID','调整后库存不能少于已占用数量',409);
   const result=(await c.query('UPDATE reward_component_inventory SET stock_on_hand=stock_on_hand+$2,confirmed=true,version=version+1,updated_at=now() WHERE code=$1 RETURNING code,version,stock_on_hand,reserved_quantity,confirmed',[code,delta])).rows[0];return {id:code,...result};
  },'commerce.inventory.manage');
 }
 async issue(actor:string|undefined,activityId:string,keyInput:string,input:unknown,now=new Date()){
  const b=rewardBody(input,['batchId','awards']),batch=rewardText(b.batchId,1,80),id=rewardId(activityId);
  if(!Array.isArray(b.awards)||!b.awards.length||b.awards.length>500)fail('REWARD_AWARDS_INVALID','每批请填写1至500条获奖记录');
  const awards=b.awards.map((raw:unknown)=>{const v=rewardBody(raw,['sourceRecordId','memberId']);return {sourceRecordId:rewardText(v.sourceRecordId,1,120),memberId:rewardId(v.memberId)};});
  if(new Set(awards.map(a=>a.sourceRecordId)).size!==awards.length)fail('REWARD_AWARDS_DUPLICATED','同批获奖记录编号不能重复');
  return this.command(actor,keyInput,'reward.voucher.issue',{id,batch,awards},async(c,owner)=>{
   await this.authority.requireWithClient(c,owner,'member.manage');await this.enabled(c);
   // Global member identity, not a batch/activity code, is the one-award boundary.
   await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['reward-global-issuance']);
   const activity=(await c.query("SELECT * FROM reward_activity WHERE id=$1 AND state='published' FOR SHARE",[id])).rows[0];if(!activity?.terms)fail('REWARD_ACTIVITY_UNAVAILABLE','请先确认并发布活动',409);
   const terms=rewardTerms(activity.terms),results=[];
   for(const award of awards){
    if(!(await c.query("SELECT 1 FROM member WHERE id=$1 AND status='active' FOR SHARE",[award.memberId])).rowCount)fail('REWARD_MEMBER_NOT_FOUND','发放对象必须是已有有效会员',409);
    const same=(await c.query('SELECT * FROM reward_award WHERE activity_id=$1 AND source_record_id=$2',[id,award.sourceRecordId])).rows[0];
    if(same&&same.member_id!==award.memberId)fail('REWARD_AWARD_CONFLICT','该获奖编号已绑定其他会员',409);
    const prior=(await c.query('SELECT id,award_id FROM reward_voucher WHERE member_id=$1',[award.memberId])).rows[0];
    if(prior){results.push({memberId:award.memberId,voucherId:prior.id,issued:false});continue;}
    const a=(await c.query('INSERT INTO reward_award(activity_id,source_record_id,member_id,batch_id,created_by) VALUES($1,$2,$3,$4,$5) RETURNING id',[id,award.sourceRecordId,award.memberId,batch,owner])).rows[0];
    const v=(await c.query('INSERT INTO reward_voucher(activity_id,award_id,member_id,terms_snapshot,activity_version,expires_at,issued_at) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id',[id,a.id,award.memberId,terms,activity.version,new Date(now.getTime()+30*86400000),now])).rows[0];results.push({memberId:award.memberId,voucherId:v.id,issued:true});
   }
   return {id,items:results,issued:results.filter(r=>r.issued).length,existing:results.filter(r=>!r.issued).length};
  },'commerce.product.manage');
 }
 async revoke(actor:string|undefined,voucherId:string,keyInput:string,input:unknown){
  const b=rewardBody(input,['expectedVersion','reason']),id=rewardId(voucherId),version=rewardInt(b.expectedVersion),reason=rewardText(b.reason,4,500);
  return this.command(actor,keyInput,'reward.voucher.revoke',{id,version,reason},async(c,owner)=>{await this.authority.requireWithClient(c,owner,'member.manage');
   const r=(await c.query('SELECT * FROM reward_voucher WHERE id=$1 FOR UPDATE',[id])).rows[0];if(!r)fail('REWARD_NOT_FOUND','兑换券不存在',404);
   if(r.version!==version)fail('REWARD_CHANGED','兑换券已有更新',409);
   if(!['unused','expired'].includes(r.state))fail('REWARD_REVOKE_REQUIRES_AFTERSALE','已领取奖励请通过领取订单售后处理',409);
   return (await c.query("UPDATE reward_voucher SET state='revoked',version=version+1 WHERE id=$1 RETURNING id,state,version",[id])).rows[0];
  },'commerce.product.manage');
 }
 async management(actor:string|undefined,query:{activityId?:unknown;state?:unknown;after?:unknown}={}){
  await this.authority.requireAny(actor,['commerce.product.manage','commerce.inventory.manage','commerce.fulfillment.manage']);
  const activity=query.activityId?rewardId(query.activityId):null,after=query.after?rewardId(query.after):null,state=query.state??'all';
  if(!['all','unused','used','expired','revoked','placed','shipped','received','cancelled','aftersale_requested','closed'].includes(String(state)))fail('REWARD_FILTER_INVALID','状态筛选无效');
  return transaction(this.pool,async c=>{
   const grants=await this.authority.projection(actor),canIssue=grants.capabilities.includes('commerce.product.manage')&&grants.capabilities.includes('member.manage'),canFulfill=grants.capabilities.includes('commerce.fulfillment.manage');
   const allowed=(['commerce.product.manage','commerce.inventory.manage','commerce.fulfillment.manage'] as const).filter(cap=>grants.capabilities.includes(cap));
   if(!allowed.length)fail('CAPABILITY_REQUIRED','当前账号无活动管理权限',403);
   for(const cap of allowed)await this.authority.requireWithClient(c,actor,cap);
   if(canIssue)await this.authority.requireWithClient(c,actor,'member.manage');
   const activities=(await c.query('SELECT id,code,title,state,version,terms,created_at FROM reward_activity ORDER BY created_at DESC,id DESC LIMIT 100')).rows;
   const vouchers=canIssue?(await c.query(`SELECT v.id,v.member_id,v.state,v.version,v.expires_at,v.claim_id,a.batch_id,a.source_record_id,m.display_name
    FROM reward_voucher v JOIN reward_award a ON a.id=v.award_id JOIN member m ON m.id=v.member_id
    WHERE ($1::uuid IS NULL OR v.activity_id=$1) AND ($2='all' OR CASE WHEN v.state='unused' AND v.expires_at<=now() THEN 'expired' ELSE v.state END=$2)
    AND ($3::uuid IS NULL OR v.id>$3) ORDER BY v.id LIMIT 51`,[activity,state,after])).rows:[];
   const claims=canFulfill?(await c.query(`SELECT c.* FROM activity_reward_claim c JOIN reward_voucher v ON v.id=c.voucher_id
    WHERE ($1::uuid IS NULL OR v.activity_id=$1) AND ($2='all' OR c.state=$2) AND ($3::uuid IS NULL OR c.id>$3) ORDER BY c.id LIMIT 51`,[activity,state,after])).rows:[];
   return {memberId:actor!,activities,inventory:(await c.query('SELECT * FROM reward_component_inventory ORDER BY code')).rows,vouchers:vouchers.slice(0,50).map(r=>({...r,state:visibleVoucherState(r,new Date())})),claims:claims.slice(0,50).map(r=>this.claimView(r)),voucherNext:vouchers.length>50?vouchers[49].id:null,claimNext:claims.length>50?claims[49].id:null,
    permissions:{configure:grants.capabilities.includes('commerce.product.manage'),stock:grants.capabilities.includes('commerce.inventory.manage'),issue:canIssue,fulfill:canFulfill}};
  },'REPEATABLE READ');
 }
 async export(actor:string|undefined,activityId:string,kind:string,after?:string){
  const activity=rewardId(activityId),cursor=after?rewardId(after):null;
  if(!['awarded','issued','claimed','pending_dispatch','unclaimed'].includes(kind))fail('REWARD_EXPORT_INVALID','导出类型无效');
  return transaction(this.pool,async c=>{await this.authority.requireWithClient(c,actor,'member.manage');await this.authority.requireWithClient(c,actor,'commerce.product.manage');
   const exportTracking=await this.authority.has(actor,'commerce.fulfillment.manage',c);if(exportTracking)await this.authority.requireWithClient(c,actor,'commerce.fulfillment.manage');
   const rows=(await c.query(`SELECT a.id AS award_id,a.source_record_id,a.batch_id,a.member_id,v.id AS voucher_id,CASE WHEN v.state='unused' AND v.expires_at<=clock_timestamp() THEN 'expired' ELSE v.state END AS voucher_state,v.expires_at,c.id AS claim_id,c.claim_number,c.state AS claim_state,c.item_snapshot,c.bundle_code,c.survey_version,c.questionnaire_version,c.recommendation,c.carrier_name,c.shipment_encrypted,c.key_version,c.shipping_cents,c.shipped_at,c.received_at
    FROM reward_award a LEFT JOIN reward_voucher v ON v.award_id=a.id LEFT JOIN activity_reward_claim c ON c.id=v.claim_id
    WHERE a.activity_id=$1 AND ($2::uuid IS NULL OR a.id>$2) AND
    ($3 IN ('awarded','issued') OR $3='claimed' AND v.state='used' OR $3='pending_dispatch' AND c.state='placed' OR $3='unclaimed' AND v.state IN ('unused','expired'))
    ORDER BY a.id LIMIT 501`,[activity,cursor,kind])).rows;
   const page=rows.slice(0,500),last=rows.length>500?page.at(-1)!.award_id:null;
   const workbook=fulfillmentWorkbook([['获奖记录','发放批次','会员ID','兑换券ID','券状态','有效期','领取单号','领取状态','套装','规格','运费实付','发货时间','收货时间','档案引用','问卷版本','推荐套装','领取订单ID','最终套装SKU','承运商','物流单号'],...page.map(r=>[r.source_record_id,r.batch_id,r.member_id,r.voucher_id??'',r.voucher_state??'',r.expires_at?.toISOString()??'',r.claim_number??'',r.claim_state??'',r.item_snapshot?.name??'',r.item_snapshot?`${r.item_snapshot.shampooMl}+${r.item_snapshot.conditionerMl}mL`:'','0.00',r.shipped_at?.toISOString()??'',r.received_at?.toISOString()??'',r.claim_id?`${r.member_id}#${r.survey_version}`:'',r.questionnaire_version??'',r.recommendation??'',r.claim_id??'',r.bundle_code??'',exportTracking?r.carrier_name??'':'',exportTracking&&r.claim_id?this.openShipment({...r,id:r.claim_id})??'':''])]);
   await c.query("INSERT INTO audit_log(principal_id,action,object_type,object_id,after_state,trace_id) VALUES($1,'reward.export','reward_activity',$2,$3,$4)",[`member:${actor}`,activity,{kind,count:page.length,sha256:createHash('sha256').update(workbook).digest('hex'),nextCursor:last},randomUUID()]);
   return {workbook,nextCursor:last,count:page.length};
  },'REPEATABLE READ');
 }
 async eligibleCoupons(actor:string|undefined,skuId:string,quantityInput:unknown,now=new Date()){
  const sku=rewardId(skuId),quantity=rewardInt(Number(quantityInput??1),1,99);
  return transaction(this.pool,async c=>{const owner=await requireActiveMemberWithClient(c,actor);
   const item=(await c.query(`SELECT p.id,pr.amount_cents FROM catalog_product p JOIN catalog_sku s ON s.product_id=p.id JOIN catalog_price pr ON pr.sku_id=s.id WHERE s.id=$1 AND s.active AND p.publication_status='published' AND p.qualification_status='eligible'`,[sku])).rows[0];
   if(!item)fail('CATALOG_SKU_NOT_FOUND','商品当前不可用',404);
   const coupons=(await c.query("SELECT * FROM member_purchase_coupon WHERE member_id=$1 AND state='available' AND expires_at>$2 AND $3::uuid=ANY(eligible_product_ids) AND threshold_cents<=$4 ORDER BY expires_at,id",[owner,now,item.id,item.amount_cents*quantity])).rows;
   return {items:coupons.map(r=>({id:r.id,name:'体验专属正装券',thresholdCents:r.threshold_cents,discountCents:r.discount_cents,expiresAt:r.expires_at.toISOString(),version:r.version}))};
  });
 }
}
