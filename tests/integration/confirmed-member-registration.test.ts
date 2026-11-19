import {afterAll,beforeAll,expect,it} from 'vitest';
import jpeg from 'jpeg-js';
import {loadConfig} from '@cisme/config';
import {resetDatabase,testPool,TEST_DATABASE_URL} from '@cisme/testkit';
import {createApp} from '../../services/api/src/server';
import {createApiGatewayStorage} from '../../services/api/src/storage';
import {processMemberPointSources} from '../../services/api/src/memberPointsClub';

const pool=testPool();
const config=loadConfig({APP_ENV:'test',DATABASE_URL:TEST_DATABASE_URL,ALLOW_DEV_ADAPTERS:'true',
  APP_SESSION_SECRET:'synthetic-registration-session',UPLOAD_TOKEN_SECRET:'synthetic-registration-upload',
  CONTACT_ENCRYPTION_KEY:'bc'.repeat(32),CONTACT_HASH_KEY:'de'.repeat(32),
  OBJECT_STORAGE_DRIVER:'api_gateway',WECHAT_APP_ID:'wx0000000000000001',WECHAT_APP_SECRET:'synthetic-registration-secret',
  UGC_SCAN_BASE_URL:'https://synthetic-scan.invalid'});
const consents=[{documentType:'privacy',version:'synthetic-registration-v1'},{documentType:'terms',version:'synthetic-registration-v1'}];
const avatar='data:image/jpeg;base64,'+jpeg.encode({data:Buffer.alloc(16*16*4,180),width:16,height:16},80).data.toString('base64');
let app:Awaited<ReturnType<typeof createApp>>,admin:any;
const headers=(sessionToken:string)=>({authorization:`Bearer ${sessionToken}`});
async function login(code:string,completeAccount=false){
  const r=await app.inject({method:'POST',url:'/v1/identity/wechat',payload:{code,displayName:'CISME 会员',consents,...(completeAccount?{completeAccount:true}:{})}});
  expect(r.statusCode,r.body).toBe(200);return r.json();
}
async function state(){return (await pool.query(`SELECT
  (SELECT count(*)::int FROM member) AS members,
  (SELECT count(*)::int FROM member_card_number) AS cards,
  (SELECT last_value::text FROM member_card_number_number_seq) AS last_number,
  (SELECT count(*)::int FROM points_grant) AS grants`)).rows[0];}
beforeAll(async()=>{
  await resetDatabase(pool);
  // The exact migrated fixture already enables the owner-approved V2 policy.
  const policy=(await pool.query("SELECT rules FROM member_points_policy WHERE state='active'")).rows[0];
  expect(policy.rules.taskVersion).toBe(2);expect(policy.rules.profile).toBe(50);
  for(const type of ['terms','privacy'])await pool.query(`INSERT INTO legal_document(document_type,version,title,body,operator_name,contact,active)
    VALUES($1,'synthetic-registration-v1','Synthetic only','Never publish this fixture','Synthetic','synthetic@example.invalid',true)`,[type]);
  app=await createApp({config,pool,storage:createApiGatewayStorage(config),wechatIdentityFetcher:async input=>
    new Response(JSON.stringify({openid:'synthetic-'+new URL(String(input)).searchParams.get('js_code')}))});
  admin=(await app.inject({method:'POST',url:'/v1/identity/dev',payload:{externalUserId:'registration-admin',displayName:'合成管理员',consents}})).json();
  for(const capability of ['member.profile.read','member.export'])await pool.query(`INSERT INTO authority_grant(member_id,capability,granted_by,grant_reason,environment,grant_source)
    VALUES($1,$2,'synthetic-registration','Synthetic registration test','test','integration_fixture')`,[admin.memberId,capability]);
});
afterAll(async()=>{try{await app?.close();}finally{await pool.end();}});

it('does not create a member, award points or consume a number while browsing anonymously',async()=>{
  const before=await state();
  for(let i=0;i<3;i++)for(const url of ['/v1/legal','/v1/capabilities','/v1/ugc/status','/v1/ugc/posts','/v1/catalog']){
    const r=await app.inject({url});expect(r.statusCode).not.toBe(500);
  }
  expect(await state()).toEqual(before);
  expect((await app.inject({url:'/v1/me'})).statusCode).toBe(401);
});

it('keeps an interrupted identity outside member lists, identifiers, rewards and business services',async()=>{
  const before=await state(),pending=await login('interrupted-registration');
  const me=(await app.inject({url:'/v1/me',headers:headers(pending.sessionToken)})).json();
  expect(me).toMatchObject({id:pending.memberId,registration_completed_at:null,card_number:null,user_code:null});
  expect(await state()).toMatchObject({members:before.members+1,cards:before.cards,last_number:before.last_number,grants:before.grants});
  for(const url of ['/v1/bootstrap/home','/v1/me/care-profile','/v1/me/orders','/v1/me/rewards','/v1/management/users']){
    const r=await app.inject({url,headers:headers(pending.sessionToken)});
    expect(r.statusCode,r.body).toBe(403);expect(r.json().code).toBe('MEMBER_REGISTRATION_REQUIRED');
  }
  const list=await app.inject({url:'/v1/management/users',headers:headers(admin.sessionToken)});
  expect(list.statusCode,list.body).toBe(200);expect(list.json().items.map((r:any)=>r.id)).not.toContain(pending.memberId);
  const exported=await app.inject({method:'POST',url:'/v1/management/users/export',headers:headers(admin.sessionToken),payload:{}});
  expect(exported.statusCode,exported.body).toBe(200);expect(exported.json().count).toBe(list.json().total);
  const again=await login('interrupted-registration');expect(again.memberId).toBe(pending.memberId);
  expect(await state()).toMatchObject({members:before.members+1,cards:before.cards,last_number:before.last_number,grants:before.grants});
});

it('requires both confirmed fields and commits one immutable membership despite retry or concurrent saves',async()=>{
  const pending=await login('confirmed-registration'),before=await state();
  for(const payload of [{displayName:'小雨',expectedVersion:0},{displayName:'CISME 会员',avatarDataUrl:avatar,expectedVersion:0}]){
    const r=await app.inject({method:'PUT',url:'/v1/me/profile',headers:headers(pending.sessionToken),payload});
    expect(r.statusCode,r.body).toBe(422);
  }
  expect(await state()).toEqual(before);
  const save=()=>app.inject({method:'PUT',url:'/v1/me/profile',headers:headers(pending.sessionToken),payload:{displayName:'小雨',avatarDataUrl:avatar,expectedVersion:0}});
  const results=await Promise.all([save(),save()]);expect(results.map(r=>r.statusCode).sort()).toEqual([200,409]);
  const profile=(await app.inject({url:'/v1/me/profile',headers:headers(pending.sessionToken)})).json();
  expect(profile).toMatchObject({id:pending.memberId,display_name:'小雨',profile_revision:1});
  expect(profile.card_number).toMatch(/^\d{5,}$/);expect(profile.user_code).toMatch(/^[A-Z0-9]{12}$/);
  expect(profile.registration_completed_at).toBeTruthy();expect(profile.avatar_data_url).toBeTruthy();
  expect(await state()).toMatchObject({members:before.members,cards:before.cards+1,last_number:String(BigInt(before.last_number)+1n),grants:before.grants});
  const again=await login('confirmed-registration');expect(again.memberId).toBe(pending.memberId);
  expect((await app.inject({url:'/v1/me',headers:headers(again.sessionToken)})).json()).toMatchObject({card_number:profile.card_number,user_code:profile.user_code,registration_completed_at:profile.registration_completed_at});
  expect((await app.inject({url:'/v1/bootstrap/home',headers:headers(again.sessionToken)})).statusCode).toBe(200);
  await processMemberPointSources(pool,new Date(Date.now()+2000),200);
  expect((await pool.query("SELECT 1 FROM points_grant WHERE member_id=$1 AND source_type='profile'",[pending.memberId])).rowCount).toBe(0);
  const club=(await app.inject({url:'/v1/me/points/club',headers:headers(again.sessionToken)})).json();
  expect(club.enabled).toBe(true);expect(club.tasks.length).toBeGreaterThan(5);
  expect(club.tasks.map((task:any)=>task.id)).not.toContain('profile');
  const list=(await app.inject({url:'/v1/management/users',headers:headers(admin.sessionToken)})).json();
  expect(list.items.find((r:any)=>r.id===pending.memberId)).toMatchObject({displayName:'小雨',avatar:profile.avatar_data_url});
  await expect(pool.query('UPDATE member SET registration_completed_at=NULL WHERE id=$1',[pending.memberId])).rejects.toThrow('MEMBER_REGISTRATION_IMMUTABLE');
});

it('keeps member-edited nickname and avatar authoritative across later WeChat logins',async()=>{
  const identity=await login('edited-profile'),h=headers(identity.sessionToken);
  const first=await app.inject({method:'PUT',url:'/v1/me/profile',headers:h,payload:{displayName:'原昵称',avatarDataUrl:avatar,expectedVersion:0}});
  expect(first.statusCode,first.body).toBe(200);
  const changedAvatar='data:image/jpeg;base64,'+jpeg.encode({data:Buffer.alloc(16*16*4,90),width:16,height:16},80).data.toString('base64');
  const update=await app.inject({method:'PUT',url:'/v1/me/profile',headers:h,payload:{displayName:'会员改后的昵称',avatarDataUrl:changedAvatar,expectedVersion:first.json().profile_revision}});
  expect(update.statusCode,update.body).toBe(200);const edited=update.json();
  const again=await login('edited-profile');expect(again.memberId).toBe(identity.memberId);
  const current=(await app.inject({url:'/v1/me/profile',headers:headers(again.sessionToken)})).json();
  expect(current).toMatchObject({display_name:'会员改后的昵称',avatar_data_url:edited.avatar_data_url,avatar_revision:edited.avatar_revision,profile_revision:edited.profile_revision,card_number:first.json().card_number,user_code:first.json().user_code,registration_completed_at:first.json().registration_completed_at});
});

it('binds a signed-in visitor to the sharing officer only after confirmed WeChat registration',async()=>{
  await pool.query(`INSERT INTO sharing_officer(member_id,referral_code,state)
    SELECT member_id,user_code,'active' FROM member_card_number WHERE member_id=$1`,[admin.memberId]);
  const share=await app.inject({method:'POST',url:'/v1/shares',headers:{...headers(admin.sessionToken),'idempotency-key':'confirmed-registration-share'},
    payload:{targetType:'invite',targetRef:'home'}});
  expect(share.statusCode,share.body).toBe(200);
  const {officerShareId}=share.json();
  const visit=await app.inject({method:'POST',url:`/v1/officer-shares/${officerShareId}/visits`,payload:{visitKey:'confirmed-registration-visit'}});
  expect(visit.statusCode,visit.body).toBe(200);
  const {visitToken}=visit.json();
  const buyer=await login('officer-linked-registration');
  const bind=()=>app.inject({method:'POST',url:'/v1/me/sharing-officer/commands',
    headers:{...headers(buyer.sessionToken),'idempotency-key':'confirmed-registration-bind'},payload:{action:'bind_visit',input:{visitToken}}});
  const blocked=await bind();
  expect(blocked.statusCode,blocked.body).toBe(403);
  expect(blocked.json().code).toBe('MEMBER_REGISTRATION_REQUIRED');
  const saved=await app.inject({method:'PUT',url:'/v1/me/profile',headers:headers(buyer.sessionToken),
    payload:{displayName:'合成推荐用户',avatarDataUrl:avatar,expectedVersion:0}});
  expect(saved.statusCode,saved.body).toBe(200);
  for(let i=0;i<2;i++){const bound=await bind();expect(bound.statusCode,bound.body).toBe(200);}
  const relation=(await pool.query('SELECT officer_id,source FROM sharing_customer_relation WHERE buyer_id=$1',[buyer.memberId])).rows;
  expect(relation).toEqual([{officer_id:admin.memberId,source:'first_touch'}]);
});

it('completes an explicit WeChat login once without collecting a profile or awarding registration points',async()=>{
  const before=await state(),pending=await login('store-first-identity');
  expect(await state()).toMatchObject({members:before.members+1,cards:before.cards,grants:before.grants});
  const deliveries=await Promise.all([login('store-first-identity',true),login('store-first-identity',true)]);
  expect(deliveries.map(value=>value.memberId)).toEqual([pending.memberId,pending.memberId]);
  expect(await state()).toMatchObject({members:before.members+1,cards:before.cards+1,grants:before.grants});
  const authenticated=headers(deliveries[0].sessionToken);
  const profile=(await app.inject({url:'/v1/me/profile',headers:authenticated})).json();
  expect(profile).toMatchObject({id:pending.memberId,avatar_data_url:null,completed_at:null,display_name:'CISME 会员'});
  expect(profile.card_number).toMatch(/^\d{5,}$/);expect(profile.registration_completed_at).toBeTruthy();
  for(const scope of ['home','profile','settings']){
    const bootstrap=await app.inject({url:`/v1/bootstrap/${scope}`,headers:authenticated});
    expect(bootstrap.statusCode,bootstrap.body).toBe(200);
    expect(bootstrap.json().member).toMatchObject({id:pending.memberId,registration_completed_at:profile.registration_completed_at,avatar_data_url:null});
  }
  const orders=await app.inject({url:'/v1/me/orders',headers:authenticated});
  expect(orders.statusCode,orders.body).toBe(200);expect(orders.json().items).toEqual([]);
  expect((await pool.query("SELECT 1 FROM member_contact WHERE member_id=$1",[pending.memberId])).rowCount).toBe(0);
});

it('lets a new member save a post before choosing a nickname and retains the same draft',async()=>{
  const before=await state(),identity=await login('store-new-member',true),h=headers(identity.sessionToken);
  expect(await state()).toMatchObject({members:before.members+1,cards:before.cards+1,grants:before.grants});
  const draft=await app.inject({method:'POST',url:'/v1/me/ugc/posts',headers:{...h,'idempotency-key':'store-new-draft'}});
  expect(draft.statusCode,draft.body).toBe(200);
  const {id,version}=draft.json();
  const url=`/v1/me/ugc/posts/${id}`;
  const saved=await app.inject({method:'PUT',url:`${url}/draft`,headers:h,payload:{expectedVersion:version,body:'合成护理草稿，保持私有。'}});
  expect(saved.statusCode,saved.body).toBe(200);
  const submit=()=>app.inject({method:'POST',url:`${url}/submit`,headers:h,payload:{expectedVersion:saved.json().version}});
  const noName=await submit();
  expect(noName.statusCode,noName.body).toBe(422);
  expect(noName.json().code).toBe('UGC_PROFILE_REQUIRED');
  const retained=await app.inject({url,headers:h});
  expect(retained.json()).toMatchObject({id,state:'draft',version:saved.json().version});
  const updated=await app.inject({method:'PUT',url:'/v1/me/profile',headers:h,payload:{displayName:'合成会员昵称',expectedVersion:0}});
  expect(updated.statusCode,updated.body).toBe(200);
  const nameSet=await submit();
  expect(nameSet.json().code).toBe('UGC_GO_LIVE_GATE_CLOSED');
});
