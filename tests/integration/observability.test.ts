import { afterAll, describe, expect, it } from "vitest";
import { loadConfig } from "@cisme/config";
import { TEST_DATABASE_URL } from "@cisme/testkit";
import { createPool } from "../../services/api/src/db.js";
import { recordHttpRequest, resetRuntimeMetrics, runtimeMetrics } from "../../services/api/src/observability.js";
import { createApp } from "../../services/api/src/server.js";
import { createApiGatewayStorage } from "../../services/api/src/storage.js";

const config = loadConfig({
  APP_ENV: "test",
  DATABASE_URL: TEST_DATABASE_URL,
  APP_SESSION_SECRET: "observability-session",
  ADMIN_API_TOKEN: "observability-admin",
  UPLOAD_TOKEN_SECRET: "observability-upload"
});
const pool = createPool(TEST_DATABASE_URL, config.database);

afterAll(async () => pool.end());

describe("bounded runtime observability", () => {
  it("measures pool-client SQL without retaining statement text", async () => {
    await pool.query("SELECT 1 AS private_marker");
    const client = await pool.connect();
    try { await client.query("SELECT 2 AS another_private_marker"); }
    finally { client.release(); }

    const metrics = runtimeMetrics(pool);
    expect(metrics.sqlMs.count).toBeGreaterThanOrEqual(2);
    expect(metrics.poolWaitMs.count).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(metrics)).not.toContain("private_marker");
  });

  it("tracks aggregate HTTP latency, bytes and failure classes", () => {
    resetRuntimeMetrics();
    const before = runtimeMetrics(pool).http;
    recordHttpRequest({ route: "/v1/test/:id", durationMs: 12, responseBytes: 128, statusCode: 503, coldStart: true, timedOut: true });
    const after = runtimeMetrics(pool).http;
    expect(after.total).toBe(before.total + 1);
    expect(after.serverErrors).toBe(before.serverErrors + 1);
    expect(after.timeouts).toBe(before.timeouts + 1);
    expect(after.durationMs.count).toBeGreaterThan(before.durationMs.count);
    expect(after.coldDurationMs.count).toBeGreaterThan(before.coldDurationMs.count);
    expect(after.responseBytes.max).toBeGreaterThanOrEqual(128);
    expect(after.routes["/v1/test/:id"]).toMatchObject({ total: 1, errors: 1 });
  });

  it("uses a bounded ring buffer under sustained metric volume", () => {
    resetRuntimeMetrics();
    for (let index = 0; index < 3_000; index += 1) {
      recordHttpRequest({ durationMs: index, responseBytes: index, statusCode: 200, coldStart: false });
    }
    const metrics = runtimeMetrics(pool).http;
    expect(metrics.durationMs.count).toBe(2048);
    expect(metrics.durationMs.max).toBe(2999);
  });

  it("fails with a bounded 503 when the database pool cannot be acquired", async () => {
    const saturatedConfig = loadConfig({
      APP_ENV: "test", DATABASE_URL: TEST_DATABASE_URL, APP_SESSION_SECRET: "saturated-session", ADMIN_API_TOKEN: "saturated-admin",
      UPLOAD_TOKEN_SECRET: "saturated-upload", DATABASE_POOL_MAX: "1", DATABASE_POOL_ACQUIRE_TIMEOUT_MS: "100"
    });
    const saturatedPool = createPool(TEST_DATABASE_URL, saturatedConfig.database);
    const held = await saturatedPool.connect();
    const app = await createApp({ config: saturatedConfig, pool: saturatedPool, storage: createApiGatewayStorage(saturatedConfig) });
    try {
      const response = await app.inject({ method: "GET", url: "/health/ready" });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({ code: "DATABASE_SATURATED" });
    } finally {
      held.release();
      await app.close();
      await saturatedPool.end();
    }
  });
});
