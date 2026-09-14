import { readFileSync } from "node:fs";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import yaml from "js-yaml";
import { loadConfig } from "@cisme/config";
import { TEST_DATABASE_URL, testPool } from "@cisme/testkit";
import { createApp } from "../../services/api/src/server.js";
import { createApiGatewayStorage } from "../../services/api/src/storage.js";
import { documentedOperations, registeredSourceOperations } from "../../scripts/route-contract-lib.js";

type SecurityDocument = { paths: Record<string, Record<string, { security?: Array<Record<string, unknown>> }>> };
const source = readFileSync("services/api/src/server.ts", "utf8");
const spec = readFileSync("openapi/openapi.yaml", "utf8");
const documented = documentedOperations(spec);
const registered = registeredSourceOperations(source);
const security = yaml.load(spec) as SecurityDocument;
const signed = documented.filter(({ method, path }) => {
  const policy = security.paths[path]?.[method.toLowerCase()]?.security;
  return JSON.stringify(policy) === JSON.stringify([{ session: [] }]);
});
const pool = testPool();
const config = loadConfig({ APP_ENV: "test", DATABASE_URL: TEST_DATABASE_URL,
  APP_SESSION_SECRET: "protected-route-entry-test", ADMIN_API_TOKEN: "synthetic-only-admin",
  UPLOAD_TOKEN_SECRET: "protected-route-upload-test", OBJECT_STORAGE_DRIVER: "api_gateway",
  API_RATE_INGRESS_MAX: "100000", API_RATE_MEMBER_MAX: "100000" });
let app: FastifyInstance;

beforeAll(async () => {
  expect(documented).toEqual(registered);
  expect(signed.length).toBeGreaterThan(150);
  app = await createApp({ config, pool, storage: createApiGatewayStorage(config) });
});
afterAll(async () => { if (app) await app.close(); await pool.end(); });

it.each(signed)("$method $path rejects an unauthenticated request at the runtime entry", async ({ method, path }) => {
  const url = path.replace(/\{[^}]+\}/g, "00000000-0000-4000-8000-000000000001");
  const response = await app.inject({ method: method as "GET" | "POST" | "PUT" | "PATCH" | "DELETE", url });
  expect(response.statusCode, `${method} ${path}: ${response.body}`).toBe(401);
  expect(response.json().code).toMatch(/AUTH_REQUIRED|SESSION_REQUIRED|ADMIN_AUTH_REQUIRED/);
});

it.each(signed)("$method $path rejects an unsigned bearer and claimed actor", async ({ method, path }) => {
  const url = path.replace(/\{[^}]+\}/g, "00000000-0000-4000-8000-000000000001");
  const response = await app.inject({ method: method as "GET" | "POST" | "PUT" | "PATCH" | "DELETE", url,
    headers: { authorization: "Bearer synthetic.unsigned.claim", "x-principal-id": "review_lead",
      "x-member-id": "00000000-0000-4000-8000-000000000002", "x-admin-token": "synthetic-only-admin" } });
  expect(response.statusCode, `${method} ${path}: ${response.body}`).toBe(401);
});
