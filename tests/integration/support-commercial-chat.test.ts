import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { loadConfig } from "@cisme/config";
import { TEST_DATABASE_URL, resetDatabase, testPool } from "@cisme/testkit";
import { createApp } from "../../services/api/src/server";
import { createApiGatewayStorage } from "../../services/api/src/storage";

const pool = testPool();
const config = loadConfig({
  APP_ENV: "test", DATABASE_URL: TEST_DATABASE_URL, APP_SESSION_SECRET: "commercial-chat-session",
  ADMIN_API_TOKEN: "commercial-chat-admin", UPLOAD_TOKEN_SECRET: "commercial-chat-upload", OBJECT_STORAGE_DRIVER: "api_gateway",
  CONTACT_ENCRYPTION_KEY: "33".repeat(32), CONTACT_HASH_KEY: "44".repeat(32), CONTACT_KEY_VERSION: "commercial-chat-v1",
  COMMERCE_ORDER_FLOW_ENABLED: "true"
});
let app: FastifyInstance;
let member: any;
let other: any;
let operator: any;
let observer: any;
let conversationId = "";
let memberMessageSequence = 0;
let ownedOrder: any;
let otherOrder: any;
const storedObjectKeys: string[] = [];
const auth = (token: string) => ({ authorization: `Bearer ${token}` });
const identity = async (name: string) => (await app.inject({ method: "POST", url: "/v1/identity/dev", payload: {
  externalUserId: name, displayName: name, consents: [{ documentType: "privacy", version: "v1" }, { documentType: "terms", version: "v1" }]
} })).json();

async function createSyntheticOrders() {
  const productPayload = { code: "synthetic-chat-order", name: "客服订单卡片验证商品", subtitle: "仅用于隔离验证", description: "无真实销售或支付含义。",
    imagePath: "/assets/cisme/community-card-purple-bottle-v1.jpg", sourceKind: "synthetic_test", sku: { code: "SYNTH_CHAT_ORDER", label: "合成规格", priceCents: 23900 } };
  const created = (await app.inject({ method: "POST", url: "/v1/management/catalog/products", headers: { ...auth(operator.sessionToken), "idempotency-key": "chat-product-create-01" }, payload: productPayload })).json();
  const qualified = (await app.inject({ method: "POST", url: `/v1/management/catalog/products/${created.productId}/qualification`, headers: { ...auth(operator.sessionToken), "idempotency-key": "chat-product-qualify-01" }, payload: { expectedVersion: created.version, status: "eligible", reason: "Synthetic support card", evidenceRef: "fixture://support/order-card" } })).json();
  const published = (await app.inject({ method: "POST", url: `/v1/management/catalog/products/${created.productId}/publication`, headers: { ...auth(operator.sessionToken), "idempotency-key": "chat-product-publish-01" }, payload: { expectedVersion: qualified.version, action: "publish", reason: "Synthetic support card" } })).json();
  await app.inject({ method: "POST", url: `/v1/management/catalog/skus/${published.variants[0].id}/inventory-adjustments`, headers: { ...auth(operator.sessionToken), "idempotency-key": "chat-stock-add-01" }, payload: { expectedVersion: published.variants[0].inventoryVersion, delta: 3, reason: "Synthetic support card" } });
  const product = (await app.inject({ method: "GET", url: `/v1/catalog/${created.code}` })).json();
  const makeOrder = async (buyer: any, suffix: string) => {
    const address = (await app.inject({ method: "POST", url: "/v1/me/addresses", headers: { ...auth(buyer.sessionToken), "idempotency-key": `chat-address-${suffix}` }, payload: {
      recipientName: `合成会员${suffix}`, phone: `1380000${suffix}`, province: "上海市", city: "上海市", district: "浦东新区", detail: `测试路 ${suffix} 号`, postalCode: "200000", nationalCode: "310115", label: "home", isDefault: true
    } })).json();
    const quote = (await app.inject({ method: "POST", url: "/v1/me/commerce/quotes", headers: { ...auth(buyer.sessionToken), "idempotency-key": `chat-quote-${suffix}` }, payload: { skuId: product.variants[0].id, quantity: 1, addressId: address.id, addressVersion: address.version } })).json();
    return (await app.inject({ method: "POST", url: "/v1/me/orders", headers: { ...auth(buyer.sessionToken), "idempotency-key": `chat-order-${suffix}` }, payload: { quoteId: quote.id } })).json();
  };
  ownedOrder = await makeOrder(member, "1001");
  otherOrder = await makeOrder(other, "1002");
}

beforeAll(async () => {
  await resetDatabase(pool);
  const storage = createApiGatewayStorage(config);
  await storage.ensureReady();
  app = await createApp({ config, pool, storage });
  [member, other, operator, observer] = await Promise.all(["chat-member", "chat-other", "chat-operator", "chat-observer"].map(identity));
  for (const capability of ["support.read", "support.reply", "support.assign", "commerce.product.manage", "commerce.qualification.manage", "commerce.inventory.manage", "commerce.order.read"]) {
    await pool.query(`INSERT INTO authority_grant(member_id,capability,granted_by,grant_reason,environment,grant_source)
      VALUES($1,$2,'fixture','Commercial chat integration','test','integration_fixture')`, [operator.memberId, capability]);
  }
  await pool.query(`INSERT INTO authority_grant(member_id,capability,granted_by,grant_reason,environment,grant_source)
    VALUES($1,'support.read','fixture','Commercial chat observer','test','integration_fixture')`, [observer.memberId]);
  await pool.query("INSERT INTO support_operator_profile(principal_id,display_name) VALUES($1,'小熹')", [operator.principalId]);
  await createSyntheticOrders();
});

afterAll(async () => {
  const storage = createApiGatewayStorage(config);
  for (const key of storedObjectKeys) await storage.delete(key);
  await app.close();
  await pool.end();
});

describe.sequential("commercial support conversation facts", () => {
  it("creates a real handoff system event and never equates assignment with online presence", async () => {
    const sent = await app.inject({ method: "POST", url: "/v1/me/support/messages", headers: auth(member.sessionToken), payload: { body: "我想咨询订单", clientMessageId: "commercial-member-0001" } });
    expect(sent.statusCode).toBe(200);
    conversationId = sent.json().conversation.id;
    memberMessageSequence = sent.json().message.sequence;
    const claim = await app.inject({ method: "POST", url: `/v1/management/support/conversations/${conversationId}/claim`, headers: auth(operator.sessionToken), payload: { expectedVersion: sent.json().conversation.version } });
    expect(claim.statusCode).toBe(200);

    const page = (await app.inject({ method: "GET", url: "/v1/me/support/messages", headers: auth(member.sessionToken) })).json();
    expect(page.messages.map((message: any) => [message.senderType, message.contentType, message.body])).toContainEqual(["system", "system", "已为你接入人工客服"]);
    expect(page.presence).toMatchObject({ operatorOnline: false, operatorTyping: false, agentDisplayName: "小熹" });
  });

  it("uses short-lived, explicit presence and typing facts", async () => {
    const touched = await app.inject({ method: "POST", url: `/v1/management/support/conversations/${conversationId}/presence`, headers: auth(operator.sessionToken), payload: { online: true, typing: true } });
    expect(touched.statusCode).toBe(200);
    const active = (await app.inject({ method: "GET", url: "/v1/me/support/messages", headers: auth(member.sessionToken) })).json();
    expect(active.presence).toMatchObject({ operatorOnline: true, operatorTyping: true, agentDisplayName: "小熹" });

    const unrelatedStop = await app.inject({ method: "POST", url: `/v1/management/support/conversations/${conversationId}/presence`, headers: auth(observer.sessionToken), payload: { online: false, typing: false } });
    expect(unrelatedStop.statusCode).toBe(200);
    expect(unrelatedStop.json().accepted).toBe(false);
    const stillActive = (await app.inject({ method: "GET", url: "/v1/me/support/messages", headers: auth(member.sessionToken) })).json();
    expect(stillActive.presence).toMatchObject({ operatorOnline: true, operatorTyping: true, agentDisplayName: "小熹" });

    await pool.query("UPDATE support_presence SET online_expires_at=now()-interval '1 second',typing_expires_at=now()-interval '1 second' WHERE conversation_id=$1 AND actor_type='operator'", [conversationId]);
    const expired = (await app.inject({ method: "GET", url: "/v1/me/support/messages", headers: auth(member.sessionToken) })).json();
    expect(expired.presence).toMatchObject({ operatorOnline: false, operatorTyping: false });
  });

  it("derives read receipts only from the opposite monotonic read cursor", async () => {
    let memberPage = (await app.inject({ method: "GET", url: "/v1/me/support/messages", headers: auth(member.sessionToken) })).json();
    expect(memberPage.messages.find((message: any) => message.sequence === memberMessageSequence).deliveryState).toBe("server_accepted");
    await app.inject({ method: "POST", url: `/v1/management/support/conversations/${conversationId}/read`, headers: auth(operator.sessionToken), payload: { lastSeenSequence: memberMessageSequence } });
    memberPage = (await app.inject({ method: "GET", url: "/v1/me/support/messages", headers: auth(member.sessionToken) })).json();
    expect(memberPage.messages.find((message: any) => message.sequence === memberMessageSequence).deliveryState).toBe("read");

    const reply = await app.inject({ method: "POST", url: `/v1/management/support/conversations/${conversationId}/messages`, headers: auth(operator.sessionToken), payload: { body: "您好，我已经看到您的问题。", clientMessageId: "commercial-agent-0001" } });
    expect(reply.json().message.deliveryState).toBe("server_accepted");
    await app.inject({ method: "POST", url: "/v1/me/support/read", headers: auth(member.sessionToken), payload: { lastSeenSequence: reply.json().message.sequence } });
    const operatorPage = (await app.inject({ method: "GET", url: `/v1/management/support/conversations/${conversationId}/messages`, headers: auth(operator.sessionToken) })).json();
    expect(operatorPage.messages.find((message: any) => message.id === reply.json().message.id).deliveryState).toBe("read");
  });

  it("stores a minimal owned order snapshot and rejects cross-member linking", async () => {
    const forbidden = await app.inject({ method: "POST", url: "/v1/me/support/messages", headers: auth(member.sessionToken), payload: { body: "", linkedOrderId: otherOrder.id, clientMessageId: "commercial-order-wrong" } });
    expect(forbidden.statusCode).toBe(404);

    const sent = await app.inject({ method: "POST", url: "/v1/me/support/messages", headers: auth(member.sessionToken), payload: { body: "请帮我看看这个订单", linkedOrderId: ownedOrder.id, clientMessageId: "commercial-order-owned" } });
    expect(sent.statusCode).toBe(200);
    expect(sent.json().message).toMatchObject({ contentType: "mixed", orderCard: { orderId: ownedOrder.id, orderNumberTail: ownedOrder.orderNumber.slice(-4), status: "pending_payment", totalCents: 23900, currency: "CNY", productName: "客服订单卡片验证商品" } });
    expect(JSON.stringify(sent.json().message)).not.toContain("测试路");
  });

  it("verifies up to three owned images before one immutable binding and serves them only through authenticated conversation access", async () => {
    expect((await app.inject({ method: "GET", url: "/v1/me/support/media/not-a-uuid", headers: auth(member.sessionToken) })).statusCode).toBe(422);
    expect((await app.inject({ method: "GET", url: `/v1/management/support/conversations/not-a-uuid/media/not-a-uuid`, headers: auth(operator.sessionToken) })).statusCode).toBe(422);
    const bytes = Buffer.from([0xff, 0xd8, 0xff, 0x00]);
    const authorizations: any[] = [];
    for (let index = 0; index < 3; index += 1) {
      const authorization = await app.inject({ method: "POST", url: "/v1/me/support/media/authorize", headers: auth(member.sessionToken), payload: { mimeType: "image/jpeg", maxBytes: 4 } });
      expect(authorization.statusCode).toBe(200);
      const body = authorization.json();
      authorizations.push(body);
      storedObjectKeys.push((await pool.query("SELECT object_key FROM media_object WHERE id=$1", [body.mediaId])).rows[0].object_key);
      expect((await app.inject({ method: "POST", url: `/v1/uploads/${body.mediaId}/chunks`, payload: { token: body.fields.token, index: 0, totalBytes: bytes.length, base64: bytes.toString("base64") } })).statusCode).toBe(200);
      expect((await app.inject({ method: "POST", url: `/v1/uploads/${body.mediaId}/assemble`, payload: { token: body.fields.token } })).statusCode).toBe(200);
      expect((await app.inject({ method: "POST", url: `/v1/me/support/media/${body.mediaId}/complete`, headers: auth(member.sessionToken) })).statusCode).toBe(200);
    }
    const mediaIds = authorizations.map((item) => item.mediaId);

    const crossMember = await app.inject({ method: "POST", url: "/v1/me/support/messages", headers: auth(other.sessionToken), payload: { body: "", mediaIds: [mediaIds[0]], clientMessageId: "commercial-media-wrong" } });
    expect(crossMember.statusCode).toBe(404);
    const sent = await app.inject({ method: "POST", url: "/v1/me/support/messages", headers: auth(member.sessionToken), payload: { body: "", mediaIds, clientMessageId: "commercial-media-owned" } });
    expect(sent.statusCode).toBe(200);
    expect(sent.json().message.contentType).toBe("image");
    expect(sent.json().message.attachments).toHaveLength(3);
    expect(sent.json().message.attachments.map((item: any) => item.id)).toEqual(mediaIds);
    expect(sent.json().message.attachments[0].previewPath).toBe(`/v1/me/support/media/${mediaIds[0]}`);

    expect((await app.inject({ method: "GET", url: `/v1/me/support/media/${mediaIds[0]}`, headers: auth(other.sessionToken) })).statusCode).toBe(404);
    const memberPreview = await app.inject({ method: "GET", url: `/v1/me/support/media/${mediaIds[0]}`, headers: auth(member.sessionToken) });
    expect(memberPreview.statusCode).toBe(200);
    expect(memberPreview.headers["content-type"]).toContain("image/jpeg");
    const operatorPreview = await app.inject({ method: "GET", url: `/v1/management/support/conversations/${conversationId}/media/${mediaIds[0]}`, headers: auth(operator.sessionToken) });
    expect(operatorPreview.statusCode).toBe(200);

    const replay = await app.inject({ method: "POST", url: "/v1/me/support/messages", headers: auth(member.sessionToken), payload: { body: "", mediaIds, clientMessageId: "commercial-media-owned" } });
    expect(replay.statusCode).toBe(200);
    expect(replay.json().message.id).toBe(sent.json().message.id);

    const removable = (await app.inject({ method: "POST", url: "/v1/me/support/media/authorize", headers: auth(member.sessionToken), payload: { mimeType: "image/jpeg", maxBytes: 4 } })).json();
    storedObjectKeys.push((await pool.query("SELECT object_key FROM media_object WHERE id=$1", [removable.mediaId])).rows[0].object_key);
    await pool.query("UPDATE emergency_switch SET enabled=false,reason='synthetic upload stop' WHERE key='uploads'");
    const removedWhileClosed = await app.inject({ method: "DELETE", url: `/v1/me/support/media/${removable.mediaId}`, headers: auth(member.sessionToken) });
    await pool.query("UPDATE emergency_switch SET enabled=true,reason='normal' WHERE key='uploads'");
    expect(removedWhileClosed.statusCode).toBe(200);
    expect(removedWhileClosed.json()).toMatchObject({ deleted: true, cleanupQueued: true });
  });
});
