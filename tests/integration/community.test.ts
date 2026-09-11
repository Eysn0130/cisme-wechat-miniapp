import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { loadConfig } from "@cisme/config";
import { TEST_DATABASE_URL, resetDatabase, testPool } from "@cisme/testkit";
import { createApp } from "../../services/api/src/server";
import { createApiGatewayStorage } from "../../services/api/src/storage";
import { CommunityService } from "../../services/api/src/communityService";
const pool = testPool();
const config = loadConfig({ APP_ENV: "test", DATABASE_URL: TEST_DATABASE_URL, APP_SESSION_SECRET: "community-test", ADMIN_API_TOKEN: "community-test-admin", UPLOAD_TOKEN_SECRET: "community-test-upload", OBJECT_STORAGE_DRIVER: "api_gateway" });
let app: FastifyInstance;
let owner = "", visitor = "", commentId = "";
const base = "/v1/community/brand-scalp-ritual";
const headers = (token: string) => ({ authorization: `Bearer ${token}` });
const send = (token: string, key: string, body: string, replyToId?: string, url=base) => app.inject({ method: "POST", url: `${url}/comments`, headers: { ...headers(token), "idempotency-key": key }, payload: { body, replyToId } });
const review = (id: string) => app.inject({ method: "POST", url: `/v1/admin/community/brand-scalp-ritual/comments/${id}/review`, headers: { "x-admin-token": config.adminApiToken, "x-principal-id": "community-lead" }, payload: { decision: "published", reason: "已核对真实友善表达" } });
beforeAll(async () => {
  await resetDatabase(pool);
  app = await createApp({ config, pool, storage: createApiGatewayStorage(config) });
  for (const id of ["community-owner", "community-visitor"]) {
    const response = await app.inject({ method: "POST", url: "/v1/identity/dev", payload: { externalUserId: id, displayName: id, consents: [{ documentType: "privacy", version: "v1" }, { documentType: "terms", version: "v1" }] } });
    expect(response.statusCode).toBe(200);
    if (id === "community-owner") owner = response.json().sessionToken;
    else visitor = response.json().sessionToken;
  }
  await pool.query("INSERT INTO principal_role(principal_id,role) VALUES('community-lead','review_lead')");
});
afterAll(async () => { await app?.close(); await pool.end(); });
describe("authenticated community preview", () => {
  it("is explicitly closed outside local development and test", async () => {
    const closed = new CommunityService(pool, { ...config, env: "production", allowDevAdapters: true });
    expect(closed.enabled()).toBe(false);
    await expect(closed.read("brand-scalp-ritual")).rejects.toMatchObject({ code: "COMMUNITY_PREVIEW_CLOSED" });
    expect((await app.inject({ method: "GET", url: "/v1/community/arbitrary" })).statusCode).toBe(404);
    expect((await app.inject({ method: "PUT", url: `${base}/reaction`, payload: { kind: "like", active: true } })).statusCode).toBe(401);
  });
  it("persists explicit reaction state without duplicate counts", async () => {
    const write = () => app.inject({ method: "PUT", url: `${base}/reaction`, headers: headers(owner), payload: { kind: "like", active: true } });
    const results = await Promise.all([write(),write()]);
    expect(results.every(r => r.statusCode === 200)).toBe(true);
    const own = (await app.inject({ method: "GET", url: base, headers: headers(owner) })).json();
    expect(own).toMatchObject({ liked: true, likeCount: 1 });
    expect((await app.inject({ method: "GET", url: base })).json()).toMatchObject({ liked: false, likeCount: 1 });
    const removed = await app.inject({ method: "PUT", url: `${base}/reaction`, headers: headers(owner), payload: { kind: "like", active: false } });
    expect(removed.statusCode).toBe(200);
    expect(removed.json()).toMatchObject({ liked: false, likeCount: 0 });
    expect((await write()).statusCode).toBe(200);
    expect((await app.inject({ method: "PUT", url: `${base}/reaction`, headers: headers(owner), payload: { kind: "like", active: "false" } })).statusCode).toBe(422);
  });
  it("keeps pending comments private and retries idempotent", async () => {
    const results = await Promise.all([send(owner,"comment-first-001","今天也完成护理记录"), send(owner,"comment-first-001","今天也完成护理记录")]);
    expect(results.every(r => r.statusCode === 200)).toBe(true);
    const own = results[0].json();
    expect(own.comments).toHaveLength(1);
    expect(own.commentCount).toBe(0);
    commentId = own.comments[0].id;
    expect((await app.inject({ method: "GET", url: base, headers: headers(visitor) })).json().comments).toEqual([]);
    expect((await send(owner,"comment-first-001","变更同一提交的文字")).statusCode).toBe(409);
    expect((await send(visitor,"comment-pending-reply","回复未发布的评论",commentId)).statusCode).toBe(409);
  });
  it("requires review authority, records audit, and publishes nested replies", async () => {
    const denied = await app.inject({ method: "POST", url: `/v1/admin/community/brand-scalp-ritual/comments/${commentId}/review`, headers: { "x-admin-token": config.adminApiToken, "x-principal-id": "unprivileged" }, payload: { decision: "published", reason: "测试审核权限" } });
    expect(denied.statusCode).toBe(403);
    expect((await review(commentId)).statusCode).toBe(200);
    const reply = await send(visitor,"comment-reply-001","我也在坚持记录",commentId);
    expect(reply.statusCode).toBe(200);
    const replyId = reply.json().comments.find((c: any) => c.status === "pending").id;
    expect((await review(replyId)).statusCode).toBe(200);
    const nested = await send(owner,"comment-nested-001","一起坚持下去",replyId);
    expect(nested.json().comments.find((c: any) => c.status === "pending")).toMatchObject({ parentId: commentId, replyToId: replyId, replyToName: "CISME 会员" });
    const other = await send(visitor,"comment-crosspost-001","不能跨作品回复",commentId,"/v1/community/brand-care-journal");
    expect(other.statusCode).toBe(409);
    expect((await pool.query("SELECT count(*)::int count FROM audit_log WHERE action='community_comment_review'")).rows[0].count).toBe(2);
  });
  it("supports comment likes and protects deletion ownership", async () => {
    const liked = await app.inject({ method: "PUT", url: `${base}/comments/${commentId}/like`, headers: headers(visitor), payload: { active: true } });
    expect(liked.json().comments.find((c: any) => c.id === commentId)).toMatchObject({ liked: true, likeCount: 1 });
    expect((await app.inject({ method: "DELETE", url: `${base}/comments/${commentId}`, headers: headers(visitor) })).statusCode).toBe(404);
    expect((await app.inject({ method: "DELETE", url: `${base}/comments/${commentId}`, headers: headers(owner) })).statusCode).toBe(200);
    const state = (await app.inject({ method: "GET", url: base })).json();
    expect(state.comments.find((c: any) => c.id === commentId)).toMatchObject({ status: "deleted", body: "这条评论已删除" });
    expect(state.commentCount).toBe(1);
  });
  it("never exposes a deleted pending comment to other members", async () => {
    const created = await send(owner,"private-delete-001","这条尚未审核的评论");
    const id = created.json().comments.find((c: any) => c.body === "这条尚未审核的评论").id;
    await app.inject({ method: "DELETE", url: `${base}/comments/${id}`, headers: headers(owner) });
    expect((await app.inject({ method: "GET", url: base })).json().comments.some((c: any) => c.id === id)).toBe(false);
  });
  it("paginates comments with a stable non-overlapping cursor", async () => {
    await pool.query(`INSERT INTO community_comment(post_id,member_id,body,status,operation_id,was_public)
      SELECT 'brand-scalp-ritual',id,'分页边界评论','published','pagination-boundary',true FROM member WHERE display_name='community-visitor'`);
    const first = (await app.inject({ method: "GET", url: `${base}?limit=2` })).json();
    expect(first.comments).toHaveLength(2);
    expect(first.nextCursor).toEqual(expect.any(String));
    expect(first.asOf).toEqual(expect.any(String));
    const second = (await app.inject({ method: "GET", url: `${base}?limit=2&cursor=${encodeURIComponent(first.nextCursor)}` })).json();
    expect(second.comments.map((row: any) => row.id)).not.toEqual(expect.arrayContaining(first.comments.map((row: any) => row.id)));
    expect((await app.inject({ method: "GET", url: `${base}?cursor=broken` })).statusCode).toBe(422);
  });
  it("keeps transactional aggregate counters exact across member suspension", async () => {
    const visitorId = (await pool.query("SELECT id FROM member WHERE display_name='community-visitor'")).rows[0].id;
    const before = (await app.inject({ method: "GET", url: base })).json();
    expect(before.aggregateVersion).toEqual(expect.any(Number));
    await pool.query("UPDATE member SET status='blocked' WHERE id=$1", [visitorId]);
    const suspended = (await app.inject({ method: "GET", url: base })).json();
    expect(suspended.commentCount).toBe(before.commentCount - 2);
    await pool.query("UPDATE member SET status='active' WHERE id=$1", [visitorId]);
    const restored = (await app.inject({ method: "GET", url: base })).json();
    expect(restored.commentCount).toBe(before.commentCount);
    expect(restored.aggregateVersion).toBeGreaterThan(before.aggregateVersion);
  });
});
