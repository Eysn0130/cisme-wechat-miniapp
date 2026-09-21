import { beforeAll, afterAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { loadConfig } from "@cisme/config";
import { TEST_DATABASE_URL, resetDatabase, testPool } from "@cisme/testkit";
import { createApp } from "../../services/api/src/server";
import { createApiGatewayStorage } from "../../services/api/src/storage";
import { issueSessionToken } from "../../services/api/src/auth";

// This suite only uses a reset-guarded cisme_*test* database. The synthetic
// imported history below is an ownership fixture, NOT evidence of payment,
// commission entitlement, a valid refund transition or a production provider.
const pool=testPool();
const env={DATABASE_URL:TEST_DATABASE_URL,APP_SESSION_SECRET:"synthetic-history-session",
  ADMIN_API_TOKEN:"synthetic-history-admin",UPLOAD_TOKEN_SECRET:"synthetic-history-upload",
  OBJECT_STORAGE_DRIVER:"api_gateway",CONTACT_ENCRYPTION_KEY:"11".repeat(32),
  CONTACT_HASH_KEY:"22".repeat(32),CONTACT_KEY_VERSION:"history-test-v1",LOG_LEVEL:"silent"};
const auth=(sessionToken:string)=>({authorization:`Bearer ${sessionToken}`});
type Actor={memberId:string;principalId:string;sessionToken:string};
let seed:FastifyInstance,closed:FastifyInstance,owner:Actor,other:Actor,revoked:Actor,empty:Actor;
let ownerOrder:string,otherOrder:string,cancelledOrder:string,cancelledCredit:string;
const paths=["/v1/me/refund-requests","/v1/me/commission/settlement-requests","/v1/me/commission/credit-conversions"];
const makeActor=async(name:string):Promise<Actor>=>{
  const response=await seed.inject({method:"POST",url:"/v1/identity/dev",payload:{externalUserId:name,displayName:name,
    consents:[{documentType:"privacy",version:"test"},{documentType:"terms",version:"test"}]}});
  expect(response.statusCode).toBe(200);return response.json();
};
beforeAll(async()=>{
  await resetDatabase(pool);
  const seedConfig=loadConfig({...env,APP_ENV:"test",COMMERCE_ORDER_FLOW_ENABLED:"true"});
  seed=await createApp({config:seedConfig,pool,storage:createApiGatewayStorage(seedConfig)});
  const closedConfig=loadConfig({...env,APP_ENV:"development",COMMERCE_ORDER_FLOW_ENABLED:"false"});
  // Development here is an isolated injected app, never a deployed target.
  // No paymentProtocol, merchant key, channel URL, worker or upload is provided.
  closed=await createApp({config:closedConfig,pool,storage:createApiGatewayStorage(closedConfig)});
  owner=await makeActor("history-owner");other=await makeActor("history-other");
  empty=await makeActor("history-empty");revoked=await makeActor("history-revoked");
  const operator=await makeActor("history-operator");
  for(const capability of ["commerce.product.manage","commerce.qualification.manage","commerce.inventory.manage"]){
    await pool.query(`INSERT INTO authority_grant(member_id,capability,granted_by,grant_reason,environment,grant_source)
      VALUES($1,$2,'fixture','Synthetic history ownership test','test','integration_fixture')`,[operator.memberId,capability]);
  }
  async function post(url:string,payload:object,key:string,actor=operator){
    const response=await seed.inject({method:"POST",url,headers:{...auth(actor.sessionToken),"idempotency-key":key},payload});
    expect(response.statusCode,response.body).toBe(200);return response.json();
  }
  const product=await post("/v1/management/catalog/products",{code:"synthetic-history",name:"合成历史查询商品",subtitle:"仅用于所有权测试",
    description:"无真实销售含义",imagePath:"/assets/cisme/community-card-purple-bottle-v1.jpg",sourceKind:"synthetic_test",
    sku:{code:"SYNTH_HISTORY",label:"合成规格",priceCents:10000}},"history-product-create");
  const qualified=await post(`/v1/management/catalog/products/${product.productId}/qualification`,{expectedVersion:product.version,
    status:"eligible",reason:"Synthetic history fixture",evidenceRef:"fixture://history/qualification"},"history-product-qualify");
  const published=await post(`/v1/management/catalog/products/${product.productId}/publication`,{expectedVersion:qualified.version,
    action:"publish",reason:"Synthetic history fixture"},"history-product-publish");
  const sku=published.variants[0];
  await post(`/v1/management/catalog/skus/${sku.id}/inventory-adjustments`,{expectedVersion:sku.inventoryVersion,delta:4,
    reason:"Synthetic history fixture"},"history-inventory-create");
  async function orderFor(actor:Actor,suffix:string){
    const address=await post("/v1/me/addresses",{recipientName:`合成${suffix}`,phone:"13800001001",province:"上海市",city:"上海市",district:"浦东新区",
      detail:"合成测试路 1 号",postalCode:"200000",nationalCode:"310115",provinceCode:"310000",cityCode:"310100",districtCode:"310115",label:"home",isDefault:true},`history-address-${suffix}`,actor);
    const quote=await post("/v1/me/commerce/quotes",{skuId:sku.id,quantity:1,addressId:address.id,addressVersion:address.version},`history-quote-${suffix}`,actor);
    return (await post("/v1/me/orders",{quoteId:quote.id},`history-order-${suffix}`,actor)).id as string;
  }
  ownerOrder=await orderFor(owner,"owner");otherOrder=await orderFor(other,"other");
  cancelledOrder=await orderFor(owner,"cancel");
  const pendingOrder=(await seed.inject({method:"GET",url:`/v1/me/orders/${cancelledOrder}`,headers:auth(owner.sessionToken)})).json();
  await post(`/v1/me/orders/${cancelledOrder}/cancel`,{expectedVersion:pendingOrder.version,reason:"合成取消命令回执测试"},"history-cancel-original",owner);
  for(const [actor,orderId] of [[owner,ownerOrder],[other,otherOrder]] as const){
    for(let i=0;i<3;i++){
      await pool.query(`INSERT INTO commerce_refund_request(order_id,requested_by_member_id,idempotency_key,request_hash,amount_cents,reason)
        VALUES($1,$2,$3,$4,100,'合成历史记录所有权测试')`,[orderId,actor.memberId,`history-refund-${i}`,"a".repeat(64)]);
      await pool.query(`INSERT INTO commission_settlement_request(member_id,requested_by_member_id,idempotency_key,request_hash,
        amount_cents,reason,policy_version,payee_openid,package_info) VALUES($1,$1,$2,$3,100,'合成历史记录所有权测试',
        'isolated-settlement-v1','synthetic-private-payee','synthetic-confirmation-not-for-list')`,[actor.memberId,`history-settlement-${i}`,"a".repeat(64)]);
      await pool.query(`INSERT INTO commission_credit_conversion(member_id,idempotency_key,request_hash,gross_cents,credit_cents,tax_policy_version)
        VALUES($1,$2,$3,100,100,'isolated-synthetic-zero-withholding-v1')`,[actor.memberId,`history-credit-${i}`,"a".repeat(64)]);
    }
  }
  // Deliberately imported history fixture only, not a real credit reversal.
  const conversion=await pool.query(`UPDATE commission_credit_conversion SET state='cancelled',cancelled_at=clock_timestamp(),
    cancel_key='history-credit-cancel',cancel_hash=$2 WHERE member_id=$1 AND idempotency_key='history-credit-2' RETURNING id`,[owner.memberId,"b".repeat(64)]);
  cancelledCredit=conversion.rows[0].id;
  await pool.query("UPDATE member SET status='blocked' WHERE id=$1",[revoked.memberId]);
},30_000);
afterAll(async()=>{await closed?.close();await seed?.close();await pool.end();});

describe.each(paths)("provider-independent private history: %s",path=>{
  it("reads own history while runtime is disabled without permitting forged owner or role",async()=>{
    expect((await closed.inject({method:"GET",url:"/v1/commerce/orders/status"})).json()).toMatchObject({scope:"disabled",paymentAvailable:false});
    const result=await closed.inject({method:"GET",url:`${path}?memberId=${other.memberId}&role=review_lead&limit=2`,headers:auth(owner.sessionToken)});
    expect(result.statusCode,result.body).toBe(200);expect(result.json()).toMatchObject({totalCount:3,loadedCount:2,hasMore:true});
    expect(result.body).not.toContain(other.memberId);expect(result.body).not.toContain(otherOrder);
    for(const secret of ["payee_openid","packageInfo","package_info","synthetic-private-payee","synthetic-confirmation-not-for-list","request_hash","idempotency_key"])
      expect(result.body).not.toContain(secret);
  });
  it("uses an owner-scoped bounded cursor without duplicate rows",async()=>{
    const first=await closed.inject({method:"GET",url:`${path}?limit=2`,headers:auth(owner.sessionToken)});
    expect(first.statusCode,first.body).toBe(200);const cursor=first.json().nextCursor;expect(cursor).toBeTruthy();
    const next=await closed.inject({method:"GET",url:`${path}?limit=2&cursor=${cursor}`,headers:auth(owner.sessionToken)});
    expect(next.statusCode,next.body).toBe(200);expect(next.json()).toMatchObject({totalCount:3,loadedCount:1,nextCursor:null});
    expect(new Set([...first.json().items,...next.json().items].map((row:any)=>row.id)).size).toBe(3);
    const cross=await closed.inject({method:"GET",url:`${path}?cursor=${cursor}`,headers:auth(other.sessionToken)});
    expect(cross.statusCode).toBe(422);expect(cross.json().code).toBe("PAGE_CURSOR_INVALID");
  });
  it("distinguishes a genuine empty result from an unavailable provider",async()=>{
    const result=await closed.inject({method:"GET",url:path,headers:auth(empty.sessionToken)});
    expect(result.statusCode,result.body).toBe(200);expect(result.json()).toMatchObject({items:[],totalCount:0,nextCursor:null});
  });
  it.each([undefined,"Bearer forged.invalid"])("rejects missing or forged authentication %s",async authorization=>{
    expect((await closed.inject({method:"GET",url:path,headers:authorization?{authorization}:{}})).statusCode).toBe(401);
  });
  it("rejects expired authentication and a blocked member",async()=>{
    const expired=issueSessionToken({principalId:owner.principalId,memberId:owner.memberId,adapter:"dev",provider:"dev_test",appId:"dev"},
      env.APP_SESSION_SECRET,Date.now()-24*60*60*1000);
    expect((await closed.inject({method:"GET",url:path,headers:auth(expired)})).statusCode).toBe(401);
    expect((await closed.inject({method:"GET",url:path,headers:auth(revoked.sessionToken)})).statusCode).toBe(401);
  });
  it.each(["0","51","1.5"])("bounds the page size %s",async limit=>{
    expect((await closed.inject({method:"GET",url:`${path}?limit=${limit}`,headers:auth(owner.sessionToken)})).statusCode).toBe(422);
  });
});
it("cannot filter into someone else's refunds or reuse an order-scoped cursor",async()=>{
  const first=await closed.inject({method:"GET",url:`/v1/me/refund-requests?orderId=${ownerOrder}&limit=2`,headers:auth(owner.sessionToken)});
  expect(first.statusCode,first.body).toBe(200);expect(first.json().items.every((row:any)=>row.orderId===ownerOrder)).toBe(true);
  const cross=await closed.inject({method:"GET",url:`/v1/me/refund-requests?orderId=${otherOrder}`,headers:auth(owner.sessionToken)});
  expect(cross.statusCode).toBe(200);expect(cross.json()).toMatchObject({items:[],totalCount:0});
  expect((await closed.inject({method:"GET",url:`/v1/me/refund-requests?cursor=${first.json().nextCursor}`,headers:auth(owner.sessionToken)})).statusCode).toBe(422);
});
it("readable credit history does not grant live spend or cancellation permission",async()=>{
  const result=await closed.inject({method:"GET",url:paths[2]!,headers:auth(owner.sessionToken)});
  expect(result.statusCode,result.body).toBe(200);expect(result.json()).toMatchObject({checkoutAvailableCents:0,spendable:false,redemptionStatus:"ISOLATED_TEST_ONLY"});
  expect(result.json().items.every((row:any)=>row.cancellable===false)).toBe(true);
});
it("does not loosen any money mutation gate or return a confirmation package",async()=>{
  for(const url of [`/v1/me/orders/${ownerOrder}/payment-intent`,`/v1/me/orders/${ownerOrder}/refund-requests`,
    "/v1/me/commission/settlement-requests","/v1/me/commission/credit-conversions"]){
    const result=await closed.inject({method:"POST",url,headers:{...auth(owner.sessionToken),"idempotency-key":"history-write-closed"},payload:{amountCents:100,reason:"合成测试申请"}});
    expect(result.statusCode,result.body).toBe(503);
  }
  const row=(await closed.inject({method:"GET",url:paths[1]!,headers:auth(owner.sessionToken)})).json().items[0];
  expect((await closed.inject({method:"GET",url:`/v1/me/commission/settlement-requests/${row.id}/confirmation`,headers:auth(owner.sessionToken)})).statusCode).toBe(503);
});


// The new endpoint reads existing durable facts; it neither creates facts nor
// decides a missing command never ran. In particular, no provider is installed.
const receiptKinds=["refund","settlement","credit","credit-cancel","cancel","cancel-verified"] as const;
function receiptTarget(kind:typeof receiptKinds[number]){
  const key=kind==="refund"?"history-refund-0":kind==="settlement"?"history-settlement-0":kind==="credit"?"history-credit-0":kind==="credit-cancel"?"history-credit-cancel":"history-cancel-original";
  const objectId=kind==="refund"?ownerOrder:kind==="credit-cancel"?cancelledCredit:kind.startsWith("cancel")?cancelledOrder:undefined;
  return {key,url:`/v1/me/commerce/command-receipts/${kind}${objectId?`?objectId=${objectId}`:""}`};
}
describe.each(receiptKinds)("private durable command receipt: %s",kind=>{
  it("recovers a minimal original receipt even when every outbound gate is closed",async()=>{
    const target=receiptTarget(kind);
    const result=await closed.inject({method:"GET",url:target.url,headers:{...auth(owner.sessionToken),"idempotency-key":target.key}});
    expect(result.statusCode,result.body).toBe(200);expect(result.headers["cache-control"]).toBe("no-store");
    expect(result.json()).toMatchObject({version:1,memberId:owner.memberId,kind,status:"recorded"});
    expect(Object.keys(result.json()).sort()).toEqual(["version","memberId","kind","status","record"].sort());
    const row=result.json().record;expect(row.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(Object.keys(row).every(field=>["id","orderId","state","amountCents"].includes(field))).toBe(true);
    for(const sensitive of [target.key,"idempotencyKey","reason","payee","package","request_hash","principalId","signature","nonceStr","合成历史记录"])
      expect(result.body).not.toContain(sensitive);
    if(["cancel","cancel-verified","credit-cancel"].includes(kind))expect(row.state).toBe("cancelled");
    else expect(row.amountCents).toBe(100);
  });
  it("another member's key/object is not exposed as a receipt",async()=>{
    const target=receiptTarget(kind);
    const result=await closed.inject({method:"GET",url:target.url,headers:{...auth(empty.sessionToken),"idempotency-key":target.key}});
    expect(result.statusCode,result.body).toBe(200);expect(result.json()).toEqual({version:1,memberId:empty.memberId,kind,status:"not_observed",record:null});
    expect(result.body).not.toContain(owner.memberId);expect(result.body).not.toContain(ownerOrder);
  });
  it("missing records are inconclusive, never success or proof of failed execution",async()=>{
    const target=receiptTarget(kind);
    const result=await closed.inject({method:"GET",url:target.url,headers:{...auth(owner.sessionToken),"idempotency-key":"history-absent-command"}});
    expect(result.statusCode,result.body).toBe(200);expect(result.json()).toMatchObject({status:"not_observed",record:null});
    expect(result.body).not.toContain("retrySafe");expect(result.body).not.toContain("not_executed");
  });
  it.each(["missing","forged","revoked","expired"])("rejects %s credentials before returning command facts",async mode=>{
    const target=receiptTarget(kind),expired=issueSessionToken({principalId:owner.principalId,memberId:owner.memberId,adapter:"dev",provider:"dev_test",appId:"dev"},env.APP_SESSION_SECRET,Date.now()-24*60*60*1000);
    const token=mode==="missing"?null:mode==="forged"?"forged.invalid":mode==="revoked"?revoked.sessionToken:expired;
    const result=await closed.inject({method:"GET",url:target.url,headers:{...(token?auth(token):{}),"idempotency-key":target.key}});
    expect(result.statusCode,result.body).toBe(401);expect(result.body).not.toContain(target.key);
  });
  it("rejects owner and role injection rather than widening its lookup",async()=>{
    const target=receiptTarget(kind);
    for(const extra of [`memberId=${other.memberId}`,"role=review_lead","recorded=true"]){
      const result=await closed.inject({method:"GET",url:target.url+(target.url.includes("?")?"&":"?")+extra,
        headers:{...auth(owner.sessionToken),"idempotency-key":target.key}});
      expect(result.statusCode,result.body).toBe(422);
    }
  });
  it("requires the original bounded key and validates kind-specific object scope",async()=>{
    const target=receiptTarget(kind);
    expect((await closed.inject({method:"GET",url:target.url,headers:auth(owner.sessionToken)})).statusCode).toBe(400);
    expect((await closed.inject({method:"GET",url:target.url,headers:{...auth(owner.sessionToken),"idempotency-key":"x".repeat(201)}})).statusCode).toBe(400);
    const bad=`/v1/me/commerce/command-receipts/${kind}?objectId=${["settlement","credit"].includes(kind)?ownerOrder:"not-a-uuid"}`;
    expect((await closed.inject({method:"GET",url:bad,headers:{...auth(owner.sessionToken),"idempotency-key":target.key}})).statusCode).toBe(422);
  });
});
it("a cancellation receipt is durable beyond frontend retries without releasing inventory again",async()=>{
  const before=(await pool.query("SELECT count(*)::int AS n FROM commerce_order_transition WHERE order_id=$1 AND to_status='cancelled'",[cancelledOrder])).rows[0].n;
  for(let i=0;i<3;i++){
    const target=receiptTarget("cancel");const result=await closed.inject({method:"GET",url:target.url,headers:{...auth(owner.sessionToken),"idempotency-key":target.key}});
    expect(result.json()).toMatchObject({status:"recorded",record:{id:cancelledOrder,state:"cancelled"}});
  }
  const after=(await pool.query("SELECT count(*)::int AS n FROM commerce_order_transition WHERE order_id=$1 AND to_status='cancelled'",[cancelledOrder])).rows[0].n;
  expect(before).toBe(1);expect(after).toBe(1);
});
it("a known cancellation key cannot be retargeted to a different owned or foreign order",async()=>{
  for(const id of [ownerOrder,otherOrder]){
    const result=await closed.inject({method:"GET",url:`/v1/me/commerce/command-receipts/cancel?objectId=${id}`,
      headers:{...auth(owner.sessionToken),"idempotency-key":"history-cancel-original"}});
    expect(result.json()).toMatchObject({status:"not_observed",record:null});
  }
});

const discoveryPath=(kind:string)=>`/v1/me/commerce/recorded-commands/${kind}`;
describe.each(receiptKinds)("recorded command discovery without local keys: %s",kind=>{
  it("finds only owned retained facts without returning keys, payloads or money permission",async()=>{
    const result=await closed.inject({method:"GET",url:discoveryPath(kind),headers:auth(owner.sessionToken)});
    expect(result.statusCode,result.body).toBe(200);expect(result.headers["cache-control"]).toBe("no-store");
    const body=result.json();expect(body).toMatchObject({version:1,kind,coverage:"retained_recorded_facts_only",absenceIsFailure:false});
    expect(body.items.length).toBeGreaterThan(0);
    expect(Object.keys(body).sort()).toEqual(["version","kind","coverage","absenceIsFailure","items","nextCursor","loadedCount","hasMore"].sort());
    for(const row of body.items){
      expect(Object.keys(row).sort()).toEqual(["id","objectId","state","recordVersion","commandCreatedAt"].sort());
      expect(row.id).toMatch(/^[0-9a-f-]{36}$/);expect(row.commandCreatedAt).toMatch(/\.\d{6}Z$/);
    }
    for(const secret of ["history-",other.memberId,otherOrder,"payee","package","reason","principalId","request_hash","retrySafe","amountCents"])
      expect(result.body).not.toContain(secret);
    const another=await closed.inject({method:"GET",url:discoveryPath(kind),headers:auth(empty.sessionToken)});
    expect(another.statusCode,another.body).toBe(200);expect(another.json()).toMatchObject({items:[],nextCursor:null,absenceIsFailure:false});
  });
  it.each(["missing","forged","revoked","expired"])("rejects %s authentication",async mode=>{
    const expired=issueSessionToken({principalId:owner.principalId,memberId:owner.memberId,adapter:"dev",provider:"dev_test",appId:"dev"},env.APP_SESSION_SECRET,Date.now()-24*60*60*1000);
    const token=mode==="missing"?null:mode==="forged"?"forged.invalid":mode==="revoked"?revoked.sessionToken:expired;
    expect((await closed.inject({method:"GET",url:discoveryPath(kind),headers:token?auth(token):{}})).statusCode).toBe(401);
  });
  it("rejects unknown fields, malformed objects, and excessive page size",async()=>{
    for(const query of ["memberId="+other.memberId,"role=review_lead","key=history-refund-0","objectId=invalid","limit=51","limit=0","limit=1.5"]){
      expect((await closed.inject({method:"GET",url:discoveryPath(kind)+"?"+query,headers:auth(owner.sessionToken)})).statusCode).toBe(422);
    }
  });
});
it("paginates exact database timestamps and scopes discovery cursors to actor, environment, kind and object",async()=>{
  const path=discoveryPath("refund"),headers=auth(owner.sessionToken);
  const first=await closed.inject({method:"GET",url:path+"?limit=1",headers});
  expect(first.statusCode,first.body).toBe(200);const cursor=first.json().nextCursor;expect(cursor).toBeTruthy();
  const seen=first.json().items.map((r:any)=>r.id);let next=cursor;
  while(next){const result=await closed.inject({method:"GET",url:path+"?limit=1&cursor="+next,headers});expect(result.statusCode,result.body).toBe(200);seen.push(...result.json().items.map((r:any)=>r.id));next=result.json().nextCursor;expect(seen.length).toBeLessThanOrEqual(3);}
  expect(seen).toHaveLength(3);expect(new Set(seen).size).toBe(3);
  for(const [app,url,actor] of [[closed,path+"?cursor="+cursor,other],[seed,path+"?cursor="+cursor,owner],
    [closed,discoveryPath("settlement")+"?cursor="+cursor,owner],[closed,path+"?objectId="+ownerOrder+"&cursor="+cursor,owner]] as const){
    const result=await app.inject({method:"GET",url,headers:auth(actor.sessionToken)});expect(result.statusCode,result.body).toBe(422);expect(result.json().code).toBe("PAGE_CURSOR_INVALID");
  }
  const foreign=await closed.inject({method:"GET",url:path+"?objectId="+otherOrder,headers});
  expect(foreign.statusCode,foreign.body).toBe(200);expect(foreign.json().items).toEqual([]);
});
it("never discovers an order cancellation without matching original principal/object/version facts",async()=>{
  const before=await closed.inject({method:"GET",url:discoveryPath("cancel")+"?objectId="+ownerOrder,headers:auth(owner.sessionToken)});
  expect(before.statusCode,before.body).toBe(200);expect(before.json().items).toEqual([]);
  const countBefore=(await pool.query("SELECT count(*)::int AS n FROM commerce_order_transition WHERE order_id=$1",[cancelledOrder])).rows[0].n;
  for(let i=0;i<2;i++)expect((await closed.inject({method:"GET",url:discoveryPath("cancel")+"?objectId="+cancelledOrder,headers:auth(owner.sessionToken)})).json().items).toHaveLength(1);
  const countAfter=(await pool.query("SELECT count(*)::int AS n FROM commerce_order_transition WHERE order_id=$1",[cancelledOrder])).rows[0].n;
  expect(countAfter).toBe(countBefore);
});
it("does not skip discovery records within the same millisecond",async()=>{
  const inserted:string[]=[];
  for(let i=1;i<=3;i++){
    const row=await pool.query(`INSERT INTO commerce_refund_request(order_id,requested_by_member_id,idempotency_key,request_hash,amount_cents,reason,created_at)
      VALUES($1,$2,$3,$4,100,'合成微秒分页测试','2030-01-01T00:00:00Z'::timestamptz + $5 * interval '100 microseconds') RETURNING id`,
      [ownerOrder,owner.memberId,`history-microsecond-${i}`,"c".repeat(64),i]);inserted.push(row.rows[0].id);
  }
  let cursor:string|null=null;const found:string[]=[];
  do{
    const url:string=discoveryPath("refund")+"?limit=1"+(cursor?"&cursor="+cursor:"");
    const result=await closed.inject({method:"GET",url,headers:auth(owner.sessionToken)});
    expect(result.statusCode,result.body).toBe(200);found.push(...result.json().items.map((r:any)=>r.id));cursor=result.json().nextCursor;
    expect(found.length).toBeLessThanOrEqual(6);
  }while(cursor);
  expect(found).toHaveLength(6);expect(found).toEqual(expect.arrayContaining(inserted));
});
it("rejects unknown discovery kinds",async()=>{
  const result=await closed.inject({method:"GET",url:discoveryPath("arbitrary"),headers:auth(owner.sessionToken)});
  expect(result.statusCode,result.body).toBe(422);
});
