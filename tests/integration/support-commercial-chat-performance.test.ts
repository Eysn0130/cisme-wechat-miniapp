import { performance } from "node:perf_hooks";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { loadConfig } from "@cisme/config";
import { TEST_DATABASE_URL, resetDatabase, testPool } from "@cisme/testkit";
import { createApp } from "../../services/api/src/server";
import { createApiGatewayStorage } from "../../services/api/src/storage";

type Metric = { samples: number; p50Ms: number; p95Ms: number; p99Ms: number; maxMs: number };

const pool = testPool();
const config = loadConfig({ APP_ENV: "test", DATABASE_URL: TEST_DATABASE_URL, APP_SESSION_SECRET: "chat-performance-session",
  ADMIN_API_TOKEN: "chat-performance-admin", UPLOAD_TOKEN_SECRET: "chat-performance-upload", OBJECT_STORAGE_DRIVER: "api_gateway" });
const storage = createApiGatewayStorage(config);
let app: FastifyInstance;
let member: any;
let operator: any;
let conversationId = "";
let latestSequence = 0;
const objectKeys: string[] = [];
const auth = (token: string) => ({ authorization: `Bearer ${token}` });

function metric(values: number[]): Metric {
  const sorted = [...values].sort((a, b) => a - b);
  const pick = (percentile: number) => sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * percentile) - 1)] ?? 0;
  return { samples: sorted.length, p50Ms: Number(pick(.5).toFixed(2)), p95Ms: Number(pick(.95).toFixed(2)),
    p99Ms: Number(pick(.99).toFixed(2)), maxMs: Number((sorted.at(-1) ?? 0).toFixed(2)) };
}

async function timed<T>(operation: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const started = performance.now();
  const value = await operation();
  return { value, ms: performance.now() - started };
}

beforeAll(async () => {
  await resetDatabase(pool);
  await storage.ensureReady();
  app = await createApp({ config, pool, storage });
  const identity = async (name: string) => (await app.inject({ method: "POST", url: "/v1/identity/dev", payload: { externalUserId: name, displayName: name,
    consents: [{ documentType: "privacy", version: "v1" }, { documentType: "terms", version: "v1" }] } })).json();
  [member, operator] = await Promise.all([identity("chat-perf-member"), identity("chat-perf-operator")]);
  for (const capability of ["support.read", "support.reply", "support.assign"]) await pool.query(`INSERT INTO authority_grant
    (member_id,capability,granted_by,grant_reason,environment,grant_source) VALUES($1,$2,'fixture','Commercial chat performance','test','integration_fixture')`, [operator.memberId, capability]);
  for (let index = 0; index < 120; index += 1) {
    const sent = await app.inject({ method: "POST", url: "/v1/me/support/messages", headers: auth(member.sessionToken),
      payload: { body: `历史性能样本 ${index}`, clientMessageId: `chat-perf-seed-${index}` } });
    expect(sent.statusCode).toBe(200);
    conversationId = sent.json().conversation.id;
    latestSequence = sent.json().message.sequence;
  }
  const current = (await app.inject({ method: "GET", url: "/v1/me/support/summary", headers: auth(member.sessionToken) })).json().conversation;
  const claimed = await app.inject({ method: "POST", url: `/v1/management/support/conversations/${conversationId}/claim`, headers: auth(operator.sessionToken), payload: { expectedVersion: current.version } });
  expect(claimed.statusCode).toBe(200);
  latestSequence += 1;
}, 20_000);

afterAll(async () => {
  for (const key of objectKeys) await storage.delete(key);
  await app.close();
  await pool.end();
});

it("records bounded local API latency percentiles for commercial chat operations", async () => {
  const firstLoad: number[] = [];
  const sendAck: number[] = [];
  const incrementalSync: number[] = [];
  const typingProjection: number[] = [];
  const historyPage: number[] = [];
  const attachmentUploadVerify: number[] = [];

  for (let index = 0; index < 30; index += 1) {
    const sample = await timed(() => app.inject({ method: "GET", url: "/v1/me/support/messages?limit=50", headers: auth(member.sessionToken) }));
    expect(sample.value.statusCode).toBe(200);
    expect(sample.value.json().messages).toHaveLength(50);
    firstLoad.push(sample.ms);
  }

  for (let index = 0; index < 30; index += 1) {
    const sample = await timed(() => app.inject({ method: "POST", url: "/v1/me/support/messages", headers: auth(member.sessionToken),
      payload: { body: `发送确认性能样本 ${index}`, clientMessageId: `chat-perf-send-${index}` } }));
    expect(sample.value.statusCode).toBe(200);
    expect(sample.value.json().message.deliveryState).toBe("server_accepted");
    latestSequence = sample.value.json().message.sequence;
    sendAck.push(sample.ms);
  }

  for (let index = 0; index < 30; index += 1) {
    const reply = await app.inject({ method: "POST", url: `/v1/management/support/conversations/${conversationId}/messages`, headers: auth(operator.sessionToken),
      payload: { body: `增量同步性能样本 ${index}`, clientMessageId: `chat-perf-reply-${index}` } });
    expect(reply.statusCode).toBe(200);
    const expectedSequence = reply.json().message.sequence;
    const sample = await timed(() => app.inject({ method: "GET", url: `/v1/me/support/messages?after=${latestSequence}&limit=50`, headers: auth(member.sessionToken) }));
    expect(sample.value.statusCode).toBe(200);
    expect(sample.value.json().messages.some((message: any) => message.sequence === expectedSequence)).toBe(true);
    latestSequence = expectedSequence;
    incrementalSync.push(sample.ms);
  }

  for (let index = 0; index < 30; index += 1) {
    const sample = await timed(async () => {
      const touch = await app.inject({ method: "POST", url: `/v1/management/support/conversations/${conversationId}/presence`, headers: auth(operator.sessionToken), payload: { online: true, typing: true } });
      expect(touch.statusCode).toBe(200);
      return app.inject({ method: "GET", url: `/v1/me/support/messages?after=${latestSequence}&limit=1`, headers: auth(member.sessionToken) });
    });
    expect(sample.value.statusCode).toBe(200);
    expect(sample.value.json().presence).toMatchObject({ operatorOnline: true, operatorTyping: true });
    typingProjection.push(sample.ms);
  }

  for (let index = 0; index < 30; index += 1) {
    const sample = await timed(() => app.inject({ method: "GET", url: "/v1/me/support/messages?before=100&limit=50", headers: auth(member.sessionToken) }));
    expect(sample.value.statusCode).toBe(200);
    expect(sample.value.json().messages).toHaveLength(50);
    historyPage.push(sample.ms);
  }

  // A compressed support-photo payload is large enough to exercise chunk/body
  // handling without turning this bounded smoke benchmark into a bandwidth test.
  const bytes = Buffer.alloc(256 * 1024, 0x2a);
  bytes.set([0xff, 0xd8, 0xff], 0);
  bytes.set([0xff, 0xd9], bytes.length - 2);
  for (let index = 0; index < 20; index += 1) {
    const sample = await timed(async () => {
      const authorization = await app.inject({ method: "POST", url: "/v1/me/support/media/authorize", headers: auth(member.sessionToken), payload: { mimeType: "image/jpeg", maxBytes: bytes.length } });
      expect(authorization.statusCode).toBe(200);
      const authorized = authorization.json();
      objectKeys.push((await pool.query("SELECT object_key FROM media_object WHERE id=$1", [authorized.mediaId])).rows[0].object_key);
      expect((await app.inject({ method: "POST", url: `/v1/uploads/${authorized.mediaId}/chunks`, payload: { token: authorized.fields.token, index: 0, totalBytes: bytes.length, base64: bytes.toString("base64") } })).statusCode).toBe(200);
      expect((await app.inject({ method: "POST", url: `/v1/uploads/${authorized.mediaId}/assemble`, payload: { token: authorized.fields.token } })).statusCode).toBe(200);
      return app.inject({ method: "POST", url: `/v1/me/support/media/${authorized.mediaId}/complete`, headers: auth(member.sessionToken) });
    });
    expect(sample.value.statusCode).toBe(200);
    attachmentUploadVerify.push(sample.ms);
  }

  const report = {
    scope: "local Fastify inject + PostgreSQL; excludes network, client rendering and poll scheduling",
    sampleCounts: { standard: 30, attachment: 20 },
    metrics: {
      firstLoadLatest50: metric(firstLoad),
      sendToServerAck: metric(sendAck),
      incrementalSyncAfterRemoteMessage: metric(incrementalSync),
      typingPublishAndProjection: metric(typingProjection),
      historyPage50: metric(historyPage),
      attachmentAuthorizeUploadVerify256KiB: metric(attachmentUploadVerify)
    },
    clientDetectionBounds: { activePollMs: 2000, idlePollMs: 5000, hiddenPollMs: null, note: "Schedule bounds, not measured network latency" }
  };
  for (const value of Object.values(report.metrics)) expect(value.p95Ms).toBeLessThan(1_000);
  console.log(`COMMERCIAL_CHAT_PERFORMANCE ${JSON.stringify(report)}`);
}, 20_000);
