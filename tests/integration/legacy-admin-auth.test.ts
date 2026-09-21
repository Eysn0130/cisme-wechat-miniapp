import { afterAll, beforeAll, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { loadConfig } from "@cisme/config";
import { TEST_DATABASE_URL, resetDatabase, testPool } from "@cisme/testkit";
import { createApp } from "../../services/api/src/server";
import { createApiGatewayStorage } from "../../services/api/src/storage";
import { registeredSourceOperations } from "../../scripts/route-contract-lib";

const pool = testPool();
const config = loadConfig({
  APP_ENV: "test", DATABASE_URL: TEST_DATABASE_URL, ALLOW_DEV_ADAPTERS: "true",
  APP_SESSION_SECRET: "synthetic-admin-session", ADMIN_API_TOKEN: "synthetic-shared-admin",
  UPLOAD_TOKEN_SECRET: "synthetic-upload", OBJECT_STORAGE_DRIVER: "api_gateway"
});
let app: Awaited<ReturnType<typeof createApp>>;
let ordinarySession: string;
let leadSession: string;
let leadPrincipalId: string;
let leadMemberId: string;

beforeAll(async () => {
  await resetDatabase(pool);
  app = await createApp({ config, pool, storage: createApiGatewayStorage(config) });
  const ordinary = await app.inject({ method: "POST", url: "/v1/identity/dev", payload: {
    externalUserId: "ordinary-operator-test", displayName: "ordinary",
    consents: [{ documentType: "privacy", version: "test" }, { documentType: "terms", version: "test" }]
  } });
  expect(ordinary.statusCode).toBe(200);
  ordinarySession = ordinary.json().sessionToken;
  await pool.query("INSERT INTO principal_role(principal_id,role) VALUES ('synthetic-review-lead','review_lead')");
  const lead = await app.inject({ method: "POST", url: "/v1/identity/dev", payload: {
    externalUserId: "verified-review-lead", displayName: "verified lead",
    consents: [{ documentType: "privacy", version: "test" }, { documentType: "terms", version: "test" }]
  } });
  expect(lead.statusCode).toBe(200);
  leadSession = lead.json().sessionToken;
  leadPrincipalId = lead.json().principalId;
  leadMemberId = lead.json().memberId;
  await pool.query("INSERT INTO principal_role(principal_id,role) VALUES ($1,'review_lead')", [leadPrincipalId]);
});

afterAll(async () => { await app?.close(); await pool.end(); });

it("keeps runtime metrics behind an explicit operations role and rechecks revocation", async () => {
  const url = "/v1/admin/runtime-metrics";
  expect((await app.inject({url,headers:{authorization:`Bearer ${ordinarySession}`}})).statusCode).toBe(403);
  const allowed=await app.inject({url,headers:{authorization:`Bearer ${leadSession}`}});
  expect(allowed.statusCode).toBe(200);
  expect(allowed.json().operations).toHaveProperty('signals');
  await pool.query("DELETE FROM principal_role WHERE principal_id=$1",[leadPrincipalId]);
  expect((await app.inject({url,headers:{authorization:`Bearer ${leadSession}`}})).statusCode).toBe(403);
  await pool.query("INSERT INTO principal_role(principal_id,role) VALUES ($1,'review_lead')",[leadPrincipalId]);
});

it("requires a signed session on every currently registered admin operation", async () => {
  const operations = registeredSourceOperations(readFileSync("services/api/src/server.ts", "utf8"))
    .filter((operation) => operation.path.startsWith("/v1/admin/"));
  expect(operations.length).toBeGreaterThanOrEqual(22);
  for (const { method, path } of operations) {
    const url = path.replace(/\{[^}]+\}/g, "00000000-0000-4000-8000-000000000000");
    const result = await app.inject({ method: method as "GET" | "POST" | "PUT" | "DELETE", url,
      headers: { "x-admin-token": "synthetic-shared-admin", "x-principal-id": "synthetic-review-lead" } });
    expect(result.statusCode, `${method} ${path} must reject the shared secret without a session`).toBe(401);
  }
});

it("does not let a shared legacy secret select an unrelated privileged actor", async () => {
  const route = "/v1/admin/reviews";
  expect((await app.inject({ url: route })).statusCode).toBe(401);
  expect((await app.inject({ url: route, headers: {
    "x-admin-token": "synthetic-shared-admin", "x-principal-id": "synthetic-review-lead"
  } })).statusCode).toBe(401);
  expect((await app.inject({ url: route, headers: {
    authorization: `Bearer ${ordinarySession}`,
    "x-admin-token": "synthetic-shared-admin", "x-principal-id": "synthetic-review-lead"
  } })).statusCode).toBe(403);
  expect((await app.inject({ url: route, headers: { authorization: `Bearer ${leadSession}` } })).statusCode).toBe(200);
  expect((await app.inject({ url: route, headers: {
    authorization: `Bearer ${leadSession}`, "x-principal-id": "synthetic-review-lead"
  } })).statusCode).toBe(403);
  await pool.query("DELETE FROM principal_role WHERE principal_id=$1", [leadPrincipalId]);
  expect((await app.inject({ url: route, headers: { authorization: `Bearer ${leadSession}` } })).statusCode).toBe(403);
  await pool.query("UPDATE member SET status='blocked' WHERE id=$1", [leadMemberId]);
  expect((await app.inject({ url: route, headers: { authorization: `Bearer ${leadSession}` } })).statusCode).toBe(401);
});
