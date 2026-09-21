import { createCipheriv, createHmac, randomBytes } from 'node:crypto';
import type pg from 'pg';
import type { AppConfig } from '@cisme/config';
import { DomainError } from '@cisme/domain';
import { dependencySignal } from './operationBudget.js';
import {boundedWechatJson} from './boundedWechatJson.js';
import { transaction, type DbClient } from './db.js';
export class PhoneBinding {
 private accessToken: {value:string; expiresAt:number} | null=null;
 constructor(private pool:pg.Pool, private config:AppConfig, private fetcher:typeof fetch=fetch) {}
 enabled() { return Boolean(this.config.wechat.phoneBindingEnabled && this.config.wechat.appId && this.config.wechat.appSecret && /^[0-9a-f]{64}$/i.test(this.config.contacts.encryptionKey || '') && /^[0-9a-f]{64}$/i.test(this.config.contacts.hashKey || '')); }
 private async lockActiveMember(client:DbClient,memberId:string){
  const result=await client.query("SELECT id FROM member WHERE id=$1 AND status='active' FOR UPDATE",[memberId]);
  if(!result.rowCount)throw new DomainError('AUTH_REVOKED','会员账号不可用',401);
 }
 async status(memberId:string | undefined) {
  const result=await this.pool.query('SELECT phone_masked,bound_at FROM member_contact WHERE member_id=$1',[memberId]);
  return {enabled:this.enabled(),bound:Boolean(result.rows[0]),masked:result.rows[0]?.phone_masked || null};
 }
 private async token() {
  if(this.accessToken && this.accessToken.expiresAt>Date.now())return this.accessToken.value;
  const response=await this.fetcher('https://api.weixin.qq.com/cgi-bin/stable_token',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({grant_type:'client_credential',appid:this.config.wechat.appId,secret:this.config.wechat.appSecret}),signal:dependencySignal(15000),redirect:'error'});
  const result=await boundedWechatJson<{access_token?:string;expires_in?:number}>(response);
  if(typeof result.access_token!=='string' || !result.access_token || result.access_token.length>4096 || (result.expires_in!==undefined && (!Number.isFinite(result.expires_in)||result.expires_in<0||result.expires_in>7200)))throw new DomainError('WECHAT_PHONE_UNAVAILABLE','微信手机号服务暂不可用，请稍后重试',503);
  this.accessToken={value:result.access_token,expiresAt:Date.now()+Math.max(0,(result.expires_in || 7200)-120)*1000};return result.access_token;
 }
 async unbind(memberId:string | undefined) {
  if(!memberId)throw new DomainError('AUTH_REQUIRED','请先登录会员账号',401);
  await transaction(this.pool,async client=>{
   await this.lockActiveMember(client,memberId);
   const removed=await client.query('DELETE FROM member_contact WHERE member_id=$1',[memberId]);
   if(removed.rowCount)await client.query(`INSERT INTO audit_log(principal_id,action,object_type,object_id,reason_code,trace_id) VALUES($1,'member.phone_unbound','member',$2,'USER_PHONE_UNBIND',gen_random_uuid()::text)`,[`member:${memberId}`,memberId]);
  });
  return {bound:false,masked:null};
 }
 async bind(memberId:string | undefined, code:unknown) {
  if(!memberId)throw new DomainError('AUTH_REQUIRED','请先登录会员账号',401);
  if(!this.enabled())throw new DomainError('PHONE_BINDING_UNAVAILABLE','手机号绑定服务暂未配置',503);
  if(typeof code!=='string' || !code.trim() || code.length>512)throw new DomainError('PHONE_CODE_INVALID','请重新点击微信手机号授权',422);
  const encryptionKey=Buffer.from(this.config.contacts.encryptionKey!,'hex');
  const hashKey=Buffer.from(this.config.contacts.hashKey!,'hex');
  const codeHash=createHmac('sha256',hashKey).update('code:'+code).digest('hex');
  return transaction(this.pool,async client=>{
   await this.lockActiveMember(client,memberId);
   await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[codeHash]);
   const used=await client.query('SELECT member_id FROM phone_authorization WHERE code_hash=$1',[codeHash]);
   if(used.rows[0]){
    if(used.rows[0].member_id!==memberId)throw new DomainError('PHONE_CODE_USED','该手机号凭证已使用，请重新授权',409);
    const own=await client.query('SELECT phone_masked FROM member_contact WHERE member_id=$1',[memberId]);
    return {bound:Boolean(own.rows[0]),masked:own.rows[0]?.phone_masked || null};
   }
   const token=await this.token();
   const response=await this.fetcher(`https://api.weixin.qq.com/wxa/business/getuserphonenumber?access_token=${encodeURIComponent(token)}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code}),signal:dependencySignal(15000),redirect:'error'});
   const result=await boundedWechatJson<{errcode?:number;phone_info?:{purePhoneNumber?:string;countryCode?:string;watermark?:{appid?:string;timestamp?:number}}}>(response);
   const phone=result.phone_info;
   if(!response.ok || result.errcode!==0 || !phone || typeof phone.purePhoneNumber!=='string' || typeof phone.countryCode!=='string' || phone.watermark?.appid!==this.config.wechat.appId || !/^[0-9]{4,15}$/.test(phone.purePhoneNumber || '') || !/^[0-9]{1,4}$/.test(phone.countryCode || ''))throw new DomainError('PHONE_AUTHORIZATION_FAILED','手机号授权未完成，请重新点击授权按钮',422);
   const normalized=`+${phone.countryCode}${phone.purePhoneNumber}`;
   const phoneHash=createHmac('sha256',hashKey).update('phone:'+normalized).digest('hex');
   await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[phoneHash]);
   const other=await client.query('SELECT member_id FROM member_contact WHERE phone_hmac=$1',[phoneHash]);
   if(other.rows[0] && other.rows[0].member_id!==memberId)throw new DomainError('PHONE_ALREADY_BOUND','该手机号已关联其他会员，请联系客服核验，系统不会自动合并账号',409);
   const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',encryptionKey,iv);
   cipher.setAAD(Buffer.from(memberId));
   const encrypted=Buffer.concat([cipher.update(normalized,'utf8'),cipher.final()]);
   const packed=Buffer.concat([iv,cipher.getAuthTag(),encrypted]).toString('base64');
   const masked=`***${phone.purePhoneNumber!.slice(-4)}`;
   await client.query(`INSERT INTO member_contact(member_id,phone_encrypted,phone_hmac,phone_masked,key_version) VALUES($1,$2,$3,$4,$5) ON CONFLICT(member_id) DO UPDATE SET phone_encrypted=$2,phone_hmac=$3,phone_masked=$4,key_version=$5,bound_at=now()`,[memberId,packed,phoneHash,masked,this.config.contacts.keyVersion]);
   await client.query('INSERT INTO phone_authorization(code_hash,member_id) VALUES($1,$2)',[codeHash,memberId]);
   await client.query(`INSERT INTO audit_log(principal_id,action,object_type,object_id,reason_code,trace_id) VALUES($1,'member.phone_bound','member',$2,'USER_WECHAT_PHONE_AUTHORIZATION',gen_random_uuid()::text)`,[`member:${memberId}`,memberId]);
   return {bound:true,masked};
  },'READ COMMITTED',1);
 }
}
