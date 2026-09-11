import { afterAll, beforeAll, expect, it } from 'vitest';
import { loadConfig } from '@cisme/config';
import { TEST_DATABASE_URL, resetDatabase, testPool } from '@cisme/testkit';
import { PlatformService } from '../../services/api/src/platformService';
import { CloudUpload } from '../../services/api/src/cloudUpload';
import { createApiGatewayStorage } from '../../services/api/src/storage';
const pool=testPool();
const config=loadConfig({APP_ENV:'test',DATABASE_URL:TEST_DATABASE_URL,APP_SESSION_SECRET:'chunk-session',ADMIN_API_TOKEN:'chunk-admin',UPLOAD_TOKEN_SECRET:'chunk-secret',OBJECT_STORAGE_DRIVER:'api_gateway'});
const storage=createApiGatewayStorage(config), service=new PlatformService(pool,config,storage), upload=new CloudUpload(pool,config,service);
let memberId:string;const objects:string[]=[];
beforeAll(async()=>{await resetDatabase(pool);memberId=(await pool.query("INSERT INTO member(display_name) VALUES('upload tester') RETURNING id")).rows[0].id;await storage.ensureReady();});
afterAll(async()=>{for(const key of objects)await storage.delete(key);await pool.end();});
async function fixture(maxBytes=10*1024*1024){const submissionId=(await pool.query('INSERT INTO submission(member_id) VALUES($1) RETURNING id',[memberId])).rows[0].id;const auth=await service.authorizeMedia(memberId,submissionId,{kind:'original',mimeType:'image/jpeg',maxBytes,baseUrl:'https://unused.invalid'},new Date());const key=(await pool.query('SELECT object_key FROM media_object WHERE id=$1',[auth.mediaId])).rows[0].object_key;objects.push(key);return {submissionId,mediaId:auth.mediaId,token:auth.fields.token!,key};}
it('uploads the full 10 MiB through bounded chunks and prevents replay after verification',async()=>{
 const f=await fixture();const bytes=Buffer.alloc(10*1024*1024,42);bytes.set([255,216,255]);
 const send=(index:number)=>upload.chunk(f.mediaId,{token:f.token,index,totalBytes:bytes.length,base64:bytes.subarray(index*524288,(index+1)*524288).toString('base64')});
 await expect(send(1)).rejects.toMatchObject({code:'CHUNK_ORDER_INVALID'});
 await send(0);await send(0);
 await expect(upload.chunk(f.mediaId,{token:f.token,index:0,totalBytes:bytes.length,base64:Buffer.alloc(524288,1).toString('base64')})).rejects.toMatchObject({code:'CHUNK_CONFLICT'});
 await expect(upload.finish(f.mediaId,f.token)).rejects.toMatchObject({code:'UPLOAD_INCOMPLETE'});
 for(let i=1;i<20;i++)await send(i);
 expect(await upload.finish(f.mediaId,f.token)).toMatchObject({uploaded:true,bytes:bytes.length});
 expect(await upload.finish(f.mediaId,f.token)).toMatchObject({uploaded:true});
 expect(Number((await service.completeMedia(memberId,f.submissionId,f.mediaId,new Date())).size_bytes)).toBe(bytes.length);
 expect((await pool.query('SELECT 1 FROM upload_chunk WHERE media_id=$1',[f.mediaId])).rowCount).toBe(0);
 await expect(send(0)).rejects.toMatchObject({code:'MEDIA_NOT_FOUND'});
});
it('rejects invalid, expired and oversized authorization without storing chunks',async()=>{
 const f=await fixture(100);const input={token:f.token,index:0,totalBytes:101,base64:Buffer.alloc(101,1).toString('base64')};
 await expect(upload.chunk(f.mediaId,input)).rejects.toMatchObject({code:'UPLOAD_SIZE_INVALID'});
 await expect(upload.chunk(f.mediaId,{...input,totalBytes:1,base64:'AA==',token:f.token+'x'})).rejects.toMatchObject({code:'UPLOAD_TOKEN_INVALID'});
 await expect(upload.chunk(f.mediaId,{...input,totalBytes:1,base64:'AA=='},new Date(Date.now()+700000))).rejects.toMatchObject({code:'UPLOAD_TOKEN_INVALID'});
 expect((await pool.query('SELECT 1 FROM upload_chunk WHERE media_id=$1',[f.mediaId])).rowCount).toBe(0);
});
it('does not accept chunks after delete or submit',async()=>{
 const f=await fixture();await service.deleteMedia(memberId,f.submissionId,f.mediaId,new Date());
 await expect(upload.chunk(f.mediaId,{token:f.token,index:0,totalBytes:3,base64:' /9j/'.trim()})).rejects.toMatchObject({code:'MEDIA_NOT_FOUND'});
 const g=await fixture();await pool.query("UPDATE submission SET status='submitted' WHERE id=$1",[g.submissionId]);
 await expect(upload.chunk(g.mediaId,{token:g.token,index:0,totalBytes:3,base64:'/9j/'})).rejects.toMatchObject({code:'UPLOAD_UNAVAILABLE'});
});
