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

const acceptancePort = 18_080;
const acceptanceHost = "127.0.0.1";
const externalUserId = "cisme-mini-acceptance-member";
const outputDirectory = resolve(process.cwd(), "tmp/miniprogram-acceptance");
const fixturePath = resolve(outputDirectory, "fixture.json");

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
  app = await createApp({ config, pool, storage });

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
