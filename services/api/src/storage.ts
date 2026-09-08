import { createHmac, randomUUID, timingSafeEqual, createHash } from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig
} from "@aws-sdk/client-s3";
import { createPresignedPost } from "@aws-sdk/s3-presigned-post";
import type { UploadAuthorization } from "@cisme/contracts";
import type { AppConfig } from "@cisme/config";
import { DomainError } from "@cisme/domain";

export interface StoredObject {
  bytes: number;
  checksumBase64: string;
  detectedMime: "image/jpeg" | "image/png" | "image/webp";
}

export interface ObjectStorage {
  ensureReady(): Promise<void>;
  authorize(input: { mediaId: string; objectKey: string; mimeType: string; maxBytes: number; baseUrl: string; now: Date }): Promise<UploadAuthorization>;
  verify(objectKey: string): Promise<StoredObject>;
  delete(objectKey: string): Promise<void>;
  acceptsGatewayUpload: boolean;
  writeGatewayObject?(input: { token: string; mediaId: string; objectKey: string; bytes: Uint8Array; mimeType: string; now: Date }): Promise<StoredObject>;
}

function checksum(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("base64");
}

function detectImageMime(bytes: Uint8Array): StoredObject["detectedMime"] {
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 8 && Buffer.from(bytes.slice(0, 8)).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (bytes.length >= 12 && Buffer.from(bytes.slice(0, 4)).toString("ascii") === "RIFF" && Buffer.from(bytes.slice(8, 12)).toString("ascii") === "WEBP") return "image/webp";
  throw new DomainError("UPLOAD_CONTENT_INVALID", "Uploaded bytes are not an allowed image format", 422);
}

function s3Client(config: AppConfig): S3Client {
  const clientConfig: S3ClientConfig = {
    region: config.objectStorage.region,
    forcePathStyle: true,
    ...(config.objectStorage.endpoint ? { endpoint: config.objectStorage.endpoint } : {}),
    ...(config.objectStorage.accessKeyId && config.objectStorage.secretAccessKey
      ? { credentials: { accessKeyId: config.objectStorage.accessKeyId, secretAccessKey: config.objectStorage.secretAccessKey } }
      : {})
  };
  return new S3Client(clientConfig);
}

export function createS3Storage(config: AppConfig): ObjectStorage {
  const client = s3Client(config);
  const bucket = config.objectStorage.bucket;
  return {
    acceptsGatewayUpload: false,
    async ensureReady() {
      try {
        await client.send(new HeadBucketCommand({ Bucket: bucket }));
      } catch {
        await client.send(new CreateBucketCommand({ Bucket: bucket }));
      }
    },
    async authorize(input) {
      validateUploadAuthorization(input);
      const result = await createPresignedPost(client, {
        Bucket: bucket,
        Key: input.objectKey,
        Expires: 600,
        Fields: {
          "Content-Type": input.mimeType,
          "x-amz-meta-media-id": input.mediaId
        },
        Conditions: [
          ["content-length-range", 1, input.maxBytes],
          ["eq", "$Content-Type", input.mimeType],
          ["eq", "$x-amz-meta-media-id", input.mediaId]
        ]
      });
      return {
        mediaId: input.mediaId,
        method: "POST",
        url: result.url,
        fields: result.fields,
        expiresAt: new Date(input.now.getTime() + 600_000).toISOString()
      };
    },
    async verify(objectKey) {
      const head = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: objectKey }));
      const object = await client.send(new GetObjectCommand({ Bucket: bucket, Key: objectKey }));
      const bytes = await object.Body?.transformToByteArray();
      if (!bytes) throw new DomainError("MEDIA_NOT_FOUND", "Uploaded object is empty", 422);
      return { bytes: Number(head.ContentLength ?? bytes.length), checksumBase64: checksum(bytes), detectedMime: detectImageMime(bytes) };
    },
    async delete(objectKey) {
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: objectKey }));
    }
  };
}

function gatewaySignature(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

export function createApiGatewayStorage(config: AppConfig): ObjectStorage {
  const directory = resolve(process.cwd(), "tmp/object-storage");
  const secret = config.objectStorage.uploadTokenSecret;
  return {
    acceptsGatewayUpload: true,
    async ensureReady() {
      await mkdir(directory, { recursive: true });
    },
    async authorize(input) {
      validateUploadAuthorization(input);
      const expires = input.now.getTime() + 600_000;
      const payload = Buffer.from(JSON.stringify({ mediaId: input.mediaId, objectKey: input.objectKey, mimeType: input.mimeType, maxBytes: input.maxBytes, expires })).toString("base64url");
      const token = `${payload}.${gatewaySignature(payload, secret)}`;
      return {
        mediaId: input.mediaId,
        method: "POST",
        url: `${input.baseUrl}/v1/uploads/${input.mediaId}`,
        fields: { token },
        expiresAt: new Date(expires).toISOString()
      };
    },
    async writeGatewayObject(input) {
      const claims = validateGatewayUpload(input, secret);
      const detectedMime = detectImageMime(input.bytes);
      await writeFile(resolve(directory, claims.objectKey.replaceAll("/", "__")), input.bytes, { flag: "w" });
      return { bytes: input.bytes.length, checksumBase64: checksum(input.bytes), detectedMime };
    },
    async verify(objectKey) {
      const bytes = await readFile(resolve(directory, objectKey.replaceAll("/", "__")));
      return { bytes: bytes.length, checksumBase64: checksum(bytes), detectedMime: detectImageMime(bytes) };
    },
    async delete(objectKey) {
      try { await unlink(resolve(directory, objectKey.replaceAll("/", "__"))); } catch { /* idempotent */ }
    }
  };
}

type GatewayUploadInput = Parameters<NonNullable<ObjectStorage["writeGatewayObject"]>>[0];

function validateUploadAuthorization(input: { maxBytes: number; mimeType: string }) {
  if (!Number.isInteger(input.maxBytes) || input.maxBytes < 1 || input.maxBytes > 10 * 1024 * 1024) {
    throw new DomainError("UPLOAD_SIZE_INVALID", "Upload authorization requires a valid size limit", 422);
  }
  if (!["image/jpeg", "image/png", "image/webp"].includes(input.mimeType)) {
    throw new DomainError("UPLOAD_CONTENT_INVALID", "Upload format is not allowed", 422);
  }
}

function validateGatewayUpload(input: GatewayUploadInput, secret: string) {
  const [payload, supplied, extra] = input.token.split(".");
  if (!payload || !supplied || extra !== undefined) throw new DomainError("UPLOAD_TOKEN_INVALID", "Upload token is invalid", 401);
  const expected = gatewaySignature(payload, secret);
  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw new DomainError("UPLOAD_TOKEN_INVALID", "Upload token is invalid", 401);
  const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { mediaId: string; objectKey: string; mimeType: string; maxBytes: number; expires: number };
  if (!Number.isFinite(claims.expires) || claims.expires <= input.now.getTime() || claims.mediaId !== input.mediaId || claims.objectKey !== input.objectKey || (input.mimeType !== "application/octet-stream" && claims.mimeType !== input.mimeType)) {
    throw new DomainError("UPLOAD_TOKEN_INVALID", "Upload token claims do not match", 401);
  }
  validateUploadAuthorization(claims);
  if (input.bytes.length < 1 || input.bytes.length > claims.maxBytes) throw new DomainError("UPLOAD_SIZE_INVALID", "Upload size is outside the authorized range", 422);
  return claims;
}

export function createS3GatewayStorage(config: AppConfig): ObjectStorage {
  const persistent = createS3Storage(config);
  const authorization = createApiGatewayStorage(config);
  const client = s3Client(config);
  return {
    ...persistent,
    acceptsGatewayUpload: true,
    authorize: authorization.authorize,
    async writeGatewayObject(input) {
      const claims = validateGatewayUpload(input, config.objectStorage.uploadTokenSecret);
      const detectedMime = detectImageMime(input.bytes);
      if (detectedMime !== claims.mimeType) throw new DomainError("UPLOAD_CONTENT_MISMATCH", "Image content does not match authorization", 422);
      await client.send(new PutObjectCommand({
        Bucket: config.objectStorage.bucket,
        Key: claims.objectKey,
        Body: input.bytes,
        ContentType: claims.mimeType,
        Metadata: { "media-id": claims.mediaId }
      }));
      return { bytes: input.bytes.length, checksumBase64: checksum(input.bytes), detectedMime };
    }
  };
}

export function createObjectStorage(config: AppConfig): ObjectStorage {
  if (config.objectStorage.driver === "s3_gateway") return createS3GatewayStorage(config);
  if (config.objectStorage.driver === "api_gateway") return createApiGatewayStorage(config);
  return createS3Storage(config);
}

export function objectKey(submissionId: string, kind: string): string {
  return `submissions/${submissionId}/${kind}/${randomUUID()}`;
}
