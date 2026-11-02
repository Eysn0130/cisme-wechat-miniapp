import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,expect,it,vi} from 'vitest';
import type {FastifyInstance} from 'fastify';
import {loadConfig} from '@cisme/config';
import {resetDatabase,testPool,TEST_DATABASE_URL} from '@cisme/testkit';
import {createApp} from '../../services/api/src/server';
import {createApiGatewayStorage} from '../../services/api/src/storage';
import {FormalUgcService} from '../../services/api/src/formalUgc';
import {AuthorityService} from '../../services/api/src/authority';

const pool=testPool();
const base={APP_ENV:'test',DATABASE_URL:TEST_DATABASE_URL,APP_SESSION_SECRET:'ugc-lifecycle-session',
  ADMIN_API_TOKEN:'ugc-lifecycle-admin',UPLOAD_TOKEN_SECRET:'ugc-lifecycle-upload',OBJECT_STORAGE_DRIVER:'api_gateway'};
const config=loadConfig({...base,UGC_GO_LIVE_GATE:'true',UGC_LEGAL_APPROVAL_ID:'isolated-lifecycle-approval',
  UGC_PROVENANCE_READY:'true',UGC_CONTENT_SAFETY_READY:'true',UGC_MODERATION_READY:'true'});
const storage=createApiGatewayStorage(config);
type Actor={memberId:string;sessionToken:string};
type OwnPost={id:string;version:number;revision:number;publishedRevision:number|null;state:string;body:string};
let app:FastifyInstance,closed:FastifyInstance,owner:Actor,reviewer:Actor,publisher:Actor,other:Actor;
const auth=(actor:Actor)=>({authorization:`Bearer ${actor.sessionToken}`});
const identity=async(name:string):Promise<Actor>=>{
  const response=await app.inject({method:'POST',url:'/v1/identity/dev',payload:{externalUserId:name,displayName:name,
    consents:[{documentType:'privacy',version:'test'},{documentType:'terms',version:'test'}]}});
  expect(response.statusCode).toBe(200);return response.json();
};
const create=async(actor=owner):Promise<OwnPost>=>{
  const response=await app.inject({method:'POST',url:'/v1/me/ugc/posts',headers:{...auth(actor),'idempotency-key':randomUUID()},payload:{}});
  expect(response.statusCode).toBe(200);return response.json();
};
const save=async(post:OwnPost,changes:Record<string,unknown>={},actor=owner):Promise<OwnPost>=>{
  const response=await app.inject({method:'PUT',url:`/v1/me/ugc/posts/${post.id}/draft`,headers:auth(actor),
    payload:{title:'真实护理记录',body:'这是首次公开的使用感受',mediaIds:[],expectedVersion:post.version,...changes}});
  expect(response.statusCode,JSON.stringify(response.json())).toBe(200);return response.json();
};
const submit=async(post:OwnPost)=>app.inject({method:'POST',url:`/v1/me/ugc/posts/${post.id}/submit`,headers:auth(owner),
  payload:{expectedVersion:post.version}});
const review=async(post:OwnPost,decision='approve')=>app.inject({method:'POST',url:`/v1/management/ugc/posts/${post.id}/review`,
  headers:auth(reviewer),payload:{expectedVersion:post.version,decision,reason:'已核对正文与公开许可',ruleVersion:'UGC-LIFECYCLE-1'}});
const readOwn=async(id:string):Promise<OwnPost>=>(await app.inject({method:'GET',url:`/v1/me/ugc/posts/${id}`,headers:auth(owner)})).json();
const publish=async(post:OwnPost,actor=publisher)=>app.inject({method:'POST',url:`/v1/management/ugc/posts/${post.id}/publish`,
  headers:auth(actor),payload:{expectedVersion:post.version}});
async function publishedPost(){
  let post=await save(await create());
  expect((await submit(post)).statusCode).toBe(200);post=await readOwn(post.id);
  expect((await review(post)).statusCode).toBe(200);post=await readOwn(post.id);
  expect((await publish(post)).statusCode).toBe(200);return readOwn(post.id);
}
beforeAll(async()=>{
  await resetDatabase(pool);await storage.ensureReady();app=await createApp({config,pool,storage});
  closed=await createApp({config:loadConfig(base),pool,storage});
  owner=await identity('lifecycle-owner');reviewer=await identity('lifecycle-reviewer');
  publisher=await identity('lifecycle-publisher');other=await identity('lifecycle-other');
  for(const actor of [reviewer,publisher])await pool.query(`INSERT INTO authority_grant
    (member_id,capability,granted_by,grant_reason,environment,grant_source)
    VALUES($1,'community.moderate','fixture','isolated lifecycle test','test','integration_fixture')`,[actor.memberId]);
  await pool.query(`INSERT INTO ugc_go_live_approval(approval_reference,signed_by,evidence,signed_at,expires_at)
    VALUES('isolated-lifecycle-approval','synthetic fixture','{"scope":"isolated tests only"}',now(),now()+interval '1 hour')`);
  await pool.query("UPDATE emergency_switch SET enabled=true WHERE key='community'");
});
afterAll(async()=>{await closed?.close();await app?.close();await pool.end();});

it('rejects empty publication without creating an intent snapshot for new posts or edits',async()=>{
  for(const original of [await create(),await publishedPost()]){
    const post=await save(original,{body:'',mediaIds:[]});
    const count=(await pool.query('SELECT count(*)::int n FROM ugc_post_revision WHERE post_id=$1',[post.id])).rows[0].n;
    const response=await submit(post);expect(response.statusCode).toBe(422);expect(response.json().code).toBe('UGC_CONTENT_REQUIRED');
    const current=await readOwn(post.id);expect(current.state).toBe('draft');expect(current.version).toBe(post.version);
    expect((await pool.query('SELECT count(*)::int n FROM ugc_post_revision WHERE post_id=$1',[post.id])).rows[0].n).toBe(count);
  }
});

it('saves without retired flags and submits an immutable public-intent snapshot without fabricating rights',async()=>{
  const post=await save(await create());
  const source=(await pool.query('SELECT to_jsonb(r) AS row FROM ugc_post_revision r WHERE post_id=$1 AND revision=$2',[post.id,post.revision])).rows[0].row;
  expect(source).toMatchObject({ai_usage:'unknown',rights_confirmed:false,public_consent_confirmed:false,moderation_state:'unreviewed'});
  const result=await submit(post);expect(result.statusCode).toBe(200);
  const submitted=result.json();expect(submitted).toMatchObject({state:'pending_review',version:post.version+1,revision:post.revision+1,
    rightsConfirmed:false,publicConsentConfirmed:true});
  expect((await pool.query('SELECT to_jsonb(r) AS row FROM ugc_post_revision r WHERE post_id=$1 AND revision=$2',[post.id,post.revision])).rows[0].row).toEqual(source);
  expect((await pool.query('SELECT rights_confirmed,public_consent_confirmed,moderation_state FROM ugc_post_revision WHERE post_id=$1 AND revision=$2',
    [post.id,submitted.revision])).rows[0]).toEqual({rights_confirmed:false,public_consent_confirmed:true,moderation_state:'pending'});
  expect((await pool.query("SELECT after_state FROM audit_log WHERE action='ugc.post_submitted' AND object_id=$1",[post.id])).rows[0].after_state)
    .toEqual({revision:submitted.revision,sourceRevision:post.revision,newRevision:submitted.revision,publicConsentConfirmed:true,publicConsentSource:'publish_action'});
  await expect(pool.query('UPDATE ugc_post_revision SET public_consent_confirmed=true WHERE post_id=$1 AND revision=$2',[post.id,post.revision]))
    .rejects.toMatchObject({code:'55000'});
  expect((await review(submitted)).statusCode).toBe(200);
  const approved=await readOwn(post.id);expect((await publish(approved)).statusCode).toBe(200);
  expect((await readOwn(post.id)).state).toBe('published');
});

it('preserves old checkbox facts but never carries their confirmation into a new private revision',async()=>{
  const legacy=await save(await create(),{rightsConfirmed:true,publicConsentConfirmed:true});
  const before=(await pool.query('SELECT to_jsonb(r) AS row FROM ugc_post_revision r WHERE post_id=$1 AND revision=$2',[legacy.id,legacy.revision])).rows[0].row;
  const privateEdit=await save(legacy,{body:'新内容只保存私稿，不能借用旧确认'});
  expect(privateEdit).toMatchObject({rightsConfirmed:false,publicConsentConfirmed:false});
  expect((await pool.query('SELECT to_jsonb(r) AS row FROM ugc_post_revision r WHERE post_id=$1 AND revision=$2',[legacy.id,legacy.revision])).rows[0].row).toEqual(before);
  expect((await pool.query("SELECT count(*)::int n FROM audit_log WHERE object_id=$1 AND action='ugc.post_submitted'",[legacy.id])).rows[0].n).toBe(0);
  for(const flag of ['rightsConfirmed','publicConsentConfirmed']){
    const invalid=await app.inject({method:'PUT',url:`/v1/me/ugc/posts/${legacy.id}/draft`,headers:auth(owner),
      payload:{expectedVersion:privateEdit.version,body:'不得接受伪布尔',mediaIds:[],[flag]:'true'}});
    expect(invalid.statusCode).toBe(422);expect(invalid.json().code).toBe('UGC_METADATA_INVALID');
  }
});

it('creates no public intent on closed gates, stale versions or wrong ownership',async()=>{
  const post=await save(await create());
  const rowsBefore=(await pool.query('SELECT to_jsonb(r) AS row FROM ugc_post_revision r WHERE post_id=$1 ORDER BY revision',[post.id])).rows;
  for(const [instance,actor,expectedVersion,status] of [[closed,owner,post.version,503],[app,owner,post.version-1,409],[app,other,post.version,404]] as const){
    const failed=await instance.inject({method:'POST',url:`/v1/me/ugc/posts/${post.id}/submit`,headers:auth(actor),payload:{expectedVersion}});
    expect(failed.statusCode).toBe(status);
  }
  expect((await pool.query('SELECT to_jsonb(r) AS row FROM ugc_post_revision r WHERE post_id=$1 ORDER BY revision',[post.id])).rows).toEqual(rowsBefore);
  expect((await pool.query("SELECT count(*)::int n FROM audit_log WHERE object_id=$1 AND action='ugc.post_submitted'",[post.id])).rows[0].n).toBe(0);
  expect((await readOwn(post.id))).toMatchObject({version:post.version,revision:post.revision,publicConsentConfirmed:false,rightsConfirmed:false});
});

it('accepts optional legacy AI metadata while retaining existing revision values and old audit facts',async()=>{
  const legacy=await save(await create(),{aiUsage:'generated'});
  const legacyFact={revision:legacy.revision,aiUsage:'generated',aiDeclarationChosen:true};
  const audit=(await pool.query(`INSERT INTO audit_log(principal_id,action,object_type,object_id,reason_code,after_state,trace_id)
    VALUES($1,'ugc.post_submitted','ugc_post',$2,'SYNTHETIC_LEGACY_FIXTURE',$3,gen_random_uuid()::text) RETURNING id`,
    [`member:${owner.memberId}`,legacy.id,legacyFact])).rows[0].id;
  const revised=await save(legacy,{body:'新客户端不再采集AI声明，保留既有元数据'});
  expect((await pool.query('SELECT ai_usage FROM ugc_post_revision WHERE post_id=$1 AND revision=ANY($2::integer[]) ORDER BY revision',
    [legacy.id,[legacy.revision,revised.revision]])).rows.map(row=>row.ai_usage)).toEqual(['generated','generated']);
  const submitted=await app.inject({method:'POST',url:`/v1/me/ugc/posts/${revised.id}/submit`,headers:auth(owner),
    payload:{expectedVersion:revised.version,aiDeclarationChosen:false}});
  expect(submitted.statusCode).toBe(200);
  expect((await pool.query('SELECT after_state FROM audit_log WHERE id=$1',[audit])).rows[0].after_state).toEqual(legacyFact);
  const current=(await pool.query("SELECT after_state FROM audit_log WHERE action='ugc.post_submitted' AND object_id=$1 AND id<>$2",[legacy.id,audit])).rows[0].after_state;
  expect(current).toEqual({revision:revised.revision+1,sourceRevision:revised.revision,newRevision:revised.revision+1,publicConsentConfirmed:true,publicConsentSource:'publish_action'});
  const previousClient=await save(await create(),{aiUsage:'none'});
  expect((await app.inject({method:'POST',url:`/v1/me/ugc/posts/${previousClient.id}/submit`,headers:auth(owner),
    payload:{expectedVersion:previousClient.version,aiDeclarationChosen:true}})).statusCode).toBe(200);
});

it('keeps submitted and approved revisions immutable while the prior public revision remains readable',async()=>{
  const original=await publishedPost();
  let post=await save(original,{body:'新版尚未公开的感受'});expect((await submit(post)).statusCode).toBe(200);post=await readOwn(post.id);
  for(const expectedState of ['pending_review','awaiting_publication']){
    expect(post.state).toBe(expectedState);
    const overwrite=await app.inject({method:'PUT',url:`/v1/me/ugc/posts/${post.id}/draft`,headers:auth(owner),
      payload:{expectedVersion:post.version,title:'覆盖待审版本',body:'不应保存',mediaIds:[],rightsConfirmed:true,publicConsentConfirmed:true}});
    expect(overwrite.statusCode).toBe(409);expect(overwrite.json().code).toBe('UGC_POST_LOCKED');
    expect((await readOwn(post.id)).version).toBe(post.version);
    const listed=(await app.inject({method:'GET',url:'/v1/me/ugc/posts',headers:auth(owner)})).json().items.find((item:{id:string})=>item.id===post.id);
    expect(listed).toMatchObject({state:expectedState,revision:post.revision,publishedRevision:original.revision,publicVersionActive:true,
      revisionState:expectedState==='pending_review'?'pending':'approved'});
    expect((await app.inject({method:'GET',url:`/v1/ugc/posts/${post.id}`})).json().body).toBe(original.body);
    if(expectedState==='pending_review'){expect((await review(post)).statusCode).toBe(200);post=await readOwn(post.id);}
  }
  expect((await publish(post,reviewer)).statusCode).toBe(403);
  expect((await publish({...post,version:post.version-1})).statusCode).toBe(409);
  expect((await publish(post)).statusCode).toBe(200);
  expect((await readOwn(post.id)).state).toBe('published');
  expect((await app.inject({method:'GET',url:`/v1/ugc/posts/${post.id}`})).json().body).toBe('新版尚未公开的感受');
});

it('reopens rejected edits for the owner without replacing the prior public revision',async()=>{
  const original=await publishedPost();let post=await save(original,{body:'这次编辑等待审核'});
  expect((await submit(post)).statusCode).toBe(200);post=await readOwn(post.id);
  expect((await review(post,'reject')).statusCode).toBe(200);post=await readOwn(post.id);expect(post.state).toBe('rejected');
  post=await save(post,{body:'按意见修改后的新版'});expect(post.state).toBe('draft');
  expect((await app.inject({method:'GET',url:`/v1/ugc/posts/${post.id}`})).json().body).toBe(original.body);
  const crossOwner=await app.inject({method:'PUT',url:`/v1/me/ugc/posts/${post.id}/draft`,headers:auth(other),
    payload:{expectedVersion:post.version,title:'越权',body:'不应保存',mediaIds:[],rightsConfirmed:true,publicConsentConfirmed:true}});
  expect(crossOwner.statusCode).toBe(404);
});

it('replays concurrent creation requests as one draft and preserves private creation when public UGC is closed',async()=>{
  const headers={...auth(owner),'idempotency-key':randomUUID()};
  const responses=await Promise.all(Array.from({length:6},()=>closed.inject({method:'POST',url:'/v1/me/ugc/posts',headers,payload:{}})));
  expect(responses.map(response=>response.statusCode)).toEqual(Array(6).fill(200));
  expect(new Set(responses.map(response=>response.json().id)).size).toBe(1);
  const post=await save(responses[0]!.json());
  const response=await closed.inject({method:'POST',url:`/v1/me/ugc/posts/${post.id}/submit`,headers:auth(owner),
    payload:{expectedVersion:post.version}});
  expect(response.statusCode).toBe(503);expect(response.json().code).toBe('UGC_GO_LIVE_GATE_CLOSED');
  expect((await readOwn(post.id)).state).toBe('draft');
});

it('rejects an inactive owner inside the write transaction, independently of the HTTP precheck',async()=>{
  const actor=await identity('lifecycle-inactive');const post=await create(actor);
  await pool.query("UPDATE member SET status='blocked' WHERE id=$1",[actor.memberId]);
  const service=new FormalUgcService(pool,config,storage,new AuthorityService(pool,'test'));
  await expect(service.saveDraft(actor.memberId,post.id,{expectedVersion:post.version,title:'不应修改',body:'不应修改',
    mediaIds:[],rightsConfirmed:true,publicConsentConfirmed:true})).rejects.toMatchObject({code:'MEMBER_NOT_ACTIVE'});
  await expect(service.submit(actor.memberId,post.id,post.version)).rejects.toMatchObject({code:'MEMBER_NOT_ACTIVE'});
  expect((await pool.query('SELECT version FROM ugc_post WHERE id=$1',[post.id])).rows[0].version).toBe(post.version);
});

it('filters all owned records before pagination and binds cursors and counts to the selected state',async()=>{
  let post=await save(await create());expect((await submit(post)).statusCode).toBe(200);post=await readOwn(post.id);
  expect((await review(post,'reject')).statusCode).toBe(200);
  const client=await pool.connect();
  try{
    await client.query('BEGIN');
    await client.query(`WITH posts AS (INSERT INTO ugc_post(author_member_id,client_request_key)
      SELECT $1,'filter-padding-'||gen_random_uuid()::text FROM generate_series(1,32) RETURNING id,author_member_id)
      INSERT INTO ugc_post_revision(post_id,revision,created_by_member_id) SELECT id,1,author_member_id FROM posts`,[owner.memberId]);
    await client.query('COMMIT');
  }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
  const filtered=await app.inject({method:'GET',url:'/v1/me/ugc/posts?state=rejected&limit=1',headers:auth(owner)});
  expect(filtered.statusCode).toBe(200);expect(filtered.json().items).toEqual([expect.objectContaining({id:post.id,state:'rejected'})]);
  expect(filtered.json().matchingTotal).toBe(1);expect(filtered.json().nextCursor).toBeNull();
  const first=(await app.inject({method:'GET',url:'/v1/me/ugc/posts?state=draft&limit=10',headers:auth(owner)})).json();
  expect(first.items).toHaveLength(10);expect(first.matchingTotal).toBeGreaterThanOrEqual(32);expect(first.nextCursor).toBeTruthy();
  const next=(await app.inject({method:'GET',url:`/v1/me/ugc/posts?state=draft&limit=10&cursor=${encodeURIComponent(first.nextCursor)}`,headers:auth(owner)})).json();
  expect(next.matchingTotal).toBe(first.matchingTotal);expect(next.items).toHaveLength(10);
  expect(new Set([...first.items,...next.items].map((item:{id:string})=>item.id)).size).toBe(20);
  expect((await app.inject({method:'GET',url:`/v1/me/ugc/posts?state=published&cursor=${encodeURIComponent(first.nextCursor)}`,headers:auth(owner)})).statusCode).toBe(422);
  expect((await app.inject({method:'GET',url:'/v1/me/ugc/posts?state=private',headers:auth(owner)})).statusCode).toBe(422);
});

it('rejects approval and publication if the author became inactive after submission',async()=>{
  const actor=await identity('lifecycle-inactive-after-submit');
  const post=await save(await create(actor),{},actor);
  const submitted=await app.inject({method:'POST',url:`/v1/me/ugc/posts/${post.id}/submit`,headers:auth(actor),
    payload:{expectedVersion:post.version}});expect(submitted.statusCode).toBe(200);
  const submittedPost=submitted.json();await pool.query("UPDATE member SET status='blocked' WHERE id=$1",[actor.memberId]);
  const blockedApproval=await review(submittedPost);expect(blockedApproval.statusCode).toBe(409);expect(blockedApproval.json().code).toBe('UGC_AUTHOR_INACTIVE');
  await pool.query("UPDATE member SET status='active' WHERE id=$1",[actor.memberId]);
  const approved=await review(submittedPost);expect(approved.statusCode).toBe(200);
  await pool.query("UPDATE member SET status='blocked' WHERE id=$1",[actor.memberId]);
  const blockedPublication=await publish({...submittedPost,version:approved.json().version});
  expect(blockedPublication.statusCode).toBe(409);expect(blockedPublication.json().code).toBe('UGC_AUTHOR_INACTIVE');
  expect((await pool.query('SELECT state,published_revision FROM ugc_post WHERE id=$1',[post.id])).rows[0])
    .toMatchObject({state:'pending_review',published_revision:null});
});

it('rechecks the gate after waiting for the post lock, including expiry after the transaction began',async()=>{
  for(const condition of ['switch_closed','approval_expired','approval_revoked']){
    let post=await save(await create());expect((await submit(post)).statusCode).toBe(200);post=await readOwn(post.id);
    expect((await review(post)).statusCode).toBe(200);post=await readOwn(post.id);
    const locker=await pool.connect();let pending:ReturnType<typeof publish>|undefined;
    try{
      await locker.query('BEGIN');const pid=(await locker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      await locker.query('SELECT id FROM ugc_post WHERE id=$1 FOR UPDATE',[post.id]);
      pending=publish(post);
      await vi.waitFor(async()=>{
        const waiting=(await pool.query(`SELECT count(*)::int AS n FROM pg_stat_activity
          WHERE datname=current_database() AND $1::integer=ANY(pg_blocking_pids(pid))
            AND query LIKE 'SELECT * FROM ugc_post WHERE id=%'`,[pid])).rows[0].n;
        expect(waiting).toBeGreaterThan(0);
      },{timeout:600,interval:10});
      if(condition==='switch_closed')await pool.query("UPDATE emergency_switch SET enabled=false WHERE key='community'");
      else if(condition==='approval_revoked')await pool.query('UPDATE ugc_go_live_approval SET revoked_at=clock_timestamp()');
      else{
        await pool.query("UPDATE ugc_go_live_approval SET expires_at=clock_timestamp()+interval '120 milliseconds'");
        await pool.query('SELECT pg_sleep(0.15)');
      }
      await locker.query('COMMIT');
      const response=await pending;expect(response.statusCode,JSON.stringify(response.json())).toBe(503);
      expect(response.json().code).toBe('UGC_GO_LIVE_GATE_CLOSED');
      expect((await pool.query('SELECT state,published_revision,version FROM ugc_post WHERE id=$1',[post.id])).rows[0])
        .toMatchObject({state:'pending_review',published_revision:null,version:post.version});
    }finally{
      await locker.query('ROLLBACK');locker.release();await pending;
      await pool.query("UPDATE ugc_go_live_approval SET revoked_at=NULL,expires_at=clock_timestamp()+interval '1 hour'");
      await pool.query("UPDATE emergency_switch SET enabled=true WHERE key='community'");
    }
  }
});

it('checks the public gate at the end of comment approval after a post-lock wait',async()=>{
  const post=await publishedPost();
  const comment=(await app.inject({method:'POST',url:`/v1/ugc/posts/${post.id}/comments`,
    headers:{...auth(other),'idempotency-key':randomUUID()},payload:{body:'这是一条待审核的真实评论'}})).json();
  const approve=()=>app.inject({method:'POST',url:`/v1/management/ugc/comments/${comment.id}/review`,headers:auth(reviewer),
    payload:{decision:'approve',reason:'已核对内容安全与评论关系'}});
  const locker=await pool.connect();let pending:ReturnType<typeof approve>|undefined;
  try{
    await locker.query('BEGIN');const pid=(await locker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    await locker.query('SELECT id FROM ugc_post WHERE id=$1 FOR UPDATE',[post.id]);pending=approve();
    await vi.waitFor(async()=>expect((await pool.query(`SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE datname=current_database() AND $1::integer=ANY(pg_blocking_pids(pid))`,[pid])).rows[0].n).toBeGreaterThan(0),
    {timeout:600,interval:10});
    await pool.query("UPDATE emergency_switch SET enabled=false WHERE key='community'");await locker.query('COMMIT');
    const response=await pending;expect(response.statusCode).toBe(503);expect(response.json().code).toBe('UGC_GO_LIVE_GATE_CLOSED');
    expect((await pool.query('SELECT state,version,was_public FROM ugc_comment WHERE id=$1',[comment.id])).rows[0])
      .toMatchObject({state:'pending_review',version:1,was_public:false});
  }finally{
    await locker.query('ROLLBACK');locker.release();await pending;
    await pool.query("UPDATE emergency_switch SET enabled=true WHERE key='community'");
  }
  const approved=await approve();expect(approved.statusCode).toBe(200);expect(approved.json().state).toBe('published');
});

it('keeps comment approval private when its author, post, or reply context is no longer visible',async()=>{
  const post=await publishedPost();
  const createComment=async(actor:Actor,payload:Record<string,unknown>)=>{
    const response=await app.inject({method:'POST',url:`/v1/ugc/posts/${post.id}/comments`,
      headers:{...auth(actor),'idempotency-key':randomUUID()},payload});expect(response.statusCode).toBe(200);return response.json();
  };
  const approve=(id:string)=>app.inject({method:'POST',url:`/v1/management/ugc/comments/${id}/review`,headers:auth(reviewer),
    payload:{decision:'approve',reason:'已核对内容安全与评论关系'}});
  const root=await createComment(other,{body:'作为回复上下文的根评论'});expect((await approve(root.id)).statusCode).toBe(200);
  const reply=await createComment(publisher,{body:'只可在根评论可见时公开的回复',parentId:root.id,replyToId:root.id});
  const ordinary=await createComment(other,{body:'账号失效后不能公开的评论'});
  try{
    await pool.query("UPDATE member SET status='blocked' WHERE id=$1",[other.memberId]);
    const inactive=await approve(ordinary.id);expect(inactive.statusCode).toBe(409);expect(inactive.json().code).toBe('UGC_AUTHOR_INACTIVE');
    const unavailableParent=await approve(reply.id);expect(unavailableParent.statusCode).toBe(409);
    expect(unavailableParent.json().code).toBe('UGC_COMMENT_PARENT_INVALID');
    await pool.query("UPDATE member SET status='active' WHERE id=$1",[other.memberId]);
    expect((await app.inject({method:'DELETE',url:`/v1/ugc/posts/${post.id}/comments/${root.id}`,headers:auth(other)})).statusCode).toBe(200);
    expect((await approve(reply.id)).json().code).toBe('UGC_COMMENT_PARENT_INVALID');
    await pool.query("UPDATE member SET status='blocked' WHERE id=$1",[owner.memberId]);
    expect((await approve(ordinary.id)).json().code).toBe('UGC_POST_NOT_FOUND');
    await pool.query("UPDATE member SET status='active' WHERE id=$1",[owner.memberId]);
    await pool.query("UPDATE ugc_post SET state='hidden',visibility='private',version=version+1 WHERE id=$1",[post.id]);
    expect((await approve(ordinary.id)).json().code).toBe('UGC_POST_NOT_FOUND');
    expect((await pool.query('SELECT state,version,was_public FROM ugc_comment WHERE id=$1',[ordinary.id])).rows[0])
      .toMatchObject({state:'pending_review',version:1,was_public:false});
  }finally{await pool.query("UPDATE member SET status='active' WHERE id=ANY($1::uuid[])",[[owner.memberId,other.memberId]]);}
});
