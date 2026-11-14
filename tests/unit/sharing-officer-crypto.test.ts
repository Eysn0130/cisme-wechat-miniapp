import {it,expect} from 'vitest';
import {randomBytes} from 'node:crypto';
import {loadConfig} from '@cisme/config';
import {sealSharingPayload,openSharingPayload,sharingCommandDigest} from '../../services/api/src/sharingOfficerCrypto';
const config=loadConfig({APP_ENV:'test',DATABASE_URL:'postgres://unused',APP_SESSION_SECRET:'sharing-session',ADMIN_API_TOKEN:'sharing-admin',UPLOAD_TOKEN_SECRET:'sharing-upload',CONTACT_ENCRYPTION_KEY:randomBytes(32).toString('hex'),CONTACT_KEY_VERSION:'sharing-key-v1'});
it('binds encrypted settlement information to its canonical member and key version',()=>{
 const payload={legalName:'合成收款人',account:'SYNTHETIC-ACCOUNT'},sealed=sealSharingPayload(config,payload,'sharing-payee:owner-a');
 expect(sealed).not.toContain(payload.account);expect(openSharingPayload(config,sealed,'sharing-payee:owner-a')).toEqual(payload);
 expect(()=>openSharingPayload(config,sealed,'sharing-payee:owner-b')).toThrow();
 expect(()=>openSharingPayload({...config,contacts:{...config.contacts,keyVersion:'sharing-key-v2'}},sealed,'sharing-payee:owner-a')).toThrow('资料加密版本');
 const broken=sealed.slice(0,-2)+'AA';expect(()=>openSharingPayload(config,broken,'sharing-payee:owner-a')).toThrow();
 expect(sealSharingPayload(config,payload,'sharing-payee:owner-a')).not.toBe(sealed);
});
it('rejects invalid WeChat code environment settings instead of silently selecting another release',()=>{
 expect(()=>loadConfig({APP_ENV:'test',DATABASE_URL:'postgres://unused',APP_SESSION_SECRET:'sharing-session',ADMIN_API_TOKEN:'sharing-admin',UPLOAD_TOKEN_SECRET:'sharing-upload',WECHAT_SHARE_ENV_VERSION:'development'})).toThrow('CONFIG_INVALID:WECHAT_SHARE_ENV_VERSION');
});
it('uses a purpose-bound keyed digest for private command data',()=>{
 const payload={account:'SYNTHETIC-ACCOUNT',legalName:'合成收款人'},digest=sharingCommandDigest(config,payload);
 expect(digest).toMatch(/^[a-f0-9]{64}$/);expect(sharingCommandDigest(config,payload)).toBe(digest);
 expect(sharingCommandDigest({...config,contacts:{...config.contacts,hashKey:randomBytes(32).toString('hex')}},payload)).not.toBe(digest);
});
