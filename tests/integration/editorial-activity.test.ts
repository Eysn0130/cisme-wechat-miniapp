import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import type {FastifyInstance} from 'fastify';
import {CANONICAL_WECHAT_MINIPROGRAM_APP_ID,loadConfig} from '@cisme/config';
import {resetDatabase,testPool,TEST_DATABASE_URL} from '@cisme/testkit';
import {AuthorityService} from '../../services/api/src/authority';
import {EditorialService} from '../../services/api/src/editorial';
import {EditorialActivityService} from '../../services/api/src/editorialActivity';
import {EditorialCommentsService} from '../../services/api/src/editorialComments';
import {createApiGatewayStorage} from '../../services/api/src/storage';
import {createApp} from '../../services/api/src/server';
import {issueSessionToken} from '../../services/api/src/auth';
import {transaction} from '../../services/api/src/db';

const pool=testPool(),config=loadConfig({APP_ENV:'test',DATABASE_URL:TEST_DATABASE_URL,APP_SESSION_SECRET:'synthetic-editorial-activity',
  UPLOAD_TOKEN_SECRET:'synthetic-activity-upload',WECHAT_APP_ID:CANONICAL_WECHAT_MINIPROGRAM_APP_ID,
  ALLOW_DEV_ADAPTERS:'false',UGC_GO_LIVE_GATE:'false',OBJECT_STORAGE_DRIVER:'api_gateway',CONTACT_ENCRYPTION_KEY:'1'.repeat(64),CONTACT_HASH_KEY:'2'.repeat(64)});
const storage=createApiGatewayStorage(config),authority=new AuthorityService(pool,'test'),editorial=new EditorialService(pool,config,storage,authority),
  activity=new EditorialActivityService(pool,config,editorial),comments=new EditorialCommentsService(pool,config,editorial,authority);
type Actor={id:string;principal:string};
let publisher:Actor,app:FastifyInstance;
async function actor(){
  const id=(await pool.query('INSERT INTO member(display_name) VALUES($1) RETURNING id',[`synthetic private ${randomUUID()}`])).rows[0].id;
  const identity=(await pool.query(`INSERT INTO wechat_identity(member_id,openid,adapter,provider,app_id)
    VALUES($1,$2,'wechat','wechat_miniprogram',$3) RETURNING id`,[id,`synthetic-activity-${randomUUID()}`,CANONICAL_WECHAT_MINIPROGRAM_APP_ID])).rows[0].id;
  return {id,principal:`wechat_miniprogram:${identity}`};
}
async function article(owner=publisher){
  if(owner!==publisher)await pool.query(`INSERT INTO authority_grant(member_id,capability,granted_by,grant_reason,environment,grant_source)
    VALUES($1,'editorial.manage','synthetic-operator','synthetic activity fixture','test','integration_fixture')`,[owner.id]);
  return (await editorial.publish(owner.id,owner.principal,{externalRef:`synthetic-activity-${randomUUID()}`,authorMemberId:owner.id,author:'公开精选作者',
    title:'合成精选标题',excerpt:'合成摘要',body:'只用于独立数据库的精选历史读取测试',sourceUrl:null,
    authorizationRef:'synthetic-activity',rightsEvidence:{kind:'synthetic-test'},media:[],expectedVersion:0})).id;
}
async function comment(articleId:string,owner:Actor,state='pending_review',extra:{parentId?:string;replyToId?:string;deletedAt?:boolean;body?:string}={}){
  const removed=state==='deleted',id=(await pool.query(`INSERT INTO editorial_comment(article_id,author_member_id,parent_id,reply_to_id,body,state,operation_id,request_sha256,deleted_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,CASE WHEN $9 THEN now() ELSE NULL END) RETURNING id`,[articleId,owner.id,extra.parentId??null,extra.replyToId??null,
      removed?null:extra.body??'本人的合成评论正文',state,`synthetic-${randomUUID()}`,'a'.repeat(64),removed||extra.deletedAt===true])).rows[0].id;return id;
}
function headers(owner:Actor){return {authorization:`Bearer ${issueSessionToken({principalId:owner.principal,memberId:owner.id,
  adapter:'wechat',provider:'wechat_miniprogram',appId:CANONICAL_WECHAT_MINIPROGRAM_APP_ID},config.sessionSecret)}`};}
async function read(owner:Actor,section:string,query=''){
  const response=await app.inject({url:`/v1/me/editorial/activity/${section}${query}`,headers:headers(owner)});
  expect(response.statusCode,response.body).toBe(200);expect(response.headers['cache-control']).toBe('private, no-store');return response.json();
}
async function save(owner:Actor,id:string,kind='save'){await pool.query('INSERT INTO community_reaction(member_id,post_id,kind) VALUES($1,$2,$3)',[owner.id,`editorial:${id}`,kind]);}
beforeAll(async()=>{
  await resetDatabase(pool);for(const type of ['terms','privacy'])await pool.query(`INSERT INTO legal_document(document_type,version,title,body,operator_name,contact,active)
    VALUES($1,'synthetic-activity-v1','synthetic legal','synthetic legal body','synthetic','synthetic',true)`,[type]);
  publisher=await actor();await pool.query(`INSERT INTO authority_grant(member_id,capability,granted_by,grant_reason,environment,grant_source)
    VALUES($1,'editorial.manage','synthetic-operator','synthetic activity publisher','test','integration_fixture')`,[publisher.id]);
  app=await createApp({pool,config,storage});
});
afterAll(async()=>{await app?.close();await pool.end();});
describe('member-owned editorial activity through the actual private HTTP routes',()=>{
  it('requires canonical active identity for both routes, keeps privacy sessions out, and rejects unsupported sections',async()=>{
    const viewer=await actor(),other=await actor(),id=await article();
    for(const section of ['comments','saves','reports','blocks'])expect((await app.inject({url:`/v1/me/editorial/activity/${section}`})).statusCode).toBe(401);
    expect((await app.inject({method:'DELETE',url:`/v1/me/editorial/saves/${id}`})).statusCode).toBe(401);
    await expect(activity.read(viewer.id,other.principal,'comments')).rejects.toMatchObject({code:'AUTH_REQUIRED'});
    const scoped={authorization:`Bearer ${issueSessionToken({principalId:viewer.principal,memberId:viewer.id,adapter:'wechat',provider:'wechat_miniprogram',appId:CANONICAL_WECHAT_MINIPROGRAM_APP_ID,scope:'privacy_rights'},config.sessionSecret)}`};
    expect((await app.inject({url:'/v1/me/editorial/activity/comments',headers:scoped})).statusCode).toBe(403);
    expect((await app.inject({url:'/v1/me/editorial/activity/appeals',headers:headers(viewer)})).statusCode).toBe(422);
    await pool.query("UPDATE member SET status='blocked' WHERE id=$1",[viewer.id]);
    await expect(activity.read(viewer.id,viewer.principal,'comments')).rejects.toMatchObject({code:'AUTH_REQUIRED'});
  });
  it('reads only the owner five-state history, preserves reply identifiers, and never returns held deletion text',async()=>{
    const viewer=await actor(),other=await actor(),id=await article();
    const root=await comment(id,other,'published',{body:'另一个人的正文，不应出现在本人历史'});
    const own=[];for(const state of ['pending_review','published','rejected','hidden','deleted'])own.push(await comment(id,viewer,state));
    const reply=await comment(id,viewer,'pending_review',{parentId:root,replyToId:root});
    const held=await comment(id,viewer,'hidden',{deletedAt:true,body:'法律保留的原文，不应恢复到用户视图'});
    const result=await read(viewer,'comments');expect(result.matchingTotal).toBe(7);expect(result.items).toHaveLength(7);
    expect(new Set(result.items.map((row:{id:string})=>row.id))).toEqual(new Set([...own,reply,held]));
    expect(result.items.find((row:{id:string})=>row.id===reply)).toMatchObject({parentId:root,replyToId:root,state:'pending_review',postId:id});
    expect(result.items.find((row:{id:string})=>row.id===held)).toMatchObject({state:'deleted',body:null});
    expect(JSON.stringify(result)).not.toMatch(/另一个人的正文|法律保留的原文|request_sha256|operation_id|author_member_id|openid|principal/);
    expect((await read(other,'comments')).items.map((row:{id:string})=>row.id)).toEqual([root]);
    expect((await pool.query('SELECT count(*)::int n FROM consent_acceptance WHERE member_id=$1',[viewer.id])).rows[0].n).toBe(0);
  });
  it.each(['withdrawn','inactive','noncanonical','block-out','block-in'])('keeps own history but withholds the article title under %s',async(mode)=>{
    const viewer=await actor(),author=await actor(),id=await article(author);await comment(id,viewer);await save(viewer,id);
    if(mode==='withdrawn')await pool.query("UPDATE editorial_article SET status='withdrawn' WHERE id=$1",[id]);
    if(mode==='inactive')await pool.query("UPDATE member SET status='blocked' WHERE id=$1",[author.id]);
    if(mode==='noncanonical')await pool.query("UPDATE wechat_identity SET app_id='wxsyntheticforeign' WHERE member_id=$1",[author.id]);
    if(mode.startsWith('block'))await pool.query('INSERT INTO ugc_block_relation(blocker_member_id,blocked_member_id) VALUES($1,$2)',mode==='block-out'?[viewer.id,author.id]:[author.id,viewer.id]);
    expect((await read(viewer,'comments')).items).toMatchObject([{postId:id,postTitle:null,available:false,body:'本人的合成评论正文'}]);
    expect((await read(viewer,'saves')).items).toMatchObject([{postId:id,title:null,available:false}]);
  });
  it('reads only real editorial saves, excluding ordinary preview strings, likes, and other owners',async()=>{
    const viewer=await actor(),other=await actor(),one=await article(),two=await article();
    await save(viewer,one);await save(viewer,two,'like');await save(other,two);
    await pool.query("INSERT INTO community_reaction(member_id,post_id,kind) VALUES($1,'synthetic-preview-card','save')",[viewer.id]);
    const result=await read(viewer,'saves');expect(result).toMatchObject({matchingTotal:1,loadedCount:1,hasMore:false,nextCursor:null,
      items:[{id:one,postId:one,source:'editorial',title:'合成精选标题',available:true}]});
  });
  it('returns only the reporters own evidence and real report state, without another comment body or moderation details',async()=>{
    const viewer=await actor(),other=await actor(),id=await article(),target=await comment(id,other,'published',{body:'不得泄漏的被举报评论正文'});
    const report=(await comments.report(viewer.id,viewer.principal,id,target,{category:'privacy',description:'我自己的举报说明'})).id;
    await comments.report(publisher.id,publisher.principal,id,target,{category:'spam',description:'另一个人的举报说明'});
    const result=await read(viewer,'reports');expect(result).toMatchObject({matchingTotal:1,items:[{id:report,postId:id,targetType:'comment',targetId:target,
      category:'privacy',description:'我自己的举报说明',state:'open',available:true}]});
    expect(JSON.stringify(result)).not.toMatch(/不得泄漏|另一个人的举报说明|decision|reporter_member_id/);
    await pool.query("UPDATE editorial_comment_report SET state='resolved' WHERE id=$1",[report]);
    await pool.query("UPDATE editorial_article SET status='withdrawn' WHERE id=$1",[id]);
    expect((await read(viewer,'reports')).items).toMatchObject([{state:'resolved',postTitle:null,available:false,description:'我自己的举报说明'}]);
  });
  it('reads shared owner-only blocks with safe public names and permits the existing unblock path for inactive targets',async()=>{
    const viewer=await actor(),privateTarget=await actor(),publicTarget=await actor(),inactive=await actor(),other=await actor();
    await pool.query(`INSERT INTO member_profile(member_id,handle_source,community_visible,public_status) VALUES($1,'self_reported',true,'approved')`,[publicTarget.id]);
    await pool.query("UPDATE member SET display_name='公开昵称' WHERE id=$1",[publicTarget.id]);
    for(const target of [privateTarget,publicTarget,inactive])await comments.block(viewer.id,viewer.principal,target.id,true);
    await comments.block(other.id,other.principal,publisher.id,true);await pool.query("UPDATE member SET status='blocked' WHERE id=$1",[inactive.id]);
    const result=await read(viewer,'blocks');expect(result.matchingTotal).toBe(3);
    expect(result.items.find((row:{memberId:string})=>row.memberId===publicTarget.id)).toMatchObject({displayName:'公开昵称',source:'shared'});
    for(const target of [privateTarget,inactive])expect(result.items.find((row:{memberId:string})=>row.memberId===target.id)).toMatchObject({displayName:'CISME 会员'});
    expect(JSON.stringify(result)).not.toContain('synthetic private');
    const unblocked=await app.inject({method:'PUT',url:`/v1/editorial/blocks/${inactive.id}`,headers:headers(viewer),payload:{active:false}});
    expect(unblocked.json()).toEqual({authorId:inactive.id,blocked:false});expect((await read(viewer,'blocks')).matchingTotal).toBe(2);
  });
  it('keyset-pages same-microsecond records once, counts all owner rows, and rejects section/member cursor reuse',async()=>{
    const viewer=await actor(),other=await actor(),id=await article(),ids=[];
    for(let i=0;i<5;i++)ids.push(await comment(id,viewer));
    await pool.query("UPDATE editorial_comment SET created_at='2026-10-28 12:00:00.123789+00' WHERE author_member_id=$1",[viewer.id]);
    const first=await read(viewer,'comments','?limit=2');expect(first).toMatchObject({matchingTotal:5,loadedCount:2,hasMore:true});
    expect(JSON.parse(Buffer.from(first.nextCursor,'base64url').toString()).t).toBe('2026-10-28 12:00:00.123789+00');
    let cursor=first.nextCursor;const found=first.items.map((row:{id:string})=>row.id);
    while(cursor){const page=await read(viewer,'comments',`?limit=2&cursor=${encodeURIComponent(cursor)}`);found.push(...page.items.map((row:{id:string})=>row.id));cursor=page.nextCursor;}
    expect(found).toEqual([...ids].sort().reverse());expect(new Set(found).size).toBe(5);
    for(const [who,section] of [[other,'comments'],[viewer,'saves']] as const){
      const response=await app.inject({url:`/v1/me/editorial/activity/${section}?cursor=${encodeURIComponent(first.nextCursor)}`,headers:headers(who)});
      expect(response.statusCode).toBe(422);expect(response.json().code).toBe('PAGE_CURSOR_INVALID');
    }
    for(const query of ['?limit=0','?limit=51','?cursor=broken'])expect((await app.inject({url:`/v1/me/editorial/activity/comments${query}`,headers:headers(viewer)})).statusCode).toBe(422);
  });
  it('removes only the owners save without current consent or visible content, idempotently, preserving likes and everyone elses associations',async()=>{
    const viewer=await actor(),other=await actor(),id=await article();await save(viewer,id);await save(viewer,id,'like');await save(other,id);
    await pool.query("INSERT INTO community_reaction(member_id,post_id,kind) VALUES($1,$2,'save')",[viewer.id,id]);
    await transaction(pool,async client=>{
      await client.query('INSERT INTO ugc_post(id,author_member_id,client_request_key) VALUES($1,$2,$3)',[id,viewer.id,`synthetic-${randomUUID()}`]);
      await client.query('INSERT INTO ugc_post_revision(post_id,revision,created_by_member_id,body) VALUES($1,1,$2,$3)',[id,viewer.id,'原投稿合成正文']);
      await client.query("INSERT INTO ugc_post_reaction(post_id,member_id,kind) VALUES($1,$2,'save')",[id,viewer.id]);
    });
    await pool.query("UPDATE editorial_article SET status='withdrawn' WHERE id=$1",[id]);
    await comments.block(viewer.id,viewer.principal,publisher.id,true);
    const before=(await pool.query("SELECT count(*)::int n FROM audit_log WHERE action='editorial.reaction'")).rows[0].n;
    for(const target of [id,id,randomUUID()]){
      const result=await app.inject({method:'DELETE',url:`/v1/me/editorial/saves/${target}`,headers:headers(viewer)});
      expect(result.statusCode,result.body).toBe(200);expect(result.json()).toEqual({id:target,saved:false});
    }
    expect((await pool.query("SELECT count(*)::int n FROM community_reaction WHERE member_id=$1 AND post_id=$2 AND kind='save'",[viewer.id,`editorial:${id}`])).rows[0].n).toBe(0);
    expect((await pool.query('SELECT post_id,kind FROM community_reaction WHERE member_id=$1 ORDER BY kind',[viewer.id])).rows).toEqual([{post_id:`editorial:${id}`,kind:'like'},{post_id:id,kind:'save'}]);
    expect((await pool.query("SELECT 1 FROM community_reaction WHERE member_id=$1 AND post_id=$2 AND kind='save'",[other.id,`editorial:${id}`])).rowCount).toBe(1);
    expect((await pool.query("SELECT 1 FROM ugc_post_reaction WHERE member_id=$1 AND post_id=$2 AND kind='save'",[viewer.id,id])).rowCount).toBe(1);
    expect((await pool.query('SELECT save_count,like_count FROM community_post_stats WHERE post_id=$1',[`editorial:${id}`])).rows[0]).toEqual({save_count:1,like_count:1});
    expect((await pool.query("SELECT count(*)::int n FROM audit_log WHERE action='editorial.reaction'")).rows[0].n).toBe(before+1);
    const proof=(await pool.query("SELECT after_state FROM audit_log WHERE action='editorial.reaction' AND object_id=$1 ORDER BY created_at DESC LIMIT 1",[id])).rows[0].after_state;
    expect(proof).toEqual({kind:'save',active:false,actorMemberId:viewer.id});
    expect((await pool.query('SELECT count(*)::int n FROM consent_acceptance WHERE member_id=$1',[viewer.id])).rows[0].n).toBe(0);
    expect((await read(viewer,'saves')).items).toEqual([]);
  });
  it('does not remove or disclose another members save and leaves old UGC activity behavior untouched',async()=>{
    const viewer=await actor(),other=await actor(),id=await article();await save(other,id);
    const oldBefore=await app.inject({url:'/v1/me/ugc/activity/saves',headers:headers(viewer)});
    const response=await app.inject({method:'DELETE',url:`/v1/me/editorial/saves/${id}`,headers:headers(viewer)});
    expect(response.json()).toEqual({id,saved:false});expect((await read(other,'saves')).matchingTotal).toBe(1);
    expect((await app.inject({url:'/v1/me/ugc/activity/saves',headers:headers(viewer)})).json()).toEqual(oldBefore.json());
    expect((await app.inject({url:'/v1/ugc/status'})).json().publicEnabled).toBe(false);
  });
});
