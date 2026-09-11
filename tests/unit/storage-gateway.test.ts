import { afterEach, describe, expect, it, vi } from "vitest";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { loadConfig } from "@cisme/config";
import { createObjectStorage } from "../../services/api/src/storage";

const config = loadConfig({ APP_ENV: "test", DATABASE_URL: "postgres://unused", APP_SESSION_SECRET: "session", ADMIN_API_TOKEN: "admin", UPLOAD_TOKEN_SECRET: "gateway-test-secret", OBJECT_STORAGE_DRIVER: "s3_gateway", S3_BUCKET: "private-evidence" });
const image = Buffer.from([0xff, 0xd8, 0xff, 0x00]);
const now = new Date("2026-09-09T00:00:00Z");
async function authorization() {
  const storage = createObjectStorage(config);
  const auth = await storage.authorize({ mediaId: "media", objectKey: "submission/original", mimeType: "image/jpeg", maxBytes: 4, baseUrl: "https://api.example", now });
  return { storage, auth, input: { mediaId: "media", objectKey: "submission/original", mimeType: "image/jpeg", bytes: image, token: auth.fields.token!, now } };
}
afterEach(() => vi.restoreAllMocks());
describe("persistent S3 upload gateway", () => {
  it("keeps wx.uploadFile POST and writes verified bytes to private S3", async () => {
    const send = vi.spyOn(S3Client.prototype, "send").mockResolvedValue({} as never);
    const { storage, auth, input } = await authorization();
    expect(auth.method).toBe("POST");
    expect(auth.url).toBe("https://api.example/v1/uploads/media");
    expect(storage.acceptsGatewayUpload).toBe(true);
    const result = await storage.writeGatewayObject!(input);
    expect(result.bytes).toBe(4);
    expect(send).toHaveBeenCalledTimes(1);
    const command = send.mock.calls[0]![0] as PutObjectCommand;
    expect(command).toBeInstanceOf(PutObjectCommand);
    expect(command.input).toMatchObject({ Bucket: "private-evidence", Key: "submission/original", Body: image, ContentType: "image/jpeg", Metadata: { "media-id": "media" } });
  });
  it.each(["oversize", "expired", "key", "media", "mime", "signature", "content"])("rejects %s before writing S3", async (scenario) => {
    const send = vi.spyOn(S3Client.prototype, "send").mockResolvedValue({} as never);
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
