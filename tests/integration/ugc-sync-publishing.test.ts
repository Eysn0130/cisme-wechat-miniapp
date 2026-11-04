import {createHash,randomUUID} from 'node:crypto';
import {afterAll,beforeAll,expect,it,vi} from 'vitest';
import sharp from 'sharp';
import type {FastifyInstance} from 'fastify';
import {loadConfig,CANONICAL_WECHAT_MINIPROGRAM_APP_ID} from '@cisme/config';
import {resetDatabase,testPool,TEST_DATABASE_URL} from '@cisme/testkit';
import {createApp} from '../../services/api/src/server';
import {createApiGatewayStorage} from '../../services/api/src/storage';
import {FormalUgcService} from '../../services/api/src/formalUgc';
import {AuthorityService} from '../../services/api/src/authority';
import {UgcSafetyService} from '../../services/api/src/ugcSafety';
import {UgcDirectPublication} from '../../services/api/src/ugcDirectPublication';
import {issueSessionToken} from '../../services/api/src/auth';
import {bindSafetyIdentity,directSafetyEnv,safeProvider} from './ugc-direct-fixture';

const hash=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
const pool=testPool();
const config=loadConfig({...directSafetyEnv,WECHAT_APP_ID:CANONICAL_WECHAT_MINIPROGRAM_APP_ID,WECHAT_MESSAGE_TOKEN:undefined,WECHAT_MESSAGE_PLAINTEXT_TEST_ONLY:undefined,
  APP_ENV:'test',DATABASE_URL:TEST_DATABASE_URL,APP_SESSION_SECRET:'sync-session',ADMIN_API_TOKEN:'sync-admin',
  UPLOAD_TOKEN_SECRET:'sync-upload',OBJECT_STORAGE_DRIVER:'api_gateway',UGC_IMAGE_SAFETY_MODE:'wechat_v1_sync',
  UGC_GO_LIVE_GATE:'true',UGC_LEGAL_APPROVAL_ID:'synthetic-sync',UGC_PROVENANCE_READY:'true',
  UGC_CONTENT_SAFETY_READY:'true',UGC_MODERATION_READY:'true'});
const storage=createApiGatewayStorage(config);
type Actor={memberId:string;sessionToken:string};
type Post={id:string;version:number;revision:number;state:string};
let app:FastifyInstance,owner:Actor,reader:Actor;
let imageResult:unknown={errcode:0},imageHttp=200,imageCalls=0;
let whileChecking:(()=>Promise<void>)|null=null;
const checked=new Map<string,Buffer>();
const provider:typeof fetch=async(input,init)=>{
  if(new URL(String(input)).pathname!=='/wxa/img_sec_check')return safeProvider(input,init);
  imageCalls++;expect(init?.redirect).toBe('error');expect(init?.body).toBeInstanceOf(FormData);
  const part=(init!.body as FormData).get('media') as Blob;
  expect(part.type).toBe('image/jpeg');const bytes=Buffer.from(await part.arrayBuffer());
  expect(bytes.length).toBeLessThanOrEqual(1024*1024);checked.set(hash(bytes),bytes);
  if(whileChecking){const action=whileChecking;whileChecking=null;await action();}
  if(imageResult instanceof Error)throw imageResult;
  return new Response(JSON.stringify(imageResult),{status:imageHttp});
};
const auth=(actor=owner)=>({authorization:`Bearer ${actor.sessionToken}`});
const identity=async(name:string):Promise<Actor>=>{
  const r=await app.inject({method:'POST',url:'/v1/identity/dev',payload:{externalUserId:name,displayName:name,
    consents:[{documentType:'privacy',version:'test'},{documentType:'terms',version:'test'}]}});
  expect(r.statusCode).toBe(200);const actor=r.json();await bindSafetyIdentity(pool,actor.memberId);
  const identity=(await pool.query(`INSERT INTO wechat_identity(member_id,provider,app_id,openid,adapter)
    VALUES($1,'wechat_miniprogram',$2,$3,'wechat') RETURNING id`,[actor.memberId,CANONICAL_WECHAT_MINIPROGRAM_APP_ID,'synthetic-sync-'+randomUUID()])).rows[0].id;
  actor.sessionToken=issueSessionToken({memberId:actor.memberId,principalId:`wechat_miniprogram:${identity}`,
    adapter:'wechat',provider:'wechat_miniprogram',appId:CANONICAL_WECHAT_MINIPROGRAM_APP_ID},config.sessionSecret);
  return actor;
};
async function draft(count=1){
  imageResult={errcode:0};imageHttp=200;
  const r=await app.inject({method:'POST',url:'/v1/me/ugc/posts',headers:{...auth(),'idempotency-key':randomUUID()},payload:{}});
  expect(r.statusCode).toBe(200);let post=r.json<Post>();const ids:string[]=[];
  for(let i=0;i<count;i++){
    const bytes=await sharp({create:{width:320+i,height:240,channels:4,background:{r:100+i,g:120,b:160,alpha:.7}}}).png().toBuffer();
    const a=await app.inject({method:'POST',url:`/v1/me/ugc/posts/${post.id}/media/authorize`,headers:auth(),
      payload:{mimeType:'image/png',maxBytes:bytes.length}});expect(a.statusCode).toBe(200);const u=a.json();
    expect((await app.inject({method:'POST',url:`/v1/uploads/${u.mediaId}/chunks`,payload:{token:u.fields.token,index:0,totalBytes:bytes.length,base64:bytes.toString('base64')}})).statusCode).toBe(200);
    expect((await app.inject({method:'POST',url:`/v1/uploads/${u.mediaId}/assemble`,payload:{token:u.fields.token}})).statusCode).toBe(200);
    expect((await app.inject({method:'POST',url:`/v1/me/ugc/posts/${post.id}/media/${u.mediaId}/complete`,headers:auth(),payload:{}})).statusCode).toBe(200);
    ids.push(u.mediaId);
  }
  const saved=await app.inject({method:'PUT',url:`/v1/me/ugc/posts/${post.id}/draft`,headers:auth(),
    payload:{expectedVersion:post.version,title:'同步检查测试',body:'本人主动发布的使用记录',mediaIds:ids}});
  expect(saved.statusCode).toBe(200);post=saved.json();return {post,ids};
}
const submit=(post:Post)=>app.inject({method:'POST',url:`/v1/me/ugc/posts/${post.id}/submit`,headers:auth(),payload:{expectedVersion:post.version}});
const own=async(post:Post)=>(await app.inject({method:'GET',url:`/v1/me/ugc/posts/${post.id}`,headers:auth()})).json<Post>();
const intent=()=>new FormalUgcService(pool,config,storage,new AuthorityService(pool,'test'));
const finish=(id:string)=>new UgcDirectPublication(pool,config,storage).finish(id);
const scan=(id:string)=>new UgcSafetyService(pool,config,storage,provider).scanPost(owner.memberId,id,'https://scan.synthetic.invalid');
beforeAll(async()=>{
  vi.stubGlobal('fetch',provider);await resetDatabase(pool);await storage.ensureReady();app=await createApp({config,pool,storage});
  owner=await identity('sync-owner');reader=await identity('sync-reader');
  await pool.query(`INSERT INTO ugc_go_live_approval(approval_reference,signed_by,evidence,signed_at,expires_at)
    VALUES('synthetic-sync','isolated fixture','{"scope":"isolated only"}',now(),now()+interval '1 hour')`);
  await pool.query("UPDATE emergency_switch SET enabled=true WHERE key='community'");
});
afterAll(async()=>{await app?.close();await pool.end();vi.unstubAllGlobals();});

it('publishes text without push and nine photos with the exact checked bytes, then removes all public access on deletion',async()=>{
  const text=await draft(0);expect((await submit(text.post)).json()).toMatchObject({state:'published'});
  const {post,ids}=await draft(9);const response=await submit(post);
  expect(response.statusCode).toBe(200);const published=response.json<Post>();expect(published.state).toBe('published');
  const scans=(await pool.query("SELECT provider,state,trace_id,result FROM ugc_safety_scan WHERE post_id=$1 AND kind='image'",[post.id])).rows;
  expect(scans).toHaveLength(9);expect(scans.every(s=>s.provider==='wechat_v1_sync'&&s.state==='safe'&&s.trace_id===null)).toBe(true);
  expect((await pool.query('SELECT count(*)::int n FROM ugc_safety_callback_inbox')).rows[0].n).toBe(0);
  for(const id of ids){
    const detail=await app.inject({method:'GET',url:`/v1/ugc/media/${id}`});expect(detail.statusCode).toBe(200);
    expect(detail.headers['content-type']).toContain('image/jpeg');expect(checked.get(hash(detail.rawPayload))).toEqual(detail.rawPayload);
    const meta=await sharp(detail.rawPayload).metadata();expect(meta.exif).toBeUndefined();
    expect((await app.inject({method:'GET',url:`/v1/ugc/media/${id}?variant=thumbnail`})).headers['content-type']).toContain('image/webp');
  }
  expect((await app.inject({method:'POST',url:`/v1/me/ugc/posts/${post.id}/submit`,headers:auth(),payload:{expectedVersion:post.version}})).statusCode).toBe(409);
  expect((await app.inject({method:'GET',url:`/v1/ugc/posts/${post.id}`,headers:auth(reader)})).statusCode).toBe(200);
  expect((await app.inject({method:'PUT',url:`/v1/me/ugc/follows/${owner.memberId}`,headers:auth(reader),payload:{active:true}})).statusCode).toBe(200);
  const following=await app.inject({method:'GET',url:'/v1/me/community/following',headers:auth(reader)});
  expect(following.statusCode).toBe(200);
  expect(following.json().items).toEqual(expect.arrayContaining([expect.objectContaining({kind:'formal',id:post.id})]));
  expect((await app.inject({method:'DELETE',url:`/v1/me/ugc/posts/${post.id}`,headers:auth(),payload:{expectedVersion:published.version}})).statusCode).toBe(200);
  expect((await app.inject({method:'GET',url:`/v1/ugc/posts/${post.id}`})).statusCode).toBe(404);
  expect((await app.inject({method:'GET',url:`/v1/ugc/media/${ids[0]}`})).statusCode).toBe(404);
});

it.each([{errcode:87014},{errcode:45009},{},{errcode:0,http:503},new Error('synthetic timeout')])('keeps failed or ambiguous checks private (%j)',async(result)=>{
  const {post,ids}=await draft();imageResult=result;imageHttp=(result as {http?:number}).http??200;
  const r=await submit(post);expect(r.statusCode).toBe(200);expect(r.json().state).toBe('rejected');
  expect((await app.inject({method:'GET',url:`/v1/ugc/media/${ids[0]}`})).statusCode).toBe(404);
  expect((await app.inject({method:'GET',url:`/v1/me/ugc/posts/${post.id}`,headers:auth()})).statusCode).toBe(200);
});

it('does not inspect or publish saved drafts without a current explicit publication action',async()=>{
  const {post}=await draft(),before=imageCalls;
  await expect(scan(post.id)).rejects.toMatchObject({code:'UGC_SCAN_CONFLICT'});await finish(post.id);
  expect((await own(post)).state).toBe('draft');expect(imageCalls).toBe(before);
});

it('rechecks a corrected draft after a service failure and records a new real result',async()=>{
  const {post,ids}=await draft();imageResult={errcode:-1};expect((await submit(post)).json().state).toBe('rejected');
  const failed=await own(post);
  const saved=await app.inject({method:'PUT',url:`/v1/me/ugc/posts/${post.id}/draft`,headers:auth(),
    payload:{expectedVersion:failed.version,body:'修改后明确重试',mediaIds:ids}});
  expect(saved.statusCode).toBe(200);imageResult={errcode:0};expect((await submit(saved.json())).json().state).toBe('published');
});

it('cannot publish a result after deletion or a mismatched checked image digest',async()=>{
  const {post}=await draft();whileChecking=async()=>{const current=await own(post);
    expect((await app.inject({method:'DELETE',url:`/v1/me/ugc/posts/${post.id}`,headers:auth(),payload:{expectedVersion:current.version}})).statusCode).toBe(200);};
  await submit(post);expect((await own(post)).state).toBe('deleted');
  const next=await draft();await intent().submit(owner.memberId,next.post.id,next.post.version);
  await pool.query("UPDATE emergency_switch SET enabled=false WHERE key='community'");await scan(next.post.id);
  // An immutable but invalid provider record must never become a public image.
  await pool.query(`INSERT INTO ugc_safety_scan(post_id,revision,media_asset_id,kind,content_sha256,provider,state,result,resolved_at)
    SELECT post_id,revision,media_asset_id,kind,content_sha256,provider,'safe',
      jsonb_build_object('api','img_sec_check','errcode',0,'checkedSha256',repeat('0',64),'checkedBytes',123),now()
    FROM ugc_safety_scan WHERE post_id=$1 AND kind='image'`,[next.post.id]);
  await pool.query("UPDATE emergency_switch SET enabled=true WHERE key='community'");await finish(next.post.id);
  expect((await own(next.post)).state).toBe('pending_review');
  expect((await app.inject({method:'GET',url:`/v1/ugc/media/${next.ids[0]}`})).statusCode).toBe(404);
});
