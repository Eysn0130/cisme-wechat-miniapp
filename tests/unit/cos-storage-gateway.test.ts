import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import COS from "cos-nodejs-sdk-v5";
import { loadConfig } from "@cisme/config";
import { createObjectStorage } from "../../services/api/src/storage";

const config = loadConfig({ APP_ENV: "test", DATABASE_URL: "postgres://unused", APP_SESSION_SECRET: "session", ADMIN_API_TOKEN: "admin", UPLOAD_TOKEN_SECRET: "gateway-test-secret", OBJECT_STORAGE_DRIVER: "cos_gateway", S3_BUCKET: "private-evidence" });
const image = Buffer.from([0xff, 0xd8, 0xff, 0x00]);
const now = new Date("2026-09-09T00:00:00Z");
async function authorization() {
  const storage = createObjectStorage(config);
  const auth = await storage.authorize({ mediaId: "media", objectKey: "submission/original", mimeType: "image/jpeg", maxBytes: 4, baseUrl: "https://api.example", now });
  return { storage, auth, input: { mediaId: "media", objectKey: "submission/original", mimeType: "image/jpeg", bytes: image, token: auth.fields.token!, now } };
}
afterEach(() => vi.restoreAllMocks());
describe("persistent COS upload gateway", () => {
  // The gateway refuses versioned buckets before authorization or writes.
  // These isolated cases exercise its signature and payload contract without
  // requiring a real COS bucket or network access.
  beforeEach(() => vi.spyOn(COS.prototype, "getBucketVersioning").mockResolvedValue({ VersioningConfiguration: {} } as never));
  it("issues a short-lived key-bound PUT when direct upload is explicitly enabled", async () => {
    const direct = loadConfig({ APP_ENV: "test", DATABASE_URL: "postgres://unused", APP_SESSION_SECRET: "session", ADMIN_API_TOKEN: "admin", UPLOAD_TOKEN_SECRET: "gateway-test-secret", OBJECT_STORAGE_DRIVER: "cos_gateway", S3_BUCKET: "private-evidence", S3_REGION: "ap-shanghai", S3_ACCESS_KEY_ID: "secret-id", S3_SECRET_ACCESS_KEY: "secret-key", COS_DIRECT_UPLOAD_ENABLED: "true" });
    const storage = createObjectStorage(direct);
    const auth = await storage.authorize({ mediaId: "media", objectKey: "submission/original one.jpg", mimeType: "image/jpeg", maxBytes: 4, baseUrl: "https://api.example", now });
    expect(storage.acceptsGatewayUpload).toBe(false);
    expect(auth).toMatchObject({ method: "PUT", url: "https://private-evidence.cos.ap-shanghai.myqcloud.com/submission/original%20one.jpg", fields: {}, headers: { "Content-Type": "image/jpeg", "x-cos-meta-media-id": "media", "x-cos-forbid-overwrite": "true" } });
    expect(auth.headers?.Authorization).toContain("q-sign-algorithm=sha1");
    expect(auth.expiresAt).toBe("2026-09-09T00:10:00.000Z");
  });
  it("keeps wx.uploadFile POST and writes verified bytes to private COS", async () => {
    const send = vi.spyOn(COS.prototype, "putObject").mockResolvedValue({} as never);
    const { storage, auth, input } = await authorization();
    expect(auth.method).toBe("POST");
    expect(auth.url).toBe("https://api.example/v1/uploads/media");
    expect(storage.acceptsGatewayUpload).toBe(true);
    const result = await storage.writeGatewayObject!(input);
    expect(result.bytes).toBe(4);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![0]).toMatchObject({ Bucket: "private-evidence", Key: "submission/original", Body: image, ContentType: "image/jpeg", "x-cos-meta-media-id": "media" });
  });
  it.each(["oversize", "expired", "key", "media", "mime", "signature", "content"])("rejects %s before writing COS", async (scenario) => {
    const send = vi.spyOn(COS.prototype, "putObject").mockResolvedValue({} as never);
    const { storage, input } = await authorization();
    if (scenario === "oversize") input.bytes = Buffer.concat([image, Buffer.alloc(1)]);
    if (scenario === "expired") input.now = new Date(now.getTime() + 600_001);
    if (scenario === "key") input.objectKey = "someone/else";
    if (scenario === "media") input.mediaId = "someone-else";
    if (scenario === "mime") input.mimeType = "image/png";
    if (scenario === "signature") input.token += ".extra";
    if (scenario === "content") input.bytes = Buffer.from("nope");
    await expect(storage.writeGatewayObject!(input)).rejects.toThrow();
    expect(send).not.toHaveBeenCalled();
  });
  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, 0.5, 10 * 1024 * 1024 + 1])("does not issue invalid byte limits (%s)", async (maxBytes) => {
    await expect(createObjectStorage(config).authorize({ mediaId: "media", objectKey: "key", mimeType: "image/jpeg", maxBytes, baseUrl: "https://api.example", now })).rejects.toThrow("valid size limit");
  });
});
