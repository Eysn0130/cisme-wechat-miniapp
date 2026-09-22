import { fulfillmentRuntime } from "../services/api/src/fulfillmentRuntime.js";
import { nativeFulfillmentFixture } from "./native-fulfillment-fixture.js";
import { randomBytes } from "node:crypto";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import jpeg from "jpeg-js";
import { loadConfig } from "@cisme/config";
import { CAPABILITIES } from "@cisme/contracts";
import { resetDatabase, resolveTestDatabaseUrl, seedTestCampaign } from "@cisme/testkit";
import { createApp } from "../services/api/src/server.js";
import { createPool } from "../services/api/src/db.js";
import { createApiGatewayStorage } from "../services/api/src/storage.js";

const acceptancePort = Number(process.env.CISME_ACCEPTANCE_PORT ?? 18080);
if(!Number.isInteger(acceptancePort)||acceptancePort<18080||acceptancePort>18089)throw new Error("ACCEPTANCE_LOOPBACK_PORT_INVALID");
const acceptanceHost = "127.0.0.1";
const externalUserId = "cisme-mini-acceptance-member";
const outputDirectory = resolve(process.cwd(), acceptancePort===18080?"tmp/miniprogram-acceptance":`tmp/miniprogram-acceptance-${acceptancePort}`);
const fixturePath = resolve(outputDirectory, "fixture.json");
const syntheticFulfillment = process.argv.includes("--synthetic-fulfillment");
const syntheticCommunity = process.argv.includes("--synthetic-community");

function fail(message: string): never {
  throw new Error(`MINIPROGRAM_ACCEPTANCE_${message}`);
}

function testDatabaseUrl(): string {
  const value = resolveTestDatabaseUrl();
  const url = new URL(value);
  const database = decodeURIComponent(url.pathname.slice(1));
  if (!["127.0.0.1", "localhost", "::1"].includes(url.hostname)) fail("LOOPBACK_DATABASE_REQUIRED");
  if (!database.startsWith("cisme_") || !/(^|_)test(_|$)/.test(database)) fail("TEST_DATABASE_REQUIRED");
  return value;
}

function avatarDataUrl(): string {
  const size = 32;
  const pixels = Buffer.alloc(size * size * 4);
  for (let index = 0; index < size * size; index += 1) {
    const offset = index * 4;
    pixels[offset] = 118;
    pixels[offset + 1] = 76;
    pixels[offset + 2] = 135;
    pixels[offset + 3] = 255;
  }
  const encoded = jpeg.encode({ data: pixels, width: size, height: size }, 70).data;
  return `data:image/jpeg;base64,${encoded.toString("base64")}`;
}

const databaseUrl = testDatabaseUrl();
if (!process.argv.includes("--reset")) fail("EXPLICIT_RESET_REQUIRED");

const secret = () => randomBytes(32).toString("hex");
const config = loadConfig({
  APP_ENV: "test",
  PORT: String(acceptancePort),
  DATABASE_URL: databaseUrl,
  ALLOW_DEV_ADAPTERS: "true",
  APP_SESSION_SECRET: secret(),
  UPLOAD_TOKEN_SECRET: secret(),
  OBJECT_STORAGE_DRIVER: "api_gateway",
  CONTACT_ENCRYPTION_KEY: secret(),
  CONTACT_HASH_KEY: secret(),
  CONTACT_KEY_VERSION: "local-acceptance-v1",
  COMMERCE_ORDER_FLOW_ENABLED: "true",
  COMMERCE_FULFILLMENT_ENABLED: "true",
  WECHAT_APP_ID: "wx4eac2d4fb11d299b",
  COMMERCE_FULFILLMENT_MERCHANT_ID: "1900000001",
  COMMERCE_QUOTE_TTL_MINUTES: "10",
  COMMERCE_PENDING_ORDER_TTL_MINUTES: "120",
  POINTS_RULES_ENABLED: "true",
  POINTS_RULE_IDS: "CARE_D7_STORY_R0,CARE_D28_RECORD_R0,ORDER_REWARD_R0",
  POINTS_FINANCE_APPROVAL_ID: "local-acceptance-only",
  POINTS_FINANCE_APPROVAL_EXPIRES_AT: "2099-12-31T23:59:59Z",
  POINTS_MAKER_CHECKER_READY: "true",
  POINTS_HOLD_DAYS: "7",
  POINTS_EXPIRY_DAYS: "365",
  UGC_GO_LIVE_GATE: "false",
  ...(syntheticCommunity ? {
    UGC_GO_LIVE_GATE: "true", UGC_LEGAL_APPROVAL_ID: "synthetic-local-only",
    UGC_PROVENANCE_READY: "true", UGC_CONTENT_SAFETY_READY: "true", UGC_MODERATION_READY: "true"
  } : {}),
  LOG_LEVEL: "warn"
});

const pool = createPool(databaseUrl, config.database);
const storage = createApiGatewayStorage(config);
let app: Awaited<ReturnType<typeof createApp>> | null = null;

type InjectResponse = { statusCode: number; json(): unknown };

function body<T = Record<string, unknown>>(response: InjectResponse, operation: string): T {
  const parsed = response.json() as T & { code?: string };
  if (response.statusCode < 200 || response.statusCode >= 300) {
    fail(`${operation}_${response.statusCode}_${parsed.code ?? "UNKNOWN"}`);
  }
  return parsed;
}

async function seedFixtures() {
  await resetDatabase(pool);
  await seedTestCampaign(pool);
  await storage.ensureReady();
  app = await createApp({ config, pool, storage, ...(syntheticFulfillment?{shippingTestChannel:{query:async()=>({decision:"matched" as const,platformOrderState:2,inComplaint:false}),uploadOnce:async()=>{throw Error("SYNTHETIC_QUERY_ONLY");}}}:{}) });

  await pool.query(`INSERT INTO legal_document(document_type,version,title,body,operator_name,contact,active)
    VALUES
      ('privacy','local-acceptance-v1','本地验收隐私说明','仅用于隔离的开发者工具验收，不构成正式发布文本。','CISME 本地验收','local@example.invalid',true),
      ('terms','local-acceptance-v1','本地验收服务说明','仅用于隔离的开发者工具验收，不构成正式发布文本。','CISME 本地验收','local@example.invalid',true)`);

  const identity = body<any>(await app.inject({
    method: "POST",
    url: "/v1/identity/dev",
    payload: {
      externalUserId,
      displayName: "CISME 验收会员",
      consents: [
        { documentType: "privacy", version: "local-visual-fixture-2026-08-16" },
        { documentType: "terms", version: "local-visual-fixture-2026-08-16" }
      ]
    }
  }), "IDENTITY");
  const auth = { authorization: `Bearer ${identity.sessionToken}` };
  await pool.query(`INSERT INTO principal_role(principal_id,role)
    VALUES($1,'review_lead'),($1,'support') ON CONFLICT DO NOTHING`, [identity.principalId]);

  body(await app.inject({
    method: "PUT",
    url: "/v1/me/profile",
    headers: auth,
    payload: { displayName: "CISME 验收会员", expectedVersion: 0, communityVisible: false, avatarDataUrl: avatarDataUrl() }
  }), "PROFILE");

  for (const capability of CAPABILITIES) {
    await pool.query(`INSERT INTO authority_grant
      (member_id,capability,granted_by,grant_reason,environment,grant_source,expires_at)
      VALUES($1,$2,'local-acceptance-admin','Isolated Mini Program acceptance fixture','test','local_acceptance',now()+interval '8 hours')`,
    [identity.memberId, capability]);
  }

  body(await app.inject({method:"POST",url:"/v1/me/privacy-requests",headers:auth,
    payload:{kind:"access",message:"合成验收请求：查询本轮护理记录与账号资料。仅测试受理流程，不涉及真实个人信息。"}}),"PRIVACY_REQUEST");

  // This process is test-only, loopback-bound, and resetDatabase verifies the
  // disposable runner's ownership marker before any fixture is created.
  const communityRoutes: Record<string,{path:string;query:string}> = {};
  if (syntheticCommunity) {
    const actor = async (name:string) => body<any>(await app!.inject({method:"POST",url:"/v1/identity/dev",payload:{
      externalUserId:`cisme-mini-acceptance-${name}`,displayName:`合成${name}`,
      consents:[{documentType:"privacy",version:"local-acceptance-v1"},{documentType:"terms",version:"local-acceptance-v1"}]
    }}),`UGC_ACTOR_${name}`);
    const author=await actor("作者"),publisher=await actor("复核员");
    const authorAuth={authorization:`Bearer ${author.sessionToken}`},publisherAuth={authorization:`Bearer ${publisher.sessionToken}`};
    await pool.query(`INSERT INTO authority_grant(member_id,capability,granted_by,grant_reason,environment,grant_source)
      VALUES($1,'community.moderate','local-fixture','Synthetic local acceptance only','test','local_acceptance')`,[publisher.memberId]);
    await pool.query(`INSERT INTO ugc_go_live_approval(approval_reference,signed_by,evidence,signed_at,expires_at)
      VALUES('synthetic-native-acceptance','local fixture',$1,now(),now()+interval '8 hours')`,[{scope:"loopback disposable test only"}]);
    await pool.query("UPDATE emergency_switch SET enabled=true WHERE key='community'");
    const makePost=async(key:string,publish:boolean)=>{
      const draft=body<any>(await app!.inject({method:"POST",url:"/v1/me/ugc/posts",headers:{...authorAuth,"idempotency-key":`native-${key}-0001`},payload:{}}),"UGC_CREATE");
      const saved=body<any>(await app!.inject({method:"PUT",url:`/v1/me/ugc/posts/${draft.id}/draft`,headers:authorAuth,
        payload:{expectedVersion:draft.version,title:`合成护理故事 · ${key}`,body:"仅用于本轮隔离原生验收。记录护理步骤与本人感受，不构成商品功效或医疗承诺。",mediaIds:[],aiUsage:"none",rightsConfirmed:true,publicConsentConfirmed:true}}),"UGC_SAVE");
      const submitted=body<any>(await app!.inject({method:"POST",url:`/v1/me/ugc/posts/${draft.id}/submit`,headers:authorAuth,payload:{expectedVersion:saved.version}}),"UGC_SUBMIT");
      if(!publish)return submitted;
      const reviewed=body<any>(await app!.inject({method:"POST",url:`/v1/management/ugc/posts/${draft.id}/review`,headers:auth,payload:{expectedVersion:submitted.version,decision:"approve",reason:"本地合成文本验收",ruleVersion:"synthetic-native-v1"}}),"UGC_REVIEW");
      return body<any>(await app!.inject({method:"POST",url:`/v1/management/ugc/posts/${draft.id}/publish`,headers:publisherAuth,payload:{expectedVersion:reviewed.version}}),"UGC_PUBLISH");
    };
    const published=await makePost("published",true),pending=await makePost("pending",false),deleted=await makePost("deleted",true);
    body(await app.inject({method:"DELETE",url:`/v1/me/ugc/posts/${deleted.id}`,headers:authorAuth,payload:{expectedVersion:deleted.version}}),"UGC_DELETE");
    communityRoutes.communityAuthor={path:"pages/community-author/index",query:`id=${author.memberId}`};
    communityRoutes.communityPost={path:"pages/community-post/index",query:`id=${published.id}`};
    communityRoutes.communityReview={path:"pages/community-review/index",query:`id=${pending.id}`};
    communityRoutes.communityDeleted={path:"pages/community-post/index",query:`id=${deleted.id}`};
  }

  const address = body<any>(await app.inject({
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

  const createdProduct = body<any>(await app.inject({
    method: "POST",
    url: "/v1/management/catalog/products",
    headers: { ...auth, "idempotency-key": "acceptance-product-0001" },
    payload: {
      code: "synthetic-acceptance-serum",
      name: "合成验收护理精华",
      subtitle: "仅用于本地健康态与订单链路验收",
      description: "本商品、价格、库存和订单均为隔离测试数据，不代表真实销售承诺。",
      imagePath: "/assets/cisme/community-card-purple-bottle-v1.jpg",
      sourceKind: "synthetic_test",
      sku: { code: "SYNTH_ACCEPTANCE_30", label: "合成 30ml", priceCents: 26900 }
    }
  }), "PRODUCT_CREATE");
  const qualifiedProduct = body<any>(await app.inject({
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
  const publishedProduct = body<any>(await app.inject({
    method: "POST",
    url: `/v1/management/catalog/products/${createdProduct.productId}/publication`,
    headers: { ...auth, "idempotency-key": "acceptance-product-publish-0001" },
    payload: { expectedVersion: qualifiedProduct.version, action: "publish", reason: "Isolated local acceptance fixture" }
  }), "PRODUCT_PUBLISH");
  const sku = publishedProduct.variants[0];
  body(await app.inject({
    method: "POST",
    url: `/v1/management/catalog/skus/${sku.id}/inventory-adjustments`,
    headers: { ...auth, "idempotency-key": "acceptance-inventory-0001" },
    payload: { expectedVersion: sku.inventoryVersion, delta: 20, reason: "Synthetic acceptance inventory" }
  }), "INVENTORY");

  const quote = body<any>(await app.inject({
    method: "POST",
    url: "/v1/me/commerce/quotes",
    headers: { ...auth, "idempotency-key": "acceptance-quote-pending-0001" },
    payload: { skuId: sku.id, quantity: 2, addressId: address.id, addressVersion: address.version }
  }), "QUOTE_PENDING");
  const pendingOrder = body<any>(await app.inject({
    method: "POST",
    url: "/v1/me/orders",
    headers: { ...auth, "idempotency-key": "acceptance-order-pending-0001" },
    payload: { quoteId: quote.id }
  }), "ORDER_PENDING");

  const paidFixture = syntheticFulfillment ? await nativeFulfillmentFixture(pool,config,pendingOrder.id) : null;
  let recoveryFixture:null|{id:string;number:string;paymentEvidence:string}=null;
  if(syntheticFulfillment){
    recoveryFixture=await nativeFulfillmentFixture(pool,config,pendingOrder.id);
    const failed=fulfillmentRuntime(config,pool,{query:async()=>{throw Error('Synthetic provider outage');},uploadOnce:async()=>{throw Error('Synthetic upload forbidden');}})!;
    const version=(await pool.query('SELECT version FROM commerce_order WHERE id=$1',[recoveryFixture.id])).rows[0].version;
    const serverTime=(await pool.query('SELECT clock_timestamp() time')).rows[0].time.toISOString();
    const shipment=await failed.service.dispatch(identity.memberId,recoveryFixture.id,'synthetic-recovery-dispatch',{
      carrierCode:'SF',carrierName:'合成承运商',trackingNumber:'SYNTHETICRECOVERY01',shippedAt:serverTime,evidenceReference:'synthetic-recovery-proof',expectedOrderVersion:version});
    const job=(await pool.query('SELECT shipping_sync_id FROM commerce_shipment WHERE id=$1',[shipment.id])).rows[0].shipping_sync_id;
    for(let attempt=0;attempt<5;attempt++){
      await pool.query("UPDATE commerce_shipping_sync SET next_attempt_at=clock_timestamp()-interval '1 second' WHERE id=$1",[job]);
      await failed.sync.processOne(job);
    }
  }


  const cancelledQuote = body<any>(await app.inject({
    method: "POST",
    url: "/v1/me/commerce/quotes",
    headers: { ...auth, "idempotency-key": "acceptance-quote-cancelled-0001" },
    payload: { skuId: sku.id, quantity: 1, addressId: address.id, addressVersion: address.version }
  }), "QUOTE_CANCELLED");
  const cancellableOrder = body<any>(await app.inject({
    method: "POST",
    url: "/v1/me/orders",
    headers: { ...auth, "idempotency-key": "acceptance-order-cancelled-0001" },
    payload: { quoteId: cancelledQuote.id }
  }), "ORDER_CANCELLED_CREATE");
  const cancelledOrder = body<any>(await app.inject({
    method: "POST",
    url: `/v1/me/orders/${cancellableOrder.id}/cancel`,
    headers: { ...auth, "idempotency-key": "acceptance-order-cancel-0001" },
    payload: { expectedVersion: cancellableOrder.version, reason: "合成本地验收取消" }
  }), "ORDER_CANCEL");

  const supportMessage = body<any>(await app.inject({
    method: "POST",
    url: "/v1/me/support/messages",
    headers: auth,
    payload: { body: "这是一条本地合成验收消息，用于确认客服列表、详情与人工接管界面健康。", clientMessageId: "acceptance-support-message-0001" }
  }), "SUPPORT_MESSAGE");
  const claimedConversation = body<any>(await app.inject({
    method: "POST",
    url: `/v1/management/support/conversations/${supportMessage.conversation.id}/claim`,
    headers: auth,
    payload: { expectedVersion: supportMessage.conversation.version }
  }), "SUPPORT_CLAIM");

  const enrollment = body<any>(await app.inject({
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
  const activeCycle = body<any>(await app.inject({
    method: "POST",
    url: `/v1/care-cycles/${enrollment.cycle.id}/activate`,
    headers: { ...auth, "idempotency-key": "acceptance-care-activate-0001", "x-dev-clock": "2026-09-01T10:00:00+08:00" },
    payload: { expectedVersion: enrollment.cycle.version }
  }), "CARE_ACTIVATE");
  const d1 = body<any>(await app.inject({
    method: "POST",
    url: `/v1/care-cycles/${enrollment.cycle.id}/milestones/D1/complete`,
    headers: { ...auth, "idempotency-key": "acceptance-care-d1-0001", "x-dev-clock": "2026-09-01T10:10:00+08:00" },
    payload: { expectedVersion: activeCycle.version, stepCodes: ["00", "01", "02", "03"], selfAssessment: "comfortable" }
  }), "CARE_D1");
  const d7 = body<any>(await app.inject({
    method: "POST",
    url: `/v1/care-cycles/${enrollment.cycle.id}/milestones/D7/complete`,
    headers: { ...auth, "idempotency-key": "acceptance-care-d7-0001", "x-dev-clock": "2026-09-07T10:10:00+08:00" },
    payload: { expectedVersion: d1.cycle.version, stepCodes: ["00", "01", "02", "03"], selfAssessment: "comfortable" }
  }), "CARE_D7");
  const claim = body<any>(await app.inject({
    method: "POST",
    url: `/v1/tasks/${d7.task.id}/claim`,
    headers: { ...auth, "idempotency-key": "acceptance-task-claim-0001", "x-dev-clock": "2026-09-07T10:15:00+08:00" }
  }), "TASK_CLAIM");
  body(await app.inject({
    method: "PUT",
    url: `/v1/submissions/${claim.submissionId}/draft`,
    headers: auth,
    payload: {
      postUrl: "https://example.invalid/cisme-local-acceptance",
      platformAccount: "synthetic_acceptance",
      disclosure: "本地合成验收内容，不代表真实投稿。",
      license: { content_storage: true, human_review: true, feed_readonly: false },
      expectedVersion: 1
    }
  }), "SUBMISSION_DRAFT");
  const share = body<any>(await app.inject({
    method: "POST",
    url: "/v1/shares",
    headers: { ...auth, "idempotency-key": "acceptance-share-invite-0001", "x-dev-clock": "2026-09-11T12:00:00+08:00" },
    payload: { targetType: "invite", targetRef: "home" }
  }), "SHARE");

  const protectedChecks = [
    "/v1/bootstrap/home",
    "/v1/bootstrap/profile",
    "/v1/me/addresses",
    "/v1/me/orders",
    "/v1/management/commerce/orders",
    "/v1/management/catalog/products",
    "/v1/management/support/conversations"
  ];
  for (const path of protectedChecks) body(await app.inject({ method: "GET", url: path, headers: auth }), `CHECK_${path}`);
  const orderStatus = body<any>(await app.inject({ method: "GET", url: "/v1/commerce/orders/status" }), "CHECK_ORDER_STATUS");
  if (!orderStatus.orderFlowEnabled || orderStatus.paymentAvailable !== false) fail("ORDER_BOUNDARY_INVALID");

  const databaseState = (await pool.query(`SELECT
    current_database() AS database,
    count(*)::int AS migration_count,
    max(version) AS latest_migration
    FROM schema_migration`)).rows[0];
  const migrationFiles=(await readdir(resolve(process.cwd(),"db/migrations"))).filter(name=>name.endsWith(".sql")).sort();
  if (databaseState.migration_count !== migrationFiles.length || databaseState.latest_migration !== migrationFiles.at(-1)) fail("SCHEMA_VERSION_INVALID");

  const fixture = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    scope: "local_devtools_synthetic_nonproduction",
    origin: `http://${acceptanceHost}:${acceptancePort}`,
    database: { name: databaseState.database, migrationCount: databaseState.migration_count, latestMigration: databaseState.latest_migration },
    developmentIdentity: { externalUserId },
    routes: {
      ...communityRoutes,
      ...(paidFixture?{managementPaidOrder:{path:"pages/management-order-detail/index",query:`id=${paidFixture.id}`}}:{}),
      managementMember: { path: "pages/management-member/index", query: `id=${identity.memberId}` },
      product: { path: "pages/product/index", query: `id=${createdProduct.code}` },
      checkout: { path: "pages/checkout/index", query: `product=${createdProduct.code}&sku=${sku.id}&quantity=1` },
      task: { path: "pages/task/index", query: `id=${d7.task.id}` },
      submit: { path: "pages/submit/index", query: `id=${claim.submissionId}` },
      progress: { path: "pages/progress/index", query: `id=${claim.submissionId}` },
      orderDetail: { path: "pages/order-detail/index", query: `id=${pendingOrder.id}` },
      managementProduct: { path: "pages/management-product/index", query: `id=${createdProduct.productId}` },
      managementOrderDetail: { path: "pages/management-order-detail/index", query: `id=${pendingOrder.id}` },
      managementSupportChat: { path: "pages/management-support-chat/index", query: `id=${supportMessage.conversation.id}` },
      post: { path: "pages/post/index", query: "id=brand-scalp-ritual" },
      legal: { path: "pages/legal/index", query: "type=privacy" }
    },
    facts: {
      pendingOrderId: pendingOrder.id,
      ...(paidFixture?{paidFixture}:{}),
      ...(recoveryFixture?{recoveryFixture}:{}),
      cancelledOrderId: cancelledOrder.id,
      productId: createdProduct.productId,
      productCode: createdProduct.code,
      skuId: sku.id,
      addressId: address.id,
      supportConversationId: claimedConversation.id,
      careCycleId: enrollment.cycle.id,
      taskId: d7.task.id,
      submissionId: claim.submissionId,
      shareId: share.shareId
    },
    assertions: {
      protectedReadCount: protectedChecks.length,
      orderFlowEnabled: true,
      paymentAvailable: false,
      credentialsOrTokensPersisted: false
    }
  };
  await mkdir(outputDirectory, { recursive: true });
  await writeFile(fixturePath, `${JSON.stringify(fixture, null, 2)}\n`, { mode: 0o600 });
  return fixture;
}

async function close(): Promise<void> {
  const current = app;
  app = null;
  if (current) await current.close();
  await pool.end();
}

try {
  const fixture = await seedFixtures();
  await app!.listen({ port: acceptancePort, host: acceptanceHost });
  console.log(JSON.stringify({
    event: "CISME_MINIPROGRAM_ACCEPTANCE_READY",
    origin: fixture.origin,
    database: fixture.database,
    fixturePath,
    externalUserId,
    pid: process.pid
  }));
  const stop = () => void close().finally(() => process.exit(0));
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
} catch (error) {
  await close().catch(() => undefined);
  throw error;
}
