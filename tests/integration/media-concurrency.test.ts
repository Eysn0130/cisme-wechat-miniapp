import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { loadConfig } from "@cisme/config";
import { TEST_DATABASE_URL, resetDatabase, testPool } from "@cisme/testkit";
import { SupportService } from "../../services/api/src/supportService";
import { AuthorityService } from "../../services/api/src/authority";
import { PlatformService } from "../../services/api/src/platformService";
import { createApiGatewayStorage } from "../../services/api/src/storage";

const pool = testPool();
const config = loadConfig({ APP_ENV: "test", DATABASE_URL: TEST_DATABASE_URL, APP_SESSION_SECRET: "media-test", ADMIN_API_TOKEN: "media-admin", UPLOAD_TOKEN_SECRET: "media-upload", OBJECT_STORAGE_DRIVER: "api_gateway" });
const storage = createApiGatewayStorage(config);
const service = new PlatformService(pool, config, storage);
const support = new SupportService(pool,new AuthorityService(pool,"test"),service,storage);
let memberId: string;
let fixtureNumber = 0;
const objects = new Set<string>();
beforeAll(async () => {
  await resetDatabase(pool);
  memberId = (await pool.query("INSERT INTO member(display_name) VALUES ('媒体并发测试') RETURNING id")).rows[0].id;
  await storage.ensureReady();
});
afterEach(() => vi.restoreAllMocks());
afterAll(async () => { for (const key of objects) await storage.delete(key); await pool.end(); });
async function fixture() {
  const authorization = await support.authorizeSupportMedia(memberId,`member:${memberId}`,{mimeType:"image/jpeg",maxBytes:2048,baseUrl:"http://localhost"},"media-fixture");
  const mediaId = authorization.mediaId;
  const key = (await pool.query("SELECT object_key FROM media_object WHERE id=$1", [mediaId])).rows[0].object_key as string;
  objects.add(key);
  const input = { token: authorization.fields.token!, bytes: Buffer.from([0xff, 0xd8, 0xff, ++fixtureNumber]), mimeType: "image/jpeg" };
  await service.gatewayUpload(mediaId, input, new Date());
  return { mediaId, key, input };
}

describe("shared support media storage locking", () => {
  it("blocks a token replay during verification and preserves the verified bytes", async () => {
    const f = await fixture();
    const actualVerify = storage.verify.bind(storage);
    let release!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    let entered!: () => void;
    const verificationStarted = new Promise<void>(resolve => { entered = resolve; });
    vi.spyOn(storage, "verify").mockImplementation(async key => { const result = await actualVerify(key); entered(); await barrier; return result; });
    const write = vi.spyOn(storage, "writeGatewayObject");
    const complete = support.completeSupportMedia(memberId,`member:${memberId}`,f.mediaId,"media-complete");
    await verificationStarted;
    const replay = service.gatewayUpload(f.mediaId, { ...f.input, bytes: Buffer.from([0xff, 0xd8, 0xff, 99]) }, new Date()).then(value => ({ value }), error => ({ error }));
    try {
      await vi.waitFor(async () => {
        const result = await pool.query("SELECT count(*)::int n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'SELECT status,member_id FROM support_conversation%'");
        expect(result.rows[0].n).toBeGreaterThan(0);
      });
      expect(write).not.toHaveBeenCalled();
    } finally { release(); }
    const completed = await complete;
    expect(await replay).toMatchObject({ error: { code: "MEDIA_NOT_FOUND" } });
    expect((await actualVerify(f.key)).checksumBase64).toBe((await pool.query("SELECT content_hash FROM media_object WHERE id=$1",[f.mediaId])).rows[0].content_hash);
    expect(write).not.toHaveBeenCalled();
  });

  it("returns uploaded state for concurrent support completions without re-verifying", async () => {
    const f = await fixture();
    const verify = vi.spyOn(storage, "verify");
    const results = await Promise.all([support.completeSupportMedia(memberId,`member:${memberId}`,f.mediaId,"media-complete"), support.completeSupportMedia(memberId,`member:${memberId}`,f.mediaId,"media-complete")]);
    for(const result of results)expect(result).toMatchObject({id:f.mediaId,upload_state:'uploaded',mime_type:'image/jpeg'});
    expect((await pool.query('SELECT size_bytes FROM media_object WHERE id=$1',[f.mediaId])).rows[0].size_bytes).toBe('4');
    expect(verify).toHaveBeenCalledTimes(1);
  });

  it("does not resurrect deleted media or accept an expired support upload", async () => {
    const f = await fixture();
    await support.deleteSupportMedia(memberId,`member:${memberId}`,f.mediaId,"media-delete");
    await expect(support.completeSupportMedia(memberId,`member:${memberId}`,f.mediaId,"media-complete")).rejects.toMatchObject({ code: "SUPPORT_MEDIA_NOT_FOUND" });
    const g = await fixture();
    await pool.query("UPDATE media_object SET support_expires_at=now()-interval '1 second' WHERE id=$1", [g.mediaId]);
    await expect(service.gatewayUpload(g.mediaId, g.input, new Date())).rejects.toMatchObject({ code: "UPLOAD_UNAVAILABLE" });
    await expect(support.completeSupportMedia(memberId,`member:${memberId}`,g.mediaId,"media-complete")).rejects.toMatchObject({ code: "SUPPORT_MEDIA_NOT_FOUND" });
    expect((await pool.query("SELECT upload_state FROM media_object WHERE id=$1", [f.mediaId])).rows[0].upload_state).toBe("deleted");
  });

  it("keeps a pending object available for retry after a transient verification failure", async () => {
    const f = await fixture();
    vi.spyOn(storage, "verify").mockRejectedValueOnce(new Error("temporary storage failure"));
    const remove = vi.spyOn(storage, "delete");
    await expect(support.completeSupportMedia(memberId,`member:${memberId}`,f.mediaId,"media-complete")).rejects.toThrow("temporary storage failure");
    expect(remove).not.toHaveBeenCalled();
    expect((await support.completeSupportMedia(memberId,`member:${memberId}`,f.mediaId,"media-complete")).upload_state).toBe("uploaded");
  });
});
