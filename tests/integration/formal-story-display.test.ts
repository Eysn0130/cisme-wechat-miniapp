import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {beforeAll,afterAll,expect,it,vi} from 'vitest';
import {CANONICAL_WECHAT_MINIPROGRAM_APP_ID,loadConfig} from '@cisme/config';
import {resetDatabase,testPool,TEST_DATABASE_URL} from '@cisme/testkit';
import {createApp} from '../../services/api/src/server';
import {createApiGatewayStorage} from '../../services/api/src/storage';
import {issueSessionToken} from '../../services/api/src/auth';
import {AuthorityService} from '../../services/api/src/authority';
import {FormalUgcService} from '../../services/api/src/formalUgc';
import {UgcSafetyService} from '../../services/api/src/ugcSafety';
import {portableQuerySpecs} from '../../services/api/src/privacyPortableQueries';
import {directSafetyEnv,safeProvider} from './ugc-direct-fixture';
const pool=testPool();
const config=loadConfig({...directSafetyEnv,WECHAT_APP_ID:CANONICAL_WECHAT_MINIPROGRAM_APP_ID,
 APP_ENV:'test',DATABASE_URL:TEST_DATABASE_URL,APP_SESSION_SECRET:'story-display-session',ADMIN_API_TOKEN:'story-display-admin',
 UPLOAD_TOKEN_SECRET:'story-display-upload',OBJECT_STORAGE_DRIVER:'api_gateway',UGC_GO_LIVE_GATE:'true',
 UGC_LEGAL_APPROVAL_ID:'synthetic-story-display',UGC_PROVENANCE_READY:'true',UGC_CONTENT_SAFETY_READY:'true',UGC_MODERATION_READY:'true'});
const storage=createApiGatewayStorage(config);
let app:Awaited<ReturnType<typeof createApp>>,owner:{id:string;token:string},reader:{id:string;token:string},moderator:{id:string;token:string},post:any,comment:any;
const headers=(actor=owner)=>({authorization:`Bearer ${actor.token}`});
async function actor(name:string){
 const response=await app.inject({method:'POST',url:'/v1/identity/dev',payload:{externalUserId:'story-'+randomUUID(),displayName:name,
  consents:[{documentType:'privacy',version:'test'},{documentType:'terms',version:'test'}]}});
 expect(response.statusCode).toBe(200);const memberId=response.json().memberId;
 const identity=(await pool.query(`INSERT INTO wechat_identity(member_id,provider,app_id,openid,adapter)
  VALUES($1,'wechat_miniprogram',$2,$3,'wechat') RETURNING id`,[memberId,CANONICAL_WECHAT_MINIPROGRAM_APP_ID,'synthetic-story-'+randomUUID()])).rows[0].id;
 await pool.query(`INSERT INTO member_profile(member_id,wechat_handle,handle_source,community_visible,public_status)
  VALUES($1,'private_only','self_reported',false,'private') ON CONFLICT(member_id) DO UPDATE SET wechat_handle='private_only',community_visible=false,public_status='private'`,[memberId]);
 return {id:memberId,token:issueSessionToken({memberId,principalId:`wechat_miniprogram:${identity}`,adapter:'wechat',provider:'wechat_miniprogram',appId:CANONICAL_WECHAT_MINIPROGRAM_APP_ID},config.sessionSecret)};
}
async function publish(){
 const created=await app.inject({method:'POST',url:'/v1/me/ugc/posts',headers:{...headers(),'idempotency-key':randomUUID()},payload:{}});
 expect(created.statusCode).toBe(200);
 const saved=await app.inject({method:'PUT',url:`/v1/me/ugc/posts/${created.json().id}/draft`,headers:headers(),payload:{expectedVersion:created.json().version,title:'本人发布的故事',body:'本人明确公开的内容',mediaIds:[]}});
 expect(saved.statusCode).toBe(200);
 const sent=await app.inject({method:'POST',url:`/v1/me/ugc/posts/${saved.json().id}/submit`,headers:headers(),payload:{expectedVersion:saved.json().version}});
 expect(sent.statusCode).toBe(200);expect(sent.json().state).toBe('published');return sent.json();
}
beforeAll(async()=>{
 vi.stubGlobal('fetch',safeProvider);await resetDatabase(pool);await storage.ensureReady();app=await createApp({config,pool,storage});
 owner=await actor('HEHEHE');reader=await actor('真实读者');moderator=await actor('明确授权的测试审核员');
 await pool.query(`INSERT INTO authority_grant(member_id,capability,granted_by,grant_reason,environment,grant_source)
  VALUES($1,'community.moderate','fixture','isolated story detail only','test','integration_fixture')`,[moderator.id]);
 await pool.query(`INSERT INTO ugc_go_live_approval(approval_reference,signed_by,evidence,signed_at,expires_at)
  VALUES('synthetic-story-display','isolated fixture','{"scope":"isolated only"}',now(),now()+interval '1 hour')`);
 await pool.query("UPDATE emergency_switch SET enabled=true WHERE key='community'");post=await publish();
});
afterAll(async()=>{await app?.close();await pool.end();vi.unstubAllGlobals();});
it('projects the actual author across feed, detail, profile and follows without approving private profile fields',async()=>{
 const follow=await app.inject({method:'PUT',url:`/v1/me/ugc/follows/${owner.id}`,headers:headers(reader),payload:{active:true}});expect(follow.statusCode).toBe(200);
 for(const url of ['/v1/ugc/posts',`/v1/ugc/posts/${post.id}`,`/v1/community/authors/${owner.id}`,'/v1/me/community/following?limit=20']){
  const response=await app.inject({method:'GET',url,headers:headers(reader)});expect(response.statusCode,url).toBe(200);
  const body=response.json(),value=body.author&&typeof body.author==='object'?body.author:body.items?body.items.find((x:any)=>x.id===post.id):body;
  expect(value.author??value.name).toBe('HEHEHE');expect(JSON.stringify(body)).not.toContain('private_only');
 }
 const profile=(await pool.query('SELECT community_visible,public_status,wechat_handle FROM member_profile WHERE member_id=$1',[owner.id])).rows[0];
 expect(profile).toEqual({community_visible:false,public_status:'private',wechat_handle:'private_only'});
 expect((await app.inject({method:'GET',url:`/v1/ugc/posts/${post.id}`,headers:headers()})).json().isMine).toBe(true);
 expect((await app.inject({method:'GET',url:`/v1/ugc/posts/${post.id}`,headers:headers(reader)})).json().isMine).toBe(false);
 expect((await app.inject({method:'PUT',url:`/v1/me/ugc/posts/${post.id}/draft`,headers:headers(reader),payload:{expectedVersion:post.version,body:'不能修改别人',mediaIds:[]}})).statusCode).toBe(404);
});
it('keeps pending comments private to the authenticated reader view',async()=>{
 const sent=await app.inject({method:'POST',url:`/v1/ugc/posts/${post.id}/comments`,headers:{...headers(reader),'idempotency-key':randomUUID()},payload:{body:'只有本人能看见的待处理评论'}});
 expect(sent.statusCode).toBe(200);comment=sent.json();expect(comment.replayed).toBe(false);
 const own=await app.inject({method:'GET',url:`/v1/ugc/posts/${post.id}/comments?reader=1`,headers:headers(reader)});
 expect(own.statusCode).toBe(200);expect(own.json().items).toEqual([expect.objectContaining({id:comment.id,author:'真实读者',isMine:true,state:'pending_review'})]);
 for(const auth of [{},headers(moderator)]){
  const publicRead=await app.inject({method:'GET',url:`/v1/ugc/posts/${post.id}/comments`,headers:auth});expect(publicRead.json().items).toEqual([]);
 }
 expect((await app.inject({method:'GET',url:`/v1/ugc/posts/${post.id}/comments?reader=1`})).statusCode).toBe(401);
 expect((await app.inject({method:'GET',url:`/v1/ugc/posts/${post.id}/comments?reader=1`,headers:headers(moderator)})).json().items).toEqual([]);
 expect((await app.inject({method:'PUT',url:`/v1/ugc/posts/${post.id}/comments/${comment.id}/like`,headers:headers(),payload:{active:true}})).statusCode).toBe(404);
});
it('gives the common comment heart a real idempotent owner-scoped like',async()=>{
 const safety=new UgcSafetyService(pool,config,storage,safeProvider);
 expect(await safety.scanComment(comment.id)).toMatchObject({state:'safe'});
 const service=new FormalUgcService(pool,config,storage,new AuthorityService(pool,'test'));
 await service.reviewComment(moderator.id,comment.id,{decision:'approve',reason:'isolated safe comment'});
 const url=`/v1/ugc/posts/${post.id}/comments/${comment.id}/like`;
 expect((await app.inject({method:'PUT',url,payload:{active:true}})).statusCode).toBe(401);
 for(let i=0;i<2;i++)expect((await app.inject({method:'PUT',url,headers:headers(),payload:{active:true}})).json()).toEqual({id:comment.id,liked:true,likeCount:1});
 const listed=(await app.inject({method:'GET',url:`/v1/ugc/posts/${post.id}/comments?reader=1`,headers:headers()})).json();
 expect(listed.items[0]).toMatchObject({id:comment.id,likeCount:1,liked:true,author:'真实读者'});
 expect(JSON.stringify(listed)).not.toContain('private_only');
 const ownLikes=portableQuerySpecs.find(spec=>spec.section==='community'&&spec.collection==='commentLikes')!;
 const exported=(await pool.query(ownLikes.sql,[owner.id])).rows;
 expect(exported).toEqual([{comment_id:comment.id,created_at:expect.any(Date)}]);
 expect((await pool.query(ownLikes.sql,[reader.id])).rows).toEqual([]);
 const other=await publish();expect((await app.inject({method:'PUT',url:`/v1/ugc/posts/${other.id}/comments/${comment.id}/like`,headers:headers(),payload:{active:true}})).statusCode).toBe(404);
 const sql=await readFile('db/migrations/202611040004_ugc_comment_likes.sql','utf8');
 await expect(pool.query(sql.split('-- migrate:down')[1]!)).rejects.toMatchObject({message:'UGC_COMMENT_LIKES_PRESENT'});
 expect((await app.inject({method:'PUT',url,headers:headers(),payload:{active:false}})).json()).toEqual({id:comment.id,liked:false,likeCount:0});
});
