import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import type { FastifyInstance } from "fastify";
import { loadConfig } from "@cisme/config";
import { TEST_DATABASE_URL, resetDatabase, testPool } from "@cisme/testkit";
import { createApp } from "../../services/api/src/server";
import { expirePendingOrders } from "../../services/api/src/commerceOrders";
import { createApiGatewayStorage } from "../../services/api/src/storage";

const pool = testPool();
const config = loadConfig({
  APP_ENV: "test", DATABASE_URL: TEST_DATABASE_URL, APP_SESSION_SECRET: "commerce-order-session",
  ADMIN_API_TOKEN: "legacy-admin", UPLOAD_TOKEN_SECRET: "commerce-order-upload", OBJECT_STORAGE_DRIVER: "api_gateway",
  CONTACT_ENCRYPTION_KEY: "11".repeat(32), CONTACT_HASH_KEY: "22".repeat(32), CONTACT_KEY_VERSION: "order-test-v1",
  COMMERCE_ORDER_FLOW_ENABLED: "true", COMMERCE_QUOTE_TTL_MINUTES: "10", COMMERCE_PENDING_ORDER_TTL_MINUTES: "30"
});
let app: FastifyInstance;
let operator: any;
let buyerA: any;
let buyerB: any;
let product: any;

const auth = (token: string) => ({ authorization: `Bearer ${token}` });
const identity = async (name: string) => (await app.inject({ method: "POST", url: "/v1/identity/dev", payload: {
  externalUserId: name, displayName: name, consents: [{ documentType: "privacy", version: "v1" }, { documentType: "terms", version: "v1" }]
} })).json();
const address = async (person: any, suffix: string) => {
  const response = await app.inject({ method: "POST", url: "/v1/me/addresses", headers: { ...auth(person.sessionToken), "idempotency-key": `address-${suffix}-0001` }, payload: {
    recipientName: `合成收货人${suffix}`, phone: `1380000${suffix.padStart(4, "0")}`, province: "上海市", city: "上海市", district: "浦东新区",
    detail: `合成测试路 ${suffix} 号`, postalCode: "200000", nationalCode: "310115", provinceCode: "310000", cityCode: "310100", districtCode: "310115",
    label: "home", isDefault: true
  } });
  expect(response.statusCode).toBe(200);
  return response.json();
};
const quote = (person: any, targetAddress: any, key: string, quantity = 1) => app.inject({ method: "POST", url: "/v1/me/commerce/quotes",
  headers: { ...auth(person.sessionToken), "idempotency-key": key }, payload: { skuId: product.variants[0].id, quantity, addressId: targetAddress.id, addressVersion: targetAddress.version } });
const createOrder = (person: any, quoteId: string, key: string) => app.inject({ method: "POST", url: "/v1/me/orders",
  headers: { ...auth(person.sessionToken), "idempotency-key": key }, payload: { quoteId } });

beforeAll(async () => {
  await resetDatabase(pool);
  app = await createApp({ config, pool, storage: createApiGatewayStorage(config) });
  operator = await identity("order-operator"); buyerA = await identity("order-buyer-a"); buyerB = await identity("order-buyer-b");
  for (const capability of ["commerce.product.manage", "commerce.qualification.manage", "commerce.inventory.manage", "commerce.order.read"]) {
    await pool.query(`INSERT INTO authority_grant(member_id,capability,granted_by,grant_reason,environment,grant_source)
      VALUES($1,$2,'fixture','R4-B order integration','test','integration_fixture')`, [operator.memberId, capability]);
  }
  const payload = { code: "synthetic-r4b-order", name: "合成订单验证商品", subtitle: "仅用于隔离订单域验证", description: "无真实销售或支付含义。",
    imagePath: "/assets/cisme/community-card-purple-bottle-v1.jpg", sourceKind: "synthetic_test", sku: { code: "SYNTH_R4B_ORDER", label: "合成规格", priceCents: 12345 } };
  const created = (await app.inject({ method: "POST", url: "/v1/management/catalog/products", headers: { ...auth(operator.sessionToken), "idempotency-key": "r4b-product-create-01" }, payload })).json();
  const qualified = (await app.inject({ method: "POST", url: `/v1/management/catalog/products/${created.productId}/qualification`, headers: { ...auth(operator.sessionToken), "idempotency-key": "r4b-product-qualify-01" },
    payload: { expectedVersion: created.version, status: "eligible", reason: "Synthetic order integration", evidenceRef: "fixture://r4b-order/eligible-v1" } })).json();
  const published = (await app.inject({ method: "POST", url: `/v1/management/catalog/products/${created.productId}/publication`, headers: { ...auth(operator.sessionToken), "idempotency-key": "r4b-product-publish-01" },
    payload: { expectedVersion: qualified.version, action: "publish", reason: "Synthetic order integration" } })).json();
  const sku = published.variants[0];
  await app.inject({ method: "POST", url: `/v1/management/catalog/skus/${sku.id}/inventory-adjustments`, headers: { ...auth(operator.sessionToken), "idempotency-key": "r4b-stock-add-001" },
    payload: { expectedVersion: sku.inventoryVersion, delta: 4, reason: "Synthetic order inventory" } });
  product = (await app.inject({ method: "GET", url: `/v1/catalog/${created.code}` })).json();
});

afterAll(async () => { await app.close(); await pool.end(); });

describe("R4-B isolated pending-payment order flow", () => {
  it("quotes server-authoritative CNY totals and rejects idempotency-key drift", async () => {
    expect((await app.inject({ method: "GET", url: "/v1/commerce/orders/status" })).json()).toMatchObject({ orderFlowEnabled: true, paymentAvailable: false, paymentOnboarding: "IN_PROGRESS", scope: "synthetic_nonproduction" });
    expect(product).toMatchObject({ purchaseEnabled: true, sellability: "purchasable" });
    const target = await address(buyerA, "1001");
    const first = await quote(buyerA, target, "quote-idem-buyer-a-01", 2);
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ currency: "CNY", quantity: 2, unitPriceCents: 12345, subtotalCents: 24690, memberDiscountCents: 0, shippingCents: 0, totalCents: 24690, paymentAvailable: false });
    const replay = await quote(buyerA, target, "quote-idem-buyer-a-01", 2);
    expect(replay.json()).toMatchObject({ id: first.json().id, totalCents: 24690 });
    const conflict = await quote(buyerA, target, "quote-idem-buyer-a-01", 1);
    expect(conflict.statusCode).toBe(409); expect(conflict.json().code).toBe("IDEMPOTENCY_CONFLICT");
  });

  it("creates one immutable order, redacts management address, and releases once on cancel", async () => {
    const target = (await app.inject({ method: "GET", url: "/v1/me/addresses", headers: auth(buyerA.sessionToken) })).json().addresses[0];
    const quoted = (await quote(buyerA, target, "quote-create-buyer-a-01", 1)).json();
    const created = await createOrder(buyerA, quoted.id, "order-create-buyer-a-01");
    expect(created.statusCode).toBe(200);
    expect(created.json()).toMatchObject({ status: "pending_payment", currency: "CNY", totalCents: 12345, paymentAvailable: false, address: { recipientName: "合成收货人1001", phone: "13800001001" } });
    const replay = await createOrder(buyerA, quoted.id, "order-create-buyer-a-01");
    expect(replay.json().id).toBe(created.json().id);
    const secondKey = await createOrder(buyerA, quoted.id, "order-create-buyer-a-02");
    expect(secondKey.json().id).toBe(created.json().id);
    expect((await pool.query("SELECT reserved_quantity FROM catalog_inventory_level WHERE sku_id=$1", [product.variants[0].id])).rows[0].reserved_quantity).toBe(1);

    const management = await app.inject({ method: "GET", url: `/v1/management/commerce/orders/${created.json().id}`, headers: auth(operator.sessionToken) });
    expect(management.statusCode).toBe(200);
    expect(management.json().address).toEqual({ recipientNameMasked: "合**", phoneMasked: "****1001", province: "上海市", city: "上海市", district: "浦东新区" });
    expect(JSON.stringify(management.json())).not.toContain("合成测试路");
    expect((await app.inject({ method: "GET", url: `/v1/me/orders/${created.json().id}`, headers: auth(buyerB.sessionToken) })).statusCode).toBe(404);

    const latestInventory = (await app.inject({ method: "GET", url: `/v1/management/catalog/products/${product.productId}`, headers: auth(operator.sessionToken) })).json().variants[0];
    const belowReserved = await app.inject({ method: "POST", url: `/v1/management/catalog/skus/${latestInventory.id}/inventory-adjustments`, headers: { ...auth(operator.sessionToken), "idempotency-key": "r4b-stock-below-reserved" },
      payload: { expectedVersion: latestInventory.inventoryVersion, delta: -latestInventory.stockOnHand, reason: "Reserved floor test" } });
    expect(belowReserved.statusCode).toBe(409); expect(belowReserved.json().code).toBe("INVENTORY_RESERVED_QUANTITY_CONFLICT");

    const cancelled = await app.inject({ method: "POST", url: `/v1/me/orders/${created.json().id}/cancel`, headers: { ...auth(buyerA.sessionToken), "idempotency-key": "order-cancel-buyer-a-01" },
      payload: { expectedVersion: created.json().version, reason: "合成测试取消" } });
    expect(cancelled.statusCode).toBe(200); expect(cancelled.json()).toMatchObject({ status: "cancelled", version: 2 });
    const cancelReplay = await app.inject({ method: "POST", url: `/v1/me/orders/${created.json().id}/cancel`, headers: { ...auth(buyerA.sessionToken), "idempotency-key": "order-cancel-buyer-a-01" },
      payload: { expectedVersion: created.json().version, reason: "合成测试取消" } });
    expect(cancelReplay.json()).toMatchObject({ status: "cancelled", version: 2 });
    expect((await pool.query("SELECT reserved_quantity FROM catalog_inventory_level WHERE sku_id=$1", [product.variants[0].id])).rows[0].reserved_quantity).toBe(0);
    expect((await pool.query("SELECT count(*)::int count FROM commerce_order_transition WHERE order_id=$1", [created.json().id])).rows[0].count).toBe(2);
  });

  it("rejects stale address and price facts before reserving inventory", async () => {
    const target = await address(buyerB, "1002");
    const addressQuote = (await quote(buyerB, target, "quote-address-stale-01", 1)).json();
    const updated = await app.inject({ method: "PUT", url: `/v1/me/addresses/${target.id}`, headers: auth(buyerB.sessionToken), payload: { ...target, detail: "合成测试路 1002 号更新", expectedVersion: target.version } });
    expect(updated.statusCode).toBe(200);
    const staleAddress = await createOrder(buyerB, addressQuote.id, "order-address-stale-01");
    expect(staleAddress.statusCode).toBe(409); expect(staleAddress.json().code).toBe("DELIVERY_ADDRESS_CHANGED");

    const fresh = updated.json();
    const priceQuote = (await quote(buyerB, fresh, "quote-price-stale-01", 1)).json();
    const managed = (await app.inject({ method: "GET", url: `/v1/management/catalog/products/${product.productId}`, headers: auth(operator.sessionToken) })).json();
    const sku = managed.variants[0];
    const changed = await app.inject({ method: "PUT", url: `/v1/management/catalog/products/${managed.productId}`, headers: { ...auth(operator.sessionToken), "idempotency-key": "r4b-price-change-001" }, payload: {
      name: managed.name, subtitle: managed.subtitle, description: managed.description, imagePath: managed.image, expectedVersion: managed.version,
      sku: { id: sku.id, expectedVersion: sku.version, expectedPriceVersion: sku.priceVersion, code: sku.code, label: sku.label, priceCents: 12346, active: true }
    } });
    expect(changed.statusCode).toBe(200);
    const stalePrice = await createOrder(buyerB, priceQuote.id, "order-price-stale-01");
    expect(stalePrice.statusCode).toBe(409); expect(stalePrice.json().code).toBe("QUOTE_STALE");
  });

  it("expires pending orders exactly once and keeps event payloads free of address PII", async () => {
    const target = (await app.inject({ method: "GET", url: "/v1/me/addresses", headers: auth(buyerB.sessionToken) })).json().addresses[0];
    product = (await app.inject({ method: "GET", url: "/v1/catalog/synthetic-r4b-order" })).json();
    const quoted = (await quote(buyerB, target, "quote-expiry-buyer-b-01", 1)).json();
    const created = await createOrder(buyerB, quoted.id, "order-expiry-buyer-b-01");
    expect(created.statusCode).toBe(200);
    const future = new Date(Date.now() + 31 * 60_000);
    expect(await expirePendingOrders(pool, future, 50)).toBe(1);
    expect(await expirePendingOrders(pool, future, 50)).toBe(0);
    const detail = await app.inject({ method: "GET", url: `/v1/me/orders/${created.json().id}`, headers: auth(buyerB.sessionToken) });
    expect(detail.json()).toMatchObject({ status: "expired", version: 2, terminalReason: "PAYMENT_WINDOW_EXPIRED" });
    expect((await pool.query("SELECT reserved_quantity FROM catalog_inventory_level WHERE sku_id=$1", [product.variants[0].id])).rows[0].reserved_quantity).toBe(0);
    const events = await pool.query<{ payload: unknown }>("SELECT payload FROM outbox_event WHERE aggregate_id=$1", [created.json().id]);
    const serialized = JSON.stringify(events.rows);
    expect(serialized).not.toContain("13800001002"); expect(serialized).not.toContain("合成测试路"); expect(events.rowCount).toBe(2);
  });

  it("allows only one buyer to reserve the last available unit", async () => {
    const managed = (await app.inject({ method: "GET", url: `/v1/management/catalog/products/${product.productId}`, headers: auth(operator.sessionToken) })).json();
    const sku = managed.variants[0];
    const toOne = 1 - sku.stockOnHand;
    if (toOne !== 0) {
      const adjusted = await app.inject({ method: "POST", url: `/v1/management/catalog/skus/${sku.id}/inventory-adjustments`, headers: { ...auth(operator.sessionToken), "idempotency-key": "r4b-last-unit-setup" },
        payload: { expectedVersion: sku.inventoryVersion, delta: toOne, reason: "Last unit concurrency setup" } });
      expect(adjusted.statusCode).toBe(200);
    }
    const [addressA, addressB] = await Promise.all([
      app.inject({ method: "GET", url: "/v1/me/addresses", headers: auth(buyerA.sessionToken) }),
      app.inject({ method: "GET", url: "/v1/me/addresses", headers: auth(buyerB.sessionToken) })
    ]);
    product = (await app.inject({ method: "GET", url: "/v1/catalog/synthetic-r4b-order" })).json();
    const [quoteA, quoteB] = await Promise.all([
      quote(buyerA, addressA.json().addresses[0], "quote-last-unit-a-01", 1),
      quote(buyerB, addressB.json().addresses[0], "quote-last-unit-b-01", 1)
    ]);
    expect([quoteA.statusCode, quoteB.statusCode]).toEqual([200, 200]);
    const attempts = await Promise.all([
      createOrder(buyerA, quoteA.json().id, "order-last-unit-a-01"),
      createOrder(buyerB, quoteB.json().id, "order-last-unit-b-01")
    ]);
    expect(attempts.map((result) => result.statusCode).sort()).toEqual([200, 409]);
    expect(attempts.find((result) => result.statusCode === 409)?.json().code).toBe("INVENTORY_NOT_AVAILABLE");
    expect((await pool.query("SELECT reserved_quantity FROM catalog_inventory_level WHERE sku_id=$1", [product.variants[0].id])).rows[0].reserved_quantity).toBe(1);
  });

  it("refuses a destructive schema-34 rollback once order facts exist", async () => {
    const migration = await readFile("db/migrations/202609110007_commerce_pending_order.sql", "utf8");
    const down = migration.split("-- migrate:down")[1]!;
    await expect(pool.query(down)).rejects.toThrow("COMMERCE_ORDER_ROLLBACK_REQUIRES_DATA_PRESERVATION");
    expect((await pool.query("SELECT to_regclass('public.commerce_order') name")).rows[0].name).toBe("commerce_order");
  });
});
