import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { loadConfig } from "@cisme/config";
import { createApiGatewayStorage } from "../../services/api/src/storage";

const config = loadConfig({ APP_ENV: "test", DATABASE_URL: "postgres://unused",
  APP_SESSION_SECRET: "synthetic-session", UPLOAD_TOKEN_SECRET: "synthetic-upload", OBJECT_STORAGE_DRIVER: "api_gateway" });

afterEach(() => vi.restoreAllMocks());

it("creates the isolated local object directory on first authorized write without an earlier ensureReady call", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "cisme-pr3-storage-"));
  vi.spyOn(process, "cwd").mockReturnValue(directory);
  try {
    const storage = createApiGatewayStorage(config);
    const now = new Date();
    const bytes = Buffer.from([0xff, 0xd8, 0xff, 0x00]);
    const auth = await storage.authorize({ mediaId: "synthetic-media", objectKey: "support/synthetic/image",
      mimeType: "image/jpeg", maxBytes: bytes.length, baseUrl: "http://127.0.0.1:18191", now });
    expect(await readdir(directory)).toEqual([]);
    await storage.writeGatewayObject!({ token: auth.fields.token!, mediaId: "synthetic-media",
      objectKey: "support/synthetic/image", bytes, mimeType: "image/jpeg", now });
    expect((await storage.read("support/synthetic/image")).bytes).toEqual(bytes);
    await storage.delete("support/synthetic/image");
    expect(await readdir(resolve(directory, "tmp/object-storage"))).toEqual([]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
