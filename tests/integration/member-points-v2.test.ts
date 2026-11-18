import {randomBytes,randomUUID} from 'node:crypto';
import sharp from 'sharp';
import {beforeAll,afterAll,it,expect,vi} from 'vitest';
import {loadConfig,CANONICAL_WECHAT_MINIPROGRAM_APP_ID} from '@cisme/config';
import {testPool,resetDatabase,TEST_DATABASE_URL} from '@cisme/testkit';
import {createApp} from '../../services/api/src/server';
import {createApiGatewayStorage} from '../../services/api/src/storage';
import {issueSessionToken} from '../../services/api/src/auth';
import {processMemberPointSources,MemberPointsClub} from '../../services/api/src/memberPointsClub';
import {MemberPointsTasks} from '../../services/api/src/memberPointsTasks';
import {AuthorityService} from '../../services/api/src/authority';
import {UgcSafetyService} from '../../services/api/src/ugcSafety';
import {transaction} from '../../services/api/src/db';
import {activePointPolicy,quoteMemberPoints,grantMemberPoints,pointDay} from '../../services/api/src/pointsLedger';
import {directSafetyEnv,safeProvider} from './ugc-direct-fixture';
const pool=testPool(),config=loadConfig({...directSafetyEnv,APP_ENV:'test',DATABASE_URL:TEST_DATABASE_URL,APP_SESSION_SECRET:randomBytes(32).toString('hex'),ADMIN_API_TOKEN:'points-v2-isolated-admin',UPLOAD_TOKEN_SECRET:'points-v2-isolated-upload',OBJECT_STORAGE_DRIVER:'api_gateway',WECHAT_APP_ID:CANONICAL_WECHAT_MINIPROGRAM_APP_ID,CONTACT_ENCRYPTION_KEY:randomBytes(32).toString('hex'),CONTACT_HASH_KEY:randomBytes(32).toString('hex'),UGC_GO_LIVE_GATE:'true',UGC_LEGAL_APPROVAL_ID:'synthetic-points-v2',UGC_PROVENANCE_READY:'true',UGC_CONTENT_SAFETY_READY:'true',UGC_MODERATION_READY:'true'});
const storage=createApiGatewayStorage(config),authority=new AuthorityService(pool,'test'),club=new MemberPointsClub(pool,config,authority),tasks=new MemberPointsTasks(pool,config,authority);
let app:Awaited<ReturnType<typeof createApp>>,admin:any,productId:string,skuId:string,sourcePost:any;let actorN=0;
const auth=(a:any)=>({authorization:'Bearer '+a.sessionToken});
async function person(){const response=await app.inject({method:'POST',url:'/v1/identity/dev',remoteAddress:`192.0.2.${++actorN}`,payload:{externalUserId:randomUUID(),displayName:'合成积分会员'+actorN,consents:[{documentType:'privacy',version:'test'},{documentType:'terms',version:'test'}]}});expect(response.statusCode,response.body).toBe(200);const a=response.json();const identity=(await pool.query(`INSERT INTO wechat_identity(member_id,provider,app_id,openid,adapter) VALUES($1,'wechat_miniprogram',$2,$3,'wechat') RETURNING id`,[a.memberId,CANONICAL_WECHAT_MINIPROGRAM_APP_ID,'points-v2-'+randomUUID()])).rows[0].id;return {...a,sessionToken:issueSessionToken({memberId:a.memberId,principalId:'wechat_miniprogram:'+identity,adapter:'wechat',provider:'wechat_miniprogram',appId:CANONICAL_WECHAT_MINIPROGRAM_APP_ID},config.sessionSecret)};}
async function post(a:any,kind='original',body='这是我认真记录的日常护理过程，洗护后头皮感受需要如实保留。'+randomUUID()){
 const create=await app.inject({method:'POST',url:'/v1/me/ugc/posts',headers:{...auth(a),'idempotency-key':randomUUID()},payload:{}});expect(create.statusCode,create.body).toBe(200);const p=create.json();
 const save=await app.inject({method:'PUT',url:`/v1/me/ugc/posts/${p.id}/draft`,headers:auth(a),payload:{expectedVersion:p.version,title:'合成护理分享',body,mediaIds:[],rewardKind:kind,...(kind==='experience'?{experienceProductCode:'synthetic-v2-essence',experienceDays:7}:{})}});expect(save.statusCode,save.body).toBe(200);
 const publish=await app.inject({method:'POST',url:`/v1/me/ugc/posts/${p.id}/submit`,headers:auth(a),payload:{expectedVersion:save.json().version}});expect(publish.statusCode,publish.body).toBe(200);expect(publish.json().state).toBe('published');return publish.json();
}
const work=()=>processMemberPointSources(pool,new Date(Date.now()+2000),200);
const grants=async(a:any,type:string)=>(await pool.query('SELECT id,component,amount FROM points_grant WHERE member_id=$1 AND source_type=$2 ORDER BY created_at,id',[a.memberId,type])).rows;
beforeAll(async()=>{vi.stubGlobal('fetch',safeProvider);await resetDatabase(pool);await storage.ensureReady();app=await createApp({config,pool,storage});admin=await person();for(const cap of ['community.moderate','commerce.product.manage'])await pool.query(`INSERT INTO authority_grant(member_id,capability,granted_by,grant_reason,environment,grant_source) VALUES($1,$2,'fixture','isolated points v2','test','integration_fixture')`,[admin.memberId,cap]);
 await pool.query(`INSERT INTO ugc_go_live_approval(approval_reference,signed_by,evidence,signed_at,expires_at) VALUES('synthetic-points-v2','isolated fixture','{"scope":"synthetic"}',now(),now()+interval '1 hour')`);await pool.query("UPDATE emergency_switch SET enabled=true WHERE key='community'");
 productId=(await pool.query(`INSERT INTO catalog_product(code,name,source_kind,qualification_status,publication_status,created_by,updated_by,published_at) VALUES('synthetic-v2-essence','合成精华','synthetic_test','eligible','published','fixture','fixture',now()) RETURNING id`)).rows[0].id;
 skuId=(await pool.query(`INSERT INTO catalog_sku(product_id,code,label,created_by,updated_by) VALUES($1,'V2_ESSENCE','合成规格','fixture','fixture') RETURNING id`,[productId])).rows[0].id;
 await pool.query(`INSERT INTO catalog_price(sku_id,currency,amount_cents,created_by,updated_by) VALUES($1,'CNY',10000,'fixture','fixture')`,[skuId]);
 await pool.query("INSERT INTO catalog_inventory_level(sku_id,stock_on_hand,updated_by) VALUES($1,10,'fixture')",[skuId]);
});
afterAll(async()=>{await app?.close();await pool.end();vi.unstubAllGlobals();});
it('uses approved prospective v2 rules and returns a public guide without member progress',async()=>{const r=await app.inject({url:'/v1/points/guide'});expect(r.statusCode,r.body).toBe(200);expect(r.json().policy.rules).toMatchObject({comment:2,commentMinHan:15,commentDailyLimit:3,streak7:20,streak30:50,dailyShoppingMultiplier:2});expect(r.json().tasks.every((t:any)=>t.count===null&&t.state==='login')).toBe(true);expect(r.body).not.toContain(admin.memberId);});
it('separates first-post bonus from mutually exclusive monthly original and experience rewards',async()=>{const a=await person();sourcePost=await post(a);await post(a);await post(a);await post(a,'experience','我连续七天在洗头后使用这款产品，具体用量和过程认真记录，发丝没有想象中柔顺，头皮感受仍需继续观察。'+randomUUID());await post(a,'experience');await work();
 const rows=await grants(a,'post');expect(rows.map(g=>[g.component,g.amount]).sort()).toEqual([['first_post',20],['original',30],['original',30],['experience',80]].sort());const before=JSON.stringify(rows);await work();expect(JSON.stringify(await grants(a,'post'))).toBe(before);
 const receipt=await app.inject({url:`/v1/me/points/content-receipt?kind=post&id=${sourcePost.id}`,headers:auth(a)});expect(receipt.json().grants.reduce((n:number,g:any)=>n+g.points,0)).toBe(50);expect((await app.inject({url:`/v1/me/points/content-receipt?kind=post&id=${sourcePost.id}`,headers:auth(admin)})).statusCode).toBe(404);
});
it('counts only 15 or more Han characters, shares one daily quota across actual comments and pays neither likes nor repeated text',async()=>{const a=await person(),bodies=['只是太短的评论','abcdefghijklmnopqrst，1234567890','读完这篇护理体验以后，我想了解更多具体使用感受。甲','认真记录每天的变化很有帮助，也想交流洗护的方法。乙','对产品的真实体验应该保留，包括没有满意的地方。丙','这是一条超过当天奖励上限的真实护理交流内容。丁'];
 for(const body of bodies){const r=await app.inject({method:'POST',url:`/v1/ugc/posts/${sourcePost.id}/comments`,headers:{...auth(a),'idempotency-key':randomUUID()},payload:{body}});expect(r.statusCode,r.body).toBe(200);await new UgcSafetyService(pool,config,storage,safeProvider).scanComment(r.json().id);}
 await work();expect((await grants(a,'comment')).map(g=>g.amount)).toEqual([2,2,2]);const status=await club.overview(a.memberId);expect(status.tasks.find(t=>t.id==='comment')).toMatchObject({count:3,state:'limit'});
});
it('does not award a share button or self visit and rewards an authenticated other-person visit only once',async()=>{const a=await person(),visitor=await person(),shared=await post(a);await work();const link=await app.inject({method:'POST',url:'/v1/shares',headers:{...auth(a),'idempotency-key':randomUUID()},payload:{targetType:'post',targetRef:shared.id}});expect(link.statusCode,link.body).toBe(200);expect((await grants(a,'share'))).toHaveLength(0);
 const share=link.json().shareId;for(const [actor,key]of [[a,'self-visit-key-v2-01'],[visitor,'other-visit-key-v2-01'],[visitor,'other-visit-key-v2-02']] as const){expect((await app.inject({method:'POST',url:`/v1/shares/${share}/visits`,payload:{visitKey:key}})).statusCode).toBe(200);const r=await app.inject({method:'POST',url:`/v1/shares/${share}/attributions/identity`,headers:auth(actor),payload:{visitKey:key}});expect(r.statusCode,r.body).toBe(200);}await work();expect((await grants(a,'share')).map(g=>g.amount)).toEqual([5]);expect((await pool.query('SELECT 1 FROM sharing_customer_relation WHERE buyer_id=$1',[visitor.memberId])).rowCount).toBe(0);
});
it('keeps suggestions private and encrypted, enforces reviewer authority and awards approved unique suggestions only',async()=>{const a=await person(),body='我希望在领取订单列表中增加按物流状态筛选，这样能更方便地查看已经发出的礼品。',key=randomUUID(),submitted=await tasks.submitSuggestion(a.memberId,key,{body});expect(submitted.state).toBe('pending');expect(await tasks.submitSuggestion(a.memberId,key,{body})).toMatchObject({id:submitted.id,replayed:true});expect((await pool.query('SELECT encrypted_body FROM member_points_suggestion WHERE id=$1',[submitted.id])).rows[0].encrypted_body).not.toContain('领取订单');
 await expect(tasks.reviewSuggestion(a.memberId,submitted.id,{state:'approved',expectedVersion:1,reason:'有效明确的建议'})).rejects.toMatchObject({code:'CAPABILITY_REQUIRED'});await tasks.reviewSuggestion(admin.memberId,submitted.id,{state:'approved',expectedVersion:1,reason:'有效明确的功能改进建议'});await work();expect((await grants(a,'suggestion')).map(g=>g.amount)).toEqual([20]);await expect(tasks.reviewSuggestion(admin.memberId,submitted.id,{state:'approved',expectedVersion:1,reason:'重复审核不能发分'})).rejects.toMatchObject({code:'POINTS_SUGGESTION_CHANGED'});expect((await tasks.suggestions(admin.memberId)).items).toHaveLength(0);
});
it('makes member-day cap, exclusions and promotion end boundaries authoritative',async()=>{const a=await person(),day18=new Date(Date.UTC(2027,0,18,1)),day19=new Date(Date.UTC(2027,0,19,1));await transaction(pool,async c=>{const p=(await activePointPolicy(c))!;await grantMemberPoints(c,{owner:a.memberId,sourceType:'fixture',sourceId:randomUUID(),component:'base',amount:10000,policy:p,now:new Date()});});
 const quote=(at:Date,points=0)=>transaction(pool,c=>quoteMemberPoints(c,a.memberId,skuId,10000,points,at));expect(await quote(day18)).toMatchObject({maximum:2000,enabled:true});expect(await quote(day19)).toMatchObject({maximum:0,enabled:false});await expect(quote(day19,1)).rejects.toMatchObject({code:'POINTS_DISCOUNT_UNAVAILABLE'});
 await pool.query('UPDATE catalog_product SET points_discount_enabled=false WHERE id=$1',[productId]);expect(await quote(day18)).toMatchObject({maximum:0});await pool.query('UPDATE catalog_product SET shopping_points_multiplier=3,points_promotion_starts_at=$2,points_promotion_ends_at=$3 WHERE id=$1',[productId,day18,day19]);
 expect((await pool.query('SELECT effective_shopping_points_multiplier($1,$2) AS n',[productId,day18])).rows[0].n).toBe(3);expect((await pool.query('SELECT effective_shopping_points_multiplier($1,$2) AS n',[productId,day19])).rows[0].n).toBe(2);
});

it('awards each actual care day and completed streak under the prospective rule, without duplicate worker grants',async()=>{
 const a=await person(),base=(await pool.query<{now:Date}>('SELECT clock_timestamp() AS now')).rows[0]!.now;
 for(let i=0;i<30;i++){const at=new Date(+base+i*86400000);await club.checkin(a.memberId,randomUUID(),{products:['net_run'],note:'今天洗护以后头皮感觉比较清爽，具体变化继续认真记录。',serverDay:pointDay(at)},at);}
 const end=new Date(+base+30*86400000);await processMemberPointSources(pool,end,200);await processMemberPointSources(pool,end,200);
 const days=await grants(a,'care_day'),streaks=await grants(a,'care_streak');expect(days.filter(g=>g.component==='daily')).toHaveLength(30);expect(days.filter(g=>g.component==='note')).toHaveLength(30);expect(streaks.filter(g=>g.component==='streak7').map(g=>g.amount)).toEqual([20,20,20,20]);expect(streaks.filter(g=>g.component==='streak30').map(g=>g.amount)).toEqual([50]);
 const onMilestone=await club.overview(a.memberId,new Date(+base+29*86400000));
 expect(onMilestone.tasks).toEqual(expect.arrayContaining([
  expect.objectContaining({id:'daily',count:1,state:'limit'}),
  expect.objectContaining({id:'note',count:1,state:'limit'}),
  expect.objectContaining({id:'streak30',count:1,state:'completed'})
 ]));
 const tomorrow=await club.overview(a.memberId,end);
 expect(tomorrow.tasks).toEqual(expect.arrayContaining([
  expect.objectContaining({id:'note',count:0,state:'available'}),
  expect.objectContaining({id:'streak30',count:1,state:'completed'})
 ]));
 const prior=JSON.stringify([days,streaks]);await processMemberPointSources(pool,end,200);expect(JSON.stringify([await grants(a,'care_day'),await grants(a,'care_streak')])).toBe(prior);
});

it('only shows pending daily awards for the current day and an eligible note',async()=>{
 const a=await person(),b=await person(),now=new Date();
 const paused=await pool.query("UPDATE emergency_switch SET enabled=false WHERE key='rewards' AND enabled RETURNING key");
 expect(paused.rowCount).toBe(1);
 try{
  await club.checkin(a.memberId,randomUUID(),{products:['net_run'],note:'今天清洗以后头皮清爽，发丝柔顺，之后继续记录。',serverDay:pointDay(now)},now);
  await club.checkin(b.memberId,randomUUID(),{products:['net_run'],note:'简短感受',serverDay:pointDay(now)},now);
  expect((await club.overview(a.memberId,now)).tasks).toEqual(expect.arrayContaining([
   expect.objectContaining({id:'daily',count:0,state:'pending'}),
   expect.objectContaining({id:'note',count:0,state:'pending'})
  ]));
  expect((await club.overview(b.memberId,now)).tasks.find(task=>task.id==='note')).toMatchObject({count:0,state:'available'});
  expect((await club.overview(a.memberId,new Date(+now+86400000))).tasks.find(task=>task.id==='note')).toMatchObject({count:0,state:'available'});
 }finally{
  await pool.query("UPDATE emergency_switch SET enabled=true WHERE key='rewards'");
 }
});

it('projects confirmed ledger progress for all guide tasks, including repeat invitations and an invited first order',async()=>{
 const a=await person(),now=new Date();
 const before=await club.overview(a.memberId,now);
 expect(before.tasks).toHaveLength(14);
 await transaction(pool,async c=>{
  const policy=(await activePointPolicy(c,now))!;
  for(const task of before.tasks){
   const goal=task.limit||2;
   const care=task.type==='care_day'||task.type==='care_streak';
   for(let i=0;i<goal;i++)await grantMemberPoints(c,{owner:a.memberId,sourceType:task.type,
    sourceId:care?task.bucket:randomUUID(),component:task.id==='firstOrder'?'invite_friend':task.component,
    amount:task.id==='firstOrder'?policy.rules.inviteFriend:task.amount!,policy,now,bucket:task.bucket});
  }
 });
 const after=await club.overview(a.memberId,now);
 for(const task of before.tasks){
  const target=after.tasks.find(row=>row.id===task.id);
  const recurring=task.bucket&&task.type!=='care_streak';
  expect(target,task.id).toMatchObject({count:task.limit||2,state:!task.limit?'available':recurring?'limit':'completed'});
 }
 expect(after.tasks.find(task=>task.id==='firstOrder')).toMatchObject({amount:200,state:'completed'});
});
