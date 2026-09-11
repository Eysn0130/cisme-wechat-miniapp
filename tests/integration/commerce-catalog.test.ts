import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { loadConfig } from "@cisme/config";
import { TEST_DATABASE_URL, resetDatabase, testPool } from "@cisme/testkit";
import { createApp } from "../../services/api/src/server";
import { createApiGatewayStorage } from "../../services/api/src/storage";

const pool=testPool();
const config=loadConfig({APP_ENV:"test",DATABASE_URL:TEST_DATABASE_URL,APP_SESSION_SECRET:"commerce-test-session",ADMIN_API_TOKEN:"legacy-admin",UPLOAD_TOKEN_SECRET:"commerce-upload",OBJECT_STORAGE_DRIVER:"api_gateway"});
let app:FastifyInstance;let operator:any;let limited:any;
const auth=(token:string)=>({authorization:`Bearer ${token}`});
const identity=async(name:string)=>(await app.inject({method:"POST",url:"/v1/identity/dev",payload:{externalUserId:name,displayName:name,consents:[{documentType:"privacy",version:"v1"},{documentType:"terms",version:"v1"}]}})).json();

beforeAll(async()=>{await resetDatabase(pool);app=await createApp({config,pool,storage:createApiGatewayStorage(config)});operator=await identity("commerce-operator");limited=await identity("commerce-limited");for(const capability of ["commerce.product.manage","commerce.qualification.manage","commerce.inventory.manage"])await pool.query(`INSERT INTO authority_grant(member_id,capability,granted_by,grant_reason,environment,grant_source) VALUES($1,$2,'fixture','Commerce integration','test','integration_fixture')`,[operator.memberId,capability]);});
afterAll(async()=>{await app.close();await pool.end();});

describe("R4-A first-party catalog",()=>{
  it("keeps legacy previews private and completes capability-separated create-to-browse lifecycle",async()=>{
    const initial=await app.inject({method:"GET",url:"/v1/catalog"});expect(initial.statusCode).toBe(200);expect(initial.json()).toMatchObject({version:3,checkoutEnabled:false,items:[]});
    expect((await app.inject({method:"GET",url:"/v1/management/catalog/products",headers:auth(limited.sessionToken)})).statusCode).toBe(403);
    const payload={code:"synthetic-care-serum",name:"合成测试护理精华",subtitle:"仅用于 R4-A 隔离验证",description:"不代表真实商品资质或销售承诺。",imagePath:"/assets/cisme/community-card-purple-bottle-v1.jpg",sourceKind:"synthetic_test",sku:{code:"SYNTH_CARE_30",label:"30ml",priceCents:26900}};
    expect((await app.inject({method:"POST",url:"/v1/management/catalog/products",headers:{...auth(limited.sessionToken),"idempotency-key":"limited-create-01"},payload})).statusCode).toBe(403);
    const headers={...auth(operator.sessionToken),"idempotency-key":"catalog-create-integration-01"};
    const created=await app.inject({method:"POST",url:"/v1/management/catalog/products",headers,payload});expect(created.statusCode).toBe(200);
    const replay=await app.inject({method:"POST",url:"/v1/management/catalog/products",headers,payload});expect(replay.json()).toEqual(created.json());
    const product=created.json();expect(product).toMatchObject({sourceKind:"synthetic_test",qualificationStatus:"pending",publicationStatus:"draft",price:26900,stockOnHand:0,purchaseEnabled:false});
    expect((await app.inject({method:"GET",url:`/v1/catalog/${product.code}`})).statusCode).toBe(404);

    const noEvidence=await app.inject({method:"POST",url:`/v1/management/catalog/products/${product.productId}/qualification`,headers:{...auth(operator.sessionToken),"idempotency-key":"catalog-qualify-no-evidence"},payload:{expectedVersion:product.version,status:"eligible",reason:"Synthetic eligibility test"}});
    expect(noEvidence.statusCode).toBe(422);expect(noEvidence.json().code).toBe("QUALIFICATION_EVIDENCE_REQUIRED");
    const qualified=(await app.inject({method:"POST",url:`/v1/management/catalog/products/${product.productId}/qualification`,headers:{...auth(operator.sessionToken),"idempotency-key":"catalog-qualify-integration"},payload:{expectedVersion:product.version,status:"eligible",reason:"Synthetic qualification path test",evidenceRef:"fixture://commerce-catalog/eligible-v1"}})).json();
    const published=await app.inject({method:"POST",url:`/v1/management/catalog/products/${product.productId}/publication`,headers:{...auth(operator.sessionToken),"idempotency-key":"catalog-publish-integration"},payload:{expectedVersion:qualified.version,action:"publish",reason:"Synthetic browse path verification"}});expect(published.statusCode).toBe(200);
    const visible=(await app.inject({method:"GET",url:`/v1/catalog/${product.code}`})).json();expect(visible).toMatchObject({code:product.code,inStock:false,sellability:"out_of_stock",purchaseEnabled:false});

    const sku=visible.variants[0];const inventoryHeaders={...auth(operator.sessionToken),"idempotency-key":"catalog-stock-integration-01"};
    const adjusted=await app.inject({method:"POST",url:`/v1/management/catalog/skus/${sku.id}/inventory-adjustments`,headers:inventoryHeaders,payload:{expectedVersion:sku.inventoryVersion,delta:5,reason:"Synthetic stock setup"}});expect(adjusted.statusCode).toBe(200);
    const stockReplay=await app.inject({method:"POST",url:`/v1/management/catalog/skus/${sku.id}/inventory-adjustments`,headers:inventoryHeaders,payload:{expectedVersion:sku.inventoryVersion,delta:5,reason:"Synthetic stock setup"}});expect(stockReplay.json()).toEqual(adjusted.json());
    const concurrent=await Promise.all([1,2].map(index=>app.inject({method:"POST",url:`/v1/management/catalog/skus/${sku.id}/inventory-adjustments`,headers:{...auth(operator.sessionToken),"idempotency-key":`catalog-stock-race-0${index}`},payload:{expectedVersion:adjusted.json().sku.inventoryVersion,delta:-index,reason:`Synthetic race check ${index}`}})));
    expect(concurrent.map(result=>result.statusCode).sort()).toEqual([200,409]);
    const stocked=(await app.inject({method:"GET",url:`/v1/catalog/${product.code}`})).json();expect([3,4]).toContain(stocked.stockOnHand);expect(stocked).toMatchObject({inStock:true,sellability:"browse_only",purchaseEnabled:false});

    const stale=await app.inject({method:"PUT",url:`/v1/management/catalog/products/${product.productId}`,headers:{...auth(operator.sessionToken),"idempotency-key":"catalog-stale-update-01"},payload:{...payload,expectedVersion:product.version,sku:{...payload.sku,id:sku.id,expectedVersion:sku.version,expectedPriceVersion:sku.priceVersion}}});expect(stale.statusCode).toBe(409);
    const latest=(await app.inject({method:"GET",url:`/v1/management/catalog/products/${product.productId}`,headers:auth(operator.sessionToken)})).json();
    const unpublished=await app.inject({method:"POST",url:`/v1/management/catalog/products/${product.productId}/publication`,headers:{...auth(operator.sessionToken),"idempotency-key":"catalog-unpublish-integration"},payload:{expectedVersion:latest.version,action:"unpublish",reason:"Synthetic lifecycle complete"}});expect(unpublished.statusCode).toBe(200);
    expect((await app.inject({method:"GET",url:`/v1/catalog/${product.code}`})).statusCode).toBe(404);
    expect((await pool.query("SELECT count(*)::int count FROM catalog_inventory_adjustment WHERE sku_id=$1",[sku.id])).rows[0].count).toBe(2);
    expect((await pool.query("SELECT count(*)::int count FROM outbox_event WHERE aggregate_id IN ($1,$2)",[product.productId,sku.id])).rows[0].count).toBeGreaterThanOrEqual(5);
  });

  it("enforces environment, expiry and revocation for catalog authority",async()=>{
    await pool.query(`UPDATE authority_grant SET revoked_at=now(),revoked_by='fixture',revoke_reason='Immediate revocation test' WHERE member_id=$1 AND capability='commerce.product.manage'`,[operator.memberId]);
    const payload={code:"revoked-test-product",name:"撤权测试商品",subtitle:"隔离测试",description:"不公开",sourceKind:"synthetic_test",sku:{code:"REVOKED_TEST_SKU",label:"测试规格",priceCents:100}};
    expect((await app.inject({method:"POST",url:"/v1/management/catalog/products",headers:{...auth(operator.sessionToken),"idempotency-key":"revoked-create-01"},payload})).statusCode).toBe(403);
    await pool.query(`INSERT INTO authority_grant(member_id,capability,granted_by,grant_reason,environment,grant_source,expires_at) VALUES($1,'commerce.product.manage','fixture','Expired environment test','staging','integration_fixture',now()+interval '1 hour')`,[limited.memberId]);
    expect((await app.inject({method:"GET",url:"/v1/management/catalog/products",headers:auth(limited.sessionToken)})).statusCode).toBe(403);
  });
});
