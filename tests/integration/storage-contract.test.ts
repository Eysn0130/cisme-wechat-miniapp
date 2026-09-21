import { afterAll, describe, expect, it } from "vitest";
import { createS3Storage, objectKey } from "../../services/api/src/storage";
import { loadConfig } from "@cisme/config";

const runId=process.env.CISME_TEST_RUN_ID,endpoint=process.env.CISME_TEST_S3_ENDPOINT;
if(!runId||!endpoint||!/^http:\/\/127\.0\.0\.1:[0-9]+$/.test(endpoint)||new URL(endpoint).port==='58333'||
  process.env.CISME_TEST_S3_BUCKET!==`cisme-${runId}`||!process.env.CISME_TEST_S3_ACCESS_KEY||!process.env.CISME_TEST_S3_SECRET)
  throw new Error('DISPOSABLE_S3_REQUIRED');
const config = loadConfig({
  APP_ENV: "test", DATABASE_URL: "postgres://unused", APP_SESSION_SECRET: "test-session", ADMIN_API_TOKEN: "test-admin", UPLOAD_TOKEN_SECRET: "test-upload",
  OBJECT_STORAGE_DRIVER: "s3", S3_ENDPOINT: endpoint, S3_REGION: "us-east-1", S3_BUCKET: process.env.CISME_TEST_S3_BUCKET,
  S3_ACCESS_KEY_ID: process.env.CISME_TEST_S3_ACCESS_KEY, S3_SECRET_ACCESS_KEY: process.env.CISME_TEST_S3_SECRET
});
const storage = createS3Storage(config);
let key = "";

describe("wx.uploadFile-compatible SeaweedFS contract", () => {
  it("supports path-style SigV4 multipart POST, HEAD, checksum and delete", async () => {
    await storage.ensureReady();
    key = objectKey("11111111-1111-4111-8111-111111111111", "original");
    const authorization = await storage.authorize({ mediaId: "22222222-2222-4222-8222-222222222222", objectKey: key, mimeType: "image/jpeg", maxBytes: 1024, baseUrl: "http://unused", now: new Date() });
    const form = new FormData();
    for (const [name, value] of Object.entries(authorization.fields)) form.set(name, value);
    form.set("file", new Blob([Buffer.from([0xff, 0xd8, 0xff, ...Buffer.from("cisme-storage-contract")])], { type: "image/jpeg" }), "care.jpg");
    const response = await fetch(authorization.url, { method: "POST", body: form });
    expect(response.status, await response.text()).toBeGreaterThanOrEqual(200);
    expect(response.status).toBeLessThan(300);
    const verified = await storage.verify(key);
    expect(verified.bytes).toBe(25);
    expect(verified.detectedMime).toBe("image/jpeg");
    expect(verified.checksumBase64).toMatch(/^[A-Za-z0-9+/]+=*$/);
    await storage.delete(key);
    key = "";
  }, 30_000);
});

afterAll(async () => { if (key) await storage.delete(key); });
