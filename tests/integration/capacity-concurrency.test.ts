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
  it("completes concurrent D7 care without allocating retired campaign capacity", async () => {
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
    const completeD7 = ({ token, cycleId, version }: typeof members[number], index: number) => app.inject({ method: "POST", url: `/v1/care-cycles/${cycleId}/milestones/D7/complete`, headers: careHeaders(token, `capacity-${index}-D7`, "2026-08-07T12:00:00+08:00"), payload: careCompletion(version) });
    const responses = await Promise.all(members.map(completeD7));
    // Serializable work has bounded server retries. A confirmed conflict may
    // outlive that budget; it is not a successful write. Once this concurrent
    // wave has settled, retry only that explicit verdict with the original
    // key/version/payload, once. Other failures must still fail this test.
    for (let index = 0; index < responses.length; index += 1) {
      if (responses[index]!.statusCode === 409) {
        expect(responses[index]!.json()).toMatchObject({ code: "CONCURRENT_OPERATION_RETRY", status: 409 });
        responses[index] = await completeD7(members[index]!, index);
      }
      expect(responses[index]!.statusCode, JSON.stringify(responses[index]!.json())).toBe(200);
    }
    // Replaying every key must return its saved result and create no more steps.
    for (let index = 0; index < responses.length; index += 1) {
      const replay = await completeD7(members[index]!, index);
      expect(replay.statusCode).toBe(200);
      expect(replay.json()).toEqual(responses[index]!.json());
    }
    const counts = await pool.query("SELECT (SELECT count(*) FROM eligibility_decision)::int decisions, (SELECT count(*) FROM eligibility_task)::int tasks");
    expect(counts.rows[0]).toEqual({ decisions: 0, tasks: 0 });
    expect(responses.every(response=>response.json().task===null)).toBe(true);
    expect((await pool.query("SELECT count(*)::int n FROM care_record_step")).rows[0].n).toBe(40);
  });
});
