import { createHash, randomUUID } from 'node:crypto';
import { lstat, open, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type pg from 'pg';
import { DomainError } from '@cisme/domain';
import { transaction, type DbClient } from './db.js';

export type Marker={version:1;memberId:string;identityDigest:string;requestId:string;createdAt:string};
export interface SuppressionRemote {
  put(marker:Marker):Promise<void>;
  list():Promise<Marker[]>;
}
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const digest=/^[0-9a-f]{64}$/;

/** This directory must live outside database backups and release directories. */
export class AccountClosure {
  constructor(private readonly directory:string|null,private readonly remote?:SuppressionRemote) {}

  private path(memberId:string) {if(!uuid.test(memberId))throw new Error('ACCOUNT_CLOSURE_MARKER_INVALID');return join(this.directory!,`${memberId}.json`);}
  static identityDigest(provider:string,appId:string,openid:string) {
    return createHash('sha256').update(JSON.stringify([provider,appId,openid])).digest('hex');
  }
  private async requireDirectory() {
    if(!this.directory)throw new DomainError('ACCOUNT_CLOSURE_UNAVAILABLE','注销服务暂不可用，请稍后重试',503);
    const info=await lstat(this.directory);
    const uid=process.getuid?.();
    if(!info.isDirectory()||(info.mode&0o077)!==0||(uid!==undefined&&info.uid!==uid))
      throw new Error('ACCOUNT_CLOSURE_DIRECTORY_UNSAFE');
  }
  async assertReady() {if(this.directory)await this.requireDirectory();}
  private valid(row:Marker,memberId:string) {
    if(row.version!==1||row.memberId!==memberId||!digest.test(row.identityDigest)||!uuid.test(row.requestId)||!Number.isFinite(Date.parse(row.createdAt)))
      throw new Error('ACCOUNT_CLOSURE_MARKER_INVALID');
    return row;
  }
  private async marker(memberId:string):Promise<Marker|null> {
    if(!this.directory)return null;
    await this.requireDirectory();
    try {
      const row=JSON.parse(await readFile(this.path(memberId),'utf8')) as Marker;
      return this.valid(row,memberId);
    }catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error;}
  }
  async hasMember(memberId:string) {return Boolean(await this.marker(memberId));}
  async hasIdentity(provider:string,appId:string,openid:string) {
    if(!this.directory)return false;
    await this.requireDirectory();
    const wanted=AccountClosure.identityDigest(provider,appId,openid);
    for(const filename of await readdir(this.directory)){
      if(!uuid.test(filename.slice(0,-5))||!filename.endsWith('.json'))throw new Error('ACCOUNT_CLOSURE_DIRECTORY_UNEXPECTED_FILE');
      if((await this.marker(filename.slice(0,-5)))?.identityDigest===wanted)return true;
    }
    return false;
  }
  async record(memberId:string,identityDigest:string,requestId:string) {
    await this.requireDirectory();
    const old=await this.marker(memberId);
    if(old&&old.identityDigest!==identityDigest)throw new Error('ACCOUNT_CLOSURE_IDENTITY_MISMATCH');
    let row=old??this.valid({version:1,memberId,identityDigest,requestId,createdAt:new Date().toISOString()},memberId);
    if(!old){try{await this.writeLocal(row);}catch(error){
      const concurrent=await this.marker(memberId);
      if(!concurrent||concurrent.identityDigest!==identityDigest)throw error;
      row=concurrent;
    }}
    // Success is returned only after the independent copy is verified.
    try{await this.remote?.put(row);}catch{throw new DomainError('ACCOUNT_CLOSURE_PENDING','注销结果暂未确认，请稍后重试',503);}
    return row;
  }
  private async writeLocal(row:Marker) {
    const old=await this.marker(row.memberId);
    if(old){if(JSON.stringify(old)!==JSON.stringify(row))throw new Error('ACCOUNT_CLOSURE_MARKER_MISMATCH');return;}
    let handle;
    try{handle=await open(this.path(row.memberId),'wx',0o600);}catch(error){
      if((error as NodeJS.ErrnoException).code==='EEXIST'){
        const concurrent=await this.marker(row.memberId);
        if(concurrent&&JSON.stringify(concurrent)===JSON.stringify(row))return;
      }
      throw error;
    }
    try{await handle.writeFile(JSON.stringify(row));await handle.sync();}finally{await handle.close();}
    const dir=await open(this.directory!,'r');try{await dir.sync();}finally{await dir.close();}
  }
  async replay(pool:pg.Pool) {
    if(!this.directory)return;
    await this.requireDirectory();
    if(this.remote){
      for(const row of await this.remote.list()){
        this.valid(row,row.memberId);
        await this.writeLocal(row);
      }
    }
    for(const filename of await readdir(this.directory)){
      if(!filename.endsWith('.json')||!uuid.test(filename.slice(0,-5)))throw new Error('ACCOUNT_CLOSURE_DIRECTORY_UNEXPECTED_FILE');
      const row=await this.marker(filename.slice(0,-5));
      if(!row)throw new Error('ACCOUNT_CLOSURE_MARKER_MISSING');
      await this.remote?.put(row);
      await transaction(pool,client=>applyAccountClosure(client,row));
    }
  }
  async replayMember(pool:pg.Pool,memberId:string) {
    const row=await this.marker(memberId);
    if(!row)return null;
    try{await this.remote?.put(row);}catch{throw new DomainError('ACCOUNT_CLOSURE_PENDING','注销处理中，请稍后重试',503);}
    return transaction(pool,client=>applyAccountClosure(client,row));
  }
}

export async function applyAccountClosure(client:DbClient,marker:Marker) {
  const member=(await client.query<{status:string}>('SELECT status FROM member WHERE id=$1 FOR UPDATE',[marker.memberId])).rows[0];
  // A restored snapshot may predate the original registration. The external
  // identity digest still blocks a fresh account, so no database row is needed.
  if(!member)return {id:marker.requestId,kind:'close_account',status:'suppressed_without_member',accountClosed:true};
  const identity=(await client.query<{provider:string;app_id:string;openid:string}>(
    'SELECT provider,app_id,openid FROM wechat_identity WHERE member_id=$1 FOR UPDATE',[marker.memberId])).rows[0];
  if(!identity||AccountClosure.identityDigest(identity.provider,identity.app_id,identity.openid)!==marker.identityDigest)
    throw new Error('ACCOUNT_CLOSURE_IDENTITY_MISMATCH');
  await client.query(`INSERT INTO privacy_request(id,member_id,kind,message,due_at)
    VALUES($1,$2,'close_account','本人申请注销 CISME 账号',now()+interval '30 days') ON CONFLICT(id) DO NOTHING`,[marker.requestId,marker.memberId]);
  const request=(await client.query<{member_id:string;kind:string;status:string}>(
    'SELECT member_id,kind,status FROM privacy_request WHERE id=$1 FOR UPDATE',[marker.requestId])).rows[0];
  if(!request||request.member_id!==marker.memberId||request.kind!=='close_account')throw new Error('ACCOUNT_CLOSURE_REQUEST_MISMATCH');
  // Keep financial, order, refund, aftersale and their support evidence intact.
  const held=Boolean((await client.query(`SELECT 1 FROM legal_hold_binding b JOIN legal_hold h ON h.id=b.hold_id
    WHERE h.status='active' AND h.expires_at>now() AND
      ((b.object_type IN ('member','member_profile','member_contact') AND b.object_id=$1)
       OR (b.object_type='member_delivery_address' AND b.object_id IN
          (SELECT id::text FROM member_delivery_address WHERE member_id=$2))) LIMIT 1`,
    [marker.memberId,marker.memberId])).rowCount);
  await client.query("UPDATE member SET status='deleted',display_name=CASE WHEN $2::boolean THEN display_name ELSE '已注销用户' END WHERE id=$1",
    [marker.memberId,held]);
  if(!held){
    await client.query('UPDATE wechat_identity SET unionid=NULL WHERE member_id=$1',[marker.memberId]);
    await client.query('DELETE FROM member_contact WHERE member_id=$1',[marker.memberId]);
    await client.query('DELETE FROM phone_authorization WHERE member_id=$1',[marker.memberId]);
    await client.query('DELETE FROM member_profile WHERE member_id=$1',[marker.memberId]);
    await client.query(`UPDATE member_delivery_address SET encrypted_payload='',payload_hmac=encode(digest(id::text,'sha256'),'hex'),
      key_version='erased',is_default=false,deleted_at=COALESCE(deleted_at,now()),updated_at=now()
      WHERE member_id=$1 AND key_version<>'erased'`,[marker.memberId]);
  }
  const previousMembership=(await client.query<{state:string}>(
    'SELECT state FROM commercial_membership WHERE member_id=$1 FOR UPDATE',[marker.memberId])).rows[0];
  const membership=(await client.query<{version:number;effective_at:Date;expires_at:Date|null}>(
    "UPDATE commercial_membership SET state='expired',version=version+1,changed_by=$2,change_reason='本人注销账号',updated_at=now() WHERE member_id=$1 AND state<>'expired' RETURNING version,effective_at,expires_at",
    [marker.memberId,`member:${marker.memberId}`])).rows[0];
  if(membership)await client.query(`INSERT INTO commercial_membership_event(member_id,version,from_state,to_state,effective_at,expires_at,actor_principal_id,reason)
    VALUES($1,$2,$3,'expired',$4,$5,$6,'本人注销账号')`,[marker.memberId,membership.version,previousMembership?.state??null,membership.effective_at,membership.expires_at,`member:${marker.memberId}`]);
  await client.query(`UPDATE commercial_referral_code SET state='disabled',disabled_at=now(),disabled_by=$2,disable_reason='本人注销账号'
    WHERE member_id=$1 AND state='active'`,[marker.memberId,`member:${marker.memberId}`]);
  await client.query(`UPDATE authority_grant SET revoked_at=now(),revoked_by=$2,revoke_reason='本人注销账号'
    WHERE member_id=$1 AND revoked_at IS NULL`,[marker.memberId,`member:${marker.memberId}`]);
  await client.query("UPDATE consent_receipt SET status='withdrawn',withdrawn_at=now() WHERE member_id=$1 AND status='active'",[marker.memberId]);
  if(request.status!=='completed'){
    if(request.status!=='received')throw new Error('ACCOUNT_CLOSURE_REQUEST_STATE_UNEXPECTED');
    for(const status of ['reviewing','approved','executing'] as const)
      await client.query('UPDATE privacy_request SET status=$2,version=version+1,updated_at=now() WHERE id=$1',[marker.requestId,status]);
    await client.query(`UPDATE privacy_request SET status='completed',resolution_code=$2,response=$3,completed_at=now(),version=version+1,updated_at=now()
      WHERE id=$1`,[marker.requestId,held?'SELF_ACCOUNT_CLOSED_WITH_LEGAL_HOLD':'SELF_ACCOUNT_CLOSED',
      held?'账号已注销。受法定保全约束的资料暂予隔离保留，其他历史事项可继续在本页申请处理。':'账号已注销。历史交易与售后资料按必要期限隔离保留。']);
    await client.query(`INSERT INTO privacy_request_event(privacy_request_id,actor_id,event_type,detail)
      VALUES($1,$2,'execution_succeeded',jsonb_build_object('scope','account_identity_only','retainedTransactions',true,'legalHold', $3::boolean))`,
      [marker.requestId,`member:${marker.memberId}`,held]);
    await client.query(`INSERT INTO audit_log(principal_id,action,object_type,object_id,reason_code,before_state,after_state,trace_id)
      VALUES($1,'privacy.account.close','member',$2,'SELF_ACCOUNT_CLOSURE',jsonb_build_object('status',$3::text),
        '{"status":"deleted","transactionsRetained":true}'::jsonb,$4)`,
      [`member:${marker.memberId}`,marker.memberId,member.status,randomUUID()]);
  }
  return {id:marker.requestId,kind:'close_account',status:'completed',accountClosed:true};
}
