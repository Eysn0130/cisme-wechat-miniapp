import { createHash } from "node:crypto";
import { expect,it,vi } from "vitest";
import type COS from "cos-nodejs-sdk-v5";
import { loadConfig } from "@cisme/config";
import { createCosGatewayStorage } from "../../services/api/src/storage";

it("refuses versioned buckets and pins UGC uploads to byte-identical retry only",async()=>{
  const config=loadConfig({APP_ENV:"test",DATABASE_URL:"postgres://unused/cisme_test",
    APP_SESSION_SECRET:"cos-immutability-session",ADMIN_API_TOKEN:"cos-immutability-admin",
    UPLOAD_TOKEN_SECRET:"cos-immutability-upload",OBJECT_STORAGE_DRIVER:"cos_gateway",
    S3_BUCKET:"fixture-bucket",S3_REGION:"ap-shanghai"});
  const objects=new Map<string,Buffer>();let versioned=true;
  const client={
    headBucket:async()=>({}),
    getBucketVersioning:async()=>({VersioningConfiguration:versioned?{Status:"Enabled"}:{}}),
    putObject:async(input:{Key:string;Body:Buffer;Headers:Record<string,string>})=>{
      expect(input.Headers["x-cos-forbid-overwrite"]).toBe("true");
      if(objects.has(input.Key))throw new Error("ObjectAlreadyExists");
      objects.set(input.Key,Buffer.from(input.Body));return {};
    },
    getObject:async(input:{Key:string})=>{
      const Body=objects.get(input.Key);if(!Body)throw new Error("NoSuchKey");return {Body};
    },
  } as unknown as COS;
  const storage=createCosGatewayStorage(config,client);
  const key="ugc/fixture/post/media",mediaId="00000000-0000-4000-8000-000000000001";
  const input={mediaId,objectKey:key,mimeType:"image/png",maxBytes:100,
    baseUrl:"https://upload.example.test",now:new Date()};
  await expect(storage.authorize(input)).rejects.toMatchObject({code:"UGC_BUCKET_VERSIONING_UNSAFE"});
  versioned=false;
  const auth=await storage.authorize(input);
  const bytes=Buffer.from([137,80,78,71,13,10,26,10,1,2,3]);
  const upload={token:auth.fields.token!,mediaId,objectKey:key,bytes,mimeType:"image/png",now:new Date()};
  expect((await storage.writeGatewayObject!(upload)).bytes).toBe(bytes.length);
  expect((await storage.writeGatewayObject!(upload)).bytes).toBe(bytes.length);
  await expect(storage.writeGatewayObject!({...upload,bytes:Buffer.from([...bytes,4])}))
    .rejects.toThrow("ObjectAlreadyExists");
  expect(objects.get(key)).toEqual(bytes);
  const derived=Buffer.from("RIFF0000WEBP", "ascii");
  await storage.writeDerivedImage("ugc-derived/fixture/detail.webp",derived);
  await storage.writeDerivedImage("ugc-derived/fixture/detail.webp",derived);
  await expect(storage.writeDerivedImage("ugc-derived/fixture/detail.webp",
    Buffer.concat([derived,Buffer.from([1])]))).rejects.toThrow("ObjectAlreadyExists");
  versioned=true;
  await expect(storage.ensureReady()).rejects.toMatchObject({code:"UGC_BUCKET_VERSIONING_UNSAFE"});
});

it("uses object-only readiness and upload checks for a confirmed Lighthouse bucket",async()=>{
  const marker=Buffer.from("CISME object readiness\n");
  const markerKey="submissions/fixture/probe/readiness.txt";
  const markerSha=createHash("sha256").update(marker).digest("hex");
  const config=loadConfig({APP_ENV:"test",DATABASE_URL:"postgres://unused/cisme_test",
    APP_SESSION_SECRET:"cos-light-session",ADMIN_API_TOKEN:"cos-light-admin",
    UPLOAD_TOKEN_SECRET:"cos-light-upload",OBJECT_STORAGE_DRIVER:"cos_gateway",
    COS_BUCKET_PRODUCT:"lighthouse",COS_READINESS_OBJECT_KEY:markerKey,
    COS_READINESS_OBJECT_SHA256:markerSha,S3_BUCKET:"lhcos-81ddf-1257392443",S3_REGION:"ap-shanghai"});
  const headBucket=vi.fn(async()=>{throw new Error("BUCKET_API_UNSUPPORTED")});
  const getBucketVersioning=vi.fn(async()=>{throw new Error("BUCKET_API_UNSUPPORTED")});
  const putObject=vi.fn(async()=>({}));
  const client={headBucket,getBucketVersioning,
    headObject:vi.fn(async()=>({headers:{"content-length":String(marker.length)}})),
    getObject:vi.fn(async()=>({Body:marker})),putObject} as unknown as COS;
  const storage=createCosGatewayStorage(config,client);
  await storage.ensureReady();
  const now=new Date("2026-09-26T00:00:00Z");
  const mediaId="00000000-0000-4000-8000-000000000001";
  const objectKey="submissions/fixture/original/image.png";
  const auth=await storage.authorize({mediaId,objectKey,mimeType:"image/png",maxBytes:100,
    baseUrl:"https://api.example.test",now});
  const bytes=Buffer.from([137,80,78,71,13,10,26,10,1,2,3]);
  await storage.writeGatewayObject!({token:auth.fields.token!,mediaId,objectKey,bytes,mimeType:"image/png",now});
  expect(putObject).toHaveBeenCalledWith(expect.objectContaining({Key:objectKey,Headers:{"x-cos-forbid-overwrite":"true"}}));
  expect(headBucket).not.toHaveBeenCalled();
  expect(getBucketVersioning).not.toHaveBeenCalled();
  const wrong=loadConfig({...configToEnv(),COS_READINESS_OBJECT_SHA256:"0".repeat(64)});
  await expect(createCosGatewayStorage(wrong,client).ensureReady()).rejects.toThrow("COS_READINESS_OBJECT_MISMATCH");

  function configToEnv(){return {APP_ENV:"test",DATABASE_URL:"postgres://unused/cisme_test",
    APP_SESSION_SECRET:"cos-light-session",ADMIN_API_TOKEN:"cos-light-admin",UPLOAD_TOKEN_SECRET:"cos-light-upload",
    OBJECT_STORAGE_DRIVER:"cos_gateway",COS_BUCKET_PRODUCT:"lighthouse",COS_READINESS_OBJECT_KEY:markerKey,
    S3_BUCKET:"lhcos-81ddf-1257392443",S3_REGION:"ap-shanghai"};}
});
