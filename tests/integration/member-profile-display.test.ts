import { afterAll, beforeAll, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import jpeg from 'jpeg-js';
import { loadConfig } from '@cisme/config';
import { TEST_DATABASE_URL, resetDatabase, testPool } from '@cisme/testkit';
import { createApp } from '../../services/api/src/server';
import { createApiGatewayStorage } from '../../services/api/src/storage';
import { communityAuthors } from '../../services/api/src/memberProfile';

const pool=testPool();
const config=loadConfig({APP_ENV:'test',DATABASE_URL:TEST_DATABASE_URL,APP_SESSION_SECRET:'profile-display-test',ADMIN_API_TOKEN:'profile-display-admin',UPLOAD_TOKEN_SECRET:'profile-display-upload',OBJECT_STORAGE_DRIVER:'api_gateway'});
const encoded=jpeg.encode({data:Buffer.alloc(16*16*4,190),width:16,height:16,comments:['PRIVATE-EXIF-LIKE-COMMENT']},80).data;
const avatar=`data:image/jpeg;base64,${encoded.toString('base64')}`;
let app:FastifyInstance;
let owner:any, reviewer:any, other:any;
const headers=(token:string)=>({authorization:`Bearer ${token}`});
const save=(payload:Record<string,unknown>)=>app.inject({method:'PUT',url:'/v1/me/profile',headers:headers(owner.sessionToken),payload});
const review=(token:string,payload:Record<string,unknown>)=>app.inject({method:'POST',url:`/v1/team/member-profiles/${owner.memberId}/review`,headers:headers(token),payload});
beforeAll(async()=>{
 await resetDatabase(pool); app=await createApp({config,pool,storage:createApiGatewayStorage(config)});
 const identity=async(id:string)=>(await app.inject({method:'POST',url:'/v1/identity/dev',payload:{externalUserId:id,displayName:id,consents:[{documentType:'privacy',version:'v1'},{documentType:'terms',version:'v1'}]}})).json();
 owner=await identity('profile-owner');reviewer=await identity('profile-reviewer');other=await identity('profile-other');
 await pool.query("INSERT INTO authority_grant(member_id,capability,granted_by,grant_reason,environment,grant_source) VALUES($1,'community.moderate','test-owner','Member profile moderation fixture','test','integration_fixture')",[reviewer.memberId]);
});
afterAll(async()=>{await app.close();await pool.end();});

it('saves canonical private member data and never exposes it before community approval',async()=>{
 expect((await app.inject({method:'GET',url:'/v1/me/profile'})).statusCode).toBe(401);
 const response=await save({displayName:'护理伙伴',wechatHandle:'private_handle',avatarDataUrl:avatar,communityVisible:true,expectedVersion:0,public_status:'approved'});
 expect(response.statusCode).toBe(200);
 const result=response.json();
 expect(result).toMatchObject({display_name:'护理伙伴',profile_revision:1,public_status:'pending',community_visible:true,handle_source:'self_reported'});
 const normalized=jpeg.decode(Buffer.from(result.avatar_data_url.slice(23),'base64'));
 expect([normalized.width,normalized.height]).toEqual([128,128]);
 expect(Buffer.from(result.avatar_data_url.slice(23),'base64').includes(Buffer.from('PRIVATE-EXIF-LIKE-COMMENT'))).toBe(false);
 expect(result.avatar_data_url.length).toBeLessThan(22000);
 const publicAuthors=await communityAuthors(pool,[owner.memberId]);
 expect(publicAuthors[owner.memberId]).toMatchObject({name:'CISME 会员',avatar:''});
 expect(JSON.stringify(publicAuthors)).not.toContain('private_handle');
 expect((await app.inject({method:'GET',url:'/v1/me',headers:headers(owner.sessionToken)})).json()).toMatchObject({display_name:'护理伙伴',avatar_revision:result.avatar_revision});
 const otherProfile=(await app.inject({method:'GET',url:'/v1/me/profile',headers:headers(other.sessionToken)})).json();
 expect(otherProfile.avatar_data_url).toBeNull();expect(otherProfile.wechat_handle).toBeNull();
});

it('requires independent authorized review of the exact current profile revision',async()=>{
 const command={decision:'approve',expectedVersion:1,reason:'已核验头像昵称'};
 expect((await review(other.sessionToken,command)).statusCode).toBe(403);
 expect((await review(owner.sessionToken,command)).statusCode).toBe(403);
 expect((await review(reviewer.sessionToken,{...command,expectedVersion:0})).statusCode).toBe(409);
 const queue=(await app.inject({method:'GET',url:'/v1/team/member-profiles',headers:headers(reviewer.sessionToken)})).json();
 expect(queue).toHaveLength(1);expect(JSON.stringify(queue)).not.toContain('private_handle');
 expect((await review(reviewer.sessionToken,command)).statusCode).toBe(200);
 const authors=await communityAuthors(pool,[owner.memberId]);
 expect(authors[owner.memberId]?.name).toBe('护理伙伴');expect(authors[owner.memberId]?.avatar).toMatch(/^data:image\/jpeg;base64,/);
});

it('keeps a stable login identity and rejects stale concurrent profile edits',async()=>{
 const login=(await app.inject({method:'POST',url:'/v1/identity/dev',payload:{externalUserId:'profile-owner',displayName:'old-client-value',consents:[{documentType:'privacy',version:'v1'},{documentType:'terms',version:'v1'}]}})).json();
 expect(login.memberId).toBe(owner.memberId);
 expect((await app.inject({method:'GET',url:'/v1/me',headers:headers(owner.sessionToken)})).json().display_name).toBe('护理伙伴');
 const commands=await Promise.all([save({displayName:'新昵称一',expectedVersion:1}),save({displayName:'新昵称二',expectedVersion:1})]);
 expect(commands.map(r=>r.statusCode).sort()).toEqual([200,409]);
 const current=(await app.inject({method:'GET',url:'/v1/me/profile',headers:headers(owner.sessionToken)})).json();
 expect(current.wechat_handle).toBe('private_handle');expect(current.public_status).toBe('pending');
 expect((await communityAuthors(pool,[owner.memberId]))[owner.memberId]?.avatar).toBe('');
});

it('removes public identity immediately on withdrawal and removes the avatar atomically',async()=>{
 const result=await save({displayName:'仅本人可见',communityVisible:false,avatarDataUrl:null,expectedVersion:2});
 expect(result.statusCode).toBe(200);expect(result.json()).toMatchObject({avatar_data_url:null,avatar_revision:null,public_status:'private',profile_revision:3});
 expect((await communityAuthors(pool,[owner.memberId]))[owner.memberId]).toMatchObject({name:'CISME 会员',avatar:''});
 expect((await review(reviewer.sessionToken,{decision:'approve',expectedVersion:2,reason:'过期审核'})).statusCode).toBe(409);
});

it('rejects arbitrary URLs, invalid images and forged visibility values without altering saved data',async()=>{
 for(const avatarDataUrl of ['https://example.invalid/private.jpg','wxfile://tmp/avatar.jpg','data:image/jpeg;base64,YWJjZA==','data:image/svg+xml;base64,PHN2Zz4=']) {
  expect((await save({displayName:'破坏性输入',avatarDataUrl,expectedVersion:3})).statusCode).toBe(422);
 }
 expect((await save({displayName:'合法昵称',communityVisible:'true',expectedVersion:3})).statusCode).toBe(422);
 expect((await save({displayName:'带\u202e控制字符',expectedVersion:3})).statusCode).toBe(422);
 expect((await app.inject({method:'GET',url:'/v1/me/profile',headers:headers(owner.sessionToken)})).json()).toMatchObject({display_name:'仅本人可见',profile_revision:3});
});

it('keeps phone data private and supports unbinding even while phone authorization is disabled',async()=>{
 await pool.query("INSERT INTO member_contact(member_id,phone_encrypted,phone_hmac,phone_masked,key_version) VALUES($1,'private-phone-ciphertext',$2,'***5432','test')",[owner.memberId,'f'.repeat(64)]);
 const publicData=JSON.stringify(await communityAuthors(pool,[owner.memberId]));
 expect(publicData).not.toContain('5432');expect(publicData).not.toContain('private-phone');
 expect((await app.inject({method:'DELETE',url:'/v1/me/phone'})).statusCode).toBe(401);
 await app.inject({method:'DELETE',url:'/v1/me/phone',headers:headers(other.sessionToken)});
 expect((await pool.query('SELECT 1 FROM member_contact WHERE member_id=$1',[owner.memberId])).rowCount).toBe(1);
 const deleted=await app.inject({method:'DELETE',url:'/v1/me/phone',headers:headers(owner.sessionToken)});
 expect(deleted.statusCode).toBe(200);expect(deleted.json()).toEqual({bound:false,masked:null});
 expect((await app.inject({method:'DELETE',url:'/v1/me/phone',headers:headers(owner.sessionToken)})).statusCode).toBe(200);
 expect((await pool.query('SELECT 1 FROM member_contact WHERE member_id=$1',[owner.memberId])).rowCount).toBe(0);
 expect((await app.inject({method:'GET',url:'/v1/me/profile',headers:headers(owner.sessionToken)})).json()).toMatchObject({display_name:'仅本人可见',profile_revision:3});
});

it('stops public projection and review access after member or team revocation',async()=>{
 await pool.query("UPDATE authority_grant SET revoked_at=now(),revoked_by='test-owner',revoke_reason='Immediate revocation fixture' WHERE member_id=$1 AND capability='community.moderate'",[reviewer.memberId]);
 expect((await app.inject({method:'GET',url:'/v1/team/member-profiles',headers:headers(reviewer.sessionToken)})).statusCode).toBe(403);
 await pool.query("UPDATE member SET status='blocked' WHERE id=$1",[owner.memberId]);
 expect(await communityAuthors(pool,[owner.memberId])).toEqual({});
 expect((await app.inject({method:'PUT',url:'/v1/me/profile',headers:headers(owner.sessionToken),payload:{displayName:'新名称',expectedVersion:3}})).statusCode).toBe(401);
});

it('publishes only native login capability switches without authentication or account data',async()=>{
 const response=await app.inject({method:'GET',url:'/v1/identity/capabilities'});
 expect(response.statusCode).toBe(200);
 expect(response.json()).toEqual({phoneBindingEnabled:false,avatarSelection:'chooseAvatar'});
});
