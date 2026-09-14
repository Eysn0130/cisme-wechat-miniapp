import { Writable } from "node:stream";
import pino from "pino";
import type pg from "pg";
import { expect, it } from "vitest";
import { loadConfig } from "@cisme/config";
import { createApp } from "../../services/api/src/server.js";
import { safeFailureFields } from "../../services/api/src/observability.js";
import { createApiGatewayStorage } from "../../services/api/src/storage.js";

it("does not log synthetic sensitive markers from request URLs or thrown driver errors", async () => {
  const marker = "SYNTHETIC_PRIVATE_PHONE_ADDRESS_SIGNED_URL_TOKEN";
  const lines: string[] = [];
  const sink = new Writable({ write(chunk, _encoding, done) { lines.push(String(chunk)); done(); } });
  const config = loadConfig({ APP_ENV: "test", DATABASE_URL: "postgres://unused",
    APP_SESSION_SECRET: "log-redaction-session", ADMIN_API_TOKEN: "log-redaction-admin",
    UPLOAD_TOKEN_SECRET: "log-redaction-upload", OBJECT_STORAGE_DRIVER: "api_gateway", LOG_LEVEL: "info" });
  const pool = { query: async () => { throw Object.assign(new Error(`driver query detail ${marker}`),
    { code: "57014", detail: marker, query: `SELECT '${marker}'` }); } } as unknown as pg.Pool;
  const app = await createApp({ config, pool, storage: createApiGatewayStorage(config),
    loggerInstance: pino({ level: "info" }, sink) });
  try {
    expect((await app.inject({ method: "GET", url: `/health/live?token=${marker}`,
      headers: { "x-request-id": marker, authorization: `Bearer ${marker}` } })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: `/health/ready?signature=${marker}` })).statusCode).toBe(504);
    const output = lines.join("");
    expect(output).toContain("http_failure");
    expect(output).toContain("57014");
    expect(output).not.toContain(marker);
    expect(output).not.toContain("SELECT");
  } finally { await app.close(); }
});

it("never copies arbitrary error class, code, message or stack into diagnostic fields", () => {
  const marker = "SYNTHETIC_PRIVATE_MARKER";
  expect(safeFailureFields(Object.assign(new Error(marker), { code: marker }))).toEqual({ failure_class: "runtime" });
  expect(JSON.stringify(safeFailureFields(new Error(marker)))).not.toContain(marker);
});
