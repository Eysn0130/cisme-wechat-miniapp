import assert from 'node:assert/strict';
import { randomUUID,createHash } from 'node:crypto';
import type pg from 'pg';
import sharp from 'sharp';
import { CANONICAL_WECHAT_MINIPROGRAM_APP_ID, loadConfig } from '@cisme/config';
import { TEST_DATABASE_URL } from '@cisme/testkit';
import { createApp } from '../../services/api/src/server';
import { createApiGatewayStorage } from '../../services/api/src/storage';
import { EditorialService } from '../../services/api/src/editorial';
import { AuthorityService } from '../../services/api/src/authority';
import { issueSessionToken } from '../../services/api/src/auth';
import { CommunityAccess } from '../../services/api/src/communityAccess';

type Actor={id:string;principal:string;token:string};
export async function communityFollowingScenario(pool:pg.Pool){
 const checked:string[]=[];
 const base={APP_ENV:'test',DATABASE_URL:TEST_DATABASE_URL,APP_SESSION_SECRET:'following-synthetic-session',ADMIN_API_TOKEN:'following-synthetic-admin',
  UPLOAD_TOKEN_SECRET:'following-synthetic-upload',WECHAT_APP_ID:CANONICAL_WECHAT_MINIPROGRAM_APP_ID,WECHAT_APP_SECRET:'synthetic-secret',WECHAT_MESSAGE_TOKEN:'synthetic-callback',WECHAT_MESSAGE_PLAINTEXT_TEST_ONLY:'true',UGC_SCAN_BASE_URL:'https://synthetic-scan.invalid',ALLOW_DEV_ADAPTERS:'false',
  PII_ENCRYPTION_KEY:'1'.repeat(64),CONTACT_HASH_KEY:'2'.repeat(64),OBJECT_STORAGE_DRIVER:'api_gateway'};
 const config=loadConfig(base),openConfig=loadConfig({...base,UGC_GO_LIVE_GATE:'true',UGC_LEGAL_APPROVAL_ID:'synthetic-following-approval',
  UGC_PROVENANCE_READY:'true',UGC_CONTENT_SAFETY_READY:'true',UGC_MODERATION_READY:'true'});
 const storage=createApiGatewayStorage(config);await storage.ensureReady();
 const editorial=new EditorialService(pool,config,storage,new AuthorityService(pool,'test'));
 async function actor(name:string):Promise<Actor>{
  const id=(await pool.query('INSERT INTO member(display_name) VALUES($1) RETURNING id',[`合成${name}`])).rows[0].id;
  const identity=(await pool.query(`INSERT INTO wechat_identity(member_id,openid,adapter,provider,app_id)
   VALUES($1,$2,'wechat','wechat_miniprogram',$3) RETURNING id`,[id,`synthetic-following-${randomUUID()}`,CANONICAL_WECHAT_MINIPROGRAM_APP_ID])).rows[0].id;
  const principal=`wechat_miniprogram:${identity}`;
  return{id,principal,token:issueSessionToken({principalId:principal,memberId:id,adapter:'wechat',provider:'wechat_miniprogram',appId:CANONICAL_WECHAT_MINIPROGRAM_APP_ID},config.sessionSecret)};
 }
 const [author,reader,outsider,reviewer,publisher]=await Promise.all(['作者','读者','未关注用户','审核','发布'].map(actor)) as [Actor,Actor,Actor,Actor,Actor];
 for(const type of ['terms','privacy'])await pool.query(`INSERT INTO legal_document(document_type,version,title,body,operator_name,contact,active)
  VALUES($1,'following-v1','synthetic','synthetic','synthetic','synthetic',true)`,[type]);
 for(const who of [author,reader,outsider,reviewer,publisher])await editorial.acceptCurrentLegal(who.id,who.principal,
  {consents:[{documentType:'terms',version:'following-v1'},{documentType:'privacy',version:'following-v1'}]});
 for(const who of [reviewer,publisher])await pool.query(`INSERT INTO authority_grant(member_id,capability,granted_by,grant_reason,environment,grant_source)
  VALUES($1,'community.moderate','fixture','following integration only','test','integration_fixture')`,[who.id]);
 await pool.query(`INSERT INTO authority_grant(member_id,capability,granted_by,grant_reason,environment,grant_source)
  VALUES($1,'editorial.manage','fixture','following integration only','test','integration_fixture')`,[author.id]);
 await pool.query(`INSERT INTO ugc_go_live_approval(approval_reference,signed_by,evidence,signed_at,expires_at)
  VALUES('synthetic-following-approval','synthetic fixture','{"scope":"disposable only"}',now(),now()+interval '1 hour')`);
 await pool.query("UPDATE emergency_switch SET enabled=true WHERE key='community'");
 const realFetch=globalThis.fetch;let textVerdict='pass';
 globalThis.fetch=(async(input:any)=>{const url=String(input);assert(url.startsWith('https://api.weixin.qq.com/'),'Unexpected external request');
  if(url.includes('/cgi-bin/token?'))return new Response(JSON.stringify({access_token:'synthetic-only-token',expires_in:7200}));
  if(url.includes('/msg_sec_check?')){if(textVerdict==='error')throw new Error('synthetic safety outage');return new Response(JSON.stringify({errcode:0,result:{suggest:textVerdict}}));}
  assert(url.includes('/media_check_async?'));return new Response(JSON.stringify({errcode:0,trace_id:'synthetic-'+randomUUID()}));}) as typeof fetch;
 const app=await createApp({config:openConfig,pool,storage}),closed=await createApp({config,pool,storage});
 const headers=(who:Actor)=>({authorization:`Bearer ${who.token}`});
 async function call(method:'GET'|'POST'|'PUT'|'DELETE',url:string,who?:Actor,payload?:any,expected=200){
  const result=await app.inject({method,url,...(who?{headers:headers(who)}:{}),...(payload===undefined?{}:{payload})});
  assert.equal(result.statusCode,expected,`${method} ${url}: ${result.body}`);return result;
 }
 const timeline=async(who=reader,query='')=>(await call('GET','/v1/me/community/following'+query,who)).json();
 const follow=async(active:boolean,who=reader)=>call('PUT',`/v1/me/ugc/follows/${author.id}`,who,{active});
 const bytes=await sharp({create:{width:2,height:2,channels:3,background:'#ffffff'}}).png().toBuffer();
 let serial=0;
 async function publishPost(who:Actor,label:string){
  const create=await app.inject({method:'POST',url:'/v1/me/ugc/posts',headers:{...headers(who),'idempotency-key':`following-create-${++serial}`},payload:{}});
  assert.equal(create.statusCode,200,create.body);const id=create.json().id;
  const grant=(await call('POST',`/v1/me/ugc/posts/${id}/media/authorize`,who,{mimeType:'image/png',maxBytes:100})).json();
  await call('POST',`/v1/uploads/${grant.mediaId}/chunks`,undefined,{token:grant.fields.token,index:0,totalBytes:bytes.length,base64:bytes.toString('base64')});
  await call('POST',`/v1/uploads/${grant.mediaId}/assemble`,undefined,{token:grant.fields.token});
  await call('POST',`/v1/me/ugc/posts/${id}/media/${grant.mediaId}/complete`,who,{});
  await call('PUT',`/v1/me/ugc/posts/${id}/draft`,who,{title:label,body:'合成公开护理记录',mediaIds:[grant.mediaId],expectedVersion:1});
  const pending=(await call('POST',`/v1/me/ugc/posts/${id}/submit`,who,{expectedVersion:2})).json();assert.equal(pending.state,'pending_review');
  if(serial===1){
   const revised=(await call('PUT',`/v1/me/ugc/posts/${id}/draft`,who,{title:label,body:'合成公开护理记录',mediaIds:[grant.mediaId],expectedVersion:pending.version})).json();
   await finishImage(grant.mediaId);assert.equal((await call('GET',`/v1/me/ugc/posts/${id}`,who)).json().state,'draft');
   await call('POST',`/v1/me/ugc/posts/${id}/submit`,who,{expectedVersion:revised.version});
   checked.push('editing cancels an in-flight publication; a late image callback cannot publish it, and explicit republish can reuse a matching safe image');
  }else await finishImage(grant.mediaId);
  const version=(await call('GET',`/v1/me/ugc/posts/${id}`,who)).json().version;
  await finishImage(grant.mediaId);assert.equal((await call('GET',`/v1/me/ugc/posts/${id}`,who)).json().version,version);
  assert.equal((await call('GET',`/v1/ugc/posts/${id}`,who)).json().id,id);
  assert.equal((await pool.query('SELECT count(*)::int n FROM ugc_post_review_action WHERE post_id=$1',[id])).rows[0].n,0);

  return id;
 }
 async function finishImage(mediaId:string){
  const trace=(await pool.query("SELECT trace_id FROM ugc_safety_scan WHERE media_asset_id=$1 AND kind='image' ORDER BY requested_at DESC,id DESC LIMIT 1",[mediaId])).rows[0].trace_id;
  const timestamp=String(Math.floor(Date.now()/1000)),nonce='synthetic-'+randomUUID();
  const signature=createHash('sha1').update(['synthetic-callback',timestamp,nonce].sort().join('')).digest('hex');
  await call('POST',`/v1/ugc/safety-callback?timestamp=${timestamp}&nonce=${nonce}&signature=${signature}`,undefined,
   {Event:'wxa_media_check',appid:CANONICAL_WECHAT_MINIPROGRAM_APP_ID,version:2,trace_id:trace,errcode:0,result:{suggest:'pass'}});
 }
 async function textDraft(body:string){const created=await app.inject({method:'POST',url:'/v1/me/ugc/posts',headers:{...headers(outsider),'idempotency-key':'direct-'+randomUUID()},payload:{}});
  assert.equal(created.statusCode,200,created.body);const id=created.json().id;await call('PUT',`/v1/me/ugc/posts/${id}/draft`,outsider,{title:'合成直接发布',body,mediaIds:[],expectedVersion:1});return id;}
 try{
  await call('GET','/v1/me/community/following',undefined,undefined,401);
  await pool.query("INSERT INTO community_follow(member_id,author_id) VALUES($1,'brand:cisme')",[reader.id]);
  assert.deepEqual((await timeline()).items,[]);checked.push('authenticated empty timeline without featured fallback');
  const legacyId=randomUUID();
  for(const [method,url,payload]of [['POST',`/v1/tasks/${legacyId}/claim`,{}],['POST',`/v1/submissions/${legacyId}/submit`,{}],['PUT',`/v1/submissions/${legacyId}/draft`,{}],['POST',`/v1/submissions/${legacyId}/media/authorize`,{}]] as const){
   const response=await app.inject({method,url,headers:{...headers(reader),'idempotency-key':'retired-'+randomUUID()},payload});assert.equal(response.statusCode,410,response.body);assert.equal(response.json().code,'TASK_PROOF_REMOVED');}
  assert.deepEqual((await call('GET','/v1/me/tasks',reader)).json(),[]);
  assert.equal((await pool.query('SELECT count(*)::int n FROM submission')).rows[0].n,0);checked.push('removed task/proof entry APIs reject writes without creating submissions');
  const qualification=(await pool.query("INSERT INTO qualification_fact(member_id,source,external_ref,occurred_at) VALUES($1,'approved_tester_fulfillment',$2,now()) RETURNING id",[reader.id,randomUUID()])).rows[0].id;
  const cycle=(await pool.query("INSERT INTO care_cycle(member_id,qualification_fact_id,phase,started_on,timezone,protocol_version) VALUES($1,$2,'active',(now() AT TIME ZONE 'UTC')::date-6,'UTC','care-r0-v1') RETURNING id",[reader.id,qualification])).rows[0].id;
  for(const [index,milestone]of ['D1','D7'].entries()){
   const response=await app.inject({method:'POST',url:`/v1/care-cycles/${cycle}/milestones/${milestone}/complete`,headers:{...headers(reader),'idempotency-key':'direct-care-'+milestone},payload:{expectedVersion:index+1,stepCodes:['00','01','02','03'],selfAssessment:'comfortable'}});
   assert.equal(response.statusCode,200,response.body);assert.equal(response.json().task,null);
  }
  assert.equal((await pool.query('SELECT count(*)::int n FROM care_record_step s JOIN care_record r ON r.id=s.record_id WHERE r.cycle_id=$1',[cycle])).rows[0].n,8);
  assert.equal((await pool.query('SELECT count(*)::int n FROM eligibility_task')).rows[0].n,0);checked.push('D1 and D7 care steps and self-assessment persist without creating proof tasks or rewards');
  const support=(await call('POST','/v1/me/support/media/authorize',reader,{mimeType:'image/png',maxBytes:100})).json();
  await call('POST',`/v1/uploads/${support.mediaId}/chunks`,undefined,{token:support.fields.token,index:0,totalBytes:bytes.length,base64:bytes.toString('base64')});
  await call('POST',`/v1/uploads/${support.mediaId}/assemble`,undefined,{token:support.fields.token});
  await call('POST',`/v1/me/support/media/${support.mediaId}/complete`,reader,{});
  await call('POST','/v1/me/support/messages',reader,{body:'合成客服图片验证',mediaIds:[support.mediaId],clientMessageId:'synthetic-direct-support'});
  const supportImage=await call('GET',`/v1/me/support/media/${support.mediaId}`,reader);assert.deepEqual(supportImage.rawPayload,bytes);
  await call('GET',`/v1/me/support/media/${support.mediaId}`,outsider,undefined,404);checked.push('shared support image authorization, chunks, assembly, completion and private read still work');
  const direct=await textDraft('安全文字直接公开');
  const directResult=(await call('POST',`/v1/me/ugc/posts/${direct}/submit`,outsider,{expectedVersion:2})).json();assert.equal(directResult.state,'published');
  assert.equal((await call('GET',`/v1/ugc/posts/${direct}`,reader)).json().body,'安全文字直接公开');
  await call('POST',`/v1/me/ugc/posts/${direct}/submit`,outsider,{expectedVersion:2},409);
  await call('POST',`/v1/management/ugc/posts/${direct}/review`,reviewer,{decision:'approve',expectedVersion:directResult.version,reason:'不应再人工审核',ruleVersion:'test'},410);
  await call('POST',`/v1/management/ugc/posts/${direct}/publish`,publisher,{expectedVersion:directResult.version},410);
  assert.equal((await pool.query('SELECT count(*)::int n FROM ugc_post_review_action WHERE post_id=$1',[direct])).rows[0].n,0);
  checked.push('safe text publishes in the author action, duplicate submit cannot duplicate publication, human review/publish APIs removed');
  for(const result of ['risky','review','error']){textVerdict=result;const id=await textDraft('不能公开的安全检测合成输入 '+result);
   const failed=(await call('POST',`/v1/me/ugc/posts/${id}/submit`,outsider,{expectedVersion:2})).json();assert.equal(failed.state,'rejected');
   await call('GET',`/v1/ugc/posts/${id}`,reader,undefined,404);assert.equal(failed.publicVersionActive,false);}
  textVerdict='pass';checked.push('unsafe, uncertain and unavailable checks remain private and editable; no false publication');
  const closedId=await textDraft('发布开关关闭检查');const before=(await call('GET',`/v1/me/ugc/posts/${closedId}`,outsider)).json();
  const blocked=await closed.inject({method:'POST',url:`/v1/me/ugc/posts/${closedId}/submit`,headers:headers(outsider),payload:{expectedVersion:before.version}});assert.equal(blocked.statusCode,503);
  assert.equal((await call('GET',`/v1/me/ugc/posts/${closedId}`,outsider)).json().version,before.version);checked.push('direct publication still respects the closed public gate without mutating the draft');
  const legacyPending=await textDraft('升级前的私人待审内容');
  await pool.query(`INSERT INTO ugc_post_revision(post_id,revision,created_by_member_id,title,body,ai_usage,rights_confirmed,public_consent_confirmed,moderation_state)
   SELECT post_id,revision+1,created_by_member_id,title,body,ai_usage,rights_confirmed,true,'pending' FROM ugc_post_revision WHERE post_id=$1 AND revision=2`,[legacyPending]);
  await pool.query("UPDATE ugc_post SET state='pending_review',current_revision=3,version=3 WHERE id=$1",[legacyPending]);
  assert.equal((await call('GET',`/v1/me/ugc/posts/${legacyPending}`,outsider)).json().state,'awaiting_publication');
  const legacyList=(await call('GET','/v1/me/ugc/posts?state=awaiting_publication',outsider)).json();assert(legacyList.items.some((row:any)=>row.id===legacyPending));
  await call('GET',`/v1/ugc/posts/${legacyPending}`,reader,undefined,404);
  const renewed=(await call('PUT',`/v1/me/ugc/posts/${legacyPending}/draft`,outsider,{title:'重新确认的公开内容',body:'作者重新点击发布',mediaIds:[],expectedVersion:3})).json();
  assert.equal((await call('POST',`/v1/me/ugc/posts/${legacyPending}/submit`,outsider,{expectedVersion:renewed.version})).json().state,'published');
  checked.push('historical pending content stays private and is labeled for explicit republish, not silently auto-published or stuck checking');
  const first=await publishPost(author,'关注前的公开帖');await publishPost(outsider,'未关注作者的新帖');
  await follow(true);await follow(true);assert.equal((await pool.query('SELECT count(*)::int n FROM ugc_author_follow WHERE follower_member_id=$1 AND followed_member_id=$2',[reader.id,author.id])).rows[0].n,1);
  const legacyAccess=new CommunityAccess(pool,loadConfig({...base,ALLOW_DEV_ADAPTERS:'true'}),new AuthorityService(pool,'test'));
  assert((await legacyAccess.follows(reader.id)).includes(author.id));
  const fresh=await publishPost(author,'关注后新发布的帖子');
  const draft=await app.inject({method:'POST',url:'/v1/me/ugc/posts',headers:{...headers(author),'idempotency-key':'following-private-draft'},payload:{}});assert.equal(draft.statusCode,200);
  const curated=await editorial.publish(author.id,author.principal,{externalRef:'following-curated',authorMemberId:author.id,author:'CISME头皮实验室',title:'关注作者的精选',excerpt:'合成摘要',body:'合成正文',
   sourceUrl:null,authorizationRef:'synthetic:following',rightsEvidence:{scope:'disposable integration'},media:[],expectedVersion:0});
  const full=await timeline();assert.equal(full.items.length,3);assert.deepEqual(new Set(full.items.map((x:any)=>x.id)),new Set([first,fresh,curated.id]));
  assert(full.items.findIndex((x:any)=>x.id===fresh)<full.items.findIndex((x:any)=>x.id===first));assert(full.items.every((x:any)=>x.authorId===author.id));
  assert(!JSON.stringify(full).match(/openid|phone|object_key|rights_evidence|sessionToken|authorizationRef/));
  assert.deepEqual((await timeline(outsider)).items,[]);checked.push('follow → publish new user post → fresh timeline; drafts and un-followed authors excluded');
  assert.equal((await call('GET',`/v1/editorial/articles/${curated.id}`,reader)).json().following,true);
  assert.equal((await call('GET',`/v1/editorial/authors/${author.id}`,reader)).json().author.following,true);checked.push('shared author following state on curated details and profile');
  const page1=await timeline(reader,'?limit=1');assert(page1.nextCursor);const page2=await timeline(reader,'?limit=1&cursor='+encodeURIComponent(page1.nextCursor));assert.notEqual(page1.items[0].id,page2.items[0].id);
  const newer=await publishPost(author,'翻页期间的新帖子');
  const page3=await timeline(reader,'?limit=1&cursor='+encodeURIComponent(page2.nextCursor));
  assert.equal(new Set([page1.items[0].id,page2.items[0].id,page3.items[0].id]).size,3);assert.equal(page3.nextCursor,null);
  assert.equal((await timeline(reader,'?limit=1')).items[0].id,newer);
  await call('GET','/v1/me/community/following?cursor='+encodeURIComponent(page1.nextCursor),outsider,undefined,422);
  await call('GET','/v1/me/community/following?cursor=bad',reader,undefined,422);checked.push('global keyset page order and owner-bound cursor; new posts on first-page refresh');
  const closedFeed=await closed.inject({url:'/v1/me/community/following',headers:headers(reader)});assert.equal(closedFeed.statusCode,200);assert.deepEqual(closedFeed.json().items.map((x:any)=>x.id),[curated.id]);checked.push('closed public UGC gate preserves followed curated posts only');
  await call('PUT',`/v1/editorial/articles/${curated.id}/follow`,reader,{active:false});assert.deepEqual((await timeline()).items,[]);
  assert.equal((await call('GET',`/v1/ugc/posts/${first}`,reader)).json().following,false);
  await call('PUT',`/v1/editorial/articles/${curated.id}/follow`,reader,{active:true});assert.equal((await timeline()).items.length,4);
  assert.equal((await call('GET',`/v1/ugc/authors/${author.id}`,reader)).json().following,true);
  await follow(true);assert.equal((await timeline()).items.length,4);
  await follow(false);assert.deepEqual((await timeline()).items,[]);assert.equal((await call('GET',`/v1/editorial/articles/${curated.id}`,reader)).json().following,false);checked.push('follow and unfollow remain consistent across both post sources');
  await follow(true);await call('PUT',`/v1/editorial/blocks/${author.id}`,reader,{active:true});assert.deepEqual((await timeline()).items,[]);
  await call('PUT',`/v1/editorial/blocks/${author.id}`,reader,{active:false});await follow(true);
  await call('POST',`/v1/management/ugc/posts/${fresh}/hide`,reviewer,{reason:'合成下架检查',expectedVersion:(await call('GET',`/v1/me/ugc/posts/${fresh}`,author)).json().version});assert(!(await timeline()).items.some((x:any)=>x.id===fresh));
  await editorial.withdraw(author.id,author.principal,curated.id,curated.version,'synthetic following withdrawal');assert(!(await timeline()).items.some((x:any)=>x.id===curated.id));
  await pool.query("UPDATE member SET status='blocked' WHERE id=$1",[author.id]);assert.deepEqual((await timeline()).items,[]);checked.push('blocks, hidden posts, withdrawn curated content and inactive authors filtered');
  return {passed:true,checks:checked,syntheticActors:5,publishedOrdinaryPosts:6,existingAccountWrites:0};
 }finally{await closed.close();await app.close();globalThis.fetch=realFetch;}
}
