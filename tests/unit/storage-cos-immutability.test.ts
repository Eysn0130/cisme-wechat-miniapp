import { expect,it } from "vitest";
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
