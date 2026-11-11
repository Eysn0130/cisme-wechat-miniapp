import {createCipheriv,createDecipheriv,randomBytes} from 'node:crypto';
import {DomainError} from '@cisme/domain';
import type {AppConfig} from '@cisme/config';
import type {DbClient} from './db.js';

function key(config:AppConfig){
  if(!/^[a-f0-9]{64}$/i.test(config.contacts.encryptionKey??''))throw new DomainError('CARE_PROFILE_STORAGE_UNAVAILABLE','护理档案安全存储暂不可用',503);
  return Buffer.from(config.contacts.encryptionKey!,'hex');
}
export function sealPrivateCarePayload(config:AppConfig,memberId:string,payload:unknown){
  const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key(config),iv);cipher.setAAD(Buffer.from(`care-profile:${memberId}`));
  const data=Buffer.concat([cipher.update(JSON.stringify(payload),'utf8'),cipher.final()]);
  return Buffer.concat([iv,cipher.getAuthTag(),data]).toString('base64');
}
export function openPrivateCarePayload(config:AppConfig,row:{member_id:string;answers_encrypted:string;key_version:string|null}):any {
  if(row.key_version!==config.contacts.keyVersion)throw new DomainError('CARE_PROFILE_KEY_UNAVAILABLE','护理档案暂无法安全读取',503);
  try{
    const bytes=Buffer.from(row.answers_encrypted,'base64'),decipher=createDecipheriv('aes-256-gcm',key(config),bytes.subarray(0,12));
    decipher.setAAD(Buffer.from(`care-profile:${row.member_id}`));decipher.setAuthTag(bytes.subarray(12,28));
    return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)),decipher.final()]).toString('utf8'));
  }catch(error){if(error instanceof DomainError)throw error;throw new DomainError('CARE_PROFILE_UNREADABLE','护理档案暂无法安全读取',503);}
}
/** External account edits supersede an unfinished registration birthday. A
 * version fence stops an old questionnaire tab from restoring deleted data. */
export async function discardRegistrationBirthday(client:DbClient,config:AppConfig|undefined,memberId:string,now:Date){
  const row=(await client.query('SELECT member_id,answers_encrypted,key_version FROM member_care_profile WHERE member_id=$1 FOR UPDATE',[memberId])).rows[0];
  if(!row?.answers_encrypted)return;
  if(!config)throw new DomainError('CARE_PROFILE_STORAGE_UNAVAILABLE','资料安全存储暂不可用',503);
  const payload=openPrivateCarePayload(config,row);
  if(payload?.format!=='care-registration-v1')return;
  await client.query(`UPDATE member_care_profile SET answers_encrypted=$2,key_version=$3,version=version+1,
    latest_operation_id=NULL,updated_at=$4 WHERE member_id=$1`,
    [memberId,sealPrivateCarePayload(config,memberId,payload.answers),config.contacts.keyVersion,now]);
}
