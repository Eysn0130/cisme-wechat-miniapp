import {afterAll,beforeAll,describe,expect,it,vi} from 'vitest';
import {createHash,randomUUID} from 'node:crypto';
import type {FastifyInstance} from 'fastify';
import {CANONICAL_WECHAT_MINIPROGRAM_APP_ID,loadConfig} from '@cisme/config';
import {resetDatabase,testPool,TEST_DATABASE_URL} from '@cisme/testkit';
import {EditorialService} from '../../services/api/src/editorial';
import {EditorialCommentsService} from '../../services/api/src/editorialComments';
import {AuthorityService} from '../../services/api/src/authority';
import {createApiGatewayStorage} from '../../services/api/src/storage';
import {UgcSafetyService} from '../../services/api/src/ugcSafety';
import {createApp} from '../../services/api/src/server';
import {issueSessionToken} from '../../services/api/src/auth';
import {transaction} from '../../services/api/src/db';
import {AccountClosure,applyAccountClosure} from '../../services/api/src/accountClosure';
import {collectMemberPortableData} from '../../services/api/src/privacyPortableData';
import {DeliveryAddressService} from '../../services/api/src/deliveryAddress';
import jpeg from 'jpeg-js';
import {readFile} from 'node:fs/promises';
import {MemberProfile} from '../../services/api/src/memberProfile';
import {portableQuerySpecs} from '../../services/api/src/privacyPortableQueries';

const pool=testPool(),config=loadConfig({APP_ENV:'test',DATABASE_URL:TEST_DATABASE_URL,APP_SESSION_SECRET:'synthetic-editorial-comments',
  UPLOAD_TOKEN_SECRET:'synthetic-editorial-comment-upload',
  WECHAT_APP_ID:CANONICAL_WECHAT_MINIPROGRAM_APP_ID,WECHAT_APP_SECRET:'synthetic-wechat-secret',ALLOW_DEV_ADAPTERS:'false',UGC_GO_LIVE_GATE:'false',
  OBJECT_STORAGE_DRIVER:'api_gateway',CONTACT_ENCRYPTION_KEY:'1'.repeat(64),CONTACT_HASH_KEY:'2'.repeat(64)});
const storage=createApiGatewayStorage(config),authority=new AuthorityService(pool,'test'),editorial=new EditorialService(pool,config,storage,authority),
  comments=new EditorialCommentsService(pool,config,editorial,authority);
type Actor={id:string;principal:string;openid:string};
let author:Actor,reader:Actor,other:Actor,moderator:Actor,app:FastifyInstance;
async function actor(label:string){
  const id=(await pool.query('INSERT INTO member(display_name) VALUES($1) RETURNING id',[`synthetic ${label}`])).rows[0].id;
  const openid=`synthetic-editorial-comments-${randomUUID()}`;
  const identity=(await pool.query(`INSERT INTO wechat_identity(member_id,openid,adapter,provider,app_id) VALUES($1,$2,'wechat','wechat_miniprogram',$3) RETURNING id`,[id,openid,CANONICAL_WECHAT_MINIPROGRAM_APP_ID])).rows[0].id;
  const person={id,principal:`wechat_miniprogram:${identity}`,openid};await accept(person);return person;
}
async function accept(person:Actor){await editorial.acceptCurrentLegal(person.id,person.principal,{consents:[{documentType:'terms',version:'synthetic-comments-v1'},{documentType:'privacy',version:'synthetic-comments-v1'}]});}
async function grant(person:Actor,capability:string){await pool.query(`INSERT INTO authority_grant(member_id,capability,granted_by,grant_reason,environment,grant_source)
 VALUES($1,$2,'synthetic-operator','synthetic comments authorization','test','integration_fixture')`,[person.id,capability]);}
async function article(label:string,owner=author){return (await editorial.publish(owner.id,owner.principal,{externalRef:`synthetic-comments-${label}-${randomUUID()}`,
  authorMemberId:owner.id,author:'公开作者',title:'护理故事',excerpt:'用于独立评论测试',body:'合成测试正文，不代表生产内容',sourceUrl:null,
  authorizationRef:'synthetic-editorial-authorization',rightsEvidence:{kind:'synthetic test'},media:[],expectedVersion:0})).id;}
function headers(person:Actor){return {authorization:`Bearer ${issueSessionToken({principalId:person.principal,memberId:person.id,adapter:'wechat',provider:'wechat_miniprogram',appId:CANONICAL_WECHAT_MINIPROGRAM_APP_ID},config.sessionSecret)}`};}
const submit=(id:string,person=reader,body='这是一条真实保存的合成评论',replyToId?:string,key=`synthetic-${randomUUID()}`)=>comments.create(person.id,person.principal,id,key,{body,replyToId});
function scanner(suggest='pass',fetcher?:typeof fetch){return new UgcSafetyService(pool,config,storage,fetcher??(async(url,options)=>{
  if(String(url).includes('/cgi-bin/token?'))return new Response(JSON.stringify({access_token:'synthetic-provider-token',expires_in:7200}));
  const input=JSON.parse(String(options?.body));expect(input).toMatchObject({version:2,scene:2});expect(input.openid).toMatch(/^synthetic-editorial-comments-/);
  return new Response(JSON.stringify({errcode:0,result:{suggest,label:100},detail:{text:'must never enter immutable editorial proof'}}));
}) as typeof fetch);}
async function approve(id:string,who=author){await pool.query("UPDATE editorial_comment SET state='pending_review' WHERE id=$1",[id]);await scanner().scanEditorialComment(id);return comments.review(who.id,who.principal,id,{decision:'approve',reason:'已核对安全检查与评论内容',expectedVersion:1});}
beforeAll(async()=>{
  await resetDatabase(pool);for(const type of ['terms','privacy'])await pool.query(`INSERT INTO legal_document(document_type,version,title,body,operator_name,contact,active)
    VALUES($1,'synthetic-comments-v1','synthetic legal','synthetic comment processing notice','synthetic','synthetic',true)`,[type]);
  author=await actor('author');reader=await actor('reader');other=await actor('other');moderator=await actor('moderator');
  await grant(author,'editorial.manage');await grant(other,'editorial.manage');await grant(moderator,'community.moderate');app=await createApp({pool,config,storage});
});
afterAll(async()=>{await app?.close();await pool.end();});
describe('real editorial comments with ordinary UGC still closed (disposable synthetic DB)',()=>{
  it('exposes public empty comments and actual detail policy without inventing UGC posts or consent',async()=>{
    const id=await article('empty'),before=(await pool.query('SELECT count(*)::int n FROM consent_acceptance')).rows[0].n;
    const response=await app.inject({method:'GET',url:`/v1/editorial/articles/${id}/comments`});expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({comments:[],commentCount:0,commentsEnabled:true,commentsPolicyVersion:0,canModerate:false,preview:false,nextCursor:null});
    expect((await app.inject({method:'GET',url:`/v1/editorial/articles/${id}`,headers:headers(author)})).json()).toMatchObject({commentCount:0,commentsEnabled:true,canModerate:true});
    expect((await pool.query('SELECT count(*)::int n FROM ugc_post')).rows[0].n).toBe(0);
    expect((await pool.query('SELECT count(*)::int n FROM consent_acceptance')).rows[0].n).toBe(before);
    expect((await app.inject({method:'GET',url:'/v1/ugc/status'})).json().publicEnabled).toBe(false);
  });
  it('synchronizes current saved nickname and sanitized avatar for published comments independently of public-profile approval',async()=>{
    const person=await actor('profile-commenter'),id=await article('profile-sync'),profiles=new MemberProfile(pool,'test');
    const avatar=(color:number)=>`data:image/jpeg;base64,${jpeg.encode({data:Buffer.from([color,20,30,255]),width:1,height:1},60).data.toString('base64')}`;
    await profiles.update(person.id,{displayName:'已保存昵称',avatarDataUrl:avatar(80),communityVisible:false,expectedVersion:0});
    const row=await submit(id,person),first=await comments.read(undefined,id),saved=await profiles.get(person.id);
    expect(first.comments[0]).toMatchObject({id:row.id,status:'published',authorName:'已保存昵称'});
    expect(first.authors[person.id]).toEqual({name:'已保存昵称',avatar:saved.avatar_data_url,avatarRevision:saved.avatar_revision});
    await profiles.update(person.id,{displayName:'新昵称立即同步',avatarDataUrl:avatar(180),expectedVersion:1});
    const second=await comments.read(undefined,id),updated=await profiles.get(person.id);
    expect(second.comments[0]!.authorName).toBe('新昵称立即同步');expect(second.authors[person.id]).toEqual({name:'新昵称立即同步',avatar:updated.avatar_data_url,avatarRevision:updated.avatar_revision});
    expect(second.authors[person.id]!.avatarRevision).not.toBe(first.authors[person.id]!.avatarRevision);
    expect(JSON.stringify(second)).not.toContain(person.openid);expect(JSON.stringify(second)).not.toContain('wechat_handle');
    expect(updated.public_status).toBe('private');
    await expect(comments.remove(person.id,person.principal,id,row.id)).rejects.toMatchObject({code:'CAPABILITY_REQUIRED'});
    expect(await comments.remove(moderator.id,moderator.principal,id,row.id)).toMatchObject({status:'deleted'});
  });
  it('requires the canonical authenticated actor and current explicit legal acceptance for publishing',async()=>{
    const id=await article('auth');
    expect((await app.inject({method:'POST',url:`/v1/editorial/articles/${id}/comments`,payload:{body:'游客不能代写评论'}})).statusCode).toBe(401);
    await expect(comments.create(reader.id,other.principal,id,'synthetic-invalid-actor',{body:'错误主体不得提交'})).rejects.toMatchObject({code:'AUTH_REQUIRED'});
    await pool.query('DELETE FROM consent_acceptance WHERE member_id=$1',[reader.id]);
    await expect(submit(id)).rejects.toMatchObject({code:'CURRENT_LEGAL_CONSENT_REQUIRED'});await accept(reader);
    for(const body of ['', '字', 'x'.repeat(181),'无效\u0000字符'])await expect(submit(id,reader,body)).rejects.toMatchObject({code:'COMMENT_BODY_INVALID'});
  });
  it('serves the actual required-write/public-read/manage/delete routes with canonical local results',async()=>{
    const id=await article('http'),key=`synthetic-${randomUUID()}`;
    const created=await app.inject({method:'POST',url:`/v1/editorial/articles/${id}/comments`,headers:{...headers(reader),'idempotency-key':key},payload:{body:'通过真实接口保存的评论',memberId:other.id}});
    expect(created.statusCode).toBe(200);const row=created.json();expect(row).toMatchObject({status:'published',version:1,replayed:false});
    expect((await app.inject({method:'GET',url:`/v1/editorial/articles/${id}/comments`,headers:headers(reader)})).json().comments).toMatchObject([{id:row.id,isMine:true,status:'published'}]);
    expect((await app.inject({method:'GET',url:`/v1/management/editorial/comments?articleId=${id}`,headers:headers(author)})).json().items).toMatchObject([{id:row.id,articleId:id,version:1}]);
    await pool.query("UPDATE editorial_comment SET state='pending_review' WHERE id=$1",[row.id]);await scanner().scanEditorialComment(row.id);
    expect((await app.inject({method:'POST',url:`/v1/management/editorial/comments/${row.id}/review`,headers:headers(author),payload:{decision:'approve',reason:'接口审核与版本校验',expectedVersion:1}})).json()).toMatchObject({status:'published',version:2});
    expect((await app.inject({method:'DELETE',url:`/v1/editorial/articles/${id}/comments/${row.id}`,headers:headers(other)})).statusCode).toBe(403);
    expect((await app.inject({method:'DELETE',url:`/v1/editorial/articles/${id}/comments/${row.id}`,headers:headers(reader)})).statusCode).toBe(403);
    expect((await app.inject({method:'DELETE',url:`/v1/editorial/articles/${id}/comments/${row.id}`,headers:headers(author)})).json()).toMatchObject({id:row.id,status:'deleted'});
    expect((await app.inject({method:'POST',url:`/v1/editorial/articles/${id}/comments`,headers:{...headers(reader),'idempotency-key':key},payload:{body:'通过真实接口保存的评论'}})).json()).toMatchObject({id:row.id,status:'deleted',replayed:true});
    expect((await comments.read(undefined,id)).commentCount).toBe(0);
  });
  it('publishes one comment immediately under concurrent retries and serves it publicly without administrator review',async()=>{
    const id=await article('retry'),key=`synthetic-${randomUUID()}`;
    const results=await Promise.all(Array.from({length:4},()=>submit(id,reader,'并发只创建一次评论',undefined,key)));
    expect(new Set(results.map(row=>row.id)).size).toBe(1);expect(results.filter(row=>!row.replayed)).toHaveLength(1);
    expect((await comments.read(undefined,id)).comments).toMatchObject([{id:results[0]!.id,status:'published'}]);
    expect(await comments.read(reader.id,id)).toMatchObject({commentCount:1,comments:[{id:results[0]!.id,status:'published',isMine:true,replyRootId:results[0]!.id}]});
    expect((await comments.read(other.id,id)).comments).toMatchObject([{id:results[0]!.id,status:'published',isMine:false}]);
    await expect(submit(id,reader,'换过正文不能用同一编号',undefined,key)).rejects.toMatchObject({code:'IDEMPOTENCY_CONFLICT'});
  });
  it('requires a matching safe WeChat result even in tests, audits real self moderation and rejects CAS drift',async()=>{
    const id=await article('review'),own=await submit(id,author);await pool.query("UPDATE editorial_comment SET state='pending_review' WHERE id=$1",[own.id]);
    await expect(comments.review(author.id,author.principal,own.id,{decision:'approve',reason:'真实作者审核自己的评论',expectedVersion:1})).rejects.toMatchObject({code:'COMMENT_TEXT_SCAN_REQUIRED'});
    expect(await approve(own.id)).toMatchObject({status:'published',version:2});
    await expect(comments.review(author.id,author.principal,own.id,{decision:'hide',reason:'旧版本不应覆盖新状态',expectedVersion:1})).rejects.toMatchObject({code:'COMMENT_REVIEW_CONFLICT'});
    const scan=(await pool.query('SELECT * FROM editorial_comment_safety_scan WHERE comment_id=$1',[own.id])).rows[0];
    expect(scan).toMatchObject({provider:'wechat_v2',state:'safe',body_sha256:createHash('sha256').update('这是一条真实保存的合成评论').digest('hex')});
    expect(JSON.stringify(scan)).not.toContain('must never');expect(JSON.stringify(scan)).not.toContain(author.openid);
    expect((await pool.query("SELECT 1 FROM audit_log WHERE action='editorial.comment_review' AND object_id=$1 AND principal_id=$2",[own.id,author.principal])).rowCount).toBe(1);
  });
  it('rejects non-string dispatch inputs without changing review state, reports or audit',async()=>{
    const id=await article('strict-dispatch'),row=await submit(id),before=(await pool.query('SELECT count(*)::int n FROM audit_log')).rows[0].n;
    for(const decision of [['approve'],['reject'],['hide'],{toString:'approve'},42,null]){
      const response=await app.inject({method:'POST',url:`/v1/management/editorial/comments/${row.id}/review`,headers:headers(author),payload:{decision,reason:'数组不能改变真实处理决定',expectedVersion:1}});
      expect(response.statusCode).toBe(422);expect(response.json().code).toBe('COMMENT_REVIEW_INVALID');
    }
    const report=await app.inject({method:'POST',url:`/v1/editorial/articles/${id}/comments/${row.id}/report`,headers:headers(other),payload:{category:['spam']}});
    expect(report.statusCode).toBe(422);expect(report.json().code).toBe('COMMENT_REPORT_INVALID');
    const queue=await app.inject({method:'GET',url:'/v1/management/editorial/comments?state=pending&state=pending',headers:headers(author)});
    expect(queue.statusCode).toBe(422);expect(queue.json().code).toBe('COMMENT_REVIEW_INVALID');
    expect((await pool.query('SELECT state,version FROM editorial_comment WHERE id=$1',[row.id])).rows[0]).toEqual({state:'published',version:1});
    expect((await pool.query('SELECT 1 FROM editorial_comment_report WHERE comment_id=$1',[row.id])).rowCount).toBe(0);
    expect((await pool.query('SELECT count(*)::int n FROM audit_log')).rows[0].n).toBe(before);
  });
  it('patrols directly published text, hides risky/review results and retries failures with bounded claims',async()=>{
    const id=await article('scan');for(const verdict of ['review','risky']){
      const row=await submit(id,reader,`需要核对的 ${verdict} 评论`);expect(await scanner(verdict).scanEditorialComment(row.id)).toMatchObject({state:verdict});
      expect((await comments.read(undefined,id)).comments.some(item=>item.id===row.id)).toBe(false);
      expect((await pool.query('SELECT state FROM editorial_comment WHERE id=$1',[row.id])).rows[0].state).toBe('hidden');
    }
    const row=await submit(id),failed=scanner('pass',async()=>{throw new Error('synthetic network error');});
    expect(await failed.scanEditorialComment(row.id)).toMatchObject({state:'error'});
    const claim=(await pool.query('SELECT * FROM editorial_comment_scan_claim WHERE comment_id=$1',[row.id])).rows[0];expect(claim).toMatchObject({state:'pending',attempt_count:1,last_error:'UGC_SCAN_UNAVAILABLE'});
    await comments.remove(author.id,author.principal,id,row.id);await expect(scanner().scanEditorialComment(row.id)).rejects.toMatchObject({code:'UGC_COMMENT_SCAN_CONFLICT'});
    expect((await comments.read(undefined,id)).commentCount).toBe(0);
  });
  it('fences concurrent scanner deliveries and ignores a result after administrator deletion',async()=>{
    const id=await article('fence'),row=await submit(id);let release!:()=>void,entered!:()=>void;
    const started=new Promise<void>(resolve=>entered=resolve),waiting=new Promise<void>(resolve=>release=resolve);const calls=vi.fn();
    const slow=scanner('pass',async(url)=>{if(String(url).includes('/cgi-bin/token?'))return new Response(JSON.stringify({access_token:'synthetic-token'}));calls();entered();await waiting;return new Response(JSON.stringify({errcode:0,result:{suggest:'pass'}}));});
    const first=slow.scanEditorialComment(row.id);await started;expect(await slow.scanEditorialComment(row.id)).toMatchObject({state:'pending'});expect(calls).toHaveBeenCalledOnce();
    await comments.remove(author.id,author.principal,id,row.id);release();expect(await first).toMatchObject({state:'obsolete'});
    expect((await pool.query('SELECT 1 FROM editorial_comment_safety_scan WHERE comment_id=$1',[row.id])).rowCount).toBe(0);
  });
  it('retries only editorial text without a media scan URL and never invokes ordinary UGC adapters',async()=>{
    const id=await article('text-only'),row=await submit(id);await pool.query("UPDATE editorial_comment SET created_at='2000-01-01' WHERE id=$1",[row.id]);
    const safety=scanner(),post=vi.spyOn(safety,'scanPost'),ugc=vi.spyOn(safety,'scanComment'),nickname=vi.spyOn(safety,'scanNickname');
    expect(await safety.scanPendingBatch('',1)).toBe(1);expect(post).not.toHaveBeenCalled();expect(ugc).not.toHaveBeenCalled();expect(nickname).not.toHaveBeenCalled();
    expect((await pool.query('SELECT state FROM editorial_comment_safety_scan WHERE comment_id=$1',[row.id])).rows[0].state).toBe('safe');
  });
  it('derives real reply roots, rejects cross-article references and removes a hidden root with its replies from counts',async()=>{
    const id=await article('thread'),elsewhere=await article('other-thread'),root=await submit(id);await approve(root.id);
    const reply=await submit(id,other,'回复根评论',root.id);await approve(reply.id);const nested=await submit(id,reader,'回复这一条回复',reply.id);await approve(nested.id);
    const view=await comments.read(undefined,id);expect(view.commentCount).toBe(3);expect(view.comments.map(row=>[row.id,row.parentId,row.replyRootId,row.replyToId])).toEqual([
      [root.id,null,root.id,null],[reply.id,root.id,root.id,root.id],[nested.id,root.id,root.id,reply.id]]);
    await expect(submit(elsewhere,reader,'不能跨文章回复',reply.id)).rejects.toMatchObject({code:'COMMENT_REPLY_UNAVAILABLE'});
    await comments.review(author.id,author.principal,root.id,{decision:'hide',reason:'根评论隐藏需同步回复可见性',expectedVersion:2});
    expect(await comments.read(undefined,id)).toMatchObject({commentCount:0,comments:[]});
    await expect(submit(id,reader,'不可回复隐藏根下回复',reply.id)).rejects.toMatchObject({code:'COMMENT_REPLY_UNAVAILABLE'});
    await expect(comments.like(other.id,other.principal,id,reply.id,true)).rejects.toMatchObject({code:'COMMENT_NOT_FOUND'});
  });
  it('prevents cross-thread references at the database boundary, not only in the API',async()=>{
    const first=await article('db-first'),second=await article('db-second'),a=await submit(first),b=await submit(second);
    await expect(pool.query(`INSERT INTO editorial_comment(article_id,author_member_id,parent_id,reply_to_id,body,operation_id,request_sha256)
      VALUES($1,$2,$3,$4,'无效跨文章评论',$5,$6)`,[first,reader.id,a.id,b.id,`synthetic-${randomUUID()}`,'a'.repeat(64)])).rejects.toThrow('EDITORIAL_COMMENT_THREAD_MISMATCH');
  });
  it('sets comment likes idempotently and exposes only active account counts',async()=>{
    const id=await article('likes'),row=await submit(id);await approve(row.id);
    const send=()=>app.inject({method:'PUT',url:`/v1/editorial/articles/${id}/comments/${row.id}/like`,headers:headers(other),payload:{active:true}});
    expect((await send()).json()).toMatchObject({liked:true,likeCount:1});expect((await send()).json()).toMatchObject({liked:true,likeCount:1});
    expect((await comments.read(other.id,id)).comments[0]).toMatchObject({liked:true,likeCount:1});
    await pool.query("UPDATE member SET status='blocked' WHERE id=$1",[other.id]);expect((await comments.read(undefined,id)).comments[0]!.likeCount).toBe(0);
    await pool.query("UPDATE member SET status='active' WHERE id=$1",[other.id]);
  });
  it('keeps rejected comments visible only to their author and never publicly counts them',async()=>{
    const id=await article('reject'),row=await submit(id);await pool.query("UPDATE editorial_comment SET state='pending_review' WHERE id=$1",[row.id]);await comments.review(author.id,author.principal,row.id,{decision:'reject',reason:'审核后退回评论',expectedVersion:1});
    expect((await comments.read(reader.id,id)).comments).toMatchObject([{id:row.id,status:'rejected',isMine:true}]);expect((await comments.read(undefined,id)).comments).toEqual([]);
  });
  it('scopes management to actual grants and owning articles; revocation immediately removes access',async()=>{
    const own=await article('scope-own'),foreign=await article('scope-foreign',other);const a=await submit(own),b=await submit(foreign);
    const ownQueue=await comments.queue(author.id,author.principal);expect(ownQueue.items.some(row=>row.id===a.id)).toBe(true);expect(ownQueue.items.some(row=>row.id===b.id)).toBe(false);
    expect((await comments.queue(author.id,author.principal,{articleId:own})).items.map(row=>row.id)).toEqual([a.id]);
    await expect(comments.review(author.id,author.principal,b.id,{decision:'hide',reason:'不能跨作者管理精选',expectedVersion:1})).rejects.toMatchObject({code:'CAPABILITY_REQUIRED'});
    expect((await comments.queue(moderator.id,moderator.principal)).items.some(row=>row.id===b.id)).toBe(true);
    await expect(comments.queue(reader.id,reader.principal)).rejects.toMatchObject({code:'CAPABILITY_REQUIRED'});
    await pool.query("UPDATE authority_grant SET revoked_at=now(),revoked_by='synthetic',revoke_reason='synthetic revocation' WHERE member_id=$1 AND capability='community.moderate'",[moderator.id]);
    await expect(comments.queue(moderator.id,moderator.principal)).rejects.toMatchObject({code:'CAPABILITY_REQUIRED'});await grant(moderator,'community.moderate');
  });
  it('records reports without duplicate cases and applies reversible block filtering to roots and replies',async()=>{
    const id=await article('report'),row=await submit(id),reply=await (async()=>{await approve(row.id);const reply=await submit(id,other,'另一位读者的回复',row.id);await approve(reply.id);return reply;})();
    const report=()=>comments.report(other.id,other.principal,id,row.id,{category:'misinformation',description:'合成举报依据'});
    expect((await report()).id).toBe((await report()).id);expect((await comments.queue(author.id,author.principal,{state:'reported'})).items).toMatchObject([{id:row.id,reportCount:1}]);
    await comments.block(other.id,other.principal,reader.id,true);expect((await comments.read(other.id,id)).commentCount).toBe(0);
    await expect(comments.like(other.id,other.principal,id,row.id,true)).rejects.toMatchObject({code:'COMMENT_NOT_FOUND'});
    expect((await comments.read(undefined,id)).commentCount).toBe(2);await comments.block(other.id,other.principal,reader.id,false);
    expect((await comments.read(other.id,id)).comments.map(row=>row.id)).toEqual([row.id,reply.id]);
    await comments.review(author.id,author.principal,row.id,{decision:'hide',reason:'已核对举报内容并隐藏',expectedVersion:2});
    expect((await pool.query('SELECT state FROM editorial_comment_report WHERE comment_id=$1',[row.id])).rows[0].state).toBe('resolved');
  });
  it('rejects new comments across an actual block relationship with the article owner',async()=>{
    const id=await article('owner-block');await comments.block(author.id,author.principal,reader.id,true);
    await expect(submit(id)).rejects.toMatchObject({code:'COMMENT_NOT_FOUND'});
    await comments.block(author.id,author.principal,reader.id,false);expect(await submit(id)).toMatchObject({status:'published'});
  });
  it('lists only the authenticated member blocks across page visits with private profiles and scoped pagination',async()=>{
    const person=await actor('block-list-owner'),first=await actor('blocked-one'),second=await actor('blocked-two'),third=await actor('blocked-three');
    for(const target of [first,second,third])await comments.block(person.id,person.principal,target.id,true);
    await pool.query("UPDATE ugc_block_relation SET created_at='2026-10-28 00:00:00.123456+00' WHERE blocker_member_id=$1",[person.id]);
    const get=(query='')=>app.inject({method:'GET',url:`/v1/editorial/blocks${query}`,headers:headers(person)});
    expect((await app.inject({method:'GET',url:'/v1/editorial/blocks'})).statusCode).toBe(401);
    await expect(comments.blocks(person.id,reader.principal)).rejects.toMatchObject({code:'AUTH_REQUIRED'});
    const one=(await get('?limit=2')).json(),two=(await get(`?limit=2&cursor=${one.nextCursor}`)).json();
    expect(one).toMatchObject({loadedCount:2,hasMore:true});expect(two).toMatchObject({loadedCount:1,hasMore:false,nextCursor:null});
    expect(new Set([...one.items,...two.items].map(row=>row.authorId)).size).toBe(3);
    for(const row of [...one.items,...two.items])expect(row).toEqual({authorId:row.authorId,name:'CISME 会员',avatar:'',avatarRevision:null});
    expect(JSON.stringify(one)).not.toContain(first.openid);expect(JSON.stringify(one)).not.toContain('synthetic blocked');
    await expect(comments.blocks(reader.id,reader.principal,{cursor:one.nextCursor})).rejects.toMatchObject({code:'PAGE_CURSOR_INVALID'});
    expect((await comments.blocks(other.id,other.principal)).items).not.toEqual(expect.arrayContaining([expect.objectContaining({authorId:first.id})]));
    // A fresh service instance still reads the real relation; it is not tied to
    // a page-local lastBlockedAuthor. Removal needs no renewed legal consent.
    const fresh=new EditorialCommentsService(pool,config,editorial,authority);
    await pool.query('DELETE FROM consent_acceptance WHERE member_id=$1',[person.id]);
    expect((await fresh.blocks(person.id,person.principal)).items).toHaveLength(3);
    await pool.query("UPDATE member SET status='blocked' WHERE id=$1",[first.id]);
    expect((await fresh.blocks(person.id,person.principal)).items).toEqual(expect.arrayContaining([{authorId:first.id,name:'CISME 会员',avatar:'',avatarRevision:null}]));
    expect(await fresh.block(person.id,person.principal,first.id,false)).toMatchObject({blocked:false});
    expect((await fresh.blocks(person.id,person.principal)).items).toHaveLength(2);
  });
  it('closes only the selected article and still permits an administrator to remove comments without renewed consent',async()=>{
    const id=await article('policy'),row=await submit(id),foreign=await article('other-policy');await approve(row.id);
    expect(await comments.setPolicy(author.id,author.principal,id,{enabled:false,expectedVersion:0})).toEqual({commentsEnabled:false,commentsPolicyVersion:1});
    expect(await comments.read(undefined,id)).toMatchObject({commentsEnabled:false,commentCount:1});expect((await comments.read(undefined,foreign)).commentsEnabled).toBe(true);
    await expect(submit(id)).rejects.toMatchObject({code:'EDITORIAL_COMMENTS_CLOSED'});
    await expect(comments.setPolicy(author.id,author.principal,id,{enabled:true,expectedVersion:0})).rejects.toMatchObject({code:'COMMENT_POLICY_CONFLICT'});
    await pool.query('DELETE FROM consent_acceptance WHERE member_id=$1',[reader.id]);
    expect(await comments.remove(author.id,author.principal,id,row.id)).toEqual({id:row.id,status:'deleted'});await accept(reader);
    expect((await pool.query('SELECT body FROM editorial_comment WHERE id=$1',[row.id])).rows[0].body).toBeNull();
    expect((await comments.read(undefined,id)).commentCount).toBe(0);
  });
  it('hides a held deletion immediately, keeps only protected evidence, and clears it after release',async()=>{
    const id=await article('held-delete'),row=await submit(id);await approve(row.id);
    const hold=(await pool.query(`INSERT INTO legal_hold(reason_code,legal_basis,approved_by,review_at,expires_at)
      VALUES('SYNTHETIC_COMMENT_HOLD','synthetic temporary dispute','synthetic',now()+interval '1 day',now()+interval '2 days') RETURNING id`)).rows[0].id;
    await pool.query("INSERT INTO legal_hold_binding(hold_id,object_type,object_id) VALUES($1,'editorial_comment',$2)",[hold,row.id]);
    expect(await comments.remove(author.id,author.principal,id,row.id)).toMatchObject({status:'deleted'});
    expect((await comments.read(reader.id,id)).comments).toEqual([]);expect((await comments.read(undefined,id)).commentCount).toBe(0);
    expect((await comments.queue(author.id,author.principal,{articleId:id,state:'hidden'})).items).toEqual([]);
    expect((await pool.query('SELECT state,body,deleted_at FROM editorial_comment WHERE id=$1',[row.id])).rows[0]).toMatchObject({state:'hidden',body:'这是一条真实保存的合成评论',deleted_at:expect.any(Date)});
    await pool.query("UPDATE legal_hold SET status='released',released_at=now(),released_by='synthetic' WHERE id=$1",[hold]);
    await comments.remove(author.id,author.principal,id,row.id);expect((await pool.query('SELECT state,body FROM editorial_comment WHERE id=$1',[row.id])).rows[0]).toEqual({state:'deleted',body:null});
  });
  it('paginates with actual microsecond keys and rejects cursors for another actor/article',async()=>{
    const id=await article('page');for(let n=0;n<3;n++){const row=await submit(id,reader,`分页评论 ${n}`);await approve(row.id);}
    await pool.query("UPDATE editorial_comment SET created_at='2026-10-28 00:00:00.123456+00' WHERE article_id=$1",[id]);
    const first=await comments.read(undefined,id,{limit:2}),second=await comments.read(undefined,id,{limit:2,cursor:first.nextCursor});
    expect(first.commentCount).toBe(3);expect(new Set([...first.comments,...second.comments].map(row=>row.id)).size).toBe(3);expect(second.nextCursor).toBeNull();
    await expect(comments.read(reader.id,id,{cursor:first.nextCursor})).rejects.toMatchObject({code:'PAGE_CURSOR_INVALID'});
  });
  it('withdraws article comments immediately and refuses to approve or post after withdrawal',async()=>{
    const id=await article('withdraw'),publicRow=await submit(id),pending=await submit(id,other);await approve(publicRow.id);
    await pool.query("UPDATE editorial_comment SET state='pending_review' WHERE id=$1",[pending.id]);
    await editorial.withdraw(author.id,author.principal,id,1,'SYNTHETIC_OWNER_WITHDRAWAL');
    await expect(comments.read(undefined,id)).rejects.toMatchObject({code:'EDITORIAL_NOT_FOUND'});await expect(submit(id)).rejects.toMatchObject({code:'EDITORIAL_NOT_FOUND'});
    await scanner().scanEditorialComment(pending.id).catch(()=>{});
    await expect(comments.review(author.id,author.principal,pending.id,{decision:'approve',reason:'撤回后不能公开评论',expectedVersion:1})).rejects.toMatchObject({code:'EDITORIAL_NOT_FOUND'});
    expect(await comments.remove(author.id,author.principal,id,publicRow.id)).toMatchObject({status:'deleted'});
  });
  it('migrates only eligible legacy pending comments while retaining risk, hidden and inactive facts with an audit',async()=>{
    const id=await article('legacy-migration'),safe=await submit(id),risky=await submit(id,other),hidden=await submit(id,author);
    const disabled=await actor('legacy-disabled'),inactive=await submit(id,disabled);
    const reply=await submit(id,other,'旧待处理评论的回复',safe.id);
    await pool.query("UPDATE editorial_comment SET state='pending_review' WHERE id=ANY($1::uuid[])",[[safe.id,risky.id,inactive.id,reply.id]]);
    await pool.query("UPDATE editorial_comment SET state='hidden' WHERE id=$1",[hidden.id]);
    await pool.query("UPDATE member SET status='blocked' WHERE id=$1",[disabled.id]);
    await pool.query(`INSERT INTO editorial_comment_safety_scan(comment_id,body_sha256,provider,state,result)
      VALUES($1,$2,'wechat_v2','risky','{}')`,[risky.id,createHash('sha256').update('这是一条真实保存的合成评论').digest('hex')]);
    const migration=await readFile(new URL('../../db/migrations/202610300002_editorial_comment_direct_publication.sql',import.meta.url),'utf8');
    await pool.query(migration.split('-- migrate:down')[0]!);
    const rows=(await pool.query('SELECT id,state,version FROM editorial_comment WHERE id=ANY($1::uuid[])',[[safe.id,risky.id,hidden.id,inactive.id,reply.id]])).rows;
    expect(rows.find(row=>row.id===safe.id)).toMatchObject({state:'published',version:2});
    expect(rows.find(row=>row.id===reply.id)).toMatchObject({state:'published',version:2});
    expect(rows.find(row=>row.id===risky.id)).toMatchObject({state:'pending_review',version:1});
    expect(rows.find(row=>row.id===hidden.id)).toMatchObject({state:'hidden',version:1});
    expect(rows.find(row=>row.id===inactive.id)).toMatchObject({state:'pending_review',version:1});
    expect((await pool.query("SELECT count(*)::int n FROM audit_log WHERE object_id=ANY($1::uuid[]) AND reason_code='OWNER_DIRECT_PUBLICATION_20261030'",[[safe.id,reply.id]])).rows[0].n).toBe(2);
    expect((await comments.read(undefined,id)).commentCount).toBe(2);
  });
  it('exports only the subject comment/likes/reports and erases text on verified account closure',async()=>{
    const person=await actor('privacy-subject'),id=await article('privacy'),row=await submit(id,person,'需要随账号删除的评论');await approve(row.id);
    await comments.like(person.id,person.principal,id,row.id,true);
    const snapshot=await transaction(pool,c=>collectMemberPortableData(c,config,new DeliveryAddressService(pool,config),person.id));
    expect((snapshot.sections.editorial as any).comments).toMatchObject([{id:row.id,body:'需要随账号删除的评论'}]);
    for(const spec of portableQuerySpecs.filter(s=>s.section==='editorial'&&s.collection==='comments'))expect((await pool.query(spec.sql,[person.id])).rows[0].id).toBe(row.id);
    await transaction(pool,c=>applyAccountClosure(c,{version:1,memberId:person.id,identityDigest:AccountClosure.identityDigest('wechat_miniprogram',CANONICAL_WECHAT_MINIPROGRAM_APP_ID,person.openid),requestId:randomUUID(),createdAt:new Date().toISOString()}));
    expect((await pool.query('SELECT body,state FROM editorial_comment WHERE id=$1',[row.id])).rows[0]).toEqual({body:null,state:'deleted'});
    expect((await pool.query('SELECT 1 FROM editorial_comment_like WHERE member_id=$1',[person.id])).rowCount).toBe(0);expect((await comments.read(undefined,id)).commentCount).toBe(0);
  });
});
