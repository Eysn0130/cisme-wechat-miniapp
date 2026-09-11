import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { loadConfig } from "@cisme/config";
import { TEST_DATABASE_URL, resetDatabase, testPool } from "@cisme/testkit";
import { createApp } from "../../services/api/src/server";
import { createApiGatewayStorage } from "../../services/api/src/storage";

const pool = testPool();
const config = loadConfig({ APP_ENV: "test", DATABASE_URL: TEST_DATABASE_URL, APP_SESSION_SECRET: "invite-test-session", ADMIN_API_TOKEN: "invite-test-admin", UPLOAD_TOKEN_SECRET: "invite-test-upload", OBJECT_STORAGE_DRIVER: "api_gateway" });
let app: FastifyInstance;
let ownerToken = "";
let visitorToken = "";
let shareId = "";
const clock = "2026-09-08T12:00:00Z";
const headers = (token: string) => ({ authorization: `Bearer ${token}`, "x-dev-clock": clock });

beforeAll(async () => {
  await resetDatabase(pool);
  app = await createApp({ config, pool, storage: createApiGatewayStorage(config) });
  for (const id of ["invite-owner", "invite-visitor"]) {
    const response = await app.inject({ method: "POST", url: "/v1/identity/dev", payload: { externalUserId: id, displayName: "测试会员", consents: [{ documentType: "privacy", version: "v1" }, { documentType: "terms", version: "v1" }] } });
    expect(response.statusCode).toBe(200);
    if (id === "invite-owner") ownerToken = response.json().sessionToken;
    else visitorToken = response.json().sessionToken;
  }
});
afterAll(async () => { await app?.close(); await pool.end(); });

describe("member invitation links", () => {
  it("requires authentication and exposes only the caller's generated links", async () => {
    expect((await app.inject({ method: "GET", url: "/v1/me/shares" })).statusCode).toBe(401);
    const created = await app.inject({ method: "POST", url: "/v1/shares", headers: { ...headers(ownerToken), "idempotency-key": "invite-create-1" }, payload: { targetType: "invite", targetRef: "home" } });
    expect(created.statusCode).toBe(200);
    shareId = created.json().shareId;
    expect(shareId).toMatch(/^[0-9a-f]{32}$/);
    const own = await app.inject({ method: "GET", url: "/v1/me/shares", headers: headers(ownerToken) });
    expect(own.json()).toHaveLength(1);
    expect(own.json()[0]).toMatchObject({ shareId, targetType: "invite", targetRef: "home", state: "active" });
    expect(own.json()[0]).not.toHaveProperty("sent");
    expect(own.json()[0]).not.toHaveProperty("memberId");
    expect((await app.inject({ method: "GET", url: "/v1/me/shares", headers: headers(visitorToken) })).json()).toEqual([]);
  });

  it("reuses an active invitation and rejects arbitrary invitation destinations", async () => {
    const repeated = await app.inject({ method: "POST", url: "/v1/shares", headers: { ...headers(ownerToken), "idempotency-key": "invite-create-2" }, payload: { targetType: "invite", targetRef: "home" } });
    expect(repeated.statusCode).toBe(200);
    expect(repeated.json().shareId).toBe(shareId);
    const invalid = await app.inject({ method: "POST", url: "/v1/shares", headers: { ...headers(ownerToken), "idempotency-key": "invite-invalid-destination" }, payload: { targetType: "invite", targetRef: "https://elsewhere.example" } });
    expect(invalid.statusCode).toBe(422);
  });

  it("keeps an active invitation discoverable when other share history exceeds the page limit", async () => {
    await pool.query("INSERT INTO share_link (share_id, member_id, target_type, target_ref, created_at, expires_at) SELECT md5(random()::text), member_id, 'post', 'fixture-' || n, now() + interval '1 minute', now() + interval '30 days' FROM share_link CROSS JOIN generate_series(1,21) n WHERE share_id=$1", [shareId]);
    const filtered = await app.inject({ method: "GET", url: "/v1/me/shares?targetType=invite", headers: headers(ownerToken) });
    expect(filtered.statusCode).toBe(200);
    expect(filtered.json()).toHaveLength(1);
    expect(filtered.json()[0].shareId).toBe(shareId);
    expect((await app.inject({ method: "GET", url: "/v1/me/shares?targetType=unknown", headers: headers(ownerToken) })).statusCode).toBe(422);
  });

  it("resolves anonymously and records a real visit before identity attribution", async () => {
    const resolved = await app.inject({ method: "GET", url: `/v1/shares/${shareId}`, headers: { "x-dev-clock": clock } });
    expect(resolved.json()).toMatchObject({ targetType: "invite", targetRef: "home" });
    expect(resolved.json()).not.toHaveProperty("memberId");
    const visitKey = "visit-invitation-integration-0001";
    const visit = await app.inject({ method: "POST", url: `/v1/shares/${shareId}/visits`, headers: { "x-dev-clock": clock }, payload: { visitKey } });
    expect(visit.statusCode).toBe(200);
    const credited = await app.inject({ method: "POST", url: `/v1/shares/${shareId}/attributions/identity`, headers: headers(visitorToken), payload: { visitKey } });
    expect(credited.json()).toMatchObject({ credited: true });
    const replay = await app.inject({ method: "POST", url: `/v1/shares/${shareId}/attributions/identity`, headers: headers(visitorToken), payload: { visitKey } });
    expect(replay.json()).toMatchObject({ credited: true, reason: "ALREADY_RECORDED" });
  });

  it("shows expiry honestly and stops resolving after the 30-day window", async () => {
    const later = { ...headers(ownerToken), "x-dev-clock": "2026-10-09T12:00:00Z" };
    expect((await app.inject({ method: "GET", url: "/v1/me/shares?targetType=invite", headers: later })).json()[0].state).toBe("expired");
    expect((await app.inject({ method: "GET", url: `/v1/shares/${shareId}`, headers: later })).statusCode).toBe(404);
  });
});
