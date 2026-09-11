import { afterAll, beforeAll, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import pg from "pg";
import { loadConfig } from "@cisme/config";
import { createApp } from "../../services/api/src/server";
import { createApiGatewayStorage } from "../../services/api/src/storage";

const config = loadConfig({ APP_ENV: "test", DATABASE_URL: "postgres://localhost/unused", APP_SESSION_SECRET: "test-session-secret", ADMIN_API_TOKEN: "test-admin-secret", UPLOAD_TOKEN_SECRET: "test-upload-secret", OBJECT_STORAGE_DRIVER: "api_gateway" });
const pool = new pg.Pool({ connectionString: config.databaseUrl });
const cloudHeaders = { "x-cisme-transport": "cloud-http-v1" };
let app: FastifyInstance;
beforeAll(async () => { app = await createApp({ config, pool, storage: createApiGatewayStorage(config) }); });
afterAll(async () => { await app.close(); await pool.end(); });

it("preserves ordinary HTTP authentication errors", async () => {
  const result = await app.inject({ method: "GET", url: "/v1/me" });
  expect(result.statusCode).toBe(401);
  expect(result.json()).toMatchObject({ status: 401, code: "AUTH_REQUIRED" });
});

it("keeps the authentication error and trace inside the native cloud envelope", async () => {
  const result = await app.inject({ method: "GET", url: "/v1/me", headers: cloudHeaders });
  expect(result.statusCode).toBe(200);
  expect(result.json()).toEqual({ cismeHttpError: { version: 1, statusCode: 401, data: expect.objectContaining({ status: 401, code: "AUTH_REQUIRED", trace_id: expect.any(String) }) } });
});

it("preserves validation errors without creating a member or connecting to the database", async () => {
  const result = await app.inject({ method: "POST", url: "/v1/identity/dev", headers: cloudHeaders, payload: { externalUserId: "unused", displayName: "CISME 会员", consents: [] } });
  expect(result.statusCode).toBe(200);
  expect(result.json()).toMatchObject({ cismeHttpError: { version: 1, statusCode: 422, data: { code: "CONSENT_REQUIRED" } } });
  expect(pool.totalCount).toBe(0);
});

it("also transports missing-route errors while leaving successful JSON unchanged", async () => {
  const missing = await app.inject({ method: "GET", url: "/missing-route", headers: cloudHeaders });
  expect(missing.statusCode).toBe(200);
  expect(missing.json()).toMatchObject({ cismeHttpError: { version: 1, statusCode: 404 } });
  const live = await app.inject({ method: "GET", url: "/health/live", headers: cloudHeaders });
  expect(live.statusCode).toBe(200);
  expect(live.json()).toEqual({ status: "ok" });
});

it("keeps public reads public with query parameters, without opening protected paths", async () => {
  const query = vi.spyOn(pool, "query").mockResolvedValue({ rows: [], rowCount: 0 } as never);
  try {
    const feed = await app.inject({ method: "GET", url: "/v1/feed?from=cloud", headers: cloudHeaders });
    expect(feed.statusCode).toBe(200);
    expect(feed.json()).toEqual([]);
    const privateRoute = await app.inject({ method: "GET", url: "/v1/me?from=cloud", headers: cloudHeaders });
    expect(privateRoute.json()).toMatchObject({ cismeHttpError: { statusCode: 401, data: { code: "AUTH_REQUIRED" } } });
  } finally { query.mockRestore(); }
});
