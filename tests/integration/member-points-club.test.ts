import {beforeAll,afterAll,describe,it,expect} from 'vitest';
import {randomUUID} from 'node:crypto';
import {loadConfig} from '@cisme/config';
import {testPool,resetDatabase,TEST_DATABASE_URL} from '@cisme/testkit';
import {createApp} from '../../services/api/src/server';
import {createApiGatewayStorage} from '../../services/api/src/storage';
import {transaction} from '../../services/api/src/db';
import {clubRulesV1,grantMemberPoints,reverseMemberGrant,pointDay,addPointMonths,settleOrderPoints,returnOrderPoints} from '../../services/api/src/pointsLedger';
import {processMemberPointSources} from '../../services/api/src/memberPointsClub';
const pool=testPool(),base=new Date(Date.now()+120000),day=(n:number)=>new Date(base.getTime()+n*86400000);
const config=loadConfig({APP_ENV:'test',DATABASE_URL:TEST_DATABASE_URL,APP_SESSION_SECRET:'member-points-test',UPLOAD_TOKEN_SECRET:'member-points-upload',
 OBJECT_STORAGE_DRIVER:'api_gateway',ALLOW_DEV_ADAPTERS:'true',CONTACT_ENCRYPTION_KEY:'19'.repeat(32),CONTACT_HASH_KEY:'29'.repeat(32),COMMERCE_ORDER_FLOW_ENABLED:'true'});
let app:Awaited<ReturnType<typeof createApp>>,maker:any,checker:any,policy:any,sku:any;
const headers=(a:any,key=randomUUID(),now=base)=>({authorization:`Bearer ${a.sessionToken}`,'idempotency-key':key,'x-dev-clock':now.toISOString()});
async function actor(label='合成积分会员'){
 const r=await app.inject({method:'POST',url:'/v1/identity/dev',headers:{'x-dev-clock':base.toISOString()},payload:{externalUserId:randomUUID(),displayName:label,
  consents:[{documentType:'privacy',version:'fixture-v1'},{documentType:'terms',version:'fixture-v1'}]}});expect(r.statusCode,r.body).toBe(200);return r.json();
}
const get=(a:any,path='/v1/me/points',now=base)=>app.inject({url:path,headers:headers(a,randomUUID(),now)});
const checkin=(a:any,now=base,key=randomUUID(),extra:Record<string,unknown>={})=>app.inject({method:'POST',url:'/v1/me/points/checkin',headers:headers(a,key,now),
 payload:{products:['essence'],note:'今天护理后头皮感觉舒适清爽',serverDay:pointDay(now),...extra}});
async function fund(a:any,amount:number,source=randomUUID(),now=base){return transaction(pool,c=>grantMemberPoints(c,{owner:a.memberId,sourceType:'fixture',sourceId:source,component:'base',amount,policy,now}));}
async function invariant(a:any){
 const p=(await pool.query('SELECT * FROM points_projection WHERE member_id=$1',[a.memberId])).rows[0];
 const e=(await pool.query(`SELECT COALESCE(sum(available_delta),0)::int a,COALESCE(sum(frozen_delta),0)::int f,COALESCE(sum(debt_delta),0)::int d,COALESCE(sum(reserved_delta),0)::int r
  FROM points_entry WHERE member_id=$1`,[a.memberId])).rows[0];
 const lots=(await pool.query(`SELECT COALESCE(sum(l.available_amount),0)::int a,COALESCE(sum(l.frozen_amount),0)::int f,COALESCE(sum(l.reserved_amount),0)::int r
  FROM points_lot l JOIN points_grant g ON g.id=l.grant_id WHERE g.member_id=$1`,[a.memberId])).rows[0];
 expect({a:p.available,f:p.frozen,d:p.debt,r:p.reserved}).toEqual(e);expect({a:p.available,f:p.frozen,r:p.reserved}).toEqual(lots);
 if(p.debt>0)expect(p.available).toBe(0);return p;
}
async function address(a:any){const r=await app.inject({method:'POST',url:'/v1/me/addresses',headers:headers(a),payload:{recipientName:'合成会员',phone:'13800001234',province:'上海市',city:'上海市',district:'浦东新区',detail:'合成测试路12号',postalCode:'200000',nationalCode:'310115',provinceCode:'310000',cityCode:'310100',districtCode:'310115',label:'home',isDefault:true}});expect(r.statusCode,r.body).toBe(200);return r.json();}
beforeAll(async()=>{
 await resetDatabase(pool);app=await createApp({pool,config,storage:createApiGatewayStorage(config)});maker=await actor('合成积分制单员');checker=await actor('合成积分复核员');
 for(const a of [maker,checker])for(const capability of ['commerce.money.reconcile','commerce.product.manage','commerce.qualification.manage','commerce.inventory.manage','commerce.fulfillment.manage','community.moderate'])
  await pool.query(`INSERT INTO authority_grant(member_id,capability,granted_by,grant_reason,environment,grant_source) VALUES($1,$2,'fixture','合成积分集成权限','test','integration_fixture')`,[a.memberId,capability]);
 const created=await app.inject({method:'POST',url:'/v1/management/points/policies',headers:headers(maker,randomUUID(),new Date(base.getTime()-10000)),payload:{version:'club-integration-v1',monthlyBudget:1000000,rules:clubRulesV1,startsAt:base.toISOString(),endsAt:null}});expect(created.statusCode,created.body).toBe(200);
 const same=await app.inject({method:'POST',url:'/v1/management/points/policies/club-integration-v1/approve',headers:headers(maker,randomUUID(),new Date(base.getTime()-5000)),payload:{evidence:'合成独立复核不得自批'}});expect(same.statusCode).toBe(409);
 const approved=await app.inject({method:'POST',url:'/v1/management/points/policies/club-integration-v1/approve',headers:headers(checker,randomUUID(),new Date(base.getTime()-1000)),payload:{evidence:'合成预算、规则和不提现权益完整复核'}});expect(approved.statusCode,approved.body).toBe(200);policy=(await pool.query("SELECT * FROM member_points_policy WHERE version='club-integration-v1'")).rows[0];
 const product=await app.inject({method:'POST',url:'/v1/management/catalog/products',headers:headers(maker),payload:{code:'synthetic-points-gift',name:'合成积分礼品',subtitle:'隔离测试',description:'仅用于隔离积分流程',imagePath:'/assets/icons/spray-bottle-plum.svg',sourceKind:'synthetic_test',sku:{code:'SYN_POINTS_GIFT',label:'合成规格',priceCents:10000}}});expect(product.statusCode,product.body).toBe(200);
 let p=product.json();const qualified=await app.inject({method:'POST',url:`/v1/management/catalog/products/${p.productId}/qualification`,headers:headers(maker),payload:{expectedVersion:p.version,status:'eligible',reason:'合成积分测试',evidenceRef:'fixture://points/qualified'}});expect(qualified.statusCode,qualified.body).toBe(200);p=qualified.json();
 const published=await app.inject({method:'POST',url:`/v1/management/catalog/products/${p.productId}/publication`,headers:headers(maker),payload:{expectedVersion:p.version,action:'publish',reason:'合成积分测试'}});expect(published.statusCode,published.body).toBe(200);sku=published.json().variants[0];
 const stock=await app.inject({method:'POST',url:`/v1/management/catalog/skus/${sku.id}/inventory-adjustments`,headers:headers(maker),payload:{expectedVersion:sku.inventoryVersion,delta:30,reason:'合成积分库存'}});expect(stock.statusCode,stock.body).toBe(200);
});
afterAll(async()=>{await app?.close();await pool.end();});
describe('member club points closed loop',()=>{
 it('protects owner and operator routes and does not issue points at registration',async()=>{
  const a=await actor();expect((await get(a)).json().projection.available).toBe(0);
  for(const url of ['/v1/me/points','/v1/me/points/club','/v1/me/points/gifts','/v1/me/points/redemptions','/v1/management/points'])expect((await app.inject({url})).statusCode).toBe(401);
  expect((await get(a,'/v1/management/points')).statusCode).toBe(403);
  expect((await checkin(a,base,randomUUID(),{memberId:maker.memberId})).statusCode).toBe(422);
 });
 it('awards a product checkin once per Shanghai day and a meaningful ten-character note once, never each product',async()=>{
  const a=await actor(),key=randomUUID(),r=await checkin(a,base,key);expect(r.statusCode,r.body).toBe(200);
  expect((await checkin(a,base,key)).json().replayed).toBe(true);
  expect((await invariant(a)).available).toBe(15);
  const changed=await checkin(a,base,randomUUID(),{products:['net_run','net_xie','essence'],expectedVersion:1});expect(changed.statusCode,changed.body).toBe(200);
  expect((await invariant(a)).available).toBe(15);expect((await checkin(a,base,key)).json().replayed).toBe(true);
  const stored=(await pool.query('SELECT note_encrypted FROM member_points_checkin WHERE member_id=$1',[a.memberId])).rows[0];expect(stored.note_encrypted).not.toContain('舒适');
  const page=(await get(a,'/v1/me/points/club')).json();expect(page.today.note).toContain('舒适');expect(page.today.products).toHaveLength(3);
 });
 it('does not multiply grants under concurrent commands and rejects stale days or unqualified notes',async()=>{
  const a=await actor(),key=randomUUID(),rs=await Promise.all([checkin(a,base,key,{note:'短感受'}),checkin(a,base,key,{note:'短感受'})]);
  rs.forEach(r=>expect(r.statusCode,r.body).toBe(200));expect((await invariant(a)).available).toBe(10);
  expect((await checkin(a,day(1),randomUUID(),{serverDay:pointDay(base)})).json().code).toBe('POINTS_DAY_CHANGED');
 });
 it('cycles seven and thirty day awards, stacks both on day 210, and resets after a missed day',async()=>{
  const a=await actor();await pool.query(`INSERT INTO member_points_attendance(member_id,care_day,first_source,qualified_at)
   SELECT $1,($2::date-n), 'fixture', $3 FROM generate_series(1,209) n`,[a.memberId,pointDay(day(210)),base]);
  const r=await checkin(a,day(210));expect(r.statusCode,r.body).toBe(200);expect(r.json().streak).toBe(210);
  expect((await invariant(a)).available).toBe(265);
  expect((await get(a,'/v1/me/points/club',day(210))).json().badges).toHaveLength(1);
  expect((await checkin(a,day(212))).json().streak).toBe(1);expect((await invariant(a)).available).toBe(280);
 });
 it('uses twelve calendar months, shows the thirty-day expiry window, and posts expiry exactly once',async()=>{
  expect(addPointMonths(new Date('2028-02-29T04:05:00Z'),12).toISOString()).toBe('2029-02-28T04:05:00.000Z');
  const a=await actor();await fund(a,88);const expiry=addPointMonths(base,12),before=new Date(expiry.getTime()-86400000);
  expect((await get(a,'/v1/me/points',before)).json().expiring.points).toBe(88);
  const expired=(await get(a,'/v1/me/points',expiry)).json();expect(expired.projection.available).toBe(0);expect(expired.expired).toBe(88);
  await get(a,'/v1/me/points',expiry);expect((await invariant(a)).available).toBe(0);
  expect((await pool.query("SELECT 1 FROM points_entry WHERE member_id=$1 AND entry_type='expire'",[a.memberId])).rowCount).toBe(1);
 });
 it('paginates real totals and keeps the profile and ledger balances identical',async()=>{
  const a=await actor();for(let i=0;i<7;i++)await fund(a,3);
  const p=(await get(a,'/v1/me/points?limit=2')).json();expect(p.totalCount).toBe(7);expect(p.entries).toHaveLength(2);expect(p.nextCursor).toBeTruthy();
  const next=(await get(a,'/v1/me/points?limit=2&cursor='+encodeURIComponent(p.nextCursor))).json();expect(next.entries.every((e:any)=>!p.entries.some((x:any)=>x.id===e.id))).toBe(true);
  const profile=(await get(a,'/v1/bootstrap/profile')).json();expect(profile.points.projection).toEqual(p.projection);
  expect((await get(a,'/v1/me/points?source=spend')).json().totalCount).toBe(0);
 });
 it('quotes at most twenty percent of merchandise, atomically reserves points, and releases them on cancellation',async()=>{
  const a=await actor();await fund(a,2500);const addr=await address(a);
  const payload={skuId:sku.id,quantity:1,addressId:addr.id,addressVersion:addr.version,points:500};
  const q=await app.inject({method:'POST',url:'/v1/me/commerce/quotes',headers:headers(a),payload});expect(q.statusCode,q.body).toBe(200);expect(q.json()).toMatchObject({totalCents:9500,memberDiscountCents:500,pointsSpent:500,pointsMaximum:2000});
  const over=await app.inject({method:'POST',url:'/v1/me/commerce/quotes',headers:headers(a),payload:{...payload,points:2001}});expect(over.statusCode).toBe(409);
  const order=await app.inject({method:'POST',url:'/v1/me/orders',headers:headers(a),payload:{quoteId:q.json().id}});expect(order.statusCode,order.body).toBe(200);
  expect(await invariant(a)).toMatchObject({available:2000,reserved:500});
  const cancelled=await app.inject({method:'POST',url:`/v1/me/orders/${order.json().id}/cancel`,headers:headers(a),payload:{expectedVersion:1,reason:'合成取消测试'}});expect(cancelled.statusCode,cancelled.body).toBe(200);
  expect(await invariant(a)).toMatchObject({available:2500,reserved:0});
 });
 it('redeems real stock and the same lots once, isolates ownership, and returns exact points and stock before dispatch',async()=>{
  const a=await actor(),b=await actor();await fund(a,50000);const addr=await address(a),key=randomUUID();
  const payload={skuId:sku.id,offerVersion:1,policyVersion:'club-integration-v1',expectedPoints:10000,quantity:1,addressId:addr.id,addressVersion:addr.version};
  const rs=await Promise.all([app.inject({method:'POST',url:'/v1/me/points/redemptions',headers:headers(a,key),payload}),app.inject({method:'POST',url:'/v1/me/points/redemptions',headers:headers(a,key),payload})]);rs.forEach(r=>expect(r.statusCode,r.body).toBe(200));
  expect(rs[0].json().id).toBe(rs[1].json().id);expect((await invariant(a)).available).toBe(40000);
  expect((await get(b,'/v1/me/points/redemptions')).json().items).toHaveLength(0);
  const action=`/v1/me/points/redemptions/${rs[0].json().id}/cancel`,h=headers(a),data={expectedVersion:1,reason:'合成取消兑换测试'};
  expect((await app.inject({method:'POST',url:action,headers:headers(b),payload:data})).statusCode).toBe(404);
  const cancelled=await app.inject({method:'POST',url:action,headers:h,payload:data});expect(cancelled.statusCode,cancelled.body).toBe(200);
  expect((await app.inject({method:'POST',url:action,headers:h,payload:data})).statusCode).toBe(200);expect((await invariant(a)).available).toBe(50000);
 });
 it('creates debt for a spent reward and offsets later earnings before making them spendable',async()=>{
  const a=await actor(),g=await fund(a,10000),addr=await address(a);
  const r=await app.inject({method:'POST',url:'/v1/me/points/redemptions',headers:headers(a),payload:{skuId:sku.id,offerVersion:1,policyVersion:'club-integration-v1',expectedPoints:10000,quantity:1,addressId:addr.id,addressVersion:addr.version}});expect(r.statusCode,r.body).toBe(200);
  await transaction(pool,c=>reverseMemberGrant(c,g!,10000,'synthetic-invalidation',base,'合成违规撤回'));
  expect(await invariant(a)).toMatchObject({available:0,debt:10000});await fund(a,6000);expect(await invariant(a)).toMatchObject({available:0,debt:4000});
  await fund(a,5000);expect(await invariant(a)).toMatchObject({available:1000,debt:0});
 });
 it('automatically exposes every newly published SKU at its real price and rejects stale conversion consent',async()=>{
  const a=await actor();await fund(a,20000);const addr=await address(a),response=await get(a,'/v1/me/points/gifts');expect(response.statusCode,response.body).toBe(200);const offers=response.json();
  expect(offers.items.find((o:any)=>o.skuId===sku.id)).toMatchObject({points:10000,policyVersion:policy.version});
  expect(offers.items[0]).not.toHaveProperty('perMemberLimit');
  const payload={skuId:sku.id,offerVersion:1,policyVersion:policy.version,expectedPoints:9999,quantity:1,addressId:addr.id,addressVersion:addr.version};
  const r=await app.inject({method:'POST',url:'/v1/me/points/redemptions',headers:headers(a),payload});expect(r.statusCode).toBe(409);expect((await invariant(a)).available).toBe(20000);
 });
 it('serializes abandon against a late original redemption and never creates an unconfirmed second command',async()=>{
  const a=await actor();await fund(a,20000);const addr=await address(a),key=randomUUID();
  expect((await get(a,'/v1/me/points/commands/'+key)).json().status).toBe('not_found');
  const abandon=await app.inject({method:'POST',url:'/v1/me/points/commands/'+key+'/abandon',headers:headers(a),payload:{}});expect(abandon.json().status).toBe('abandoned');
  const r=await app.inject({method:'POST',url:'/v1/me/points/redemptions',headers:headers(a,key),payload:{skuId:sku.id,offerVersion:1,policyVersion:policy.version,expectedPoints:10000,quantity:1,addressId:addr.id,addressVersion:addr.version}});
  expect(r.statusCode,r.body).toBe(409);expect(r.json().code).toBe('POINTS_COMMAND_ABANDONED');expect((await invariant(a)).available).toBe(20000);
 });
 it('fulfills a points-only order and returns original points after physical return without inventing restock or cash',async()=>{
  const a=await actor();await fund(a,40000);const addr=await address(a),before=(await pool.query('SELECT stock_on_hand FROM catalog_inventory_level WHERE sku_id=$1',[sku.id])).rows[0].stock_on_hand;
  const r=await app.inject({method:'POST',url:'/v1/me/points/redemptions',headers:headers(a),payload:{skuId:sku.id,offerVersion:1,policyVersion:policy.version,expectedPoints:10000,quantity:2,addressId:addr.id,addressVersion:addr.version}});expect(r.statusCode,r.body).toBe(200);const id=r.json().id;
  let version=1;for(const [actor,action,management,extra] of [[checker,'ship',true,{carrierName:'合成承运商',trackingNumber:'SYN12345678'}],[a,'receive',false,{}],[a,'request_return',false,{}],[checker,'return_received',true,{}]] as const){
   const step=await app.inject({method:'POST',url:`/v1/${management?'management':'me'}/points/redemptions/${id}/${action}`,headers:headers(actor),payload:{expectedVersion:version,reason:'隔离流程事实核对',...extra}});expect(step.statusCode,step.body).toBe(200);version++;
  }
  expect((await invariant(a)).available).toBe(40000);expect((await pool.query('SELECT stock_on_hand FROM catalog_inventory_level WHERE sku_id=$1',[sku.id])).rows[0].stock_on_hand).toBe(before-2);
  expect((await pool.query('SELECT count(*)::int n FROM commerce_payment_attempt WHERE member_id=$1',[a.memberId])).rows[0].n).toBe(0);
 });
 it('locks a product promotion into the quote and order and makes later promotion changes require a new quote',async()=>{
  const a=await actor(),addr=await address(a),p=(await pool.query('SELECT product_id FROM catalog_sku WHERE id=$1',[sku.id])).rows[0].product_id;
  let version=(await pool.query('SELECT version FROM catalog_product WHERE id=$1',[p])).rows[0].version;
  const set=await app.inject({method:'PUT',url:`/v1/management/points/products/${p}/multiplier`,headers:headers(maker),payload:{expectedVersion:version,multiplier:3,reason:'合成已公示商品三倍积分'}});expect(set.statusCode,set.body).toBe(200);version=set.json().version;
  const payload={skuId:sku.id,quantity:1,addressId:addr.id,addressVersion:addr.version},q=await app.inject({method:'POST',url:'/v1/me/commerce/quotes',headers:headers(a),payload});expect(q.statusCode,q.body).toBe(200);expect(q.json().shoppingPointsMultiplier).toBe(3);
  const order=await app.inject({method:'POST',url:'/v1/me/orders',headers:headers(a),payload:{quoteId:q.json().id}});expect(order.statusCode,order.body).toBe(200);expect(order.json().shoppingPointsMultiplier).toBe(3);
  const q2=await app.inject({method:'POST',url:'/v1/me/commerce/quotes',headers:headers(a),payload});
  const reset=await app.inject({method:'PUT',url:`/v1/management/points/products/${p}/multiplier`,headers:headers(maker),payload:{expectedVersion:version,multiplier:1,reason:'合成停止商品三倍积分'}});expect(reset.statusCode,reset.body).toBe(200);
  const stale=await app.inject({method:'POST',url:'/v1/me/orders',headers:headers(a),payload:{quoteId:q2.json().id}});expect(stale.json().code).toBe('QUOTE_STALE');
  expect((await pool.query('SELECT shopping_points_multiplier FROM commerce_order WHERE id=$1',[order.json().id])).rows[0].shopping_points_multiplier).toBe(3);
  await app.inject({method:'POST',url:`/v1/me/orders/${order.json().id}/cancel`,headers:headers(a),payload:{expectedVersion:1,reason:'合成结束预占订单'}});
 });
 it('reconciles lots, immutable entries, orders and redemptions and only reports a discrepancy',async()=>{
  const {reconcilePointWallets}=await import('../../services/api/src/pointsReconciliation');const a=await actor();await fund(a,30);
  await reconcilePointWallets(pool,base,100);expect((await pool.query('SELECT status FROM member_points_wallet_check WHERE member_id=$1',[a.memberId])).rows[0].status).toBe('balanced');
  await pool.query('UPDATE points_projection SET available=available+1,version=version+1 WHERE member_id=$1',[a.memberId]);await reconcilePointWallets(pool,base,100);
  expect((await pool.query('SELECT status FROM member_points_wallet_check WHERE member_id=$1',[a.memberId])).rows[0].status).toBe('mismatch');expect((await pool.query('SELECT available FROM points_projection WHERE member_id=$1',[a.memberId])).rows[0].available).toBe(31);
  await pool.query('UPDATE points_projection SET available=available-1,version=version+1 WHERE member_id=$1',[a.memberId]);await reconcilePointWallets(pool,base,100);await invariant(a);
 });
 it('cancels an expired invalidated reservation without charging debt against later legitimate earnings',async()=>{
  const a=await actor(),created=new Date(addPointMonths(base,-12).getTime()+10*60000),g=await fund(a,1000,randomUUID(),created),addr=await address(a);
  const q=await app.inject({method:'POST',url:'/v1/me/commerce/quotes',headers:headers(a),payload:{skuId:sku.id,quantity:1,addressId:addr.id,addressVersion:addr.version,points:1000}});expect(q.statusCode,q.body).toBe(200);
  const r=await app.inject({method:'POST',url:'/v1/me/orders',headers:headers(a),payload:{quoteId:q.json().id}});expect(r.statusCode,r.body).toBe(200);
  await transaction(pool,c=>reverseMemberGrant(c,g!,1000,'synthetic-reserved-invalidation',base,'预占期间原奖励作废'));
  expect(await invariant(a)).toMatchObject({available:0,reserved:1000,debt:0});await fund(a,1200,randomUUID(),new Date(base.getTime()+4*60000));
  expect(await invariant(a)).toMatchObject({available:1200,reserved:1000,debt:0});
  const late=new Date(base.getTime()+12*60000),cancel=await app.inject({method:'POST',url:`/v1/me/orders/${r.json().id}/cancel`,headers:headers(a,randomUUID(),late),payload:{expectedVersion:1,reason:'原奖励失效后取消未支付订单'}});expect(cancel.statusCode,cancel.body).toBe(200);
  expect(await invariant(a)).toMatchObject({available:1200,reserved:0,debt:0});
 });
 it('does not withdraw a returned invalidated gift twice when the original grant is later fully reversed',async()=>{
  const a=await actor(),g=await fund(a,20000),addr=await address(a);
  const r=await app.inject({method:'POST',url:'/v1/me/points/redemptions',headers:headers(a),payload:{skuId:sku.id,offerVersion:1,policyVersion:policy.version,expectedPoints:10000,quantity:1,addressId:addr.id,addressVersion:addr.version}});expect(r.statusCode,r.body).toBe(200);
  // The first reversal consumes the original unused half, then invalidates the spent half.
  await transaction(pool,c=>reverseMemberGrant(c,g!,20000,'synthetic-full-invalidation',base,'已花奖励原来源作废'));expect(await invariant(a)).toMatchObject({available:0,debt:10000});
  await fund(a,10000);const cancelled=await app.inject({method:'POST',url:`/v1/me/points/redemptions/${r.json().id}/cancel`,headers:headers(a),payload:{expectedVersion:1,reason:'会员取消并恢复已冲抵的积分权益'}});expect(cancelled.statusCode,cancelled.body).toBe(200);
  expect(await invariant(a)).toMatchObject({available:10000,debt:0});await transaction(pool,c=>reverseMemberGrant(c,g!,20000,'synthetic-replayed-invalidation',base,'重复撤回不扣已恢复权益'));expect(await invariant(a)).toMatchObject({available:10000,debt:0});
  const page=(await get(a)).json();expect(page.lifetimeEarned).toBe(30000);expect((await pool.query("SELECT count(*)::int n FROM points_grant WHERE member_id=$1 AND source_type='refund_recovery'",[a.memberId])).rows[0].n).toBe(1);
 });
 it('separately records birthday month/day and prevents repeated changes from generating another birthday',async()=>{
  const a=await actor();const r=await app.inject({method:'PUT',url:'/v1/me/points/birthday',headers:headers(a),payload:{monthDay:'02-29'}});expect(r.statusCode,r.body).toBe(200);
  expect((await app.inject({method:'PUT',url:'/v1/me/points/birthday',headers:headers(a),payload:{monthDay:'12-01'}})).statusCode).toBe(409);
  expect((await app.inject({method:'PUT',url:'/v1/me/points/birthday',headers:headers(a),payload:{monthDay:null}})).statusCode).toBe(200);
  expect((await app.inject({method:'PUT',url:'/v1/me/points/birthday',headers:headers(a),payload:{monthDay:'02-31'}})).statusCode).toBe(422);
  expect((await invariant(a)).available).toBe(0);
 });
 it('retains the existing emergency reward stop and never processes an unconfigured historical event as an award',async()=>{
  const a=await actor();await pool.query("UPDATE emergency_switch SET enabled=false WHERE key='rewards'");
  expect((await checkin(a)).json().code).toBe('REWARDS_PAUSED');await pool.query("UPDATE emergency_switch SET enabled=true WHERE key='rewards'");
  await pool.query(`INSERT INTO member_points_source_event(kind,source_id,member_id,occurred_at) VALUES('questionnaire',$1::text,$1::uuid,$2)`,[a.memberId,new Date(base.getTime()-86400000)]);
  await processMemberPointSources(pool,base);expect((await invariant(a)).available).toBe(0);
 });
 it('preserves an already announced future rule when another approval tries to insert an earlier version',async()=>{
  const propose=async(version:string,start:Date)=>app.inject({method:'POST',url:'/v1/management/points/policies',headers:headers(maker),payload:{version,rules:clubRulesV1,startsAt:start.toISOString(),endsAt:null}});
  expect((await propose('club-future-ordered-500',day(500))).statusCode).toBe(200);
  expect((await app.inject({method:'POST',url:'/v1/management/points/policies/club-future-ordered-500/approve',headers:headers(checker),payload:{evidence:'合成核对未来公示与原批次权益'}})).statusCode).toBe(200);
  expect((await propose('club-future-unsafe-400',day(400))).statusCode).toBe(200);
  const conflict=await app.inject({method:'POST',url:'/v1/management/points/policies/club-future-unsafe-400/approve',headers:headers(checker),payload:{evidence:'合成验证不能覆盖已公示规则'}});
  expect(conflict.statusCode).toBe(409);expect(conflict.json().code).toBe('POINTS_POLICY_SEQUENCE_CONFLICT');
  const {MemberPointsClub}=await import('../../services/api/src/memberPointsClub');
  const {AuthorityService}=await import('../../services/api/src/authority');const club=new MemberPointsClub(pool,config,new AuthorityService(pool,'test'));
  expect((await club.publicPolicy(day(450)))?.version).toBe(policy.version);expect((await club.publicPolicy(day(500)))?.version).toBe('club-future-ordered-500');
  await expect(pool.query("UPDATE member_points_policy SET retired_at=$2 WHERE version=$1",[policy.version,day(399)])).rejects.toThrow('POINTS_POLICY_HISTORY_IMMUTABLE');
 });

 it('uses the published 20-percent cap for future high-price products without an extra fixed points ceiling',async()=>{
  const a=await actor(),addr=await address(a);await fund(a,30000000);
  const old=(await pool.query('SELECT amount_cents FROM catalog_price WHERE sku_id=$1',[sku.id])).rows[0].amount_cents;
  await pool.query('UPDATE catalog_price SET amount_cents=100000000,version=version+1 WHERE sku_id=$1',[sku.id]);
  try{
   const quote=await app.inject({method:'POST',url:'/v1/me/commerce/quotes',headers:headers(a),payload:{skuId:sku.id,quantity:1,addressId:addr.id,addressVersion:addr.version,points:20000000}});
   expect(quote.statusCode,quote.body).toBe(200);expect(quote.json()).toMatchObject({pointsSpent:20000000,pointsMaximum:20000000,totalCents:80000000});
   const order=await app.inject({method:'POST',url:'/v1/me/orders',headers:headers(a),payload:{quoteId:quote.json().id}});expect(order.statusCode,order.body).toBe(200);
   expect(await invariant(a)).toMatchObject({available:10000000,reserved:20000000});
   const cancel=await app.inject({method:'POST',url:`/v1/me/orders/${order.json().id}/cancel`,headers:headers(a),payload:{expectedVersion:1,reason:'合成结束高价商品正常抵扣验证'}});expect(cancel.statusCode,cancel.body).toBe(200);
   expect(await invariant(a)).toMatchObject({available:30000000,reserved:0,debt:0});
  }finally{await pool.query('UPDATE catalog_price SET amount_cents=$2,version=version+1 WHERE sku_id=$1',[sku.id,old]);}
 });

});
