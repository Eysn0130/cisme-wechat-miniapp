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
  CONTACT_ENCRYPTION_KEY:'19'.repeat(32),CONTACT_HASH_KEY:'29'.repeat(32),APP_ENV:'test',DATABASE_URL:TEST_DATABASE_URL,APP_SESSION_SECRET:'sync-session',ADMIN_API_TOKEN:'sync-admin',
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
async function draft(count=1,body:string|null="本人主动发布的使用记录"+randomUUID()){
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
    payload:{expectedVersion:post.version,title:'同步检查测试',body,mediaIds:ids}});
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

const processRewards=async()=>{const {processMemberPointSources}=await import('../../services/api/src/memberPointsClub');return processMemberPointSources(pool,new Date(Date.now()+1000),100);};
const balance=async(actor:Actor)=>{const r=await app.inject({url:'/v1/me/points',headers:auth(actor)});expect(r.statusCode,r.body).toBe(200);return r.json().projection.available;};
let publicPost:Post;
it('issues basic setup once after optional sensitive refusal, without creating a care completion',async()=>{
 const {careQuestions,careQuestionnaireVersion,careConsentVersion}=await import('../../services/api/src/careOnboarding');const a=await identity('合成基础建档积分');
 const profile=await app.inject({url:'/v1/me/care-profile',headers:auth(a)});expect(profile.statusCode,profile.body).toBe(200);
 const answers=Object.fromEntries(careQuestions.map(q=>[q.id,q.id==='source'?{status:'answered',values:['doctor','friend']}:q.id==='preference'?{status:'answered',values:['net_run']}:q.sensitive?{status:'not_authorized',values:[]}:{status:'skipped',values:[]}]));
 const payload={questionnaireVersion:careQuestionnaireVersion,expectedVersion:profile.json().profile?.version??0,currentQuestion:10,answers,consentChoice:'declined',consentVersion:careConsentVersion};const headers={...auth(a),'idempotency-key':randomUUID()};
 const completed=await app.inject({method:'POST',url:'/v1/me/care-profile/complete',headers,payload});expect(completed.statusCode,completed.body).toBe(200);await processRewards();
 const events=await pool.query("SELECT state,last_error,occurred_at,(SELECT starts_at FROM member_points_policy LIMIT 1) starts_at FROM member_points_source_event WHERE member_id=$1",[a.memberId]);expect(await balance(a),JSON.stringify(events.rows)).toBe(100);
 expect((await app.inject({method:'POST',url:'/v1/me/care-profile/complete',headers,payload})).statusCode).toBe(200);await processRewards();expect(await balance(a)).toBe(100);
 expect((await pool.query('SELECT count(*)::int n FROM daily_care_record WHERE member_id=$1',[a.memberId])).rows[0].n).toBe(0);
});
it('rewards only two newly safe public posts per Shanghai week, adds featured separately and reverses deleted content',async()=>{
 const posts:Post[]=[];for(let i=0;i<3;i++){const d=await draft(0,'这是本人使用后的不同护理体验记录'+i);const p=await submit(d.post);expect(p.statusCode,p.body).toBe(200);expect(p.json().state).toBe('published');posts.push(p.json());}
 publicPost=posts[1]!;await processRewards();expect(await balance(owner)).toBe(100);
 await pool.query("INSERT INTO authority_grant(member_id,capability,granted_by,grant_reason,environment,grant_source) VALUES($1,'community.moderate','fixture','Synthetic points featured','test','integration_fixture')",[reader.memberId]);
 const selected=await app.inject({method:'POST',url:`/v1/management/points/featured/${posts[0]!.id}`,headers:auth(reader),payload:{reason:'合成真实来源精选核对'}});expect(selected.statusCode,selected.body).toBe(200);await processRewards();expect(await balance(owner)).toBe(200);
 const removed=await app.inject({method:'DELETE',url:`/v1/me/ugc/posts/${posts[0]!.id}`,headers:auth(),payload:{expectedVersion:posts[0]!.version}});expect(removed.statusCode,removed.body).toBe(200);await processRewards();expect(await balance(owner)).toBe(50);
});
it('supports an image-only published note without a null-body reward failure',async()=>{
 const previous=owner;owner=await identity('合成纯图片积分');try{const d=await draft(1,null),p=await submit(d.post);expect(p.statusCode,p.body).toBe(200);await processRewards();expect(await balance(owner)).toBe(50);}finally{owner=previous;}
});
it('publishes fresh comments after matched WeChat safety, applies quota and duplicate guards, and revokes removed comments',async()=>{
 const old=await app.inject({method:'POST',url:`/v1/ugc/posts/${publicPost.id}/comments`,headers:{...auth(reader),'idempotency-key':randomUUID()},payload:{body:'历史待审材料不得因新流程自动公开'}});expect(old.statusCode,old.body).toBe(200);
 await pool.query("UPDATE ugc_comment SET created_at=(SELECT min(activated_at)-interval '1 second' FROM ugc_comment_direct_publication_policy) WHERE id=$1",[old.json().id]);
 await new UgcSafetyService(pool,config,storage,provider).scanComment(old.json().id);
 const ids:string[]=[];for(let i=0;i<3;i++){const c=await app.inject({method:'POST',url:`/v1/ugc/posts/${publicPost.id}/comments`,headers:{...auth(reader),'idempotency-key':randomUUID()},payload:{body:'读后有帮助，感谢分享护理体验'+i}});expect(c.statusCode,c.body).toBe(200);await new UgcSafetyService(pool,config,storage,provider).scanComment(c.json().id);ids.push(c.json().id);}
 expect((await pool.query("SELECT state FROM ugc_comment WHERE id=ANY($1::uuid[])",[ids])).rows.every(r=>r.state==='published')).toBe(true);await processRewards();expect(await balance(reader)).toBe(10);
 expect((await pool.query('SELECT state FROM ugc_comment WHERE id=$1',[old.json().id])).rows[0].state).toBe('pending_review');
 const self=await app.inject({method:'POST',url:`/v1/ugc/posts/${publicPost.id}/comments`,headers:{...auth(),'idempotency-key':randomUUID()},payload:{body:'本人补充自己的护理内容'}});await new UgcSafetyService(pool,config,storage,provider).scanComment(self.json().id);await processRewards();expect(await balance(owner)).toBe(50);
 const removed=await app.inject({method:'DELETE',url:`/v1/ugc/posts/${publicPost.id}/comments/${ids[0]}`,headers:auth(reader)});expect(removed.statusCode,removed.body).toBe(200);await processRewards();expect(await balance(reader)).toBe(5);
 const duplicate=await identity('合成重复评论积分');for(let i=0;i<2;i++){const c=await app.inject({method:'POST',url:`/v1/ugc/posts/${publicPost.id}/comments`,headers:{...auth(duplicate),'idempotency-key':randomUUID()},payload:{body:'这段护理分享对我很有帮助'}});await new UgcSafetyService(pool,config,storage,provider).scanComment(c.json().id);}await processRewards();expect(await balance(duplicate)).toBe(5);
});
it('binds an invite only for a visit before new registration, and never turns it into a cash referral automatically',async()=>{
 const share=await app.inject({method:'POST',url:'/v1/shares',headers:{...auth(),'idempotency-key':randomUUID()},payload:{targetType:'invite',targetRef:'home'}});expect(share.statusCode,share.body).toBe(200);const shareId=share.json().shareId,visitKey='synthetic-visit-'+randomUUID();
 expect((await app.inject({method:'POST',url:`/v1/shares/${shareId}/visits`,payload:{visitKey}})).statusCode).toBe(200);const a=await identity('合成受邀新注册');
 const attributed=await app.inject({method:'POST',url:`/v1/shares/${shareId}/attributions/identity`,headers:auth(a),payload:{visitKey}});expect(attributed.statusCode,attributed.body).toBe(200);
 const chronology=(await pool.query('SELECT m.created_at,v.first_seen_at,a.occurred_at FROM member m,share_visit v JOIN share_attribution a ON a.share_visit_id=v.id WHERE m.id=$1 AND a.converted_member_id=m.id',[a.memberId])).rows;
 expect((await pool.query('SELECT referrer_member_id FROM member_points_referral WHERE member_id=$1',[a.memberId])).rows,JSON.stringify(chronology)).toEqual([{referrer_member_id:owner.memberId}]);
 const oldVisit='synthetic-existing-'+randomUUID();await app.inject({method:'POST',url:`/v1/shares/${shareId}/visits`,payload:{visitKey:oldVisit}});await app.inject({method:'POST',url:`/v1/shares/${shareId}/attributions/identity`,headers:auth(reader),payload:{visitKey:oldVisit}});
 expect((await pool.query('SELECT 1 FROM member_points_referral WHERE member_id=$1',[reader.memberId])).rowCount).toBe(0);expect((await pool.query('SELECT count(*)::int n FROM commercial_referral_relation')).rows[0].n).toBe(0);expect(await balance(a)).toBe(0);
});
it('renews expired invitation links while preserving the original request receipt and deduplicating concurrent new requests',async()=>{
 const {PlatformService}=await import('../../services/api/src/platformService');const service=new PlatformService(pool,config,storage);const sponsor=await identity('合成邀请过期恢复'),now=new Date();
 const original=await service.createShare(sponsor.memberId,'synthetic-original-invite',{targetType:'invite',targetRef:'home'},now),late=new Date(+now+31*86400000);
 expect(await service.createShare(sponsor.memberId,'synthetic-original-invite',{targetType:'invite',targetRef:'home'},late)).toEqual(original);
 const fresh=await Promise.all(['synthetic-renew-invite-1','synthetic-renew-invite-2'].map(key=>service.createShare(sponsor.memberId,key,{targetType:'invite',targetRef:'home'},late)));
 expect(fresh[0]!.shareId).not.toBe(original.shareId);expect(fresh[1]!.shareId).toBe(fresh[0]!.shareId);expect(Date.parse(fresh[0]!.expiresAt)).toBeGreaterThan(+late);
 expect((await pool.query("SELECT state,count(*)::int n FROM share_link WHERE member_id=$1 GROUP BY state ORDER BY state",[sponsor.memberId])).rows).toEqual([{state:'active',n:1},{state:'expired',n:1}]);
});
it('serves mixed concurrent capability and home reads without late rule-query cancellation affecting another request',async()=>{
 const a=await identity('合成并发连接回收');
 for(let batch=0;batch<50;batch++){
  const replies=await Promise.all(Array.from({length:10},(_,i)=>app.inject({url:i%2?'/v1/capabilities':'/v1/bootstrap/home',headers:auth(a),remoteAddress:`127.1.0.${batch+1}`})));
  for(const reply of replies)expect(reply.statusCode,reply.body).toBe(200);
 }
},30000);
