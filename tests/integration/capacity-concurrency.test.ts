import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { loadConfig } from "@cisme/config";
import { TEST_DATABASE_URL, resetDatabase, seedTestCampaign, testPool } from "@cisme/testkit";
import { createApp } from "../../services/api/src/server";
import { createApiGatewayStorage } from "../../services/api/src/storage";
import { sweepExpired } from "../../services/worker/src/main";

const pool = testPool();
const config = loadConfig({ APP_ENV: "test", DATABASE_URL: TEST_DATABASE_URL, ALLOW_DEV_ADAPTERS: "true", APP_SESSION_SECRET: "capacity-session", ADMIN_API_TOKEN: "capacity-admin", UPLOAD_TOKEN_SECRET: "capacity-upload", OBJECT_STORAGE_DRIVER: "api_gateway" });
const storage = createApiGatewayStorage(config);
let app: FastifyInstance;

function careHeaders(token: string, key: string, clock: string) {
  return { authorization: `Bearer ${token}`, "x-dev-clock": clock, "idempotency-key": key };
}

function careCompletion(expectedVersion: number) {
  return { expectedVersion, stepCodes: ["00", "01", "02", "03"], selfAssessment: "neutral" };
}

beforeAll(async () => { await resetDatabase(pool); await seedTestCampaign(pool); await storage.ensureReady(); app = await createApp({ config, pool, storage }); });
afterAll(async () => { await app.close(); await pool.end(); });

describe("campaign capacity", () => {
  it("serializes concurrent D7 decisions without exceeding capacity", async () => {
    const members: Array<{ token: string; cycleId: string; version: number }> = [];
    for (let index = 0; index < 5; index += 1) {
      const identity = (await app.inject({ method: "POST", url: "/v1/identity/dev", payload: { externalUserId: `capacity-${index}`, displayName: `容量会员${index}`, consents: [{ documentType: "privacy", version: "v1" }, { documentType: "terms", version: "v1" }] } })).json();
      const headers = { authorization: `Bearer ${identity.sessionToken}`, "x-dev-clock": "2026-08-01T09:00:00+08:00" };
      const fact = (await app.inject({ method: "POST", url: "/v1/qualifications/dev", headers, payload: { externalRef: `capacity-purchase-${index}`, occurredAt: "2026-08-01T08:00:00+08:00" } })).json();
      const planned = (await app.inject({ method: "POST", url: "/v1/care-cycles", headers, payload: { qualificationFactId: fact.id, timezone: "Asia/Shanghai", protocolVersion: "care-r0-v1" } })).json();
      const active = (await app.inject({ method: "POST", url: `/v1/care-cycles/${planned.id}/activate`, headers: careHeaders(identity.sessionToken, `capacity-${index}-activate`, "2026-08-01T09:00:00+08:00"), payload: { expectedVersion: planned.version } })).json();
      const d1 = (await app.inject({ method: "POST", url: `/v1/care-cycles/${planned.id}/milestones/D1/complete`, headers: careHeaders(identity.sessionToken, `capacity-${index}-D1`, "2026-08-01T09:00:00+08:00"), payload: careCompletion(active.version) })).json();
      members.push({ token: identity.sessionToken, cycleId: planned.id, version: d1.cycle.version });
    }
    const responses = await Promise.all(members.map(({ token, cycleId, version }, index) => app.inject({ method: "POST", url: `/v1/care-cycles/${cycleId}/milestones/D7/complete`, headers: careHeaders(token, `capacity-${index}-D7`, "2026-08-07T12:00:00+08:00"), payload: careCompletion(version) })));
    expect(responses.map((response) => ({ status: response.statusCode, body: response.json() }))).toEqual(
      responses.map((response) => ({ status: 200, body: response.json() }))
    );
    const counts = await pool.query("SELECT (SELECT count(*) FROM eligibility_decision)::int decisions, (SELECT count(*) FROM eligibility_task)::int tasks");
    expect(counts.rows[0]).toEqual({ decisions: 5, tasks: 2 });

    await pool.query("UPDATE eligibility_task SET expires_at='2026-08-06T00:00:00Z' WHERE id=(SELECT id FROM eligibility_task ORDER BY id LIMIT 1)");
    await sweepExpired(pool, new Date("2026-08-07T12:30:00+08:00"));
    const identity = (await app.inject({ method: "POST", url: "/v1/identity/dev", payload: { externalUserId: "capacity-release", displayName: "释放名额会员", consents: [{ documentType: "privacy", version: "v1" }, { documentType: "terms", version: "v1" }] } })).json();
    const headers = { authorization: `Bearer ${identity.sessionToken}`, "x-dev-clock": "2026-08-01T09:00:00+08:00" };
    const fact = (await app.inject({ method: "POST", url: "/v1/qualifications/dev", headers, payload: { externalRef: "capacity-purchase-release", occurredAt: "2026-08-01T08:00:00+08:00" } })).json();
    const planned = (await app.inject({ method: "POST", url: "/v1/care-cycles", headers, payload: { qualificationFactId: fact.id, timezone: "Asia/Shanghai", protocolVersion: "care-r0-v1" } })).json();
    const active = (await app.inject({ method: "POST", url: `/v1/care-cycles/${planned.id}/activate`, headers: careHeaders(identity.sessionToken, "capacity-release-activate", "2026-08-01T09:00:00+08:00"), payload: { expectedVersion: planned.version } })).json();
    const d1 = (await app.inject({ method: "POST", url: `/v1/care-cycles/${planned.id}/milestones/D1/complete`, headers: careHeaders(identity.sessionToken, "capacity-release-D1", "2026-08-01T09:00:00+08:00"), payload: careCompletion(active.version) })).json();
    const released = await app.inject({ method: "POST", url: `/v1/care-cycles/${planned.id}/milestones/D7/complete`, headers: careHeaders(identity.sessionToken, "capacity-release-D7", "2026-08-07T13:00:00+08:00"), payload: careCompletion(d1.cycle.version) });
    expect(released.statusCode).toBe(200);
    const afterRelease = await pool.query("SELECT count(*) FILTER (WHERE state <> 'expired')::int active, count(*)::int total FROM eligibility_task");
    expect(afterRelease.rows[0]).toEqual({ active: 2, total: 3 });
  });
});
