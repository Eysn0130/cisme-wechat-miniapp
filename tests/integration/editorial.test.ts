import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {createDecipheriv,createHash,randomUUID} from 'node:crypto';
import sharp from 'sharp';
import type {FastifyInstance} from 'fastify';
import {CANONICAL_WECHAT_MINIPROGRAM_APP_ID,loadConfig} from '@cisme/config';
import {TEST_DATABASE_URL,resetDatabase,testPool} from '@cisme/testkit';
import {EditorialService,type EditorialPublication,type EditorialVideo} from '../../services/api/src/editorial';
import {AuthorityService} from '../../services/api/src/authority';
import {createApiGatewayStorage} from '../../services/api/src/storage';
import {createApp} from '../../services/api/src/server';
import {issueSessionToken} from '../../services/api/src/auth';
import {transaction} from '../../services/api/src/db';
import {AccountClosure,applyAccountClosure} from '../../services/api/src/accountClosure';
import {DeliveryAddressService} from '../../services/api/src/deliveryAddress';
import {collectMemberPortableData} from '../../services/api/src/privacyPortableData';
import {portableQuerySpecs} from '../../services/api/src/privacyPortableQueries';
import {buildPortableParts,needsPortableParts} from '../../services/api/src/privacyPortableParts';
import {syntheticEditorialMp4} from '../fixtures/editorial-video';
const pool=testPool(),config=loadConfig({APP_ENV:'test',DATABASE_URL:TEST_DATABASE_URL,APP_SESSION_SECRET:'synthetic-editorial-session',UPLOAD_TOKEN_SECRET:'synthetic-editorial-upload',
  CONTACT_ENCRYPTION_KEY:'1'.repeat(64),CONTACT_HASH_KEY:'2'.repeat(64),WECHAT_APP_ID:CANONICAL_WECHAT_MINIPROGRAM_APP_ID,ALLOW_DEV_ADAPTERS:'false',UGC_GO_LIVE_GATE:'false',OBJECT_STORAGE_DRIVER:'api_gateway'});
const storage=createApiGatewayStorage(config),service=new EditorialService(pool,config,storage,new AuthorityService(pool,'test'));
let app:FastifyInstance;let author:{id:string;principal:string;openid:string},reader:typeof author,outsider:typeof author;let publication:EditorialPublication,id='',mediaSha='';
async function identity(label:string){
 const member=(await pool.query('INSERT INTO member(display_name) VALUES($1) RETURNING id',[`synthetic ${label}`])).rows[0].id;
 const openid=`synthetic-editorial-${randomUUID()}`;
 const identity=(await pool.query(`INSERT INTO wechat_identity(member_id,openid,adapter,provider,app_id) VALUES($1,$2,'wechat','wechat_miniprogram',$3) RETURNING id`,[member,openid,CANONICAL_WECHAT_MINIPROGRAM_APP_ID])).rows[0].id;
 return {id:member,principal:`wechat_miniprogram:${identity}`,openid};
}
function headers(person:typeof author){return {authorization:`Bearer ${issueSessionToken({principalId:person.principal,memberId:person.id,adapter:'wechat',provider:'wechat_miniprogram',appId:CANONICAL_WECHAT_MINIPROGRAM_APP_ID},config.sessionSecret)}`};}
const detail=(who?:typeof author)=>app.inject({method:'GET',url:`/v1/editorial/articles/${id}`,...(who?{headers:headers(who)}:{})});
beforeAll(async()=>{
 await resetDatabase(pool);await storage.ensureReady();author=await identity('author');reader=await identity('reader');outsider=await identity('outsider');
 await pool.query(`INSERT INTO authority_grant(member_id,capability,granted_by,grant_reason,environment,grant_source)
 VALUES($1,'editorial.manage','synthetic-test-operator','synthetic editorial owner authorization','test','integration_fixture')`,[author.id]);
 for(const type of ['terms','privacy'])await pool.query(`INSERT INTO legal_document(document_type,version,title,body,operator_name,contact,active)
  VALUES($1,'synthetic-v1','synthetic legal','synthetic current legal text','synthetic operator','synthetic contact',true)`,[type]);
 for(const person of [author,reader,outsider])await service.acceptCurrentLegal(person.id,person.principal,{consents:[{documentType:'terms',version:'synthetic-v1'},{documentType:'privacy',version:'synthetic-v1'}]});
 const bytes=await sharp({create:{width:8,height:8,channels:3,background:'#f0e9de'}}).webp().toBuffer();mediaSha=createHash('sha256').update(bytes).digest('hex');
 await storage.writeDerivedImage(`editorial-derived/${mediaSha}.webp`,bytes);
 publication={externalRef:'synthetic-editorial-test',authorMemberId:author.id,author:'授权作者',title:'温和护理记录',excerpt:'真实记录自己的感受',body:'测试专用纯文本正文\n不导入虚构互动',sourceUrl:null,
 authorizationRef:'cisme-editorial-owner-synthetic',rightsEvidence:{kind:'owner_authorized_original_rewrite',sources:[],illustration:'synthetic test image'},
 media:[{sha256:mediaSha,objectKey:`editorial-derived/${mediaSha}.webp`,sourceSha256:mediaSha,rightsRef:'synthetic-image-owner',bytes:bytes.length,sourceKind:'ai_generated_editorial_artwork',aiUsage:'generated'}],expectedVersion:0};
 id=(await service.publish(author.id,author.principal,publication)).id;app=await createApp({config,pool,storage});
});
afterAll(async()=>{await app?.close();await pool.end();});
describe('independent owner-authorized editorial (synthetic DB only)',()=>{
 it('reads published editorial with UGC/dev preview closed and no invented counters',async()=>{
  expect((await detail()).json()).toMatchObject({id,author:'授权作者',likeCount:0,saveCount:0,liked:false,saved:false,isMine:false,interactionsEnabled:true});
  expect((await app.inject({method:'GET',url:'/v1/editorial/articles'})).json().items).toHaveLength(1);
  expect((await app.inject({method:'GET',url:'/v1/ugc/status'})).json()).toMatchObject({publicEnabled:false});
  expect((await app.inject({method:'GET',url:'/v1/community/brand-scalp-ritual'})).statusCode).toBe(503);
  const media=await app.inject({method:'GET',url:`/v1/editorial/media/${id}/${mediaSha}`});expect(media.statusCode).toBe(200);expect(media.headers['content-type']).toMatch(/^image\/webp/);expect(media.headers['cache-control']).toBe('private, no-store');
 });
 it('rejects guests, wrong provider principals, unauthorized publishers and self follows',async()=>{
  expect((await app.inject({method:'PUT',url:`/v1/editorial/articles/${id}/reaction`,payload:{kind:'like',active:true}})).statusCode).toBe(401);
  await expect(service.react(reader.id,author.principal,id,{kind:'like',active:true})).rejects.toMatchObject({code:'AUTH_REQUIRED'});
  await expect(service.publish(outsider.id,outsider.principal,{...publication,externalRef:'unauthorized-content'})).rejects.toMatchObject({code:'CAPABILITY_REQUIRED'});
  expect((await app.inject({method:'PUT',url:`/v1/editorial/articles/${id}/follow`,headers:headers(author),payload:{active:true}})).statusCode).toBe(422);
  expect((await app.inject({method:'GET',url:'/v1/editorial/articles/brand-scalp-ritual'})).statusCode).toBe(404);
 });
 it('requires fresh explicit legal acceptance only for editorial writes and never replays an interaction',async()=>{
  await pool.query('UPDATE legal_document SET active=false');
  for(const type of ['terms','privacy'])await pool.query(`INSERT INTO legal_document(document_type,version,title,body,operator_name,contact,active)
   VALUES($1,'synthetic-v2','synthetic legal updated','synthetic current legal text updated','synthetic operator','synthetic contact',true)`,[type]);
  const before=(await pool.query("SELECT count(*)::int n FROM audit_log WHERE action LIKE 'editorial.%'")).rows[0].n;
  for(const suffix of ['reaction','follow']){
   const response=await app.inject({method:'PUT',url:`/v1/editorial/articles/${id}/${suffix}`,headers:headers(reader),payload:{kind:'like',active:true}});
   expect(response.statusCode).toBe(409);expect(response.json().code).toBe('CURRENT_LEGAL_CONSENT_REQUIRED');
  }
  expect((await pool.query('SELECT * FROM community_reaction')).rowCount).toBe(0);expect((await pool.query('SELECT * FROM community_follow')).rowCount).toBe(0);
  expect((await pool.query("SELECT count(*)::int n FROM audit_log WHERE action LIKE 'editorial.%'")).rows[0].n).toBe(before);
  expect((await detail()).statusCode).toBe(200);expect((await detail(reader)).statusCode).toBe(200);
  const stale=await app.inject({method:'POST',url:'/v1/me/legal-acceptances',headers:headers(reader),payload:{consents:[{documentType:'terms',version:'synthetic-v1'},{documentType:'privacy',version:'synthetic-v1'}]}});expect(stale.statusCode).toBe(409);
  const accept=()=>app.inject({method:'POST',url:'/v1/me/legal-acceptances',headers:headers(reader),payload:{memberId:outsider.id,consents:[{documentType:'terms',version:'synthetic-v2'},{documentType:'privacy',version:'synthetic-v2'}]}});
  expect((await accept()).json()).toMatchObject({accepted:true,documents:expect.arrayContaining([{documentType:'terms',version:'synthetic-v2'},{documentType:'privacy',version:'synthetic-v2'}])});
  expect((await accept()).statusCode).toBe(200);expect((await pool.query("SELECT * FROM consent_acceptance WHERE member_id=$1 AND document_version='synthetic-v2'",[reader.id])).rowCount).toBe(2);
  expect((await pool.query("SELECT * FROM consent_acceptance WHERE member_id=$1 AND document_version='synthetic-v2'",[outsider.id])).rowCount).toBe(0);
  expect((await pool.query('SELECT * FROM community_reaction')).rowCount).toBe(0);expect((await pool.query('SELECT * FROM community_follow')).rowCount).toBe(0);
 });
 it('persists only the authenticated reader interaction with exact idempotent stats',async()=>{
  const react=()=>app.inject({method:'PUT',url:`/v1/editorial/articles/${id}/reaction`,headers:headers(reader),payload:{kind:'like',active:true,memberId:outsider.id}});
  expect((await react()).json()).toMatchObject({liked:true,likeCount:1,count:1});expect((await react()).json()).toMatchObject({liked:true,likeCount:1});
  expect((await app.inject({method:'PUT',url:`/v1/editorial/articles/${id}/reaction`,headers:headers(reader),payload:{kind:'save',active:true}})).json()).toMatchObject({saved:true,saveCount:1});
  expect((await app.inject({method:'PUT',url:`/v1/editorial/articles/${id}/follow`,headers:headers(reader),payload:{active:true}})).json()).toMatchObject({authorId:author.id,following:true});
  expect((await detail(outsider)).json()).toMatchObject({liked:false,saved:false,following:false,likeCount:1});
  const reactions=await pool.query('SELECT member_id,post_id FROM community_reaction');expect(reactions.rows).toHaveLength(2);expect(reactions.rows.every(r=>r.member_id===reader.id&&r.post_id===`editorial:${id}`)).toBe(true);
  expect((await pool.query("SELECT count(*)::int AS n FROM audit_log WHERE action LIKE 'editorial.%'")).rows[0].n).toBe(4);
 });
 it('exports owned article, own interactions/follows and derived media in both portable projections',async()=>{
  const snapshot=await transaction(pool,c=>collectMemberPortableData(c,config,new DeliveryAddressService(pool,config),author.id));
  expect((snapshot.sections.editorial as any).articles[0]).toMatchObject({id,body:publication.body});expect(snapshot.uploaded.some(m=>m.kind==='editorial_derived')).toBe(true);
  expect(await transaction(pool,c=>needsPortableParts(c,author.id))).toBe(true);
  const request=(await pool.query(`INSERT INTO privacy_request(member_id,kind,message,due_at) VALUES($1,'access','synthetic editorial copy',now()+interval '30 days') RETURNING id`,[author.id])).rows[0].id;
  const job=(await pool.query(`INSERT INTO data_export_job(privacy_request_id,member_id,scope,requested_by) VALUES($1,$2,'{}','synthetic-test') RETURNING id`,[request,author.id])).rows[0].id;
  const key=Buffer.alloc(32,9),parts=await transaction(pool,c=>buildPortableParts(c,config,new DeliveryAddressService(pool,config),storage,job,author.id,key),'REPEATABLE READ',1,30_000);
  expect(parts).toMatchObject({complete:true,counts:{media:1}});
  const rows=(await pool.query('SELECT * FROM privacy_export_part WHERE job_id=$1 ORDER BY part_number',[job])).rows;
  const exported=Buffer.concat(rows.map(row=>{const d=createDecipheriv('aes-256-gcm',key,row.iv);d.setAuthTag(row.auth_tag);return Buffer.concat([d.update(row.ciphertext),d.final()]);})).toString();
  expect(exported).toContain('editorial_derived');expect(exported).toContain(mediaSha);expect(exported).toContain(publication.body.replaceAll('\n','\\n'));
  // This fixture predates comments; its four existing populated collections
  // remain exact. New owned comment collections are covered independently.
  for(const spec of portableQuerySpecs.filter(s=>s.section==='editorial'&&!['comments','commentLikes','commentReports'].includes(s.collection))){
   const rows=(await pool.query(spec.sql,[spec.collection==='articles'||spec.collection==='publicationEvidence'?author.id:reader.id])).rows;
   expect(rows.length).toBeGreaterThan(0);
  }
 });
 it('keeps revision proof minimal and immutable, replay and version changes honest',async()=>{
  expect(await service.publish(author.id,author.principal,publication)).toMatchObject({id,version:1,replayed:true});
  const revision=(await pool.query('SELECT * FROM editorial_article_revision WHERE article_id=$1',[id])).rows[0];
  expect(revision).not.toHaveProperty('snapshot');expect(JSON.stringify(revision)).not.toContain(publication.body);expect(JSON.stringify(revision)).not.toContain('授权作者');
  await expect(pool.query('DELETE FROM editorial_article_revision WHERE article_id=$1',[id])).rejects.toThrow('EDITORIAL_PUBLICATION_EVIDENCE_IMMUTABLE');
  await expect(service.publish(author.id,author.principal,{...publication,title:'变更但过期版本'})).rejects.toMatchObject({code:'EDITORIAL_VERSION_CONFLICT'});
 });
 it('hides inactive authors and rejects unknown or truncated media',async()=>{
  await pool.query("UPDATE member SET status='blocked' WHERE id=$1",[author.id]);expect((await detail()).statusCode).toBe(404);
  expect((await app.inject({method:'GET',url:`/v1/editorial/media/${id}/${mediaSha}`})).statusCode).toBe(404);
  await pool.query("UPDATE member SET status='active' WHERE id=$1",[author.id]);
  await expect(service.publish(author.id,author.principal,{...publication,externalRef:'missing-derived',media:[{...publication.media[0]!,sha256:'a'.repeat(64),objectKey:`editorial-derived/${'a'.repeat(64)}.webp`}]})).rejects.toThrow();
  expect((await pool.query("SELECT count(*)::int AS n FROM editorial_article WHERE external_ref='missing-derived'")).rows[0].n).toBe(0);
 });
 it('serializes a public media read against article withdrawal and author blocking',async()=>{
  let entered!:(value?:unknown)=>void,release!:(value?:unknown)=>void;
  const reached=new Promise(resolve=>entered=resolve),waiting=new Promise(resolve=>release=resolve);
  const slow={...storage,read:async(key:string,max?:number)=>{entered();await waiting;return storage.read(key,max);}};
  const mediaRead=new EditorialService(pool,config,slow,new AuthorityService(pool,'test')).media(id,mediaSha);await reached;
  const mutator=await pool.connect();
  try{
   await mutator.query("SET lock_timeout='75ms'");
   await expect(mutator.query("UPDATE editorial_article SET status='withdrawn' WHERE id=$1",[id])).rejects.toMatchObject({code:'55P03'});
   await expect(mutator.query("UPDATE member SET status='blocked' WHERE id=$1",[author.id])).rejects.toMatchObject({code:'55P03'});
  }finally{release();await mediaRead;await mutator.query('RESET lock_timeout');mutator.release();}
 });
 it('denies a revoked publisher capability without creating an article',async()=>{
  await pool.query("UPDATE authority_grant SET revoked_at=now(),revoked_by='synthetic-test',revoke_reason='synthetic revocation' WHERE member_id=$1 AND revoked_at IS NULL",[author.id]);
  await expect(service.publish(author.id,author.principal,{...publication,externalRef:'revoked-attempt'})).rejects.toMatchObject({code:'CAPABILITY_REQUIRED'});
  expect((await pool.query("SELECT 1 FROM editorial_article WHERE external_ref='revoked-attempt'")).rowCount).toBe(0);
  await pool.query(`INSERT INTO authority_grant(member_id,capability,granted_by,grant_reason,environment,grant_source)
   VALUES($1,'editorial.manage','synthetic-test','synthetic reauthorization','test','integration_fixture')`,[author.id]);
 });
 it('paginates article and author feeds without overlap including microsecond timestamps',async()=>{
  for(let n=0;n<3;n++)await service.publish(author.id,author.principal,{...publication,externalRef:`synthetic-page-${n}`,title:`护理知识${n}`});
  await pool.query("UPDATE editorial_article SET published_at='2026-10-26 00:00:00.123456+00'");
  const first=(await app.inject({method:'GET',url:'/v1/editorial/articles?limit=2'})).json();const second=(await app.inject({method:'GET',url:`/v1/editorial/articles?limit=2&cursor=${first.nextCursor}`})).json();
  expect(new Set([...first.items,...second.items].map(x=>x.id)).size).toBe(4);expect(second.nextCursor).toBeNull();
  const a=(await app.inject({method:'GET',url:`/v1/editorial/authors/${author.id}?limit=2`})).json();expect(a.author.postCount).toBe(4);
  const b=(await app.inject({method:'GET',url:`/v1/editorial/authors/${author.id}?limit=2&cursor=${a.nextCursor}`})).json();expect(new Set([...a.items,...b.items].map(x=>x.id)).size).toBe(4);
  expect((await app.inject({method:'GET',url:`/v1/editorial/articles?cursor=${a.nextCursor}`})).statusCode).toBe(422);
 });
 it('withdraws old detail/media immediately; purge keeps shared media until its last reference',async()=>{
  await service.withdraw(author.id,author.principal,id,1,'OWNER_REQUEST');expect((await detail()).statusCode).toBe(404);
  expect((await app.inject({method:'GET',url:`/v1/editorial/media/${id}/${mediaSha}`})).statusCode).toBe(404);
  const hold=(await pool.query(`INSERT INTO legal_hold(reason_code,legal_basis,approved_by,review_at,expires_at)
    VALUES('SYNTHETIC_HOLD','synthetic temporary test legal hold','synthetic-test',now()+interval '1 day',now()+interval '2 days') RETURNING id`)).rows[0].id;
  await pool.query("INSERT INTO legal_hold_binding(hold_id,object_type,object_id) VALUES($1,'editorial_article',$2)",[hold,id]);
  await expect(service.purgeWithdrawn(author.id,author.principal,id,2)).rejects.toMatchObject({code:'EDITORIAL_HELD'});
  await pool.query("UPDATE legal_hold SET status='released',released_at=now(),released_by='synthetic-test' WHERE id=$1",[hold]);
  expect(await service.purgeWithdrawn(author.id,author.principal,id,2)).toMatchObject({removedObjects:0});
  expect((await pool.query('SELECT body,media FROM editorial_article WHERE id=$1',[id])).rows[0]).toEqual({body:'已撤回内容',media:[]});
 });
 it('physically removes an unshared derived object only after explicit withdrawal and purge',async()=>{
  const bytes=await sharp({create:{width:9,height:9,channels:3,background:'#44aaff'}}).webp().toBuffer(),sha=createHash('sha256').update(bytes).digest('hex');
  const key=`editorial-derived/${sha}.webp`;await storage.writeDerivedImage(key,bytes);
  const article=await service.publish(author.id,author.principal,{...publication,externalRef:'synthetic-unique-media',media:[{sha256:sha,sourceSha256:sha,objectKey:key,bytes:bytes.length,rightsRef:'synthetic-owned-image',sourceKind:'ai_generated_editorial_artwork',aiUsage:'generated'}]});
  await service.withdraw(author.id,author.principal,article.id,1,'OWNER_AUTHORIZED_WITHDRAWAL');
  expect(await service.purgeWithdrawn(author.id,author.principal,article.id,2)).toMatchObject({removedObjects:1});await expect(storage.read(key,1024)).rejects.toThrow();
 });
 it('publishes source-bound ordered brand images without invented AI declarations or public UGC',async()=>{
  const images=[];
  for(const color of ['#a05080','#326aac']){
   const bytes=await sharp({create:{width:12,height:10,channels:3,background:color}}).webp().toBuffer();
   const sha=createHash('sha256').update(bytes).digest('hex');await storage.writeDerivedImage(`editorial-derived/${sha}.webp`,bytes);
   images.push({bytes,media:{sha256:sha,objectKey:`editorial-derived/${sha}.webp`,sourceSha256:createHash('sha256').update('synthetic-original:'+color).digest('hex'),
    rightsRef:'synthetic-brand-owner-authorization',bytes:bytes.length,sourceKind:'owner_authorized_brand_media' as const,aiUsage:'not_declared' as const}});
  }
  const content:EditorialPublication={...publication,externalRef:'synthetic-brand-gallery',sourceUrl:'https://www.xiaohongshu.com/explore/synthetic-brand-note',
   rightsEvidence:{kind:'owner_authorized_brand_republication',sources:[{url:'https://www.xiaohongshu.com/explore/synthetic-brand-note'}]},
   media:images.slice().reverse().map(image=>image.media)};
  const article=await service.publish(author.id,author.principal,content);
  expect(await service.publish(author.id,author.principal,content)).toMatchObject({id:article.id,version:1,replayed:true});
  const response=await app.inject({method:'GET',url:`/v1/editorial/articles/${article.id}`});expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({authorId:author.id,provenanceLabel:'品牌原帖配图',likeCount:0,saveCount:0,
   coverUrl:`/v1/editorial/media/${article.id}/${images[1]!.media.sha256}`,media:content.media.map(image=>({id:image.sha256,url:`/v1/editorial/media/${article.id}/${image.sha256}`}))});
  expect((await pool.query('SELECT media FROM editorial_article WHERE id=$1',[article.id])).rows[0].media).toEqual(content.media);
  for(const image of images){
   const read=await app.inject({method:'GET',url:`/v1/editorial/media/${article.id}/${image.media.sha256}`});
   expect(read.statusCode).toBe(200);expect(read.headers['content-type']).toMatch(/^image\/webp/);
   expect(read.headers['x-content-type-options']).toBe('nosniff');expect(read.rawPayload).toEqual(image.bytes);
  }
  expect((await app.inject({method:'GET',url:'/v1/ugc/status'})).json().publicEnabled).toBe(false);
  const copy=await transaction(pool,c=>collectMemberPortableData(c,config,new DeliveryAddressService(pool,config),author.id));
  const exported=(copy.sections.editorial as any).articles.find((row:any)=>row.id===article.id);expect(exported.media).toEqual(content.media);
  await expect(service.publish(outsider.id,outsider.principal,{...content,externalRef:'synthetic-unauthorized-brand'})).rejects.toMatchObject({code:'CAPABILITY_REQUIRED'});
  await expect(service.publish(author.id,author.principal,{...content,title:'stale edit',expectedVersion:0})).rejects.toMatchObject({code:'EDITORIAL_VERSION_CONFLICT'});
  await service.withdraw(author.id,author.principal,article.id,1,'OWNER_AUTHORIZED_WITHDRAWAL');
  expect((await app.inject({method:'GET',url:`/v1/editorial/articles/${article.id}`})).statusCode).toBe(404);
  for(const image of images)expect((await app.inject({method:'GET',url:`/v1/editorial/media/${article.id}/${image.media.sha256}`})).statusCode).toBe(404);
 });
 it('labels mixed and explicitly AI-declared brand galleries accurately without changing legacy AI reads',async()=>{
  const legacy=publication.media[0]!;
  const declared={...legacy,sourceKind:'owner_authorized_brand_media' as const,aiUsage:'generated' as const};
  const article=await service.publish(author.id,author.principal,{...publication,externalRef:'synthetic-declared-brand-ai',media:[declared]});
  expect((await app.inject({method:'GET',url:`/v1/editorial/articles/${article.id}`})).json().provenanceLabel).toBe('AI辅助配图');
  const bytes=await sharp({create:{width:7,height:6,channels:3,background:'#567a24'}}).webp().toBuffer();
  const sha=createHash('sha256').update(bytes).digest('hex');await storage.writeDerivedImage(`editorial-derived/${sha}.webp`,bytes);
  const mixed=await service.publish(author.id,author.principal,{...publication,externalRef:'synthetic-mixed-brand-ai',media:[
   {...declared,sha256:sha,objectKey:`editorial-derived/${sha}.webp`,sourceSha256:sha,bytes:bytes.length,aiUsage:'not_declared'},legacy]});
  expect((await app.inject({method:'GET',url:`/v1/editorial/articles/${mixed.id}`})).json().provenanceLabel).toBe('品牌原帖配图（含AI辅助配图）');
 });
 it('serves verified H264 video and poster with bounded single ranges, correct export MIME, and withdrawal protection',async()=>{
  const sha=createHash('sha256').update(syntheticEditorialMp4).digest('hex');
  const posterBytes=await sharp({create:{width:32,height:24,channels:3,background:'#23aabb'}}).webp().toBuffer();
  const posterSha=createHash('sha256').update(posterBytes).digest('hex'),sourceSha=createHash('sha256').update('synthetic-original-video').digest('hex');
  const provenance={sourceSha256:sourceSha,rightsRef:'synthetic-video-republication',sourceKind:'owner_authorized_brand_media' as const,aiUsage:'not_declared' as const};
  const media:EditorialVideo={sha256:sha,objectKey:`editorial-video/${sha}.mp4`,bytes:syntheticEditorialMp4.length,...provenance,
   mediaType:'video',mimeType:'video/mp4',width:32,height:24,durationMs:400,
   poster:{sha256:posterSha,objectKey:`editorial-derived/${posterSha}.webp`,bytes:posterBytes.length,...provenance}};
  await storage.writeEditorialVideo!(media.objectKey,syntheticEditorialMp4);await storage.writeDerivedImage(media.poster.objectKey,posterBytes);
  const content={...publication,externalRef:'synthetic-video-note',media:[media]},article=await service.publish(author.id,author.principal,content);
  const url=`/v1/editorial/media/${article.id}/${sha}`,posterUrl=`/v1/editorial/media/${article.id}/${posterSha}`;
  const detail=await app.inject({method:'GET',url:`/v1/editorial/articles/${article.id}`});
  expect(detail.json()).toMatchObject({coverUrl:posterUrl,provenanceLabel:'品牌原帖视频',media:[{id:sha,url,type:'video',mimeType:'video/mp4',posterUrl,width:32,height:24,durationMs:400}]});
  const full=await app.inject({method:'GET',url});expect(full.statusCode).toBe(200);expect(full.rawPayload).toEqual(syntheticEditorialMp4);
  expect(full.headers).toMatchObject({'content-type':'video/mp4','accept-ranges':'bytes','x-content-type-options':'nosniff','cache-control':'private, no-store'});
  for(const [range,start,end] of [['bytes=0-99',0,99],['bytes=100-',100,syntheticEditorialMp4.length-1],['bytes=-20',syntheticEditorialMp4.length-20,syntheticEditorialMp4.length-1],['bytes=0-999999',0,syntheticEditorialMp4.length-1]] as const){
   const result=await app.inject({method:'GET',url,headers:{range}});expect(result.statusCode).toBe(206);
   expect(result.headers['content-range']).toBe(`bytes ${start}-${end}/${syntheticEditorialMp4.length}`);
   expect(result.rawPayload).toEqual(syntheticEditorialMp4.subarray(start,end+1));
  }
  for(const range of ['bytes=0-1,3-4','bytes=999999-','bytes=-0','bytes=3-2','items=0-1','bytes=-','bytes=0-NaN']){
   const result=await app.inject({method:'GET',url,headers:{range}});expect(result.statusCode).toBe(416);
   expect(result.headers['content-range']).toBe(`bytes */${syntheticEditorialMp4.length}`);expect(result.rawPayload.length).toBe(0);
  }
  const poster=await app.inject({method:'GET',url:posterUrl});expect(poster.statusCode).toBe(200);expect(poster.rawPayload).toEqual(posterBytes);expect(poster.headers['content-type']).toMatch(/^image\/webp/);
  const corrupt=Buffer.from(syntheticEditorialMp4);corrupt[corrupt.length-1]=corrupt[corrupt.length-1]!^1;
  const tampered=await createApp({config,pool,storage:{...storage,read:async(key,max)=>key===media.objectKey?{bytes:corrupt,mimeType:'video/mp4'}:storage.read(key,max)}});
  try{const refused=await tampered.inject({method:'GET',url,headers:{range:'bytes=0-7'}});expect(refused.statusCode).toBe(503);expect(refused.rawPayload).not.toEqual(syntheticEditorialMp4.subarray(0,8));}
  finally{await tampered.close();}
  const copy=await transaction(pool,c=>collectMemberPortableData(c,config,new DeliveryAddressService(pool,config),author.id));
  expect(copy.uploaded.find(item=>item.object_key===media.objectKey)).toMatchObject({mime_type:'video/mp4',size_bytes:String(syntheticEditorialMp4.length)});
  expect(copy.uploaded.find(item=>item.object_key===media.poster.objectKey)).toMatchObject({mime_type:'image/webp',size_bytes:String(posterBytes.length)});
  const request=(await pool.query("INSERT INTO privacy_request(member_id,kind,message,due_at) VALUES($1,'access','synthetic video export',now()+interval '30 days') RETURNING id",[author.id])).rows[0].id;
  const job=(await pool.query("INSERT INTO data_export_job(privacy_request_id,member_id,scope,requested_by) VALUES($1,$2,'{}','synthetic-test') RETURNING id",[request,author.id])).rows[0].id;
  const key=Buffer.alloc(32,11),parts=await transaction(pool,c=>buildPortableParts(c,config,new DeliveryAddressService(pool,config),storage,job,author.id,key),'REPEATABLE READ',1,30_000);
  expect(parts.counts.media).toBe(copy.uploaded.length);
  const rows=(await pool.query('SELECT * FROM privacy_export_part WHERE job_id=$1 ORDER BY part_number',[job])).rows;
  const exported=Buffer.concat(rows.map(row=>{const d=createDecipheriv('aes-256-gcm',key,row.iv);d.setAuthTag(row.auth_tag);return Buffer.concat([d.update(row.ciphertext),d.final()]);})).toString();
  expect(exported).toContain('"mimeType":"video/mp4"');expect(exported).toContain(posterSha);
  let entered!:()=>void,release!:()=>void;const reached=new Promise<void>(resolve=>entered=resolve),waiting=new Promise<void>(resolve=>release=resolve);
  const slow={...storage,read:async(objectKey:string,max?:number)=>{if(objectKey===media.objectKey){entered();await waiting;}return storage.read(objectKey,max);}};
  const reading=new EditorialService(pool,config,slow,new AuthorityService(pool,'test')).media(article.id,sha,'bytes=0-7');await reached;
  const mutator=await pool.connect();try{
   await mutator.query("SET lock_timeout='75ms'");
   await expect(mutator.query("UPDATE editorial_article SET status='withdrawn' WHERE id=$1",[article.id])).rejects.toMatchObject({code:'55P03'});
   await expect(mutator.query("UPDATE member SET status='blocked' WHERE id=$1",[author.id])).rejects.toMatchObject({code:'55P03'});
  }finally{release();await reading;await mutator.query('RESET lock_timeout');mutator.release();}
  const shared=await service.publish(author.id,author.principal,{...publication,externalRef:'synthetic-shared-video-poster',media:[media.poster]});
  await service.withdraw(author.id,author.principal,shared.id,1,'OWNER_WITHDRAW_POSTER');
  expect(await service.purgeWithdrawn(author.id,author.principal,shared.id,2)).toMatchObject({removedObjects:0});
  await service.withdraw(author.id,author.principal,article.id,1,'OWNER_WITHDRAW_VIDEO');
  for(const mediaUrl of [url,posterUrl])expect((await app.inject({method:'GET',url:mediaUrl,headers:{range:'bytes=0-7'}})).statusCode).toBe(404);
  expect(await service.purgeWithdrawn(author.id,author.principal,article.id,2)).toMatchObject({removedObjects:2});
  await expect(storage.read(media.objectKey)).rejects.toThrow();await expect(storage.read(media.poster.objectKey)).rejects.toThrow();
 });
 it('account closure withdraws/redacts author text and clears own real reader activity',async()=>{
  await transaction(pool,c=>applyAccountClosure(c,{version:1,memberId:author.id,identityDigest:AccountClosure.identityDigest('wechat_miniprogram',CANONICAL_WECHAT_MINIPROGRAM_APP_ID,author.openid),requestId:randomUUID(),createdAt:new Date().toISOString()}));
  expect((await app.inject({method:'GET',url:'/v1/editorial/articles'})).json().items).toEqual([]);
  expect((await pool.query('SELECT DISTINCT body,status,author_display_name FROM editorial_article')).rows).toEqual([{body:'已撤回内容',status:'withdrawn',author_display_name:'已注销用户'}]);
  await transaction(pool,c=>applyAccountClosure(c,{version:1,memberId:reader.id,identityDigest:AccountClosure.identityDigest('wechat_miniprogram',CANONICAL_WECHAT_MINIPROGRAM_APP_ID,reader.openid),requestId:randomUUID(),createdAt:new Date().toISOString()}));
  expect((await pool.query('SELECT * FROM community_reaction WHERE member_id=$1',[reader.id])).rows).toEqual([]);expect((await pool.query('SELECT * FROM community_follow WHERE member_id=$1',[reader.id])).rows).toEqual([]);
 });
});
