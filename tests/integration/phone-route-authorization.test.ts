import { afterAll, beforeAll, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { loadConfig } from "@cisme/config";
import { TEST_DATABASE_URL, resetDatabase, testPool } from "@cisme/testkit";
import { createApp } from "../../services/api/src/server.js";
import { createApiGatewayStorage } from "../../services/api/src/storage.js";

const pool = testPool();
const config = loadConfig({
  APP_ENV: "test", DATABASE_URL: TEST_DATABASE_URL, APP_SESSION_SECRET: "phone-route-session-test",
  ADMIN_API_TOKEN: "phone-route-admin-test", UPLOAD_TOKEN_SECRET: "phone-route-upload-test",
  OBJECT_STORAGE_DRIVER: "api_gateway", WECHAT_APP_ID: "wx0000000000000001",
  WECHAT_APP_SECRET: "synthetic-only", WECHAT_PHONE_BINDING_ENABLED: "true",
  CONTACT_ENCRYPTION_KEY: "ab".repeat(32), CONTACT_HASH_KEY: "cd".repeat(32)
});
const phoneFetcher = vi.fn<typeof fetch>();
phoneFetcher.mockImplementation(async (input, init) => {
  expect(init?.redirect).toBe("error");
  const url = String(input);
  if (url.includes("/stable_token")) return new Response(JSON.stringify({ access_token: "synthetic-token", expires_in: 7200 }));
  const code = JSON.parse(String(init?.body)).code as string;
  const purePhoneNumber = code === "synthetic-code-a" ? "13800000001" : code === "synthetic-code-b" ? "13900000002" : "";
  return new Response(JSON.stringify({ errcode: purePhoneNumber ? 0 : 40029,
    phone_info: { purePhoneNumber, countryCode: "86", watermark: { appid: config.wechat.appId } } }));
});

let app: FastifyInstance;
let memberA: { memberId: string; sessionToken: string };
let memberB: { memberId: string; sessionToken: string };
const auth = (token: string) => ({ authorization: `Bearer ${token}` });

beforeAll(async () => {
  await resetDatabase(pool);
  app = await createApp({ config, pool, storage: createApiGatewayStorage(config), phoneFetcher });
  const identity = async (externalUserId: string) => (await app.inject({ method: "POST", url: "/v1/identity/dev",
    payload: { externalUserId, displayName: externalUserId, consents: [
      { documentType: "privacy", version: "v1" }, { documentType: "terms", version: "v1" }
    ] } })).json() as { memberId: string; sessionToken: string };
  memberA = await identity("phone-route-a");
  memberB = await identity("phone-route-b");
});
afterAll(async () => { if (app) await app.close(); await pool.end(); });

it("binds, reads and unbinds phones only for the signed member despite forged body fields", async () => {
  expect((await app.inject({ method: "GET", url: "/v1/me/phone" })).statusCode).toBe(401);
  expect((await app.inject({ method: "POST", url: "/v1/me/phone", payload: { code: "synthetic-code-a" } })).statusCode).toBe(401);
  expect((await app.inject({ method: "DELETE", url: "/v1/me/phone" })).statusCode).toBe(401);

  const aBind = await app.inject({ method: "POST", url: "/v1/me/phone", headers: auth(memberA.sessionToken),
    payload: { code: "synthetic-code-a", memberId: memberB.memberId, principalId: "forged", role: "review_lead" } });
  expect(aBind.statusCode).toBe(200);
  expect(aBind.json()).toEqual({ bound: true, masked: "***0001" });
  expect(aBind.body).not.toContain("13800000001");
  expect((await app.inject({ method: "GET", url: "/v1/me/phone", headers: auth(memberA.sessionToken) })).json())
    .toEqual({ enabled: true, bound: true, masked: "***0001" });
  expect((await app.inject({ method: "GET", url: "/v1/me/phone", headers: auth(memberB.sessionToken) })).json())
    .toEqual({ enabled: true, bound: false, masked: null });

  const reused = await app.inject({ method: "POST", url: "/v1/me/phone", headers: auth(memberB.sessionToken),
    payload: { code: "synthetic-code-a", memberId: memberA.memberId } });
  expect(reused.statusCode).toBe(409);
  expect(reused.json().code).toBe("PHONE_CODE_USED");
  const bBind = await app.inject({ method: "POST", url: "/v1/me/phone", headers: auth(memberB.sessionToken),
    payload: { code: "synthetic-code-b", memberId: memberA.memberId } });
  expect(bBind.statusCode).toBe(200);
  expect(bBind.json()).toEqual({ bound: true, masked: "***0002" });
  expect((await pool.query("SELECT member_id,phone_masked FROM member_contact ORDER BY member_id")).rows)
    .toEqual(expect.arrayContaining([{ member_id: memberA.memberId, phone_masked: "***0001" },
      { member_id: memberB.memberId, phone_masked: "***0002" }]));

  const bUnbind = await app.inject({ method: "DELETE", url: "/v1/me/phone", headers: auth(memberB.sessionToken),
    payload: { memberId: memberA.memberId, principalId: "forged" } });
  expect(bUnbind.statusCode).toBe(200);
  expect(bUnbind.json()).toEqual({ bound: false, masked: null });
  expect((await app.inject({ method: "GET", url: "/v1/me/phone", headers: auth(memberA.sessionToken) })).json().masked)
    .toBe("***0001");
  expect((await app.inject({ method: "GET", url: "/v1/me/phone", headers: auth(memberB.sessionToken) })).json().bound)
    .toBe(false);
  const audit = (await pool.query("SELECT principal_id,action,object_id FROM audit_log WHERE action IN ('member.phone_bound','member.phone_unbound') ORDER BY id")).rows;
  expect(audit).toEqual(expect.arrayContaining([
    { principal_id: `member:${memberA.memberId}`, action: "member.phone_bound", object_id: memberA.memberId },
    { principal_id: `member:${memberB.memberId}`, action: "member.phone_bound", object_id: memberB.memberId },
    { principal_id: `member:${memberB.memberId}`, action: "member.phone_unbound", object_id: memberB.memberId }
  ]));
  expect(audit).not.toContainEqual({ principal_id: `member:${memberA.memberId}`, action: "member.phone_unbound", object_id: memberA.memberId });
});

it('does not reuse a provider token whose supplied lifetime is zero',async()=>{
 const {PhoneBinding}=await import('../../services/api/src/phoneBinding');
 const fetcher=vi.fn<typeof fetch>().mockImplementation(async(input)=>new Response(JSON.stringify(
  String(input).includes('/stable_token')?{access_token:'synthetic-short-lived',expires_in:0}:
   {errcode:0,phone_info:{purePhoneNumber:'13800000001',countryCode:'86',watermark:{appid:config.wechat.appId}}})));
 const phone=new PhoneBinding(pool,config,fetcher);
 await phone.bind(memberA.memberId,'synthetic-zero-token-first');
 await phone.bind(memberA.memberId,'synthetic-zero-token-second');
 expect(fetcher.mock.calls.filter(([input])=>String(input).includes('/stable_token'))).toHaveLength(2);
});
