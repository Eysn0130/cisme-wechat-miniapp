import {afterAll,beforeAll,expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {CANONICAL_WECHAT_MINIPROGRAM_APP_ID,loadConfig} from '@cisme/config';
import {resetDatabase,testPool,TEST_DATABASE_URL} from '@cisme/testkit';
import {createApp} from '../../services/api/src/server';
import {createApiGatewayStorage} from '../../services/api/src/storage';
import {EditorialService} from '../../services/api/src/editorial';
import {AuthorityService} from '../../services/api/src/authority';
import {issueSessionToken} from '../../services/api/src/auth';
const pool=testPool();
const base={APP_ENV:'test',DATABASE_URL:TEST_DATABASE_URL,APP_SESSION_SECRET:'profile-synthetic-session',ADMIN_API_TOKEN:'profile-synthetic-admin',UPLOAD_TOKEN_SECRET:'profile-synthetic-upload',WECHAT_APP_ID:CANONICAL_WECHAT_MINIPROGRAM_APP_ID,WECHAT_APP_SECRET:'synthetic-secret',WECHAT_MESSAGE_TOKEN:'synthetic-callback',WECHAT_MESSAGE_PLAINTEXT_TEST_ONLY:'true',UGC_SCAN_BASE_URL:'https://synthetic-scan.invalid',PII_ENCRYPTION_KEY:'1'.repeat(64),CONTACT_HASH_KEY:'2'.repeat(64),ALLOW_DEV_ADAPTERS:'false',OBJECT_STORAGE_DRIVER:'api_gateway'};
const config=loadConfig({...base,UGC_GO_LIVE_GATE:'true',UGC_LEGAL_APPROVAL_ID:'synthetic-profile',UGC_PROVENANCE_READY:'true',UGC_CONTENT_SAFETY_READY:'true',UGC_MODERATION_READY:'true'});
const storage=createApiGatewayStorage(config),editorial=new EditorialService(pool,config,storage,new AuthorityService(pool,'test'));
let app:Awaited<ReturnType<typeof createApp>>,closed:typeof app;
let author:{id:string;principal:string;token:string},other:typeof author,empty:typeof author;
let verdict='pass',checked:string[]=[];
const originalFetch=globalThis.fetch;
const headers=(who:typeof author)=>({authorization:`Bearer ${who.token}`});
const read=(who?:typeof author,id=author.id,query='')=>app.inject({method:'GET',url:`/v1/community/authors/${id}${query}`,headers:who?headers(who):{}});
const save=(bio:unknown,expectedVersion:unknown,who=author)=>app.inject({method:'PUT',url:'/v1/me/community-profile',headers:headers(who),payload:{bio,expectedVersion}});
async function actor(name:string){
 const id=(await pool.query('INSERT INTO member(display_name) VALUES($1) RETURNING id',[name])).rows[0].id;
 const identity=(await pool.query(`INSERT INTO wechat_identity(member_id,openid,adapter,provider,app_id) VALUES($1,$2,'wechat','wechat_miniprogram',$3) RETURNING id`,[id,'synthetic-profile-'+randomUUID(),CANONICAL_WECHAT_MINIPROGRAM_APP_ID])).rows[0].id;
 const principal=`wechat_miniprogram:${identity}`;
 const token=issueSessionToken({principalId:principal,memberId:id,adapter:'wechat',provider:'wechat_miniprogram',appId:CANONICAL_WECHAT_MINIPROGRAM_APP_ID},config.sessionSecret);
 return {id,principal,token};
}
async function publish(who:typeof author,title:string){
 const created=await app.inject({method:'POST',url:'/v1/me/ugc/posts',headers:{...headers(who),'idempotency-key':'profile-'+randomUUID()},payload:{}});expect(created.statusCode).toBe(200);
 const id=created.json().id;
 const edited=await app.inject({method:'PUT',url:`/v1/me/ugc/posts/${id}/draft`,headers:headers(who),payload:{title,body:'合成公开正文',mediaIds:[],expectedVersion:1}});expect(edited.statusCode).toBe(200);
 const submitted=await app.inject({method:'POST',url:`/v1/me/ugc/posts/${id}/submit`,headers:headers(who),payload:{expectedVersion:edited.json().version}});expect(submitted.statusCode,submitted.body).toBe(200);expect(submitted.json().state).toBe('published');return id;
}
beforeAll(async()=>{
 await resetDatabase(pool);await storage.ensureReady();
 [author,other,empty]=await Promise.all(['合成主页作者','合成读者','合成零帖子会员'].map(actor)) as [typeof author,typeof other,typeof empty];
 for(const type of ['terms','privacy'])await pool.query(`INSERT INTO legal_document(document_type,version,title,body,operator_name,contact,active) VALUES($1,'profile-v1','synthetic','synthetic','synthetic','synthetic',true)`,[type]);
 for(const who of [author,other,empty])await editorial.acceptCurrentLegal(who.id,who.principal,{consents:[{documentType:'terms',version:'profile-v1'},{documentType:'privacy',version:'profile-v1'}]});
 await pool.query(`INSERT INTO ugc_go_live_approval(approval_reference,signed_by,evidence,signed_at,expires_at) VALUES('synthetic-profile','synthetic','{"scope":"disposable only"}',now(),now()+interval '1 hour')`);
 await pool.query("UPDATE emergency_switch SET enabled=true WHERE key='community'");
 globalThis.fetch=(async(input:any,init:any)=>{
  const url=String(input);if(!url.startsWith('https://api.weixin.qq.com/'))throw Error('Unexpected external request');
  if(url.includes('/cgi-bin/token?'))return Response.json({access_token:'synthetic-token',expires_in:7200});
  if(!url.includes('/msg_sec_check?'))throw Error('Unexpected safety call');
  checked.push(JSON.parse(init.body).content);
  if(verdict==='error')throw Error('synthetic safety outage');return Response.json({errcode:0,result:{suggest:verdict}});
 }) as typeof fetch;
 app=await createApp({config,pool,storage});closed=await createApp({config:loadConfig(base),pool,storage});
});
afterAll(async()=>{globalThis.fetch=originalFetch;await app?.close();await closed?.close();await pool.end();});

it('opens the real owner with zero posts, keeps private identity private, and denies anonymous self access',async()=>{
 const response=await app.inject({method:'GET',url:'/v1/me/community-profile',headers:headers(empty)});expect(response.statusCode,response.body).toBe(200);
 expect(response.json()).toMatchObject({author:{id:empty.id,name:'合成零帖子会员',membershipLabel:'CISME会员',bio:'',bioRevision:0,isMine:true,postCount:0},items:[],nextCursor:null});
 expect((await app.inject({method:'GET',url:'/v1/me/community-profile'})).statusCode).toBe(401);
 expect((await read(other,empty.id)).statusCode).toBe(404);expect((await read(undefined,empty.id)).statusCode).toBe(404);
 expect((await app.inject({method:'GET',url:'/v1/me/community-profile?id='+author.id,headers:headers(empty)})).json().author.id).toBe(empty.id);
});
it('persists only the exact automatically checked biography, with an independent version and no profile approval change',async()=>{
 const before=(await pool.query('SELECT * FROM member_profile WHERE member_id=$1',[author.id])).rows[0];expect(before).toBeUndefined();
 const response=await save('  认真记录自己的护理日常。  ',0);expect(response.statusCode,response.body).toBe(200);expect(response.json()).toEqual({bio:'认真记录自己的护理日常。',bioRevision:1});expect(checked).toContain('认真记录自己的护理日常。');
 const row=(await pool.query('SELECT * FROM member_profile WHERE member_id=$1',[author.id])).rows[0];expect(row).toMatchObject({community_bio:'认真记录自己的护理日常。',community_bio_revision:1,profile_revision:0,public_status:'private',community_visible:false});
 expect((await save('旧版本覆盖',0)).statusCode).toBe(409);expect((await save('x'.repeat(121),1)).statusCode).toBe(422);expect((await save('带\u202e控制符',1)).statusCode).toBe(422);
 for(const value of ['risky','review','error']){verdict=value;expect((await save('不应公开的合成简介',1)).statusCode).toBe(value==='error'?503:422);}
 verdict='pass';expect((await pool.query('SELECT community_bio_revision FROM member_profile WHERE member_id=$1',[author.id])).rows[0].community_bio_revision).toBe(1);
 const simultaneous=await Promise.all([save('合成并发版本甲',1),save('合成并发版本乙',1)]);expect(simultaneous.map(r=>r.statusCode).sort()).toEqual([200,409]);
});
it('shows only this author’s public stories across both sources, preserves pagination and protects visibility and identity',async()=>{
 const first=await publish(author,'合成自己的公开故事一'),second=await publish(author,'合成自己的公开故事二');await publish(other,'别人的合成故事');
 await pool.query(`INSERT INTO authority_grant(member_id,capability,granted_by,grant_reason,environment,grant_source) VALUES($1,'editorial.manage','fixture','profile integration only','test','integration_fixture')`,[author.id]);
 const curated=await editorial.publish(author.id,author.principal,{externalRef:'profile-curated',authorMemberId:author.id,author:'CISME头皮实验室',title:'合成自己的精选',excerpt:'合成摘要',body:'合成正文',sourceUrl:null,authorizationRef:'synthetic:profile',rightsEvidence:{scope:'disposable integration'},media:[],expectedVersion:0});
 const draft=await app.inject({method:'POST',url:'/v1/me/ugc/posts',headers:{...headers(author),'idempotency-key':'profile-private-'+randomUUID()},payload:{}});expect(draft.statusCode).toBe(200);
 const full=await read(other);expect(full.statusCode).toBe(200);expect(full.json()).toMatchObject({author:{id:author.id,postCount:3,isMine:false,bioRevision:null,name:'CISME头皮实验室',followArticleId:curated.id}});
 expect(new Set(full.json().items.map((x:any)=>x.id))).toEqual(new Set([first,second,curated.id]));expect(JSON.stringify(full.json())).not.toMatch(/openid|wechat_handle|phone|object_key|review_note|principal|sessionToken|qualification/);
 const page1=(await read(other,author.id,'?limit=1')).json(),page2=(await read(other,author.id,'?limit=1&cursor='+encodeURIComponent(page1.nextCursor))).json(),page3=(await read(other,author.id,'?limit=1&cursor='+encodeURIComponent(page2.nextCursor))).json();
 expect(new Set([page1.items[0].id,page2.items[0].id,page3.items[0].id]).size).toBe(3);expect(page3.nextCursor).toBeNull();expect(page3.author.postCount).toBe(3);
 expect((await read(undefined,author.id,'?cursor='+encodeURIComponent(page1.nextCursor))).statusCode).toBe(422);
 expect((await read(other,other.id,'?cursor='+encodeURIComponent(page1.nextCursor))).statusCode).toBe(422);
 const gated=await closed.inject({method:'GET',url:`/v1/community/authors/${author.id}`});expect(gated.statusCode).toBe(200);expect(gated.json().items.map((x:any)=>x.kind)).toEqual(['editorial']);expect(gated.json().author.postCount).toBe(1);
 await pool.query('INSERT INTO ugc_block_relation(blocker_member_id,blocked_member_id) VALUES($1,$2)',[other.id,author.id]);expect((await read(other)).statusCode).toBe(404);expect((await read()).statusCode).toBe(200);
 await pool.query("UPDATE member SET status='blocked' WHERE id=$1",[author.id]);expect((await read()).statusCode).toBe(404);
});
it('allows an owner to remove the biography without sending empty text to the safety service',async()=>{
 const before=checked.length;const response=await save('',0,empty);expect(response.statusCode,response.body).toBe(200);expect(checked).toHaveLength(before);
 expect((await app.inject({method:'GET',url:'/v1/me/community-profile',headers:headers(empty)})).json().author.bio).toBe('');
});
