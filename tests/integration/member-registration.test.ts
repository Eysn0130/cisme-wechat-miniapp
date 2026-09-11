import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { loadConfig } from '@cisme/config';
import { TEST_DATABASE_URL, resetDatabase, testPool } from '@cisme/testkit';
import { PhoneBinding } from '../../services/api/src/phoneBinding';
import { PlatformService } from '../../services/api/src/platformService';
import { createApiGatewayStorage } from '../../services/api/src/storage';
const pool=testPool();
const config=loadConfig({APP_ENV:'test',DATABASE_URL:TEST_DATABASE_URL,APP_SESSION_SECRET:'registration-test',ADMIN_API_TOKEN:'registration-admin',UPLOAD_TOKEN_SECRET:'registration-upload',OBJECT_STORAGE_DRIVER:'api_gateway',WECHAT_APP_ID:'wx0000000000000001',WECHAT_APP_SECRET:'test-secret',WECHAT_PHONE_BINDING_ENABLED:'true',CONTACT_ENCRYPTION_KEY:'ab'.repeat(32),CONTACT_HASH_KEY:'cd'.repeat(32)});
const service=new PlatformService(pool,config,createApiGatewayStorage(config));
const exchange=vi.fn<typeof fetch>();const phone=new PhoneBinding(pool,config,exchange);
let memberId:string, otherId:string;
const consents=[{documentType:'privacy',version:'published-1'},{documentType:'terms',version:'published-1'}];
beforeAll(async()=>{await resetDatabase(pool);});
afterAll(async()=>{await pool.end();});
it('keeps phone authorization closed until the platform capability is explicitly enabled',async()=>{
 const disabled=new PhoneBinding(pool,{...config,wechat:{...config.wechat,phoneBindingEnabled:false}},exchange);
 expect(disabled.enabled()).toBe(false);
 await expect(disabled.bind('member-not-created','unused-code')).rejects.toMatchObject({code:'PHONE_BINDING_UNAVAILABLE'});
 expect(exchange).not.toHaveBeenCalled();
});
it('allows ordinary self-registration without internal enrollment, but requires current published consent',async()=>{
 const input={provider:'wechat_miniprogram' as const,appId:config.wechat.appId!,openid:'test-wechat-owner',displayName:'test user',adapter:'wechat' as const,consents};
 await expect(service.identity(input,new Date())).rejects.toMatchObject({code:'LEGAL_VERSION_REQUIRED'});
 expect((await pool.query('SELECT 1 FROM member')).rowCount).toBe(0);
 for(const type of ['terms','privacy'])await pool.query("INSERT INTO legal_document(document_type,version,title,body,operator_name,contact,active) VALUES($1,'published-1','Test only legal text','Test fixture, never publish','Test operator','test@example.invalid',true)",[type]);
 const first=await service.identity(input,new Date());memberId=first.memberId;
 expect((await service.identity(input,new Date())).memberId).toBe(memberId);
 otherId=(await service.identity({...input,openid:'test-wechat-other'},new Date())).memberId;
 expect((await pool.query('SELECT 1 FROM member_team_access')).rowCount).toBe(0);
 expect((await pool.query('SELECT 1 FROM member_contact')).rowCount).toBe(0);
 expect((await pool.query('SELECT 1 FROM points_entry')).rowCount).toBe(0);
 await expect(service.identity({...input,consents:[{documentType:'privacy',version:'old'},{documentType:'terms',version:'old'}]},new Date())).rejects.toMatchObject({code:'LEGAL_VERSION_REQUIRED'});
});
it('encrypts phone, consumes an authorization once and isolates member access',async()=>{
 exchange.mockResolvedValueOnce(new Response(JSON.stringify({access_token:'test-token',expires_in:7200}))).mockResolvedValueOnce(new Response(JSON.stringify({errcode:0,phone_info:{purePhoneNumber:'13800000001',countryCode:'86',watermark:{appid:config.wechat.appId}}})));
 expect(await phone.bind(memberId,'one-time-phone-code')).toEqual({bound:true,masked:'***0001'});
 expect(await phone.bind(memberId,'one-time-phone-code')).toEqual({bound:true,masked:'***0001'});
 expect(exchange).toHaveBeenCalledTimes(2);
 const row=(await pool.query('SELECT * FROM member_contact WHERE member_id=$1',[memberId])).rows[0];
 expect(JSON.stringify(row)).not.toContain('13800000001');expect(row.phone_hmac).toHaveLength(64);
 await expect(phone.bind(otherId,'one-time-phone-code')).rejects.toMatchObject({code:'PHONE_CODE_USED'});
 expect(await phone.status(otherId)).toMatchObject({bound:false,masked:null});
 exchange.mockResolvedValueOnce(new Response(JSON.stringify({errcode:0,phone_info:{purePhoneNumber:'13800000001',countryCode:'86',watermark:{appid:config.wechat.appId}}})));
 await expect(phone.bind(otherId,'another-code')).rejects.toMatchObject({code:'PHONE_ALREADY_BOUND'});
 expect((await pool.query('SELECT 1 FROM member')).rowCount).toBe(2);
});
it('rejects another app phone watermark without binding or leaking the number',async()=>{
 exchange.mockResolvedValueOnce(new Response(JSON.stringify({errcode:0,phone_info:{purePhoneNumber:'13800000002',countryCode:'86',watermark:{appid:'wx-another'}}})));
 await expect(phone.bind(otherId,'wrong-app-code')).rejects.toMatchObject({code:'PHONE_AUTHORIZATION_FAILED'});
 expect(await phone.status(otherId)).toMatchObject({bound:false});
});
it('stores a self-reported contact handle without changing authentication or team permissions',async()=>{
 const {MemberProfile}=await import('../../services/api/src/memberProfile');
 const profiles=new MemberProfile(pool);
 await profiles.update(memberId,{displayName:'会员甲',wechatHandle:'member_alpha'});
 expect(await profiles.get(memberId)).toMatchObject({display_name:'会员甲',wechat_handle:'member_alpha',handle_source:'self_reported'});
 expect((await profiles.get(otherId)).wechat_handle).toBeNull();
 expect((await pool.query('SELECT 1 FROM member_team_access')).rowCount).toBe(0);
 await expect(profiles.update(memberId,{displayName:'甲',wechatHandle:'bad handle'})).rejects.toMatchObject({code:'MEMBER_PROFILE_INVALID'});
 await expect(profiles.get(undefined)).rejects.toMatchObject({code:'AUTH_REQUIRED'});
 expect((await pool.query('SELECT openid FROM wechat_identity WHERE member_id=$1',[memberId])).rows[0].openid).toBe('test-wechat-owner');
});

it('binds the new number selected in WeChat to the same member, retaining no old contact row',async()=>{
 exchange.mockResolvedValueOnce(new Response(JSON.stringify({errcode:0,phone_info:{purePhoneNumber:'13900000003',countryCode:'86',watermark:{appid:config.wechat.appId}}})));
 expect(await phone.bind(memberId,'new-selected-phone-code')).toEqual({bound:true,masked:'***0003'});
 const rows=(await pool.query('SELECT phone_masked,phone_encrypted FROM member_contact WHERE member_id=$1',[memberId])).rows;
 expect(rows).toHaveLength(1);expect(rows[0].phone_masked).toBe('***0003');
 expect(JSON.stringify(rows)).not.toContain('13900000003');
 expect((await pool.query('SELECT 1 FROM member')).rowCount).toBe(2);
});
