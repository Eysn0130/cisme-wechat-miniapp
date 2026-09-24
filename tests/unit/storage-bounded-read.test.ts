import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { Readable, type Writable } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import type COS from "cos-nodejs-sdk-v5";
import { loadConfig } from "@cisme/config";
import { DomainError } from "@cisme/domain";
import { createApiGatewayStorage, createCosGatewayStorage, createS3Storage } from "../../services/api/src/storage";
import { materializeMemberPortableData, type collectMemberPortableData } from "../../services/api/src/privacyPortableData";
import type { ObjectStorage } from "../../services/api/src/storage";

const image=Buffer.from([0xff,0xd8,0xff,0x00]);
const common={APP_ENV:"test",DATABASE_URL:"postgres://unused",APP_SESSION_SECRET:"session",
  UPLOAD_TOKEN_SECRET:"upload",S3_BUCKET:"private-evidence"};
afterEach(()=>vi.restoreAllMocks());

it("caps local gateway reads even without trusted object metadata",async()=>{
  const directory=await mkdtemp(resolve(tmpdir(),"cisme-bounded-read-"));
  vi.spyOn(process,"cwd").mockReturnValue(directory);
  try{
    const path=resolve(directory,"tmp/object-storage");
    await mkdir(path,{recursive:true});
    await writeFile(resolve(path,"owned-object"),image);
    const storage=createApiGatewayStorage(loadConfig({...common,OBJECT_STORAGE_DRIVER:"api_gateway"}));
    await expect(storage.read("owned-object",3)).rejects.toMatchObject({code:"STORAGE_READ_LIMIT_EXCEEDED"});
    expect((await storage.read("owned-object",4)).bytes).toEqual(image);
    await expect(storage.read("owned-object",0)).rejects.toMatchObject({code:"STORAGE_READ_LIMIT_INVALID"});
  }finally{await rm(directory,{recursive:true,force:true});}
});

it("streams S3 range reads and refuses a server response larger than the limit",async()=>{
  const transformToByteArray=vi.fn(()=>{throw new Error("unbounded transform must not run");});
  const body=Object.assign(Readable.from([image]),{transformToByteArray});
  const send=vi.spyOn(S3Client.prototype,"send").mockResolvedValue({Body:body} as never);
  const storage=createS3Storage(loadConfig({...common,OBJECT_STORAGE_DRIVER:"s3_gateway"}));
  await expect(storage.read("owned-object",3)).rejects.toMatchObject({code:"STORAGE_READ_LIMIT_EXCEEDED"});
  expect(transformToByteArray).not.toHaveBeenCalled();
  const command=send.mock.calls[0]![0] as GetObjectCommand;
  expect(command.input).toMatchObject({Key:"owned-object",Range:"bytes=0-3"});
});

it("caps COS output independently of object size metadata and requested range",async()=>{
  const getObject=vi.fn(async(input:COS.GetObjectParams)=>{
    const output=input.Output as Writable;
    output.write(image);
    output.end();
    return {Body:Buffer.alloc(0)} as COS.GetObjectResult;
  });
  const storage=createCosGatewayStorage(loadConfig({...common,OBJECT_STORAGE_DRIVER:"cos_gateway"}),
    {getObject} as unknown as COS);
  await expect(storage.read("owned-object",3)).rejects.toMatchObject({code:"STORAGE_READ_LIMIT_EXCEEDED"});
  expect(getObject.mock.calls[0]![0]).toMatchObject({Key:"owned-object",Range:"bytes=0-3"});
});

it("reports a falsely small media object as omitted from the inline copy",async()=>{
  const read=vi.fn(async()=>{throw new DomainError("STORAGE_READ_LIMIT_EXCEEDED","limit",413);});
  const snapshot={sections:{support:{messages:[]}},uploaded:[{id:"owned-media",object_key:"owned-object",
    mime_type:"image/jpeg",size_bytes:null,kind:"member_upload"}],missingMedia:[]} as unknown as
    Awaited<ReturnType<typeof collectMemberPortableData>>;
  const result=await materializeMemberPortableData(snapshot,{read} as unknown as ObjectStorage);
  expect(read).toHaveBeenCalledWith("owned-object",32*1024*1024);
  expect(result.complete).toBe(false);
  expect(result.unavailableMedia).toEqual([expect.objectContaining({id:"owned-media",reason:"inline_copy_size_limit"})]);
});
