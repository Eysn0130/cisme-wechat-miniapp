import {beforeAll,afterAll,describe,it,expect} from 'vitest';
import {randomUUID} from 'node:crypto';
import {loadConfig} from '@cisme/config';
import {testPool,resetDatabase,TEST_DATABASE_URL} from '@cisme/testkit';
import {createApp} from '../../services/api/src/server';
import {createApiGatewayStorage} from '../../services/api/src/storage';
import {ActivityRewardService} from '../../services/api/src/activityRewards';
import {AuthorityService} from '../../services/api/src/authority';
import {DeliveryAddressService} from '../../services/api/src/deliveryAddress';
import {CareOnboardingService,careQuestions} from '../../services/api/src/careOnboarding';
import {settlePurchaseCoupon} from '../../services/api/src/rewardLedger';
import {transaction} from '../../services/api/src/db';
const pool=testPool(),config=loadConfig({APP_ENV:'test',DATABASE_URL:TEST_DATABASE_URL,APP_SESSION_SECRET:'reward-integration-session',ADMIN_API_TOKEN:'legacy-test',UPLOAD_TOKEN_SECRET:'reward-test-upload',OBJECT_STORAGE_DRIVER:'api_gateway',CONTACT_ENCRYPTION_KEY:'11'.repeat(32),CONTACT_HASH_KEY:'22'.repeat(32),CONTACT_KEY_VERSION:'reward-test-v1',COMMERCE_ORDER_FLOW_ENABLED:'true'});
let app:Awaited<ReturnType<typeof createApp>>,rewards:ActivityRewardService,operator:any,product:any,activity:any;
const auth=(p:any)=>({authorization:`Bearer ${p.sessionToken}`}),key=()=>`reward-test-${randomUUID()}`;
const person=async()=>{const r=await app.inject({method:'POST',url:'/v1/identity/dev',payload:{externalUserId:key(),displayName:'隔离奖励会员',consents:[{documentType:'privacy',version:'v1'},{documentType:'terms',version:'v1'}]}});expect(r.statusCode,r.body).toBe(200);return r.json();};
async function address(p:any){const r=await app.inject({method:'POST',url:'/v1/me/addresses',headers:{...auth(p),'idempotency-key':key()},payload:{recipientName:'隔离收件人',phone:'13800000001',province:'上海市',city:'上海市',district:'浦东新区',detail:'隔离测试路1号',postalCode:'200000',nationalCode:'310115',provinceCode:'310000',cityCode:'310100',districtCode:'310115',label:'home',isDefault:true}});expect(r.statusCode,r.body).toBe(200);return r.json();}
async function survey(p:any){const service=new CareOnboardingService(pool,config),v=await service.get(p.memberId);const answers=Object.fromEntries(careQuestions.map(q=>[q.id,q.sensitive?{status:'not_authorized',values:[]}:{status:'answered',values:[q.options[0]!.value]}]));return (await service.save(p.memberId,key(),{questionnaireVersion:v.questionnaireVersion,expectedVersion:v.profile?.version??0,currentQuestion:10,answers,consentChoice:'declined',consentVersion:v.sensitiveConsent.version},true)).profile!;}
async function issue(p:any,now?:Date){const r=await rewards.issue(operator.memberId,activity.id,key(),{batchId:'isolated-batch',awards:[{sourceRecordId:key(),memberId:p.memberId}]},now);return r.items[0]!.voucherId;}
async function ready(){const p=await person(),v=await issue(p),a=await address(p),s=await survey(p);return {p,v,a,s};}
const quote=(x:Awaited<ReturnType<typeof ready>>,bundleCode='moisture')=>rewards.quote(x.p.memberId,key(),{voucherId:x.v,bundleCode,addressId:x.a.id,addressVersion:x.a.version,surveyVersion:x.s.version});
async function claim(x:Awaited<ReturnType<typeof ready>>,bundleCode='moisture'){const q=await quote(x,bundleCode);return rewards.claim(x.p.memberId,key(),{quoteId:q.id});}
beforeAll(async()=>{
 await resetDatabase(pool);app=await createApp({config,pool,storage:createApiGatewayStorage(config)});operator=await person();
 for(const capability of ['commerce.product.manage','commerce.qualification.manage','commerce.inventory.manage','commerce.order.read','commerce.fulfillment.manage','member.manage'])await pool.query("INSERT INTO authority_grant(member_id,capability,granted_by,grant_reason,environment,grant_source) VALUES($1,$2,'fixture','活动旅行套隔离回归','test','integration_fixture')",[operator.memberId,capability]);
 const call=async(url:string,payload:any)=>{const r=await app.inject({method:'POST',url,headers:{...auth(operator),'idempotency-key':key()},payload});expect(r.statusCode,r.body).toBe(200);return r.json();};
 const created=await call('/v1/management/catalog/products',{code:'synthetic-reward-fullsize',name:'隔离正装',subtitle:'活动券验证',description:'隔离合成商品',imagePath:'/assets/icons/spray-bottle-plum.svg',sourceKind:'synthetic_test',sku:{code:'SYNTH_REWARD_198',label:'隔离正装规格',priceCents:19800}});
 const qualified=await call(`/v1/management/catalog/products/${created.productId}/qualification`,{expectedVersion:created.version,status:'eligible',reason:'隔离商品资格',evidenceRef:'fixture://reward/eligible'});
 product=await call(`/v1/management/catalog/products/${created.productId}/publication`,{expectedVersion:qualified.version,action:'publish',reason:'隔离正装上架'});
 await call(`/v1/management/catalog/skus/${product.variants[0].id}/inventory-adjustments`,{expectedVersion:product.variants[0].inventoryVersion,delta:100,reason:'隔离库存入账'});
 const authority=new AuthorityService(pool,'test');rewards=new ActivityRewardService(pool,config,authority,new DeliveryAddressService(pool,config));
 for(const code of ['conditioner100','dandruff50','moisture100'])await rewards.inventory(operator.memberId,key(),{code,expectedVersion:1,delta:30,reason:'隔离组件入库'});
 activity=await rewards.configure(operator.memberId,key(),{code:'reward-isolated-20261113',title:'隔离活动',expectedVersion:0,terms:{maxAwardsPerMember:1,voucherValidityDays:30,shippingCents:0,dispatchHours:72,restoreGraceDays:0,stockoutPolicy:'retain_until_expiry',eligibleProductIds:[product.productId]},action:'publish',reason:'隔离活动完整回归'});
});
afterAll(async()=>{await app?.close();await pool.end();});
describe('TRV native service and HTTP business authority',()=>{
 it('binds awards to existing members, deduplicates award records and globally limits one voucher per user ID',async()=>{
  const p=await person(),source=key(),b={batchId:'first-batch',awards:[{sourceRecordId:source,memberId:p.memberId}]};
  const a=await rewards.issue(operator.memberId,activity.id,key(),b),again=await rewards.issue(operator.memberId,activity.id,key(),b);
  const distinct=await rewards.issue(operator.memberId,activity.id,key(),{batchId:'another-batch',awards:[{sourceRecordId:key(),memberId:p.memberId}]});
  expect(a.issued).toBe(1);expect(again.items[0]?.voucherId).toBe(a.items[0]?.voucherId);expect(distinct.issued).toBe(0);
  expect(Number((await pool.query('SELECT count(*) n FROM reward_voucher WHERE member_id=$1',[p.memberId])).rows[0].n)).toBe(1);
  const other=await person();await expect(rewards.issue(operator.memberId,activity.id,key(),{...b,awards:[{sourceRecordId:source,memberId:other.memberId}]})).rejects.toMatchObject({code:'REWARD_AWARD_CONFLICT'});
  await expect(rewards.issue(operator.memberId,activity.id,key(),{batchId:'missing',awards:[{sourceRecordId:key(),memberId:randomUUID()}]})).rejects.toMatchObject({code:'REWARD_MEMBER_NOT_FOUND'});
 });
 it('rejects ordinary-user management and cross-account voucher use',async()=>{
  const x=await ready(),other=await person();
  expect((await app.inject({method:'GET',url:'/v1/management/rewards',headers:auth(other)})).statusCode).toBe(403);
  await expect(rewards.quote(other.memberId,key(),{voucherId:x.v,bundleCode:'moisture',addressId:x.a.id,addressVersion:x.a.version,surveyVersion:x.s.version})).rejects.toMatchObject({code:'REWARD_VOUCHER_UNAVAILABLE'});
 });
 it('quotes explicit final choice with the correct capacity and requires completed current survey',async()=>{
  const x=await ready(),q=await quote(x,'dandruff');expect(q.item).toMatchObject({code:'dandruff',shampooMl:50,conditionerMl:100,totalMl:150});expect(q.totalCents).toBe(0);
  await pool.query('UPDATE member_care_profile SET version=version+1 WHERE member_id=$1',[x.p.memberId]);
  await expect(rewards.claim(x.p.memberId,key(),{quoteId:q.id})).rejects.toMatchObject({code:'REWARD_SURVEY_CHANGED'});
  expect((await rewards.mine(x.p.memberId)).vouchers[0]?.state).toBe('unused');
 });
 it('creates one durable zero-cash claim across duplicate requests without any points or payment effects',async()=>{
  const x=await ready(),q=await quote(x),operation=key(),before=(await pool.query('SELECT * FROM points_projection WHERE member_id=$1',[x.p.memberId])).rows;
  const a=await rewards.claim(x.p.memberId,operation,{quoteId:q.id}),b=await rewards.claim(x.p.memberId,operation,{quoteId:q.id});expect(b.id).toBe(a.id);
  expect((await rewards.commandReceipt(x.p.memberId,operation))).toMatchObject({status:'found',action:'reward.claim',record:{id:a.id}});
  expect((await rewards.detail(x.p.memberId,a.id)).item.totalMl).toBe(200);
  expect((await pool.query('SELECT * FROM points_projection WHERE member_id=$1',[x.p.memberId])).rows).toEqual(before);
  expect(Number((await pool.query('SELECT count(*) n FROM commerce_payment_attempt WHERE member_id=$1',[x.p.memberId])).rows[0].n)).toBe(0);
  await expect(rewards.claim(x.p.memberId,operation,{quoteId:randomUUID()})).rejects.toMatchObject({code:'IDEMPOTENCY_CONFLICT'});
 });
 it('atomically fences an abandoned submission so a delayed request cannot consume the voucher',async()=>{
  const x=await ready(),q=await quote(x),operation=key();expect(await rewards.abandonCommand(x.p.memberId,operation)).toMatchObject({status:'abandoned'});
  await expect(rewards.claim(x.p.memberId,operation,{quoteId:q.id})).rejects.toMatchObject({code:'REWARD_COMMAND_ABANDONED'});
  expect((await rewards.mine(x.p.memberId)).vouchers[0]?.state).toBe('unused');
 });
 it('keeps shared conditioner atomic when two different bundles race for the last unit',async()=>{
  const a=await ready(),b=await ready();await pool.query("UPDATE reward_component_inventory SET stock_on_hand=1,reserved_quantity=0 WHERE code='conditioner100'");
  const qa=await quote(a,'moisture'),qb=await quote(b,'dandruff');
  const results=await Promise.allSettled([rewards.claim(a.p.memberId,key(),{quoteId:qa.id}),rewards.claim(b.p.memberId,key(),{quoteId:qb.id})]);
  expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);
  expect((await pool.query("SELECT stock_on_hand,reserved_quantity FROM reward_component_inventory WHERE code='conditioner100'")).rows[0]).toEqual({stock_on_hand:0,reserved_quantity:0});
  const loser=results[0]!.status==='rejected'?a:b;expect((await rewards.mine(loser.p.memberId)).vouchers[0]?.state).toBe('unused');
  await pool.query("UPDATE reward_component_inventory SET stock_on_hand=30 WHERE code='conditioner100'");
 });
 it('cancels an unshipped claim once, restores both components and the same voucher, and cannot restore a shipped award',async()=>{
  const x=await ready(),r=await claim(x),snapshot=(await pool.query('SELECT code,stock_on_hand FROM reward_component_inventory ORDER BY code')).rows;
  const op=key(),args={expectedVersion:1};await rewards.operate(x.p.memberId,r.id,op,'cancel',args);await rewards.operate(x.p.memberId,r.id,op,'cancel',args);
  const after=(await pool.query('SELECT code,stock_on_hand FROM reward_component_inventory ORDER BY code')).rows;
  for(const code of ['conditioner100','moisture100'])expect(after.find(v=>v.code===code).stock_on_hand).toBe(snapshot.find(v=>v.code===code).stock_on_hand+1);
  expect((await rewards.mine(x.p.memberId)).vouchers[0]?.state).toBe('unused');
  const next=await claim(x);await rewards.operate(operator.memberId,next.id,key(),'ship',{expectedVersion:1,carrierName:'隔离承运商',trackingNumber:'SYNTH123456'});
  await expect(rewards.operate(x.p.memberId,next.id,key(),'cancel',{expectedVersion:2})).rejects.toMatchObject({code:'REWARD_ALREADY_DISPATCHED'});
 });
 it('issues one 198-minus-20 coupon only after owner-confirmed receipt and encrypts delivery facts',async()=>{
  const x=await ready(),r=await claim(x);await expect(rewards.operate(x.p.memberId,r.id,key(),'receive',{expectedVersion:1})).rejects.toMatchObject({code:'REWARD_STATE_INVALID'});
  await rewards.operate(operator.memberId,r.id,key(),'ship',{expectedVersion:1,carrierName:'隔离快递',trackingNumber:'ISOLATED123456'});
  const operation=key();await rewards.operate(x.p.memberId,r.id,operation,'receive',{expectedVersion:2});await rewards.operate(x.p.memberId,r.id,operation,'receive',{expectedVersion:2});
  const coupons=(await rewards.mine(x.p.memberId)).coupons;expect(coupons).toHaveLength(1);expect(coupons[0]).toMatchObject({thresholdCents:19800,discountCents:2000,state:'available'});
  expect(Date.parse(coupons[0]!.expiresAt)-Date.parse(coupons[0]!.issuedAt)).toBe(30*86400000);
  const raw=(await pool.query('SELECT encrypted_address,shipment_encrypted FROM activity_reward_claim WHERE id=$1',[r.id])).rows[0];expect(JSON.stringify(raw)).not.toContain('13800000001');expect(JSON.stringify(raw)).not.toContain('ISOLATED123456');
  const eligible=(await app.inject({method:'GET',url:`/v1/me/coupons/eligible?skuId=${product.variants[0].id}&quantity=1`,headers:auth(x.p)})).json();expect(eligible.items[0].id).toBe(coupons[0]!.id);
  const qr=await app.inject({method:'POST',url:'/v1/me/commerce/quotes',headers:{...auth(x.p),'idempotency-key':key()},payload:{skuId:product.variants[0].id,quantity:1,addressId:x.a.id,addressVersion:x.a.version,couponId:coupons[0]!.id}});expect(qr.statusCode,qr.body).toBe(200);expect(qr.json()).toMatchObject({subtotalCents:19800,couponDiscountCents:2000,totalCents:17800});
  const order=await app.inject({method:'POST',url:'/v1/me/orders',headers:{...auth(x.p),'idempotency-key':key()},payload:{quoteId:qr.json().id}});expect(order.statusCode,order.body).toBe(200);
  expect((await rewards.mine(x.p.memberId)).coupons[0]?.state).toBe('locked');
  await transaction(pool,c=>settlePurchaseCoupon(c,order.json().id,'consume',new Date()));expect((await rewards.mine(x.p.memberId)).coupons[0]?.state).toBe('used');
 });
 it('exports bounded, text-only workbook rows under both member and product authority',async()=>{
  const result=await rewards.export(operator.memberId,activity.id,'issued');expect(result.count).toBeGreaterThan(0);expect(result.workbook.subarray(0,2).toString()).toBe('PK');
  const p=await person();await expect(rewards.export(p.memberId,activity.id,'issued')).rejects.toMatchObject({code:'CAPABILITY_REQUIRED'});
 });
});
