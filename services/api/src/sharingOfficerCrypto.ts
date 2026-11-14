import {createCipheriv,createDecipheriv,randomBytes} from 'node:crypto';
import type {AppConfig} from '@cisme/config';
import {sharingFail as fail} from './sharingOfficerPolicy.js';
export function sealSharingPayload(config:AppConfig,value:unknown,scope:string){
 const key=config.contacts.encryptionKey;if(!key||!/^[0-9a-f]{64}$/i.test(key))fail('SHARING_ENCRYPTION_UNAVAILABLE','资料服务暂不可用',503);
 const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',Buffer.from(key,'hex'),iv);cipher.setAAD(Buffer.from(scope));
 const body=Buffer.concat([cipher.update(JSON.stringify(value),'utf8'),cipher.final()]);
 return [Buffer.from(config.contacts.keyVersion),iv,cipher.getAuthTag(),body].map(b=>b.toString('base64url')).join('.');
}
export function openSharingPayload(config:AppConfig,value:string,scope:string):Record<string,any>{
 const parts=value.split('.');if(parts.length!==4)fail('SHARING_PAYEE_UNREADABLE','资料需重新核对',503);
 if(Buffer.from(parts[0]!,'base64url').toString('utf8')!==config.contacts.keyVersion)fail('SHARING_KEY_VERSION_UNAVAILABLE','资料加密版本需由公司核对',503);
 try{const cipher=createDecipheriv('aes-256-gcm',Buffer.from(config.contacts.encryptionKey!,'hex'),Buffer.from(parts[1]!,'base64url'));
  cipher.setAAD(Buffer.from(scope));cipher.setAuthTag(Buffer.from(parts[2]!,'base64url'));
  return JSON.parse(Buffer.concat([cipher.update(Buffer.from(parts[3]!,'base64url')),cipher.final()]).toString('utf8'));
 }catch{fail('SHARING_PAYEE_UNREADABLE','资料需重新核对',503);}
}
