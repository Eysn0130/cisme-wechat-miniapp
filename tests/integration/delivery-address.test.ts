import { afterAll, beforeAll, expect, it } from "vitest";
import { loadConfig } from "@cisme/config";
import { TEST_DATABASE_URL, resetDatabase, testPool } from "@cisme/testkit";
import { createApp } from "../../services/api/src/server";
import { createApiGatewayStorage } from "../../services/api/src/storage";

const pool = testPool();
const config = loadConfig({
  APP_ENV: "test",
  DATABASE_URL: TEST_DATABASE_URL,
  APP_SESSION_SECRET: "address-session",
  ADMIN_API_TOKEN: "address-admin",
  UPLOAD_TOKEN_SECRET: "address-upload",
  OBJECT_STORAGE_DRIVER: "api_gateway",
  CONTACT_ENCRYPTION_KEY: "ab".repeat(32),
  CONTACT_HASH_KEY: "cd".repeat(32),
  CONTACT_KEY_VERSION: "address-test-v1"
});
const app = await createApp({ pool, config, storage: createApiGatewayStorage(config) });
let ownerToken = "";
let otherToken = "";
let otherMemberId = "";

const address = {
  recipientName: "林女士",
  phone: "138 0000 0001",
  province: "广东省",
  city: "深圳市",
  district: "南山区",
  detail: "粤海街道护理路 8 号 1201",
  postalCode: "518000",
  nationalCode: "440305",
  provinceCode: "440000",
  cityCode: "440300",
  districtCode: "440305",
  label: "home",
  isDefault: true
};

beforeAll(async () => {
  await resetDatabase(pool);
  for (const id of ["address-owner", "address-other"]) {
    const response = await app.inject({ method: "POST", url: "/v1/identity/dev", payload: { externalUserId: id, displayName: id, consents: [{ documentType: "privacy", version: "test" }, { documentType: "terms", version: "test" }] } });
    expect(response.statusCode).toBe(200);
    if (id === "address-owner") ownerToken = response.json().sessionToken;
    else { otherToken = response.json().sessionToken; otherMemberId = response.json().memberId; }
  }
});

afterAll(async () => { await app.close(); await pool.end(); });

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

it("stores address PII encrypted, isolates owners, and replays create requests", async () => {
  expect((await app.inject({ url: "/v1/me/addresses" })).statusCode).toBe(401);
  const create = () => app.inject({ method: "POST", url: "/v1/me/addresses", headers: { ...auth(ownerToken), "idempotency-key": "address-create-owner-1" },
    payload: { ...address, memberId: otherMemberId, role: "administrator" } });
  const first = await create();
  expect(first.statusCode).toBe(200);
  expect(first.json()).toMatchObject({ recipientName: "林女士", phone: "13800000001", provinceCode: "440000", cityCode: "440300", districtCode: "440305", isDefault: true, version: 1 });
  expect((await create()).json().id).toBe(first.json().id);
  expect((await app.inject({ url: "/v1/me/addresses", headers: auth(otherToken) })).json().addresses).toEqual([]);
  const rows = (await pool.query("SELECT * FROM member_delivery_address")).rows;
  expect(rows).toHaveLength(1);
  expect(JSON.stringify(rows)).not.toContain("林女士");
  expect(JSON.stringify(rows)).not.toContain("13800000001");
  expect(JSON.stringify(rows)).not.toContain("护理路");
});

it("enforces optimistic versions and keeps exactly one default", async () => {
  const first = (await app.inject({ url: "/v1/me/addresses", headers: auth(ownerToken) })).json().addresses[0];
  const secondResponse = await app.inject({ method: "POST", url: "/v1/me/addresses", headers: { ...auth(ownerToken), "idempotency-key": "address-create-owner-2" }, payload: { ...address, phone: "13900000002", detail: "科苑路 9 号", label: "company", isDefault: false } });
  expect(secondResponse.statusCode).toBe(200);
  const second = secondResponse.json();
  expect(second.isDefault).toBe(false);
  expect((await app.inject({ method: "POST", url: `/v1/me/addresses/${second.id}/default`, headers: auth(ownerToken), payload: { expectedVersion: second.version } })).statusCode).toBe(200);
  const list = (await app.inject({ url: "/v1/me/addresses", headers: auth(ownerToken) })).json().addresses;
  expect(list.filter((item: { isDefault: boolean }) => item.isDefault)).toHaveLength(1);
  expect(list[0].id).toBe(second.id);
  const stale = await app.inject({ method: "PUT", url: `/v1/me/addresses/${first.id}`, headers: auth(ownerToken), payload: { ...address, detail: "旧客户端覆盖", expectedVersion: first.version } });
  expect(stale.statusCode).toBe(409);
  const forbidden = await app.inject({ method: "PUT", url: `/v1/me/addresses/${first.id}`, headers: auth(otherToken), payload: { ...address, expectedVersion: first.version + 1 } });
  expect(forbidden.statusCode).toBe(404);
  const otherDefault = await app.inject({ method: "POST", url: `/v1/me/addresses/${first.id}/default`,
    headers: auth(otherToken), payload: { expectedVersion: first.version + 1 } });
  expect(otherDefault.statusCode).toBe(404);
  const beforeAudit = (await pool.query("SELECT count(*)::int AS count FROM audit_log WHERE object_type='member_delivery_address' AND object_id=$1", [first.id])).rows[0].count;
  const otherDelete = await app.inject({ method: "DELETE", url: `/v1/me/addresses/${first.id}`,
    headers: auth(otherToken), payload: { expectedVersion: first.version + 1 } });
  // Deletion is intentionally idempotent for both absent and foreign IDs.
  expect(otherDelete.statusCode).toBe(200);
  const ownerList = (await app.inject({ url: "/v1/me/addresses", headers: auth(ownerToken) })).json().addresses;
  expect(ownerList.some((item: { id: string }) => item.id === first.id)).toBe(true);
  expect((await pool.query("SELECT count(*)::int AS count FROM audit_log WHERE object_type='member_delivery_address' AND object_id=$1", [first.id])).rows[0].count).toBe(beforeAudit);
});

it("soft-deletes an address and promotes a remaining address when needed", async () => {
  const list = (await app.inject({ url: "/v1/me/addresses", headers: auth(ownerToken) })).json().addresses;
  const currentDefault = list.find((item: { isDefault: boolean }) => item.isDefault);
  const removed = await app.inject({ method: "DELETE", url: `/v1/me/addresses/${currentDefault.id}`, headers: auth(ownerToken), payload: { expectedVersion: currentDefault.version } });
  expect(removed.statusCode).toBe(200);
  const remaining = (await app.inject({ url: "/v1/me/addresses", headers: auth(ownerToken) })).json().addresses;
  expect(remaining).toHaveLength(1);
  expect(remaining[0].isDefault).toBe(true);
  expect((await pool.query("SELECT count(*)::int AS count FROM member_delivery_address WHERE deleted_at IS NOT NULL")).rows[0].count).toBe(1);
  expect((await pool.query("SELECT count(*)::int AS count FROM audit_log WHERE object_type='member_delivery_address'")).rows[0].count).toBeGreaterThanOrEqual(4);
});
