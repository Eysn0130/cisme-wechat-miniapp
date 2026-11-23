import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,expect,it,vi} from 'vitest';
import type {FastifyInstance} from 'fastify';
import {loadConfig,CANONICAL_WECHAT_MINIPROGRAM_APP_ID} from '@cisme/config';
import {resetDatabase,testPool,TEST_DATABASE_URL} from '@cisme/testkit';
import {createApp} from '../../services/api/src/server';
import {createApiGatewayStorage} from '../../services/api/src/storage';
import {EditorialService} from '../../services/api/src/editorial';
import {AuthorityService} from '../../services/api/src/authority';
import {issueSessionToken} from '../../services/api/src/auth';
import {processMemberPointSources} from '../../services/api/src/memberPointsClub';
import {directSafetyEnv,safeProvider} from './ugc-direct-fixture';

const pool=testPool(),config=loadConfig({...directSafetyEnv,APP_ENV:'test',DATABASE_URL:TEST_DATABASE_URL,
 WECHAT_APP_ID:CANONICAL_WECHAT_MINIPROGRAM_APP_ID,APP_SESSION_SECRET:'synthetic-curation-session',ADMIN_API_TOKEN:'synthetic-curation-admin',
 UPLOAD_TOKEN_SECRET:'synthetic-curation-upload',OBJECT_STORAGE_DRIVER:'api_gateway',UGC_GO_LIVE_GATE:'true',
 UGC_LEGAL_APPROVAL_ID:'synthetic-curation-go-live',UGC_PROVENANCE_READY:'true',UGC_CONTENT_SAFETY_READY:'true',UGC_MODERATION_READY:'true'});
const storage=createApiGatewayStorage(config);
type Actor={memberId:string;sessionToken:string;principal:string};
let app:FastifyInstance,admin:Actor,otherAdmin:Actor,reader:Actor,brand:Actor;
const auth=(a=admin)=>({authorization:`Bearer ${a.sessionToken}`});
async function actor(name:string):Promise<Actor>{
 const r=await app.inject({method:'POST',url:'/v1/identity/dev',payload:{externalUserId:name+randomUUID(),displayName:name,
  consents:[{documentType:'privacy',version:'test'},{documentType:'terms',version:'test'}]}});expect(r.statusCode,r.body).toBe(200);const a=r.json();
 const id=(await pool.query(`INSERT INTO wechat_identity(member_id,provider,app_id,openid,adapter)
  VALUES($1,'wechat_miniprogram',$2,$3,'wechat') RETURNING id`,[a.memberId,CANONICAL_WECHAT_MINIPROGRAM_APP_ID,'synthetic-curation-'+randomUUID()])).rows[0].id;
 const principal=`wechat_miniprogram:${id}`;
 return {...a,principal,sessionToken:issueSessionToken({memberId:a.memberId,principalId:principal,adapter:'wechat',provider:'wechat_miniprogram',appId:CANONICAL_WECHAT_MINIPROGRAM_APP_ID},config.sessionSecret)};
}
async function post(person:Actor,title='合成公开帖子'+randomUUID()){
 const created=await app.inject({method:'POST',url:'/v1/me/ugc/posts',headers:{...auth(person),'idempotency-key':randomUUID()},payload:{}});expect(created.statusCode,created.body).toBe(200);
 const d=created.json(),saved=await app.inject({method:'PUT',url:`/v1/me/ugc/posts/${d.id}/draft`,headers:auth(person),payload:{expectedVersion:d.version,title,body:'这是本人明确公开的合成护理使用体验'+randomUUID(),mediaIds:[]}});expect(saved.statusCode,saved.body).toBe(200);
 const published=await app.inject({method:'POST',url:`/v1/me/ugc/posts/${d.id}/submit`,headers:auth(person),payload:{expectedVersion:saved.json().version}});expect(published.statusCode,published.body).toBe(200);expect(published.json().state).toBe('published');return published.json();
}
const place=(id:string,version:number,placement='featured',a=admin)=>app.inject({method:'PUT',url:`/v1/management/ugc/posts/${id}/placement`,headers:auth(a),payload:{expectedVersion:version,placement}});
const listing=(state='recommend',a=admin)=>app.inject({url:`/v1/management/ugc/posts?state=${state}`,headers:auth(a)});
const featured=(a?:Actor)=>app.inject({url:'/v1/community/featured?limit=30',...(a?{headers:auth(a)}:{})});
const recommend=()=>app.inject({url:'/v1/ugc/posts?limit=30&channel=recommend'});
const rewards=()=>processMemberPointSources(pool,new Date(Date.now()+1000),100);
const balance=async(a:Actor)=>(await app.inject({url:'/v1/me/points',headers:auth(a)})).json().projection.available;
beforeAll(async()=>{
 vi.stubGlobal('fetch',safeProvider);await resetDatabase(pool);await storage.ensureReady();app=await createApp({config,pool,storage});
 admin=await actor('合成管理员');otherAdmin=await actor('合成管理员乙');reader=await actor('合成普通会员');brand=await actor('合成品牌作者');
 for(const a of [admin,otherAdmin])await pool.query(`INSERT INTO authority_grant(member_id,capability,granted_by,grant_reason,environment,grant_source)
  VALUES($1,'community.moderate','fixture','Synthetic post-management fixture','test','integration_fixture')`,[a.memberId]);
 await pool.query(`INSERT INTO authority_grant(member_id,capability,granted_by,grant_reason,environment,grant_source)
  VALUES($1,'editorial.manage','fixture','Synthetic editorial fixture','test','integration_fixture')`,[brand.memberId]);
 await pool.query(`INSERT INTO ugc_go_live_approval(approval_reference,signed_by,evidence,signed_at,expires_at)
  VALUES('synthetic-curation-go-live','isolated fixture','{"scope":"synthetic only"}',now(),now()+interval '1 hour')`);
 await pool.query("UPDATE emergency_switch SET enabled=true WHERE key='community'");
});
afterAll(async()=>{await app?.close();await pool.end();vi.unstubAllGlobals();});

it('requires an explicit current moderation capability for list and every mutation; no draft can be deleted through management',async()=>{
 const p=await post(reader);
 expect((await app.inject({url:'/v1/management/ugc/posts'})).statusCode).toBe(401);
 expect((await listing('recommend',reader)).statusCode).toBe(403);
 expect((await place(p.id,p.version,'featured',reader)).statusCode).toBe(403);
 expect((await app.inject({method:'DELETE',url:`/v1/management/ugc/posts/${p.id}`,headers:auth(reader),payload:{expectedVersion:p.version}})).statusCode).toBe(403);
 const d=(await app.inject({method:'POST',url:'/v1/me/ugc/posts',headers:{...auth(reader),'idempotency-key':randomUUID()},payload:{}})).json();
 expect((await app.inject({method:'DELETE',url:`/v1/management/ugc/posts/${d.id}`,headers:auth(),payload:{expectedVersion:d.version}})).statusCode).toBe(404);
 expect((await listing()).json().items.some((x:any)=>x.id===d.id)).toBe(false);
});
it('moves the exact public revision between channels, preserves the author, awards featured once and reverses content rewards on takedown',async()=>{
 const person=await actor('合成积分会员'),p=await post(person);await rewards();expect(await balance(person)).toBe(50);
 const selected=await place(p.id,p.version);expect(selected.statusCode,selected.body).toBe(200);await rewards();expect(await balance(person)).toBe(150);
 expect((await recommend()).json().items.some((x:any)=>x.id===p.id)).toBe(false);
 expect((await featured()).json().items.find((x:any)=>x.id===p.id)).toMatchObject({kind:'formal',authorId:person.memberId,author:'合成积分会员'});
 expect((await place(p.id,p.version)).json()).toMatchObject({replayed:true,version:selected.json().version});
 const returned=await place(p.id,selected.json().version,'recommend');expect(returned.statusCode,returned.body).toBe(200);
 expect((await recommend()).json().items.some((x:any)=>x.id===p.id)).toBe(true);expect((await featured()).json().items.some((x:any)=>x.id===p.id)).toBe(false);await rewards();expect(await balance(person)).toBe(150);
 const again=await place(p.id,returned.json().version);expect(again.statusCode,again.body).toBe(200);await rewards();expect(await balance(person)).toBe(150);
 expect((await pool.query("SELECT * FROM member_points_source_event WHERE kind='featured' AND source_id=$1",[p.id])).rowCount).toBe(1);
 const hidden=await app.inject({method:'POST',url:`/v1/management/ugc/posts/${p.id}/hide`,headers:auth(),payload:{expectedVersion:again.json().version,reason:'合成管理员下架核查'}});expect(hidden.statusCode,hidden.body).toBe(200);
 expect((await featured()).json().items.some((x:any)=>x.id===p.id)).toBe(false);expect((await recommend()).json().items.some((x:any)=>x.id===p.id)).toBe(false);
 expect((await app.inject({url:`/v1/ugc/posts/${p.id}`})).statusCode).toBe(404);await rewards();expect(await balance(person)).toBe(0);
 expect((await listing('hidden')).json().items.find((x:any)=>x.id===p.id)).toMatchObject({body:p.body,state:'hidden',placement:'hidden'});
 const appeal=await app.inject({method:'POST',url:`/v1/me/ugc/posts/${p.id}/appeals`,headers:auth(person),
  payload:{expectedVersion:hidden.json().version,reason:'请复核这次下架原因'}});
 expect(appeal.statusCode,appeal.body).toBe(200);
 const queue=()=>app.inject({url:'/v1/management/ugc/appeals',headers:auth(otherAdmin)});
 const pending=await queue();
 expect(pending.statusCode,pending.body).toBe(200);
 expect(pending.json().items).toContainEqual(expect.objectContaining({id:appeal.json().id}));
 const removed=await app.inject({method:'DELETE',url:`/v1/management/ugc/posts/${p.id}`,headers:auth(),payload:{expectedVersion:hidden.json().version}});expect(removed.statusCode,removed.body).toBe(200);
 expect((await listing('hidden')).json().items.some((x:any)=>x.id===p.id)).toBe(false);
 const afterRemoval=await queue();
 expect(afterRemoval.statusCode,afterRemoval.body).toBe(200);
 expect(afterRemoval.json().matchingTotal).toBe(pending.json().matchingTotal-1);
 expect(afterRemoval.json().items).not.toContainEqual(expect.objectContaining({id:appeal.json().id}));
 expect((await app.inject({url:'/v1/me/ugc/activity/appeals',headers:auth(person)})).json().items)
  .toContainEqual(expect.objectContaining({id:appeal.json().id,postDeleted:true}));
 expect((await pool.query('SELECT * FROM ugc_post_revision WHERE post_id=$1',[p.id])).rowCount).toBeGreaterThan(0);
 expect((await app.inject({method:'DELETE',url:`/v1/management/ugc/posts/${p.id}`,headers:auth(),payload:{expectedVersion:hidden.json().version}})).json()).toMatchObject({replayed:true,state:'deleted'});
 expect((await pool.query("SELECT principal_id FROM audit_log WHERE action='ugc.post_deleted' AND object_id=$1",[p.id])).rows).toEqual([{principal_id:`member:${admin.memberId}`}]);
});
it('never exposes a private newer draft, and a newly published revision returns to recommendation until separately selected',async()=>{
 const person=await actor('合成改稿会员'),p=await post(person),selected=await place(p.id,p.version);expect(selected.statusCode,selected.body).toBe(200);
 const saved=await app.inject({method:'PUT',url:`/v1/me/ugc/posts/${p.id}/draft`,headers:auth(person),payload:{expectedVersion:selected.json().version,title:'未公开修改'+randomUUID(),body:'尚未公开的私人修改不能出现在管理员帖子列表',mediaIds:[]}});expect(saved.statusCode,saved.body).toBe(200);
 const listed=(await listing('featured')).json().items.find((x:any)=>x.id===p.id);expect(listed.body).toBe(p.body);expect(listed.title).toBe(p.title);expect(JSON.stringify(listed)).not.toContain('私人修改');
 expect((await place(p.id,selected.json().version,'recommend')).statusCode).toBe(409);
 const updated=await app.inject({method:'POST',url:`/v1/me/ugc/posts/${p.id}/submit`,headers:auth(person),payload:{expectedVersion:saved.json().version}});expect(updated.statusCode,updated.body).toBe(200);
 expect((await featured()).json().items.some((x:any)=>x.id===p.id)).toBe(false);expect((await recommend()).json().items.find((x:any)=>x.id===p.id).title).toContain('未公开修改');
 expect((await place(p.id,updated.json().version)).statusCode).toBe(200);
 expect((await pool.query('SELECT * FROM member_points_featured WHERE post_id=$1',[p.id])).rowCount).toBe(1);
});
it('paginates mixed editorial and member sources without losing equal-time items, binds cursors to the reader, and honors blocks and the UGC gate',async()=>{
 const p=await post(await actor('合成分页会员'));expect((await place(p.id,p.version)).statusCode).toBe(200);
 const editorial=new EditorialService(pool,config,storage,new AuthorityService(pool,'test'));
 const a=await editorial.publish(brand.memberId,brand.principal,{externalRef:'synthetic-curation-brand-'+randomUUID(),authorMemberId:brand.memberId,author:'合成品牌作者',title:'合成品牌精选',excerpt:'合成简介',body:'合成品牌正文，不触及真实素材',sourceUrl:null,authorizationRef:'synthetic-curation-editorial',rightsEvidence:{kind:'synthetic fixture'},media:[],expectedVersion:0});
 const sameAt='2026-11-16T11:00:00.123456Z';await pool.query('UPDATE ugc_post SET featured_at=$2 WHERE id=$1',[p.id,sameAt]);await pool.query('UPDATE editorial_article SET published_at=$2 WHERE id=$1',[a.id,sameAt]);
 const full=(await featured(reader)).json().items,seen:string[]=[];let cursor:string|null=null;
 for(let n=0;n<10;n++){const r=await app.inject({url:'/v1/community/featured?limit=1'+(cursor?'&cursor='+encodeURIComponent(cursor):''),headers:auth(reader)});expect(r.statusCode,r.body).toBe(200);const page:{items:Array<{kind:string;id:string}>;nextCursor:string|null}=r.json();seen.push(...page.items.map((x:any)=>x.kind+':'+x.id));cursor=page.nextCursor;if(!cursor)break;}
 expect(seen).toEqual(full.map((x:any)=>x.kind+':'+x.id));expect(new Set(seen).size).toBe(seen.length);expect(full.some((x:any)=>x.id===a.id&&x.kind==='editorial')).toBe(true);
 const first=(await app.inject({url:'/v1/community/featured?limit=1',headers:auth(reader)})).json();expect(first.nextCursor).toBeTruthy();
 expect((await app.inject({url:'/v1/community/featured?cursor='+encodeURIComponent(first.nextCursor),headers:auth(admin)})).statusCode).toBe(422);
 const author=(await pool.query('SELECT author_member_id FROM ugc_post WHERE id=$1',[p.id])).rows[0].author_member_id;
 await pool.query('INSERT INTO ugc_block_relation(blocker_member_id,blocked_member_id) VALUES($1,$2)',[reader.memberId,author]);expect((await featured(reader)).json().items.some((x:any)=>x.id===p.id)).toBe(false);
 const closed=await createApp({config:{...config,ugcGoLiveGate:false},pool,storage});try{const cards=(await closed.inject({url:'/v1/community/featured'})).json().items;expect(cards.some((x:any)=>x.kind==='formal')).toBe(false);expect(cards.some((x:any)=>x.id===a.id)).toBe(true);}finally{await closed.close();}
});
it('prevents self-awards, stale deletion and writes after a moderation grant is revoked',async()=>{
 const own=await post(admin);expect((await place(own.id,own.version)).statusCode).toBe(403);
 const p=await post(reader);expect((await app.inject({method:'DELETE',url:`/v1/management/ugc/posts/${p.id}`,headers:auth(),payload:{expectedVersion:p.version+1}})).statusCode).toBe(409);
 await pool.query("UPDATE authority_grant SET revoked_at=now(),revoked_by='fixture',revoke_reason='Synthetic current-capability revocation' WHERE member_id=$1 AND capability='community.moderate'",[otherAdmin.memberId]);
 expect((await place(p.id,p.version,'featured',otherAdmin)).statusCode).toBe(403);expect((await listing('recommend',otherAdmin)).statusCode).toBe(403);
 expect((await app.inject({url:`/v1/ugc/posts/${p.id}`})).statusCode).toBe(200);
});
