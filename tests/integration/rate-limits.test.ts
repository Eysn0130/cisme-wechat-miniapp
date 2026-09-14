import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { loadConfig } from "@cisme/config";
import { TEST_DATABASE_URL, resetDatabase, testPool } from "@cisme/testkit";
import { createApp } from "../../services/api/src/server";
import { createApiGatewayStorage } from "../../services/api/src/storage";

const pool = testPool();
let app: FastifyInstance | undefined;
const base = {
  APP_ENV: "test", DATABASE_URL: TEST_DATABASE_URL, ALLOW_DEV_ADAPTERS: "true",
  APP_SESSION_SECRET: "synthetic-rate-session", ADMIN_API_TOKEN: "synthetic-rate-admin",
  UPLOAD_TOKEN_SECRET: "synthetic-rate-upload", OBJECT_STORAGE_DRIVER: "api_gateway",
  API_RATE_WINDOW_MS: "1000", API_RATE_INGRESS_MAX: "100",
  API_RATE_LOGIN_MAX: "10", API_RATE_MEMBER_MAX: "2", API_RATE_CALLBACK_MAX: "2"
};

async function start(overrides: Record<string, string> = {}) {
  const config = loadConfig({ ...base, ...overrides });
  app = await createApp({ config, pool, storage: createApiGatewayStorage(config) });
  return app;
}

async function login(instance: FastifyInstance, id: string): Promise<string> {
  const result = await instance.inject({ method: "POST", url: "/v1/identity/dev", payload: {
    externalUserId: id, displayName: id,
    consents: [{ documentType: "privacy", version: "test" }, { documentType: "terms", version: "test" }]
  } });
  expect(result.statusCode).toBe(200);
  return result.json().sessionToken as string;
}

beforeAll(async () => { await resetDatabase(pool); });
afterEach(async () => { await app?.close(); app = undefined; });
afterAll(async () => { await pool.end(); });

it("isolates verified members behind the same peer IP and returns problem+json with Retry-After", async () => {
  const instance = await start();
  const alice = await login(instance, "rate-alice");
  const bob = await login(instance, "rate-bob");
  const request = (token: string, spoof = "") => instance.inject({ url: "/v1/me/authority", headers: {
    authorization: `Bearer ${token}`, "x-principal-id": spoof,
    "x-forwarded-for": spoof || "198.51.100.8"
  } });
  const statuses = await Promise.all([request(alice, "fake-a"), request(alice, "fake-b"), request(alice, "fake-c")]);
  expect(statuses.map(result => result.statusCode).sort()).toEqual([200, 200, 429]);
  const denied = statuses.find(result => result.statusCode === 429)!;
  expect(denied.headers["content-type"]).toContain("application/problem+json");
  expect(denied.headers["retry-after"]).toBe("1");
  expect(denied.json()).toMatchObject({ status: 429, code: "RATE_LIMITED" });
  expect((await request(bob, "fake-a")).statusCode).toBe(200);
  await new Promise(resolve => setTimeout(resolve, 1100));
  expect((await request(alice, "fake-d")).statusCode).toBe(200);
});

it("does not permit URL or idempotency-key rotation to escape the member bucket", async () => {
  const instance = await start();
  const token = await login(instance, "rate-rotator");
  const auth = { authorization: `Bearer ${token}` };
  const ids = ["00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000002", "00000000-0000-4000-8000-000000000003"];
  const details = [];
  for (const id of ids) details.push(await instance.inject({ url: `/v1/me/addresses/${id}?nonce=${id}`, headers: auth }));
  expect(details[2]!.statusCode).toBe(429);
  const writes = [];
  for (const [index, id] of ids.entries()) writes.push(await instance.inject({ method: "POST", url: "/v1/me/privacy-requests", headers: {
    ...auth, "idempotency-key": `rotating-${index}-${id}`
  }, payload: { kind: "other", message: " " } }));
  expect(writes[2]!.statusCode).toBe(429);
});

it("limits login before DB work without trusting caller supplied forwarding headers", async () => {
  const instance = await start({ API_RATE_LOGIN_MAX: "2" });
  const payload = { externalUserId: "same-login", displayName: "same-login", consents: [
    { documentType: "privacy", version: "test" }, { documentType: "terms", version: "test" }
  ] };
  const statuses = [];
  for (const [index, forwarded] of ["198.51.100.1", "203.0.113.2", "2001:db8::3"].entries()) {
    statuses.push((await instance.inject({ method: "POST", url: `/v1/identity/dev?nonce=${index}`,
      headers: { "x-forwarded-for": forwarded, "x-principal-id": `fake-${index}` }, payload })).statusCode);
  }
  expect(statuses).toEqual([200, 200, 429]);
});

it("keeps platform callbacks separate from member auth while bounding callback bursts", async () => {
  const instance = await start();
  const statuses = [];
  for (let index = 0; index < 3; index++) statuses.push((await instance.inject({
    method: "POST", url: `/v1/ugc/safety-callback?nonce=${index}`,
    headers: { "x-forwarded-for": `198.51.100.${index + 1}` }, payload: {}
  })).statusCode);
  expect(statuses.slice(0, 2)).not.toContain(429);
  expect(statuses[2]).toBe(429);
  const paymentStatuses = [];
  for (let index = 0; index < 3; index++) paymentStatuses.push((await instance.inject({
    method: "POST", url: "/v1/payments/wechat/callback", payload: {}
  })).statusCode);
  expect(paymentStatuses.slice(0, 2)).not.toContain(429);
  expect(paymentStatuses[2]).toBe(429);
  expect((await instance.inject({ url: "/health/live" })).statusCode).toBe(200);
});

it("bounds short-lived upload and DB readiness entry points without affecting liveness", async () => {
  const instance = await start({ API_RATE_UPLOAD_MAX: "2", API_RATE_READY_MAX: "2" });
  const uploadStatuses = [];
  for (let index = 0; index < 3; index++) uploadStatuses.push((await instance.inject({
    method: "POST", url: `/v1/uploads/00000000-0000-4000-8000-00000000000${index}`,
    headers: { "x-forwarded-for": `198.51.100.${index}` }, payload: {}
  })).statusCode);
  expect(uploadStatuses.slice(0, 2)).not.toContain(429);
  expect(uploadStatuses[2]).toBe(429);
  expect((await instance.inject({ url: "/health/ready" })).statusCode).toBe(200);
  expect((await instance.inject({ url: "/health/ready" })).statusCode).toBe(200);
  expect((await instance.inject({ url: "/health/ready" })).statusCode).toBe(429);
  expect((await instance.inject({ url: "/health/live" })).statusCode).toBe(200);
});
