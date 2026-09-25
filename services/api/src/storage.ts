import { createHmac, randomUUID, timingSafeEqual, createHash } from "node:crypto";
import { mkdir, open, readFile, unlink, writeFile } from "node:fs/promises";
import { resolve, basename } from "node:path";
import { readFileSync,lstatSync } from "node:fs";
import { Writable } from "node:stream";
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
import COS from "cos-nodejs-sdk-v5";
import type { UploadAuthorization } from "@cisme/contracts";
import type { AppConfig } from "@cisme/config";
import { DomainError } from "@cisme/domain";
import { OperationBudget, assertOperationActive, currentOperationBudget, dependencySignal } from "./operationBudget.js";
import { recordMetric,recordStorageOutcome } from "./observability.js";

export interface StoredObject {
  bytes: number;
  checksumBase64: string;
  detectedMime: "image/jpeg" | "image/png" | "image/webp";
}
type ReadableMime=StoredObject["detectedMime"] | "video/mp4";

export interface ObjectStorage {
  ensureReady(): Promise<void>;
  authorize(input: { mediaId: string; objectKey: string; mimeType: string; maxBytes: number; baseUrl: string; now: Date }): Promise<UploadAuthorization>;
  verify(objectKey: string): Promise<StoredObject>;
  read(objectKey: string, maxBytes?: number): Promise<{ bytes: Uint8Array; mimeType: ReadableMime }>;
  readRange?(objectKey: string, offset: number, length: number): Promise<Uint8Array>;
  delete(objectKey: string): Promise<void>;
  writeDerivedImage(objectKey: string, bytes: Uint8Array): Promise<void>;
  acceptsGatewayUpload: boolean;
  writeGatewayObject?(input: { token: string; mediaId: string; objectKey: string; bytes: Uint8Array; mimeType: string; now: Date }): Promise<StoredObject>;
}

function observeStorage(storage: ObjectStorage): ObjectStorage {
  const timed = async <T>(work: () => Promise<T>): Promise<T> => {
    const started = performance.now();
    try { assertOperationActive(); const result = await work(); assertOperationActive(); recordStorageOutcome(true); return result; }
    catch(error){recordStorageOutcome(false);throw error;}
    finally { recordMetric("storage_ms", performance.now() - started); }
  };
  return {
    acceptsGatewayUpload: storage.acceptsGatewayUpload,
    ensureReady: () => timed(() => storage.ensureReady()),
    authorize: (input) => timed(() => storage.authorize(input)),
    verify: (key) => timed(() => storage.verify(key)),
    read: (key, maxBytes) => timed(() => storage.read(key, maxBytes)),
    ...(storage.readRange?{readRange:(key:string,offset:number,length:number)=>timed(()=>storage.readRange!(key,offset,length))}:{}),
    delete: (key) => timed(() => storage.delete(key)),
    writeDerivedImage: (key, bytes) => timed(() => storage.writeDerivedImage(key, bytes)),
    ...(storage.writeGatewayObject ? { writeGatewayObject: (input: Parameters<NonNullable<ObjectStorage["writeGatewayObject"]>>[0]) => timed(() => storage.writeGatewayObject!(input)) } : {})
  };
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

function detectReadableMime(bytes:Uint8Array):ReadableMime {
  // Legacy owned videos may need a privacy copy. Upload validation remains
  // image-only; reading an existing MP4 does not enable a new upload path.
  if(bytes.length>=12&&Buffer.from(bytes.subarray(4,8)).toString("ascii")==="ftyp")return "video/mp4";
  return detectImageMime(bytes);
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

function checkedReadLimit(maxBytes:number|undefined):number|undefined {
  if(maxBytes!==undefined&&(!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>64*1024*1024))
    throw new DomainError("STORAGE_READ_LIMIT_INVALID","Storage read limit is invalid",422);
  return maxBytes;
}

function checkedRange(offset:number,length:number){
  if(!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(length)||length<1||length>1024*1024)
    throw new DomainError('STORAGE_RANGE_INVALID','Storage range is invalid',422);
  return `bytes=${offset}-${offset+length-1}`;
}

function readLimitExceeded():DomainError {
  return new DomainError("STORAGE_READ_LIMIT_EXCEEDED","Stored object exceeds the allowed read size",413);
}

async function readS3Body(body: { transformToByteArray(): Promise<Uint8Array> } | undefined,
  maxBytes?:number): Promise<Uint8Array | undefined> {
  if (!body) return undefined;
  assertOperationActive();
  const signal = dependencySignal(30_000);
  const destroy = () => (body as { destroy?: (reason: Error) => void }).destroy?.(new Error("STORAGE_READ_CANCELLED"));
  signal.addEventListener("abort", destroy, { once: true });
  if (signal.aborted) destroy();
  try {
    if(maxBytes===undefined){const bytes=await body.transformToByteArray();assertOperationActive();return bytes;}
    const stream=body as unknown as AsyncIterable<Uint8Array>;
    if(typeof stream[Symbol.asyncIterator]!=="function")
      throw new DomainError("STORAGE_BOUNDED_STREAM_UNAVAILABLE","Bounded object read is unavailable",503);
    const chunks:Buffer[]=[];
    let total=0;
    for await(const chunk of stream){
      assertOperationActive();
      total+=chunk.byteLength;
      if(total>maxBytes)throw readLimitExceeded();
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks,total);
  }
  finally { signal.removeEventListener("abort", destroy); }
}

async function readLocalBounded(path:string,maxBytes:number):Promise<Buffer>{
  const file=await open(path,"r");
  try{
    const bytes=Buffer.allocUnsafe(maxBytes+1);
    let total=0;
    while(total<bytes.length){
      assertOperationActive();
      const {bytesRead}=await file.read(bytes,total,bytes.length-total,total);
      if(bytesRead===0)break;
      total+=bytesRead;
    }
    if(total>maxBytes)throw readLimitExceeded();
    return bytes.subarray(0,total);
  }finally{await file.close();}
}

async function readCosBounded(client:COS,location:{Bucket:string;Region:string},objectKey:string,maxBytes:number):Promise<Buffer>{
  const chunks:Buffer[]=[];
  let total=0;
  let exceeded=false;
  const output=new Writable({write(chunk:Buffer,_encoding,done){
    total+=chunk.byteLength;
    if(total>maxBytes){exceeded=true;done(readLimitExceeded());return;}
    chunks.push(Buffer.from(chunk));
    done();
  }});
  // COS sends stream failures through both the output and its promise.
  output.on("error",()=>undefined);
  try{
    try{await client.getObject({...location,Key:objectKey,Range:`bytes=0-${maxBytes}`,Output:output});}
    catch(error){if(exceeded)throw readLimitExceeded();throw error;}
    if(exceeded)throw readLimitExceeded();
    assertOperationActive();
    return Buffer.concat(chunks,total);
  }finally{output.destroy();}
}

/** COS retries can run outside the original ALS context. Bind a request-scoped
 * client to an explicit immutable budget, never a shared SDK timeout or a
 * guessed query signal. Node's transport consumes the before-send signal. */
const budgetBoundCosClients = new WeakMap<object, OperationBudget>();
export function bindCosOperationBudget(client: COS, budget: OperationBudget): void {
  const bound = budgetBoundCosClients.get(client);
  if (bound && bound !== budget) throw new Error("COS_CLIENT_BUDGET_ALREADY_BOUND");
  if (bound || typeof client.on !== "function") return;
  budgetBoundCosClients.set(client, budget);
  client.on("before-send", (options: { signal?: AbortSignal; timeout?: number }) => {
    options.signal = budget.signal;
    try { options.timeout = Math.min(options.timeout || 30_000, budget.remaining()); }
    catch (error) { budget.abort(error); options.timeout = 1; }
  });
}

export function createS3Storage(config: AppConfig): ObjectStorage {
  const client = s3Client(config);
  const bucket = config.objectStorage.bucket;
  return {
    acceptsGatewayUpload: false,
    async ensureReady() {
      try {
        await client.send(new HeadBucketCommand({ Bucket: bucket }), { abortSignal: dependencySignal(30_000) });
      } catch (error) {
        assertOperationActive();
        if ((error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode !== 404) throw error;
        await client.send(new CreateBucketCommand({ Bucket: bucket }), { abortSignal: dependencySignal(30_000) });
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
      const head = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: objectKey }), { abortSignal: dependencySignal(30_000) });
      const object = await client.send(new GetObjectCommand({ Bucket: bucket, Key: objectKey }), { abortSignal: dependencySignal(30_000) });
      const bytes = await readS3Body(object.Body);
      if (!bytes) throw new DomainError("MEDIA_NOT_FOUND", "Uploaded object is empty", 422);
      return { bytes: Number(head.ContentLength ?? bytes.length), checksumBase64: checksum(bytes), detectedMime: detectImageMime(bytes) };
    },
    async read(objectKey,maxBytes) {
      const limit=checkedReadLimit(maxBytes);
      const object = await client.send(new GetObjectCommand({ Bucket: bucket, Key: objectKey,
        ...(limit===undefined?{}:{Range:`bytes=0-${limit}`}) }), { abortSignal: dependencySignal(30_000) });
      const bytes = await readS3Body(object.Body,limit);
      if (!bytes?.length) throw new DomainError("MEDIA_NOT_FOUND", "Uploaded object is empty", 404);
      return { bytes, mimeType: detectReadableMime(bytes) };
    },
    async readRange(objectKey,offset,length){
      const object=await client.send(new GetObjectCommand({Bucket:bucket,Key:objectKey,
        Range:checkedRange(offset,length)}),{abortSignal:dependencySignal(30_000)});
      if(object.$metadata.httpStatusCode!==206)throw new DomainError('STORAGE_RANGE_UNAVAILABLE','Stored range is unavailable',503);
      const bytes=await readS3Body(object.Body,length);
      if(!bytes||bytes.length!==length)throw new DomainError('STORAGE_RANGE_UNAVAILABLE','Stored range is incomplete',503);
      return bytes;
    },
    async delete(objectKey) {
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: objectKey }), { abortSignal: dependencySignal(30_000) });
    },
    async writeDerivedImage(objectKey, bytes) {
      if (!objectKey.startsWith("ugc-derived/") || bytes.length < 1 || bytes.length > 10 * 1024 * 1024 || detectImageMime(bytes) !== "image/webp")
        throw new DomainError("DERIVED_IMAGE_INVALID", "Derived image is invalid", 422);
      await client.send(new PutObjectCommand({ Bucket: bucket, Key: objectKey, Body: bytes, ContentType: "image/webp" }), { abortSignal: dependencySignal(30_000) });
    }
  };
}

function gatewaySignature(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

export function createApiGatewayStorage(config: AppConfig): ObjectStorage {
  let directory = resolve(process.cwd(), "tmp/object-storage");
  if(process.env.CISME_TEST_RUN_ID){
    const runId=process.env.CISME_TEST_RUN_ID,root=process.env.CISME_TEST_OBJECT_ROOT;
    if(config.databaseUrl!==process.env.CISME_TEST_OWNED_URL||!root||!root.startsWith("/")||!/^cisme-objects-[a-f0-9]{24}-/.test(basename(root))||
      !basename(root).startsWith(`cisme-objects-${runId}-`)||lstatSync(root).isSymbolicLink())
      throw new Error("DISPOSABLE_OBJECT_ROOT_REQUIRED");
    const marker=JSON.parse(readFileSync(resolve(root,".ownership.json"),"utf8"));
    if(marker.runId!==runId||marker.container!==process.env.CISME_TEST_CONTAINER_ID)
      throw new Error("DISPOSABLE_OBJECT_ROOT_MISMATCH");
    directory=resolve(root,"objects");
  }
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
      await mkdir(directory, { recursive: true });
      await writeFile(resolve(directory, claims.objectKey.replaceAll("/", "__")), input.bytes, { flag: "w", signal: dependencySignal(30_000) });
      return { bytes: input.bytes.length, checksumBase64: checksum(input.bytes), detectedMime };
    },
    async verify(objectKey) {
      const bytes = await readFile(resolve(directory, objectKey.replaceAll("/", "__")), { signal: dependencySignal(30_000) });
      return { bytes: bytes.length, checksumBase64: checksum(bytes), detectedMime: detectImageMime(bytes) };
    },
    async read(objectKey,maxBytes) {
      const limit=checkedReadLimit(maxBytes);
      const path=resolve(directory, objectKey.replaceAll("/", "__"));
      const bytes = limit===undefined
        ?await readFile(path,{signal:dependencySignal(30_000)})
        :await readLocalBounded(path,limit);
      if (!bytes.length) throw new DomainError("MEDIA_NOT_FOUND", "Uploaded object is empty", 404);
      return { bytes, mimeType: detectReadableMime(bytes) };
    },
    async readRange(objectKey,offset,length){
      checkedRange(offset,length);
      const file=await open(resolve(directory,objectKey.replaceAll('/','__')),'r');
      try{
        const bytes=Buffer.allocUnsafe(length);let total=0;
        while(total<length){
          assertOperationActive();
          const result=await file.read(bytes,total,length-total,offset+total);
          if(!result.bytesRead)break;
          total+=result.bytesRead;
        }
        if(total!==length)throw new DomainError('STORAGE_RANGE_UNAVAILABLE','Stored range is incomplete',503);
        return bytes;
      }finally{await file.close();}
    },
    async writeDerivedImage(objectKey, bytes) {
      if (!objectKey.startsWith("ugc-derived/") || bytes.length < 1 || bytes.length > 10 * 1024 * 1024 || detectImageMime(bytes) !== "image/webp")
        throw new DomainError("DERIVED_IMAGE_INVALID", "Derived image is invalid", 422);
      await mkdir(directory, { recursive: true });
      await writeFile(resolve(directory, objectKey.replaceAll("/", "__")), bytes, { flag: "w", signal: dependencySignal(30_000) });
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

export function validateGatewayUpload(input: GatewayUploadInput, secret: string) {
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
      }), { abortSignal: dependencySignal(30_000) });
      return { bytes: input.bytes.length, checksumBase64: checksum(input.bytes), detectedMime };
    }
  };
}

export function createObjectStorage(config: AppConfig): ObjectStorage {
  if (config.objectStorage.driver === "cos_gateway") return observeStorage(createCosGatewayStorage(config));
  if (config.objectStorage.driver === "s3_gateway") return observeStorage(createS3GatewayStorage(config));
  if (config.objectStorage.driver === "api_gateway") return observeStorage(createApiGatewayStorage(config));
  return observeStorage(createS3Storage(config));
}

export function createCosGatewayStorage(config: AppConfig,cosClient?:COS): ObjectStorage {
  const sdkOptions = { SecretId: config.objectStorage.accessKeyId ?? "", SecretKey: config.objectStorage.secretAccessKey ?? "",
    Protocol: "https:" as const, Timeout: 30_000 };
  const sharedClient = cosClient ?? new COS(sdkOptions);
  const scopedClients = new WeakMap<OperationBudget, COS>();
  const getClient = () => {
    const budget = currentOperationBudget();
    if (cosClient || !budget) return sharedClient;
    budget.check();
    let client = scopedClients.get(budget);
    if (!client) { client = new COS(sdkOptions); bindCosOperationBudget(client, budget); scopedClients.set(budget, client); }
    return client;
  };
  const location = { Bucket: config.objectStorage.bucket, Region: config.objectStorage.region };
  const authorization = createApiGatewayStorage(config);
  const requireNoVersioning=async()=>{
    assertOperationActive();
    const versioning=await getClient().getBucketVersioning(location);
    assertOperationActive();
    // Tencent COS documents that x-cos-forbid-overwrite is ineffective when
    // versioning has been enabled. Until pinned-version reads are implemented,
    // do not issue any UGC upload authorization for such a bucket.
    if(versioning.VersioningConfiguration?.Status)
      throw new DomainError("UGC_BUCKET_VERSIONING_UNSAFE","当前存储桶版本策略不支持不可覆盖素材",503);
  };
  const immutablePut=async(key:string,bytes:Uint8Array,mime:string,mediaId?:string)=>{
    try{
      assertOperationActive();
      await getClient().putObject({...location,Key:key,Body:Buffer.from(bytes),ContentType:mime,
        ...(mediaId?{"x-cos-meta-media-id":mediaId}:{}),Headers:{"x-cos-forbid-overwrite":"true"}});
    }catch(error){
      // Retrying after a lost response is safe only if the existing object is
      // byte-for-byte identical. A changed body must never replace evidence.
      try{
        assertOperationActive();
        const prior=await getClient().getObject({...location,Key:key});
        if(prior.Body&&Buffer.from(prior.Body).equals(Buffer.from(bytes)))return;
      }catch{/* Preserve the original write failure. */}
      throw error;
    }
  };
  return {
    acceptsGatewayUpload: !config.media.directUploadEnabled,
    async authorize(input) {
      await requireNoVersioning();
      if (!config.media.directUploadEnabled) return authorization.authorize(input);
      validateUploadAuthorization(input);
      const headers = { "Content-Type": input.mimeType, "x-cos-meta-media-id": input.mediaId, "x-cos-forbid-overwrite": "true" };
      const signature = COS.getAuthorization({ SecretId: config.objectStorage.accessKeyId!, SecretKey: config.objectStorage.secretAccessKey!, ...location, Method: "PUT", Key: input.objectKey, Headers: headers, Expires: 600 });
      const encodedKey = input.objectKey.split("/").map(encodeURIComponent).join("/");
      return {
        mediaId: input.mediaId,
        method: "PUT",
        url: `https://${location.Bucket}.cos.${location.Region}.myqcloud.com/${encodedKey}`,
        fields: {},
        headers: { ...headers, Authorization: signature },
        expiresAt: new Date(input.now.getTime() + 600_000).toISOString()
      };
    },
    async ensureReady() { await getClient().headBucket(location); await requireNoVersioning(); },
    async writeGatewayObject(input) {
      await requireNoVersioning();
      const claims = validateGatewayUpload(input, config.objectStorage.uploadTokenSecret);
      const detectedMime = detectImageMime(input.bytes);
      if (detectedMime !== claims.mimeType) throw new DomainError("UPLOAD_CONTENT_MISMATCH", "Image content does not match authorization", 422);
      await immutablePut(claims.objectKey,input.bytes,claims.mimeType,claims.mediaId);
      return { bytes: input.bytes.length, checksumBase64: checksum(input.bytes), detectedMime };
    },
    async verify(objectKey) {
      const result = await getClient().getObject({ ...location, Key: objectKey });
      const bytes = result.Body;
      if (!bytes?.length) throw new DomainError("MEDIA_NOT_FOUND", "Uploaded object is empty", 422);
      return { bytes: bytes.length, checksumBase64: checksum(bytes), detectedMime: detectImageMime(bytes) };
    },
    async read(objectKey,maxBytes) {
      const limit=checkedReadLimit(maxBytes);
      const bytes = limit===undefined
        ?(await getClient().getObject({ ...location, Key: objectKey })).Body
        :await readCosBounded(getClient(),location,objectKey,limit);
      if (!bytes?.length) throw new DomainError("MEDIA_NOT_FOUND", "Uploaded object is empty", 404);
      return { bytes, mimeType: detectReadableMime(bytes) };
    },
    async readRange(objectKey,offset,length){
      const result=await getClient().getObject({...location,Key:objectKey,Range:checkedRange(offset,length)});
      if(result.statusCode!==206||!result.Body||result.Body.length!==length)
        throw new DomainError('STORAGE_RANGE_UNAVAILABLE','Stored range is incomplete',503);
      return result.Body;
    },
    async delete(objectKey) { await getClient().deleteObject({ ...location, Key: objectKey }); },
    async writeDerivedImage(objectKey, bytes) {
      if (!objectKey.startsWith("ugc-derived/") || bytes.length < 1 || bytes.length > 10 * 1024 * 1024 || detectImageMime(bytes) !== "image/webp")
        throw new DomainError("DERIVED_IMAGE_INVALID", "Derived image is invalid", 422);
      await requireNoVersioning();
      await immutablePut(objectKey,bytes,"image/webp");
    }
  };
}

export function objectKey(submissionId: string, kind: string): string {
  return `submissions/${submissionId}/${kind}/${randomUUID()}`;
}
