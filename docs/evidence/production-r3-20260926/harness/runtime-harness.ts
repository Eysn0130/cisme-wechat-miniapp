import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {loadConfig} from '@cisme/config';
import {CAPABILITIES} from '@cisme/contracts';
import {createPool} from '../../services/api/src/db.js';
import {createApiGatewayStorage} from '../../services/api/src/storage.js';
import {nativeFulfillmentFixture} from './fixture.js';
const base='/opt/cisme/rehearsals/r3-20260926-1100';
const env=JSON.parse(await readFile(base+'/runtime.json','utf8'));
Object.assign(process.env,env);
const url=new URL(env.DATABASE_URL);assert.equal(url.hostname,'127.0.0.1');assert.equal(url.port,'31956');assert.equal(url.pathname,'/cisme_r3_runtime');
const manifest=JSON.parse(await readFile(base+'/candidate/release-manifest.json','utf8'));
assert.equal(manifest.sourceHead,'d3b9a3c85718a0378db8144e19584487c469a18a');
const config=loadConfig({...env,COMMERCE_FULFILLMENT_ENABLED:'true',WECHAT_APP_ID:'wx4eac2d4fb11d299b',COMMERCE_FULFILLMENT_MERCHANT_ID:'1900000001'});
const pool=createPool(config.databaseUrl,config.database);
let app:any;
const facts:any={sourceHead:manifest.sourceHead,sourceTree:manifest.sourceTree,mainArtifact:false,productionTouched:false,externalAdapters:'synthetic identity, local storage, synthetic signed payment; no provider/funds',checks:[]};
const check=(name:string,value:unknown)=>{facts.checks.push({name,value});};
const fail=(message:string):never=>{throw Error(message)};
function body<T=any>(r:any,op:string):T {const data=r.json();if(r.statusCode<200||r.statusCode>=300)throw Error(op+':'+r.statusCode+':'+data.code);return data;}
async function http(input:any){const response=await fetch('http://127.0.0.1:31957'+input.url,{method:input.method??'GET',headers:{...(input.payload?{'content-type':'application/json'}:{}),...input.headers},...(input.payload?{body:JSON.stringify(input.payload)}:{})});const data=await response.json();return {statusCode:response.status,json:()=>data};}
try{
const role=(await pool.query("SELECT current_user,rolsuper,rolcreatedb,rolcreaterole,rolinherit FROM pg_roles WHERE rolname=current_user")).rows[0];assert.equal(role.current_user,'r3_runtime');assert.equal(role.rolsuper,false);assert.equal(role.rolcreatedb,false);assert.equal(role.rolcreaterole,false);check('runtimeRole',role);
for(const statement of ["CREATE ROLE r3_forbidden_role","SELECT pg_read_file('/etc/passwd')"]){let denied=false;try{await pool.query(statement)}catch(e:any){denied=e.code==='42501'}assert.equal(denied,true)}check('privilegedOperationsDenied',true);
check('restoredBeforeWrites',(await pool.query("SELECT (SELECT count(*)::int FROM schema_migration) migrations,(SELECT count(*)::int FROM member) members,(SELECT count(*)::int FROM outbox_event WHERE processed_at IS NULL) pending")).rows[0]);
const original=(await pool.query("SELECT id,event_type,aggregate_id,payload,attempts,occurred_at FROM outbox_event WHERE event_type='identity.accepted.v1' ORDER BY id")).rows;
assert.equal(original.length,2);const eventHash=createHash('sha256').update(JSON.stringify(original)).digest('hex');
const old=await import('/opt/cisme/current/worker.js');const current=await import(base+'/candidate/worker.js');
assert.equal(await old.processOutboxBatch(pool),0);assert.equal(await current.processOutboxBatch(pool),2);assert.equal(await current.processOutboxBatch(pool),0);
const results=(await pool.query("SELECT event_type,attempts,processing_outcome,processed_at IS NOT NULL processed FROM outbox_event WHERE id=ANY($1::uuid[])",[original.map((r:any)=>r.id)])).rows;assert.equal(results.length,2);for(const r of results){assert.equal(r.attempts,1);assert.equal(r.processing_outcome,'audit_only');assert.equal(r.processed,true)}check('twoOriginalOutboxEvents',{eventHash,oldClaimed:0,newClaimed:2,replayClaimed:0,results});
const require=createRequire(base+'/candidate/package.json');const sharp=require('sharp');const png=await sharp({create:{width:2,height:2,channels:3,background:'#996699'}}).png().toBuffer();assert(png.length>0);check('linuxNativeSharp',{platform:process.platform,arch:process.arch,bytes:png.length});
const {createApp}=await import(base+'/candidate/index.js');const storage=createApiGatewayStorage(config);await storage.ensureReady();
app=await createApp({config,pool,storage,shippingTestChannel:{query:async()=>({decision:'matched',platformOrderState:2,inComplaint:false}),uploadOnce:async()=>{throw Error('SYNTHETIC_UPLOAD_FORBIDDEN')}}});
await app.listen({port:31957,host:'127.0.0.1'});
check('httpHealth',body(await http({url:'/health/ready'}),'HEALTH'));
assert.equal((await http({url:'/v1/me/privacy-requests'})).statusCode,401);check('unauthenticatedPrivacyDenied',true);
const identity=body(await http({method:'POST',url:'/v1/identity/dev',payload:{externalUserId:'r3-linux-runtime-synthetic-member',displayName:'R3 合成演练会员',consents:[{documentType:'privacy',version:'r3-synthetic'},{documentType:'terms',version:'r3-synthetic'}]}}),'IDENTITY');
const auth={authorization:`Bearer ${identity.sessionToken}`};
await pool.query("INSERT INTO principal_role(principal_id,role) VALUES($1,'review_lead'),($1,'support') ON CONFLICT DO NOTHING",[identity.principalId]);
for(const capability of CAPABILITIES)await pool.query("INSERT INTO authority_grant(member_id,capability,granted_by,grant_reason,environment,grant_source,expires_at) VALUES($1,$2,'r3-isolated','Synthetic runtime rehearsal only','test','r3_rehearsal',now()+interval '8 hours')",[identity.memberId,capability]);
  const address = body<any>(await http({
    method: "POST",
    url: "/v1/me/addresses",
    headers: { ...auth, "idempotency-key": "acceptance-address-0001" },
    payload: {
      recipientName: "合成验收人",
      phone: "13800001234",
      province: "上海市",
      city: "上海市",
      district: "浦东新区",
      detail: "合成本地验收路 18 号",
      postalCode: "200000",
      nationalCode: "310115",
      provinceCode: "310000",
      cityCode: "310100",
      districtCode: "310115",
      label: "home",
      isDefault: true
    }
  }), "ADDRESS");

  const createdProduct = body<any>(await http({
    method: "POST",
    url: "/v1/management/catalog/products",
    headers: { ...auth, "idempotency-key": "acceptance-product-0001" },
    payload: {
      code: "synthetic-acceptance-serum",
      name: "合成验收护理精华",
      subtitle: "仅用于本地健康态与订单链路验收",
      description: "本商品、价格、库存和订单均为隔离测试数据，不代表真实销售承诺。",
      imagePath: "/assets/cisme/synthetic-owned-acceptance.jpg",
      sourceKind: "synthetic_test",
      sku: { code: "SYNTH_ACCEPTANCE_30", label: "合成 30ml", priceCents: 26900 }
    }
  }), "PRODUCT_CREATE");
  const qualifiedProduct = body<any>(await http({
    method: "POST",
    url: `/v1/management/catalog/products/${createdProduct.productId}/qualification`,
    headers: { ...auth, "idempotency-key": "acceptance-product-qualify-0001" },
    payload: {
      expectedVersion: createdProduct.version,
      status: "eligible",
      reason: "Isolated local acceptance fixture",
      evidenceRef: "fixture://miniprogram-acceptance/product-v1"
    }
  }), "PRODUCT_QUALIFY");
  const publishedProduct = body<any>(await http({
    method: "POST",
    url: `/v1/management/catalog/products/${createdProduct.productId}/publication`,
    headers: { ...auth, "idempotency-key": "acceptance-product-publish-0001" },
    payload: { expectedVersion: qualifiedProduct.version, action: "publish", reason: "Isolated local acceptance fixture" }
  }), "PRODUCT_PUBLISH");
  const sku = publishedProduct.variants[0];
  body(await http({
    method: "POST",
    url: `/v1/management/catalog/skus/${sku.id}/inventory-adjustments`,
    headers: { ...auth, "idempotency-key": "acceptance-inventory-0001" },
    payload: { expectedVersion: sku.inventoryVersion, delta: 20, reason: "Synthetic acceptance inventory" }
  }), "INVENTORY");

  const quote = body<any>(await http({
    method: "POST",
    url: "/v1/me/commerce/quotes",
    headers: { ...auth, "idempotency-key": "acceptance-quote-pending-0001" },
    payload: { skuId: sku.id, quantity: 2, addressId: address.id, addressVersion: address.version }
  }), "QUOTE_PENDING");
  const pendingOrder = body<any>(await http({
    method: "POST",
    url: "/v1/me/orders",
    headers: { ...auth, "idempotency-key": "acceptance-order-pending-0001" },
    payload: { quoteId: quote.id }
  }), "ORDER_PENDING");


const orderRetry=body(await http({method:'POST',url:'/v1/me/orders',headers:{...auth,'idempotency-key':'acceptance-order-pending-0001'},payload:{quoteId:quote.id}}),'ORDER_RETRY');assert.equal(orderRetry.id,pendingOrder.id);check('pendingOrder',{status:pendingOrder.status,source:pendingOrder.transactionSourceKind,retrySameId:true});
const paid=await nativeFulfillmentFixture(pool,config,pendingOrder.id);
const afterUrl=`/v1/me/orders/${paid.id}/aftersales`;
assert.equal((await http({method:'POST',url:afterUrl,headers:{...auth,'idempotency-key':'r3-after-invalid'},payload:{kind:'refund_only',reason:''}})).statusCode,422);
const afterInput={method:'POST',url:afterUrl,headers:{...auth,'idempotency-key':'r3-after-valid-001'},payload:{kind:'refund_only',reason:'R3 隔离合成售后受理'}};
const after=body(await http(afterInput),'AFTERSALE');assert.equal(body(await http(afterInput),'AFTERSALE_RETRY').id,after.id);check('aftersale',{state:after.state,syntheticPayment:paid.paymentEvidence,retrySameId:true});
const privacy=body(await http({method:'POST',url:'/v1/me/privacy-requests',headers:auth,payload:{kind:'access',message:'R3 合成资料查阅请求'}}),'PRIVACY');
body(await http({method:'POST',url:`/v1/management/privacy-requests/${privacy.id}/response`,headers:auth,payload:{expectedVersion:privacy.version,status:'responded',waitingOn:'member',response:'请补充查阅范围'}}),'PRIVACY_ASK');
const replyInput={method:'POST',url:`/v1/me/privacy-requests/${privacy.id}/reply`,headers:{...auth,'idempotency-key':'r3-privacy-reply-001'},payload:{expectedVersion:2,message:'补充查阅护理记录'}};
const replied=body(await http(replyInput),'PRIVACY_REPLY');assert.equal(replied.waitingOn,'operator');assert.deepEqual(body(await http(replyInput),'PRIVACY_REPLAY'),replied);check('privacySupplement',{status:replied.status,waitingOn:replied.waitingOn,retrySameResult:true});
  const supportMessage = body<any>(await http({
    method: "POST",
    url: "/v1/me/support/messages",
    headers: auth,
    payload: { body: "这是一条本地合成验收消息，用于确认客服列表、详情与人工接管界面健康。", clientMessageId: "acceptance-support-message-0001" }
  }), "SUPPORT_MESSAGE");
  const claimedConversation = body<any>(await http({
    method: "POST",
    url: `/v1/management/support/conversations/${supportMessage.conversation.id}/claim`,
    headers: auth,
    payload: { expectedVersion: supportMessage.conversation.version }
  }), "SUPPORT_CLAIM");

  const enrollment = body<any>(await http({
    method: "POST",
    url: "/v1/admin/tester-enrollments",
    headers: { ...auth, "x-dev-clock": "2026-09-01T09:00:00+08:00" },
    payload: {
      memberId: identity.memberId,
      qualificationType: "approved_tester_fulfillment",
      externalRef: "miniprogram-acceptance-fulfillment-0001",
      occurredAt: "2026-08-31T12:00:00+08:00",
      timezone: "Asia/Shanghai",
      protocolVersion: "care-local-acceptance-v1",
      reasonCode: "LOCAL_ACCEPTANCE_SYNTHETIC_FIXTURE",
      evidence: { synthetic: true, run: "miniprogram-acceptance" }
    }
  }), "CARE_ENROLL");
  assert.equal(enrollment.cycle.phase,'planned');
  const activeCycle = body<any>(await http({
    method: "POST",
    url: `/v1/care-cycles/${enrollment.cycle.id}/activate`,
    headers: { ...auth, "idempotency-key": "acceptance-care-activate-0001", "x-dev-clock": "2026-09-01T10:00:00+08:00" },
    payload: { expectedVersion: enrollment.cycle.version }
  }), "CARE_ACTIVATE");
  assert.equal((await http({method:'POST',url:`/v1/care-cycles/${enrollment.cycle.id}/milestones/D1/complete`,headers:{...auth,'idempotency-key':'r3-care-wrong-order','x-dev-clock':'2026-09-01T10:09:00+08:00'},payload:{expectedVersion:activeCycle.version,stepCodes:['01','00','02','03'],selfAssessment:'comfortable'}})).statusCode,422);
  const d1 = body<any>(await http({
    method: "POST",
    url: `/v1/care-cycles/${enrollment.cycle.id}/milestones/D1/complete`,
    headers: { ...auth, "idempotency-key": "acceptance-care-d1-0001", "x-dev-clock": "2026-09-01T10:10:00+08:00" },
    payload: { expectedVersion: activeCycle.version, stepCodes: ["00", "01", "02", "03"], selfAssessment: "comfortable" }
  }), "CARE_D1");

const supportAgain=body(await http({method:'POST',url:'/v1/me/support/messages',headers:auth,payload:{body:'这是一条本地合成验收消息，用于确认客服列表、详情与人工接管界面健康。',clientMessageId:'acceptance-support-message-0001'}}),'SUPPORT_RETRY');assert.equal(supportAgain.message.id,supportMessage.message.id);
const supportReply=body(await http({method:'POST',url:`/v1/management/support/conversations/${supportMessage.conversation.id}/messages`,headers:auth,payload:{body:'已接收合成演练请求',clientMessageId:'r3-support-response-001'}}),'SUPPORT_REPLY');
body(await http({method:'POST',url:'/v1/me/support/read',headers:auth,payload:{lastSeenSequence:supportReply.message.sequence}}),'SUPPORT_READ');check('support',{duplicateMessageSameId:true,replyAccepted:supportReply.message.deliveryState});
const careFacts=(await pool.query("SELECT r.milestone,r.self_assessment,(SELECT json_agg(s.step_code ORDER BY s.sequence) FROM care_record_step s WHERE s.record_id=r.id) steps FROM care_record r WHERE r.cycle_id=$1",[enrollment.cycle.id])).rows;
assert.equal(careFacts.length,1);assert.deepEqual(careFacts[0].steps,['00','01','02','03']);assert.equal(careFacts[0].self_assessment,'comfortable');check('carePersisted',careFacts);
check('syntheticIds',{member:identity.memberId,order:pendingOrder.id,paid:paid.id,aftersale:after.id,privacy:privacy.id,cycle:enrollment.cycle.id});
await app.close();app=null;
await writeFile(base+'/runtime-result.json',JSON.stringify(facts,null,2)+'\n',{mode:0o600});
console.log(JSON.stringify({ok:true,checks:facts.checks.map((x:any)=>x.name),sourceHead:manifest.sourceHead}));
}catch(e:any){await writeFile(base+'/runtime-partial.json',JSON.stringify(facts,null,2)+'\n',{mode:0o600});console.error('R3_HARNESS_FAILURE',e.message);process.exitCode=1;}finally{if(app)await app.close();await pool.end();}
