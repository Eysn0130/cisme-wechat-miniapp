import { createHash, randomUUID } from 'node:crypto';
import { link, lstat, open, readFile, readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type pg from 'pg';
import { DomainError } from '@cisme/domain';
import { transaction, type DbClient } from './db.js';

export type ClosureMarker={version:1;memberId:string;identityDigest:string;requestId:string;createdAt:string};
export type ProfileErasureMarker={version:2;memberId:string;identityDigest:string;requestId:string;createdAt:string;
  scope:'member_optional_profile_v1';displayNameSha256:string};
export type Marker=ClosureMarker|ProfileErasureMarker;
export interface SuppressionRemote {
  put(marker:Marker):Promise<void>;
  list():Promise<Marker[]>;
}
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const digest=/^[0-9a-f]{64}$/;
const pendingMarker=/^\.[0-9a-f-]{36}\.[0-9a-f-]{36}\.tmp$/i;
const profileMarker=/^([0-9a-f-]{36})\.profile\.([0-9a-f-]{36})\.json$/i;

/** This directory must live outside database backups and release directories. */
export class AccountClosure {
  constructor(private readonly directory:string|null,private readonly remote?:SuppressionRemote) {}

  private path(memberId:string) {if(!uuid.test(memberId))throw new Error('ACCOUNT_CLOSURE_MARKER_INVALID');return join(this.directory!,`${memberId}.json`);}
  private markerFilename(row:Marker){return row.version===1?`${row.memberId}.json`:`${row.memberId}.profile.${row.requestId}.json`;}
  private markerPath(row:Marker){return join(this.directory!,this.markerFilename(row));}
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
    return row as ClosureMarker;
  }
  private validProfile(row:ProfileErasureMarker,memberId:string,requestId:string){
    if(row.version!==2||!uuid.test(memberId)||!uuid.test(requestId)||row.memberId!==memberId||row.requestId!==requestId||row.scope!=='member_optional_profile_v1'||
      !digest.test(row.identityDigest)||!digest.test(row.displayNameSha256)||!Number.isFinite(Date.parse(row.createdAt)))
      throw new Error('PROFILE_ERASURE_MARKER_INVALID');
    return row;
  }
  private async readFilename(filename:string):Promise<Marker>{
    await this.requireDirectory();
    const match=profileMarker.exec(filename);
    if(!match&&(!filename.endsWith('.json')||!uuid.test(filename.slice(0,-5))))throw new Error('ACCOUNT_CLOSURE_DIRECTORY_UNEXPECTED_FILE');
    const row=JSON.parse(await readFile(join(this.directory!,filename),'utf8')) as Marker;
    return match?this.validProfile(row as ProfileErasureMarker,match[1]!,match[2]!):this.valid(row,filename.slice(0,-5));
  }
  private async marker(memberId:string):Promise<ClosureMarker|null> {
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
      if(pendingMarker.test(filename))continue;
      const row=await this.readFilename(filename);
      if(row.version===1&&row.identityDigest===wanted)return true;
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
  async recordProfileErasure(memberId:string,identityDigest:string,requestId:string,displayNameSha256:string,createdAt:Date){
    await this.requireDirectory();
    const row=this.validProfile({version:2,memberId,identityDigest,requestId,
      createdAt:createdAt.toISOString(),scope:'member_optional_profile_v1',displayNameSha256},memberId,requestId);
    await this.writeLocal(row);
    try{await this.remote?.put(row);}catch{throw new DomainError('PROFILE_ERASURE_PENDING','删除请求处理结果暂未确认，请稍后查看',503);}
    return row;
  }
  private async writeLocal(row:Marker) {
    const filename=this.markerFilename(row);
    let old:Marker|null=null;
    try{old=await this.readFilename(filename);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    if(old){if(JSON.stringify(old)!==JSON.stringify(row))throw new Error('ACCOUNT_CLOSURE_MARKER_MISMATCH');return;}
    const temporary=join(this.directory!,`.${row.memberId}.${randomUUID()}.tmp`);
    try{
      const handle=await open(temporary,'wx',0o600);
      try{await handle.writeFile(JSON.stringify(row));await handle.sync();}finally{await handle.close();}
      try{await link(temporary,this.markerPath(row));}catch(error){
        if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;
        const concurrent=await this.readFilename(filename);
        if(!concurrent||JSON.stringify(concurrent)!==JSON.stringify(row))throw error;
      }
      // hard-link publication never replaces an existing marker; readers see
      // either no final path or a fully written, synced record.
      await unlink(temporary);
      const dir=await open(this.directory!,'r');try{await dir.sync();}finally{await dir.close();}
    }finally{await unlink(temporary).catch(error=>{if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;});}
  }
  async replay(pool:pg.Pool) {
    if(!this.directory)return;
    await this.requireDirectory();
    if(this.remote){
      for(const row of await this.remote.list()){
        if(row.version===1)this.valid(row,row.memberId);
        else this.validProfile(row,row.memberId,row.requestId);
        await this.writeLocal(row);
      }
    }
    for(const filename of await readdir(this.directory)){
      if(pendingMarker.test(filename))continue;
      const row=await this.readFilename(filename);
      await this.remote?.put(row);
      if(row.version===1)await transaction(pool,client=>applyAccountClosure(client,row));
      else await transaction(pool,client=>applyProfileErasure(client,row));
    }
  }
  async replayMember(pool:pg.Pool,memberId:string) {
    const row=await this.marker(memberId);
    if(!row)return null;
    try{await this.remote?.put(row);}catch{throw new DomainError('ACCOUNT_CLOSURE_PENDING','注销处理中，请稍后重试',503);}
    return transaction(pool,client=>applyAccountClosure(client,row));
  }
  /** Reapply only markers whose restored or newly released subject still has
   * active profile material. This also closes a pre-deletion database restore
   * while the worker remains alive, without waiting for another API restart. */
  async replayPendingErasure(pool:pg.Pool):Promise<number> {
    if(!this.directory)return 0;
    await this.requireDirectory();
    let repaired=0;
    for(const filename of await readdir(this.directory)){
      if(pendingMarker.test(filename))continue;
      const marker=await this.readFilename(filename);
      if(marker.version===2){
        const pending=(await pool.query<{pending:boolean}>(`SELECT EXISTS(SELECT 1 FROM member m
          WHERE m.id=$1 AND m.status='active' AND NOT EXISTS(
            SELECT 1 FROM legal_hold_binding b JOIN legal_hold h ON h.id=b.hold_id
            WHERE h.status='active' AND h.expires_at>clock_timestamp() AND
              (b.object_type IN ('member','member_profile','member_contact','wechat_identity') AND b.object_id=m.id::text
                OR b.object_type='member_delivery_address' AND b.object_id IN
                  (SELECT id::text FROM member_delivery_address WHERE member_id=m.id))) AND (
            (m.display_name<>'用户' AND encode(digest(m.display_name,'sha256'),'hex')=$2 AND
              NOT EXISTS(SELECT 1 FROM member_profile WHERE member_id=m.id AND updated_at>$3::timestamptz)) OR
            EXISTS(SELECT 1 FROM member_contact WHERE member_id=m.id AND bound_at<=$3::timestamptz) OR
            EXISTS(SELECT 1 FROM wechat_identity WHERE member_id=m.id AND unionid IS NOT NULL) OR
            EXISTS(SELECT 1 FROM phone_authorization WHERE member_id=m.id AND consumed_at<=$3::timestamptz) OR
            EXISTS(SELECT 1 FROM member_profile WHERE member_id=m.id AND updated_at<=$3::timestamptz) OR
            EXISTS(SELECT 1 FROM member_delivery_address WHERE member_id=m.id AND key_version<>'erased'
              AND updated_at<=$3::timestamptz))) AS pending`,
          [marker.memberId,marker.displayNameSha256,marker.createdAt])).rows[0]?.pending;
        if(pending){await this.remote?.put(marker);await transaction(pool,client=>applyProfileErasure(client,marker));repaired++;}
        continue;
      }
      const memberId=marker.memberId;
      const pending=(await pool.query<{pending:boolean}>(`SELECT EXISTS(SELECT 1 FROM member m
        WHERE m.id=$1 AND (m.status<>'deleted' OR (
          NOT EXISTS(SELECT 1 FROM legal_hold_binding b JOIN legal_hold h ON h.id=b.hold_id
            WHERE h.status='active' AND h.expires_at>clock_timestamp() AND
              (b.object_type IN ('member','member_profile','member_contact','wechat_identity') AND b.object_id=m.id::text
                OR b.object_type='member_delivery_address' AND b.object_id IN
                  (SELECT id::text FROM member_delivery_address WHERE member_id=m.id)))
          AND (m.display_name<>'已注销用户'
            OR EXISTS(SELECT 1 FROM wechat_identity WHERE member_id=m.id AND unionid IS NOT NULL)
            OR EXISTS(SELECT 1 FROM member_contact WHERE member_id=m.id)
            OR EXISTS(SELECT 1 FROM phone_authorization WHERE member_id=m.id)
            OR EXISTS(SELECT 1 FROM member_profile WHERE member_id=m.id)
            OR EXISTS(SELECT 1 FROM member_delivery_address WHERE member_id=m.id AND key_version<>'erased')))))
        AS pending`,[memberId])).rows[0]?.pending;
      if(pending){await this.replayMember(pool,memberId);repaired++;}
    }
    return repaired;
  }
}

export async function applyAccountClosure(client:DbClient,marker:ClosureMarker) {
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
  // Keep a concurrent legal hold from appearing after the deletion decision.
  await client.query('LOCK TABLE legal_hold IN SHARE MODE');
  await client.query('LOCK TABLE legal_hold_binding IN SHARE MODE');
  // Keep financial, order, refund, aftersale and their support evidence intact.
  const held=Boolean((await client.query(`SELECT 1 FROM legal_hold_binding b JOIN legal_hold h ON h.id=b.hold_id
    WHERE h.status='active' AND h.expires_at>now() AND
      ((b.object_type IN ('member','member_profile','member_contact','wechat_identity') AND b.object_id=$1)
       OR (b.object_type='member_delivery_address' AND b.object_id IN
          (SELECT id::text FROM member_delivery_address WHERE member_id=$2))) LIMIT 1`,
    [marker.memberId,marker.memberId])).rowCount);
  let changed=(await client.query(`UPDATE member SET status='deleted',
    display_name=CASE WHEN $2::boolean THEN display_name ELSE '已注销用户' END
    WHERE id=$1 AND (status<>'deleted' OR NOT $2::boolean AND display_name<>'已注销用户')`,
    [marker.memberId,held])).rowCount??0;
  if(!held){
    changed+=(await client.query('UPDATE wechat_identity SET unionid=NULL WHERE member_id=$1 AND unionid IS NOT NULL',[marker.memberId])).rowCount??0;
    changed+=(await client.query('DELETE FROM member_contact WHERE member_id=$1',[marker.memberId])).rowCount??0;
    changed+=(await client.query('DELETE FROM phone_authorization WHERE member_id=$1',[marker.memberId])).rowCount??0;
    changed+=(await client.query('DELETE FROM member_profile WHERE member_id=$1',[marker.memberId])).rowCount??0;
    changed+=(await client.query(`UPDATE member_delivery_address SET encrypted_payload='',payload_hmac=encode(digest(id::text,'sha256'),'hex'),
      key_version='erased',is_default=false,deleted_at=COALESCE(deleted_at,now()),updated_at=now()
      WHERE member_id=$1 AND key_version<>'erased'`,[marker.memberId])).rowCount??0;
  }

  const previousMembership=(await client.query<{state:string}>(
    'SELECT state FROM commercial_membership WHERE member_id=$1 FOR UPDATE',[marker.memberId])).rows[0];
  const membership=(await client.query<{version:number;effective_at:Date;expires_at:Date|null}>(
    "UPDATE commercial_membership SET state='expired',version=version+1,changed_by=$2,change_reason='本人注销账号',updated_at=now() WHERE member_id=$1 AND state<>'expired' RETURNING version,effective_at,expires_at",
    [marker.memberId,`member:${marker.memberId}`])).rows[0];
  if(membership)changed++;
  if(membership)await client.query(`INSERT INTO commercial_membership_event(member_id,version,from_state,to_state,effective_at,expires_at,actor_principal_id,reason)
    VALUES($1,$2,$3,'expired',$4,$5,$6,'本人注销账号')`,[marker.memberId,membership.version,previousMembership?.state??null,membership.effective_at,membership.expires_at,`member:${marker.memberId}`]);
  changed+=(await client.query(`UPDATE commercial_referral_code SET state='disabled',disabled_at=now(),disabled_by=$2,disable_reason='本人注销账号'
    WHERE member_id=$1 AND state='active'`,[marker.memberId,`member:${marker.memberId}`])).rowCount??0;
  changed+=(await client.query(`UPDATE authority_grant SET revoked_at=now(),revoked_by=$2,revoke_reason='本人注销账号'
    WHERE member_id=$1 AND revoked_at IS NULL`,[marker.memberId,`member:${marker.memberId}`])).rowCount??0;
  changed+=(await client.query("UPDATE consent_receipt SET status='withdrawn',withdrawn_at=now() WHERE member_id=$1 AND status='active'",[marker.memberId])).rowCount??0;
  if(changed||request.status!=='completed'){
    await client.query('UPDATE privacy_export_artifact SET revoked_at=now() WHERE member_id=$1 AND revoked_at IS NULL',
      [marker.memberId]);
    if(request.status==='completed')await client.query(
      'UPDATE privacy_request SET version=version+1,updated_at=now() WHERE id=$1',[marker.requestId]);
  }
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

/** A bounded self-service deletion: only optional live account data from at
 * or before this immutable marker is removed. Transaction evidence and any
 * profile information supplied after the request remain intact. */
export async function applyProfileErasure(client:DbClient,marker:ProfileErasureMarker){
  const member=(await client.query<{status:string}>(
    'SELECT status FROM member WHERE id=$1 FOR UPDATE',[marker.memberId])).rows[0];
  if(!member)return {id:marker.requestId,kind:'delete',status:'suppressed_without_member'};
  const identity=(await client.query<{provider:string;app_id:string;openid:string}>(
    'SELECT provider,app_id,openid FROM wechat_identity WHERE member_id=$1 FOR SHARE',[marker.memberId])).rows[0];
  if(!identity||AccountClosure.identityDigest(identity.provider,identity.app_id,identity.openid)!==marker.identityDigest)
    throw new Error('PROFILE_ERASURE_IDENTITY_MISMATCH');
  if(member.status==='deleted')return {id:marker.requestId,kind:'delete',status:'account_closed'};
  if(member.status!=='active')throw new DomainError('PROFILE_ERASURE_MEMBER_UNAVAILABLE','账号暂不可执行删除',409);
  await client.query(`INSERT INTO privacy_request(id,member_id,kind,message,due_at,scope_code)
    VALUES($1,$2,'delete','删除可清除的账户资料',now()+interval '30 days','member_optional_profile_v1')
    ON CONFLICT(id) DO NOTHING`,[marker.requestId,marker.memberId]);
  const request=(await client.query<{member_id:string;kind:string;scope_code:string;status:string}>(
    'SELECT member_id,kind,scope_code,status FROM privacy_request WHERE id=$1 FOR UPDATE',[marker.requestId])).rows[0];
  if(!request||request.member_id!==marker.memberId||request.kind!=='delete'||request.scope_code!==marker.scope)
    throw new Error('PROFILE_ERASURE_REQUEST_MISMATCH');
  if(request.status==='received'){
    for(const status of ['reviewing','approved','executing'] as const)
      await client.query('UPDATE privacy_request SET status=$2,version=version+1,updated_at=now() WHERE id=$1',[marker.requestId,status]);
    // Keep the in-memory state aligned with the transitions just persisted.
    // Otherwise the first execution returns completed while its database row
    // stays executing, and an unchanged replay revokes a newly generated copy.
    request.status='executing';
  }else if(!['executing','completed'].includes(request.status))throw new Error('PROFILE_ERASURE_REQUEST_STATE_UNEXPECTED');
  await client.query('LOCK TABLE legal_hold IN SHARE MODE');
  await client.query('LOCK TABLE legal_hold_binding IN SHARE MODE');
  const held=Boolean((await client.query(`SELECT 1 FROM legal_hold_binding b JOIN legal_hold h ON h.id=b.hold_id
    WHERE h.status='active' AND h.expires_at>now() AND
      ((b.object_type IN ('member','member_profile','member_contact','wechat_identity') AND b.object_id=$1)
       OR (b.object_type='member_delivery_address' AND b.object_id IN
          (SELECT id::text FROM member_delivery_address WHERE member_id=$2))) LIMIT 1`,
    [marker.memberId,marker.memberId])).rowCount);
  if(held){
    await client.query(`UPDATE privacy_request SET response=$2,resolution_code='PROFILE_ERASURE_HOLD',updated_at=now()
      WHERE id=$1 AND status='executing'`,[marker.requestId,
      '账号资料删除已受理；相关资料受保全约束，解除后继续处理。交易和售后记录仍按必要期限保存。']);
    return {id:marker.requestId,kind:'delete',status:'executing',legalHold:true};
  }
  const name=await client.query(`UPDATE member SET display_name='用户' WHERE id=$1 AND display_name<>'用户'
    AND encode(digest(display_name,'sha256'),'hex')=$2 AND NOT EXISTS(
      SELECT 1 FROM member_profile WHERE member_id=$1 AND updated_at>$3::timestamptz)`,
    [marker.memberId,marker.displayNameSha256,marker.createdAt]);
  const unionid=await client.query('UPDATE wechat_identity SET unionid=NULL WHERE member_id=$1 AND unionid IS NOT NULL',
    [marker.memberId]);
  const contact=await client.query('DELETE FROM member_contact WHERE member_id=$1 AND bound_at<=$2::timestamptz',
    [marker.memberId,marker.createdAt]);
  const authorization=await client.query('DELETE FROM phone_authorization WHERE member_id=$1 AND consumed_at<=$2::timestamptz',
    [marker.memberId,marker.createdAt]);
  const profile=await client.query('DELETE FROM member_profile WHERE member_id=$1 AND updated_at<=$2::timestamptz',
    [marker.memberId,marker.createdAt]);
  const addresses=await client.query(`UPDATE member_delivery_address SET encrypted_payload='',
    payload_hmac=encode(digest(id::text,'sha256'),'hex'),key_version='erased',is_default=false,
    deleted_at=COALESCE(deleted_at,now()),updated_at=now()
    WHERE member_id=$1 AND key_version<>'erased' AND updated_at<=$2::timestamptz`,
    [marker.memberId,marker.createdAt]);
  const changed=[name,unionid,contact,authorization,profile,addresses].reduce((sum,result)=>sum+(result.rowCount??0),0);
  if(changed||request.status==='executing'){
    await client.query('UPDATE privacy_export_artifact SET revoked_at=now() WHERE member_id=$1 AND revoked_at IS NULL',
      [marker.memberId]);
    // A restore replay can erase data after the original request completed.
    // Exports must observe this mutation even though created_at is unchanged.
    if(request.status==='completed')await client.query(
      'UPDATE privacy_request SET version=version+1,updated_at=now() WHERE id=$1',[marker.requestId]);
  }
  if(request.status==='executing'){
    await client.query(`UPDATE privacy_request SET status='completed',resolution_code='SELF_PROFILE_ERASED',
      response='可清除的账户资料已删除，旧数据副本已撤销；交易与售后记录按必要期限保留。',
      completed_at=now(),version=version+1,updated_at=now() WHERE id=$1`,[marker.requestId]);
    await client.query(`INSERT INTO privacy_request_event(privacy_request_id,actor_id,event_type,detail)
      VALUES($1,$2,'execution_succeeded',$3)`,[marker.requestId,`member:${marker.memberId}`,
      {scope:marker.scope,retainedTransactions:true}]);
  }
  if(changed||request.status==='executing')await client.query(`INSERT INTO audit_log(principal_id,action,object_type,object_id,
    reason_code,after_state,trace_id) VALUES($1,'privacy.profile.erase','privacy_request',$2,
    'VERIFIED_MEMBER_PROFILE_ERASURE',$3,gen_random_uuid()::text)`,[`member:${marker.memberId}`,marker.requestId,
    {scope:marker.scope,changed,restoredReplay:request.status==='completed'}]);
  return {id:marker.requestId,kind:'delete',status:'completed',scopeCode:marker.scope};
}
