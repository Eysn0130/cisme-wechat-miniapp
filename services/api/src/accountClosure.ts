import { createHash, randomUUID } from 'node:crypto';
import { link, lstat, open, readFile, readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type pg from 'pg';
import { DomainError } from '@cisme/domain';
import { transaction, type DbClient } from './db.js';
import { enqueue } from './outbox.js';
import { applySupportMessageSuppression } from './supportMessageSuppression.js';

export type ClosureMarker={version:1;memberId:string;identityDigest:string;requestId:string;createdAt:string};
export type ProfileErasureMarker={version:2;memberId:string;identityDigest:string;requestId:string;createdAt:string;
  scope:'member_optional_profile_v1';displayNameSha256:string};
export type AddressErasureMarker={version:3;memberId:string;identityDigest:string;requestId:string;createdAt:string;
  scope:'member_delivery_address_v1';addressId:string;addressVersion:number;payloadHmac:string};
export type ConsentWithdrawalMarker={version:4;memberId:string;identityDigest:string;requestId:string;createdAt:string;
  scope:'submission_consent_withdrawal_v1';grantId:string;submissionId:string;purpose:'feed_readonly'|'publication'};
export type SupportMessageMarker={version:5;memberId:string;conversationId:string;batchId:string;
  messageIds:string[];mediaIds:string[];memberCreatedAt:string;createdAt:string;
  scope:'support_retention_messages_v1';policyCode:string;removeConversation:boolean};
export type Marker=ClosureMarker|ProfileErasureMarker|AddressErasureMarker|ConsentWithdrawalMarker|SupportMessageMarker;
export interface SuppressionRemote {
  put(marker:Marker):Promise<void>;
  list():Promise<Marker[]>;
}
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const digest=/^[0-9a-f]{64}$/;
const pendingMarker=/^\.[0-9a-f-]{36}\.[0-9a-f-]{36}\.tmp$/i;
const profileMarker=/^([0-9a-f-]{36})\.profile\.([0-9a-f-]{36})\.json$/i;
const addressMarker=/^([0-9a-f-]{36})\.address\.([0-9a-f-]{36})\.([0-9a-f-]{36})\.json$/i;
const consentMarker=/^([0-9a-f-]{36})\.consent\.([0-9a-f-]{36})\.([0-9a-f-]{36})\.json$/i;
const supportMarker=/^([0-9a-f-]{36})\.support\.([0-9a-f-]{36})\.([0-9a-f-]{36})\.json$/i;

/** This directory must live outside database backups and release directories. */
export class AccountClosure {
  constructor(private readonly directory:string|null,private readonly remote?:SuppressionRemote) {}
  suppressionEnabled(){return Boolean(this.directory);}

  private path(memberId:string) {if(!uuid.test(memberId))throw new Error('ACCOUNT_CLOSURE_MARKER_INVALID');return join(this.directory!,`${memberId}.json`);}
  private markerFilename(row:Marker){return row.version===1?`${row.memberId}.json`:
    row.version===2?`${row.memberId}.profile.${row.requestId}.json`:
    row.version===3?`${row.memberId}.address.${row.addressId}.${row.requestId}.json`:
    row.version===4?`${row.memberId}.consent.${row.grantId}.${row.requestId}.json`:
    `${row.memberId}.support.${row.conversationId}.${row.batchId}.json`;}
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
  private validAddress(row:AddressErasureMarker,memberId:string,addressId:string,requestId:string){
    if(row.version!==3||row.memberId!==memberId||row.addressId!==addressId||row.requestId!==requestId||
      !uuid.test(memberId)||!uuid.test(addressId)||!uuid.test(requestId)||row.scope!=='member_delivery_address_v1'||
      !digest.test(row.identityDigest)||!digest.test(row.payloadHmac)||
      !Number.isSafeInteger(row.addressVersion)||row.addressVersion<1||!Number.isFinite(Date.parse(row.createdAt)))
      throw new Error('ADDRESS_ERASURE_MARKER_INVALID');
    return row;
  }
  private validConsent(row:ConsentWithdrawalMarker,memberId:string,grantId:string,requestId:string){
    if(row.version!==4||row.memberId!==memberId||row.grantId!==grantId||row.requestId!==requestId||
      !uuid.test(memberId)||!uuid.test(grantId)||!uuid.test(requestId)||!uuid.test(row.submissionId)||
      row.scope!=='submission_consent_withdrawal_v1'||!['feed_readonly','publication'].includes(row.purpose)||
      !digest.test(row.identityDigest)||!Number.isFinite(Date.parse(row.createdAt)))
      throw new Error('CONSENT_WITHDRAWAL_MARKER_INVALID');
    return row;
  }
  private validSupport(row:SupportMessageMarker,memberId:string,conversationId:string,batchId:string){
    if(row.version!==5||row.memberId!==memberId||row.conversationId!==conversationId||row.batchId!==batchId||
      ![memberId,conversationId,batchId].every(value=>uuid.test(value))||
      row.scope!=='support_retention_messages_v1'||
      !['support_conversation_policy_pending','support_transaction_three_years'].includes(row.policyCode)||
      typeof row.removeConversation!=='boolean'||!Number.isFinite(Date.parse(row.createdAt))||
      !Number.isFinite(Date.parse(row.memberCreatedAt))||!Array.isArray(row.messageIds)||
      row.messageIds.length<1||row.messageIds.length>100||new Set(row.messageIds).size!==row.messageIds.length||
      !row.messageIds.every(value=>uuid.test(value))||!Array.isArray(row.mediaIds)||
      row.mediaIds.length>1000||new Set(row.mediaIds).size!==row.mediaIds.length||
      !row.mediaIds.every(value=>uuid.test(value)))throw new Error('SUPPORT_SUPPRESSION_MARKER_INVALID');
    return row;
  }
  private async readFilename(filename:string):Promise<Marker>{
    await this.requireDirectory();
    const match=profileMarker.exec(filename),address=addressMarker.exec(filename),consent=consentMarker.exec(filename),support=supportMarker.exec(filename);
    if(!match&&!address&&!consent&&!support&&(!filename.endsWith('.json')||!uuid.test(filename.slice(0,-5))))throw new Error('ACCOUNT_CLOSURE_DIRECTORY_UNEXPECTED_FILE');
    const row=JSON.parse(await readFile(join(this.directory!,filename),'utf8')) as Marker;
    return match?this.validProfile(row as ProfileErasureMarker,match[1]!,match[2]!):
      address?this.validAddress(row as AddressErasureMarker,address[1]!,address[2]!,address[3]!):
      consent?this.validConsent(row as ConsentWithdrawalMarker,consent[1]!,consent[2]!,consent[3]!):
      support?this.validSupport(row as SupportMessageMarker,support[1]!,support[2]!,support[3]!):
      this.valid(row,filename.slice(0,-5));
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
  async recordProfileErasure(memberId:string,identityDigest:string,requestId:string,displayNameSha256:string,createdAt:string){
    await this.requireDirectory();
    const row=this.validProfile({version:2,memberId,identityDigest,requestId,
      createdAt,scope:'member_optional_profile_v1',displayNameSha256},memberId,requestId);
    await this.writeLocal(row);
    try{await this.remote?.put(row);}catch{throw new DomainError('PROFILE_ERASURE_PENDING','删除请求处理结果暂未确认，请稍后查看',503);}
    return row;
  }
  async recordAddressErasure(input:Omit<AddressErasureMarker,'version'|'scope'>){
    await this.requireDirectory();
    const row=this.validAddress({version:3,scope:'member_delivery_address_v1',...input},
      input.memberId,input.addressId,input.requestId);
    await this.writeLocal(row);
    try{await this.remote?.put(row);}catch{throw new DomainError('ADDRESS_ERASURE_PENDING','地址删除结果暂未确认，请稍后查看',503);}
    return row;
  }
  async recordConsentWithdrawal(input:Omit<ConsentWithdrawalMarker,'version'|'scope'>){
    if(!this.directory)throw new DomainError('CONSENT_WITHDRAWAL_UNAVAILABLE','授权撤回暂不可用，请稍后重试',503);
    await this.requireDirectory();
    const row=this.validConsent({version:4,scope:'submission_consent_withdrawal_v1',...input},
      input.memberId,input.grantId,input.requestId);
    await this.writeLocal(row);
    try{await this.remote?.put(row);}catch{throw new DomainError('CONSENT_WITHDRAWAL_PENDING','撤回结果暂未确认，请稍后查看',503);}
    return row;
  }
  async recordSupportMessageSuppression(input:Omit<SupportMessageMarker,'version'|'scope'>){
    if(!this.directory)throw new DomainError('SUPPORT_RETENTION_SUPPRESSION_UNAVAILABLE','客服保留抑制记录不可用',503);
    await this.requireDirectory();
    const row=this.validSupport({version:5,scope:'support_retention_messages_v1',...input},
      input.memberId,input.conversationId,input.batchId);
    await this.writeLocal(row);
    try{await this.remote?.put(row);}catch{throw new DomainError('SUPPORT_RETENTION_SUPPRESSION_PENDING','客服清理结果暂未确认',503);}
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
        else if(row.version===2)this.validProfile(row,row.memberId,row.requestId);
        else if(row.version===3)this.validAddress(row,row.memberId,row.addressId,row.requestId);
        else if(row.version===4)this.validConsent(row,row.memberId,row.grantId,row.requestId);
        else this.validSupport(row,row.memberId,row.conversationId,row.batchId);
        await this.writeLocal(row);
      }
    }
    const supportToFinalize:SupportMessageMarker[]=[];
    for(const filename of await readdir(this.directory)){
      if(pendingMarker.test(filename))continue;
      const row=await this.readFilename(filename);
      await this.remote?.put(row);
      if(row.version===1)await transaction(pool,client=>applyAccountClosure(client,row));
      else if(row.version===2)await transaction(pool,client=>applyProfileErasure(client,row));
      else if(row.version===3){
        try{await transaction(pool,client=>applyAddressErasure(client,row));}
        catch(error){
          // A marker may have been durably written before its SQL transaction
          // rolled back. A later, explicit address edit supersedes that
          // version; it must not prevent the API from starting on restore.
          if(!(error instanceof DomainError&&error.code==='DELIVERY_ADDRESS_CHANGED'))throw error;
        }
      }
      else if(row.version===4)await transaction(pool,client=>applyConsentWithdrawal(client,row));
      else {await transaction(pool,client=>applySupportMessageSuppression(client,row));
        if(row.removeConversation)supportToFinalize.push(row);}
    }
    for(const row of supportToFinalize)
      await transaction(pool,client=>applySupportMessageSuppression(client,row));
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
      if(marker.version===3){
        const pending=(await pool.query<{pending:boolean}>(`SELECT EXISTS(SELECT 1 FROM member_delivery_address
          WHERE id=$1 AND member_id=$2 AND key_version<>'erased' AND payload_hmac=$3
            AND version BETWEEN $4 AND $4+1) AS pending`,
          [marker.addressId,marker.memberId,marker.payloadHmac,marker.addressVersion])).rows[0]?.pending;
        if(pending){await transaction(pool,client=>applyAddressErasure(client,marker));repaired++;}
        continue;
      }else if(marker.version===4){
        const pending=(await pool.query<{pending:boolean}>(`SELECT EXISTS(
          SELECT 1 FROM consent_grant g WHERE g.id=$1 AND g.member_id=$2 AND
            (g.active OR EXISTS(SELECT 1 FROM feed_item f WHERE f.submission_id=$3 AND f.visible)
              OR NOT EXISTS(SELECT 1 FROM privacy_request p WHERE p.id=$4 AND p.member_id=$2
                AND p.target_ref=$1 AND p.status IN ('completed','partially_completed')))) AS pending`,
          [marker.grantId,marker.memberId,marker.submissionId,marker.requestId])).rows[0]?.pending;
        if(pending){await transaction(pool,client=>applyConsentWithdrawal(client,marker));repaired++;}
        continue;
      }else if(marker.version===5){
        const pending=(await pool.query<{pending:boolean}>(`SELECT EXISTS(SELECT 1 FROM support_message
          WHERE conversation_id=$1 AND id=ANY($2::uuid[])) OR EXISTS(SELECT 1 FROM media_object
          WHERE support_conversation_id=$1 AND id=ANY($3::uuid[]) AND upload_state IN ('authorized','uploaded')
            AND bound_support_message_id IS NULL
            AND NOT EXISTS(SELECT 1 FROM support_message remaining
              WHERE remaining.attachment_refs ? media_object.id::text)
            AND NOT EXISTS(SELECT 1 FROM media_cleanup_queue q WHERE q.media_id=media_object.id))
          OR ($4::boolean AND EXISTS(SELECT 1 FROM support_conversation c WHERE c.id=$1 AND c.status='resolved'
            AND NOT EXISTS(SELECT 1 FROM support_message m WHERE m.conversation_id=c.id)
            AND NOT EXISTS(SELECT 1 FROM commerce_aftersale_case a WHERE a.support_conversation_id=c.id))) AS pending`,
          [marker.conversationId,marker.messageIds,marker.mediaIds,marker.removeConversation])).rows[0]?.pending;
        if(pending){const applied=await transaction(pool,client=>applySupportMessageSuppression(client,marker));
          if(applied.deleted||applied.queued||applied.removed)repaired++;}
        continue;
      }else if(marker.version===2){
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

/** Address-book deletion never changes the independently sealed order address.
 * The marker is outside database backups, so replay also removes a restored
 * pre-deletion address. A hold delays payload erasure but not book visibility. */
export async function applyAddressErasure(client:DbClient,marker:AddressErasureMarker){
  const member=(await client.query<{status:string}>('SELECT status FROM member WHERE id=$1 FOR UPDATE',[marker.memberId])).rows[0];
  if(!member)return {addressId:marker.addressId,removed:true,erased:false,missing:true};
  const identity=(await client.query<{provider:string;app_id:string;openid:string}>(
    'SELECT provider,app_id,openid FROM wechat_identity WHERE member_id=$1 FOR SHARE',[marker.memberId])).rows[0];
  if(!identity||AccountClosure.identityDigest(identity.provider,identity.app_id,identity.openid)!==marker.identityDigest)
    throw new Error('ADDRESS_ERASURE_IDENTITY_MISMATCH');
  const row=(await client.query<{version:number;payload_hmac:string;key_version:string;deleted_at:Date|null}>(
    'SELECT version,payload_hmac,key_version,deleted_at FROM member_delivery_address WHERE id=$1 AND member_id=$2 FOR UPDATE',
    [marker.addressId,marker.memberId])).rows[0];
  if(!row)return {addressId:marker.addressId,removed:true,erased:false,missing:true};
  if(row.key_version==='erased')return {addressId:marker.addressId,removed:true,erased:true};
  if(row.payload_hmac!==marker.payloadHmac||
    row.version!==marker.addressVersion&&!(row.version===marker.addressVersion+1&&row.deleted_at))
    throw new DomainError('DELIVERY_ADDRESS_CHANGED','地址已更新，请刷新后重试',409);
  await client.query('LOCK TABLE legal_hold IN SHARE MODE');
  await client.query('LOCK TABLE legal_hold_binding IN SHARE MODE');
  const held=Boolean((await client.query(`SELECT 1 FROM legal_hold_binding b JOIN legal_hold h ON h.id=b.hold_id
    WHERE h.status='active' AND h.expires_at>clock_timestamp() AND
      (b.object_type='member' AND b.object_id=$1 OR
       b.object_type='member_delivery_address' AND b.object_id=$2) LIMIT 1`,
    [marker.memberId,marker.addressId])).rowCount);
  if(held&&row.deleted_at)return {addressId:marker.addressId,removed:true,erased:false,retainedForHold:true};
  const result=await client.query(`UPDATE member_delivery_address SET
    encrypted_payload=CASE WHEN $3 THEN encrypted_payload ELSE '' END,
    payload_hmac=CASE WHEN $3 THEN payload_hmac ELSE encode(digest(id::text,'sha256'),'hex') END,
    key_version=CASE WHEN $3 THEN key_version ELSE 'erased' END,
    is_default=false,deleted_at=COALESCE(deleted_at,clock_timestamp()),
    version=CASE WHEN deleted_at IS NULL THEN version+1 ELSE version END,updated_at=clock_timestamp()
    WHERE id=$1 AND member_id=$2 RETURNING version`,[marker.addressId,marker.memberId,held]);
  await client.query('UPDATE member SET privacy_erasure_revision=privacy_erasure_revision+1 WHERE id=$1',
    [marker.memberId]);
  await client.query('UPDATE privacy_export_artifact SET revoked_at=now() WHERE member_id=$1 AND revoked_at IS NULL',
    [marker.memberId]);
  if(!held){
    await client.query(`INSERT INTO audit_log(principal_id,action,object_type,object_id,reason_code,after_state,trace_id)
      VALUES($1,'privacy.address.erase','member_delivery_address',$2,'VERIFIED_MEMBER_ADDRESS_ERASURE',$3,gen_random_uuid()::text)`,
      [`member:${marker.memberId}`,marker.addressId,{requestId:marker.requestId,version:result.rows[0]?.version}]);
  }
  return {addressId:marker.addressId,removed:true,erased:!held,retainedForHold:held};
}

/** A restored database must not reactivate a consent withdrawn by the member.
 * Keep the minimum request evidence and preserve any independent history. */
export async function applyConsentWithdrawal(client:DbClient,marker:ConsentWithdrawalMarker){
  const member=(await client.query<{status:string}>(
    'SELECT status FROM member WHERE id=$1 FOR UPDATE',[marker.memberId])).rows[0];
  if(!member)return {id:marker.requestId,kind:'withdraw',status:'suppressed_without_member'};
  const identity=(await client.query<{provider:string;app_id:string;openid:string}>(
    'SELECT provider,app_id,openid FROM wechat_identity WHERE member_id=$1 FOR SHARE',
    [marker.memberId])).rows[0];
  if(!identity||AccountClosure.identityDigest(identity.provider,identity.app_id,identity.openid)!==marker.identityDigest)
    throw new Error('CONSENT_WITHDRAWAL_IDENTITY_MISMATCH');
  const grant=(await client.query<{submission_id:string;purpose:string;active:boolean}>(
    'SELECT submission_id,purpose,active FROM consent_grant WHERE id=$1 AND member_id=$2 FOR UPDATE',
    [marker.grantId,marker.memberId])).rows[0];
  if(!grant)return {id:marker.requestId,kind:'withdraw',status:'suppressed_without_grant'};
  if(grant.submission_id!==marker.submissionId||grant.purpose!==marker.purpose)
    throw new Error('CONSENT_WITHDRAWAL_TARGET_MISMATCH');
  const complete=marker.purpose==='feed_readonly';
  const label=complete?'社区只读展示':'提交内容发布';
  await client.query(`INSERT INTO privacy_request(id,member_id,kind,message,due_at,target_ref)
    VALUES($1,$2,'withdraw',$3,now()+interval '30 days',$4) ON CONFLICT(id) DO NOTHING`,
    [marker.requestId,marker.memberId,`本人撤回${label}授权`,marker.grantId]);
  const request=(await client.query<{member_id:string;kind:string;target_ref:string;status:string;version:number}>(
    'SELECT member_id,kind,target_ref,status,version FROM privacy_request WHERE id=$1 FOR UPDATE',
    [marker.requestId])).rows[0];
  if(!request||request.member_id!==marker.memberId||request.kind!=='withdraw'||request.target_ref!==marker.grantId)
    throw new Error('CONSENT_WITHDRAWAL_REQUEST_MISMATCH');
  const wasActive=grant.active;
  const now=(await client.query<{now:Date}>('SELECT clock_timestamp() AS now')).rows[0]!.now;
  if(wasActive)await client.query('UPDATE consent_grant SET active=false WHERE id=$1',[marker.grantId]);
  await client.query(`INSERT INTO revocation_request(consent_grant_id,requested_by,reason,requested_at)
    VALUES($1,$2,$3,$4) ON CONFLICT(consent_grant_id) DO NOTHING`,
    [marker.grantId,marker.memberId,`隐私权利申请 ${marker.requestId}`,now]);
  const hidden=complete?(await client.query(`UPDATE feed_item SET visible=false
    WHERE submission_id=$1 AND visible RETURNING id`,[marker.submissionId])).rowCount??0:0;
  await enqueue(client,{eventType:'consent.revocation.requested.v1',aggregateType:'consent_grant',
    aggregateId:marker.grantId,aggregateVersion:1,businessKey:`consent:${marker.grantId}:revoked`,
    payload:{submissionId:marker.submissionId,memberId:marker.memberId,purpose:marker.purpose},occurredAt:now});
  if(request.status==='received')await client.query(`INSERT INTO privacy_request_event
    (privacy_request_id,actor_id,event_type,detail) VALUES($1,$2,'received',$3)`,
    [marker.requestId,`member:${marker.memberId}`,{grantId:marker.grantId,purpose:marker.purpose}]);
  const next:Record<string,string>={received:'reviewing',reviewing:'approved',approved:'executing'};
  let status=request.status;
  while(next[status]){
    status=next[status]!;
    await client.query('UPDATE privacy_request SET status=$2,version=version+1,updated_at=now() WHERE id=$1',
      [marker.requestId,status]);
  }
  if(status==='executing'){
    status=complete?'completed':'partially_completed';
    await client.query(`UPDATE privacy_request SET status=$2,resolution_code=$3,response=$4,
      completed_at=now(),version=version+1,updated_at=now() WHERE id=$1`,
      [marker.requestId,status,complete?'SUBMISSION_FEED_CONSENT_WITHDRAWN':'SUBMISSION_PUBLICATION_CONSENT_WITHDRAWN',
        complete?'授权已撤回，社区只读展示已停止；历史记录按必要期限保留。':
          '授权已撤回，后续使用已停止；已发布内容的历史传播仍需人工核对。']);
    await client.query(`INSERT INTO privacy_request_event(privacy_request_id,actor_id,event_type,detail)
      VALUES($1,$2,$3,$4)`,[marker.requestId,`member:${marker.memberId}`,
      complete?'execution_succeeded':'execution_partially_succeeded',
      {grantId:marker.grantId,purpose:marker.purpose,blocksNewUse:true}]);
  }
  if(wasActive||hidden||request.status==='received'){
    await client.query('UPDATE member SET privacy_erasure_revision=privacy_erasure_revision+1 WHERE id=$1',
      [marker.memberId]);
    await client.query('UPDATE privacy_export_artifact SET revoked_at=now() WHERE member_id=$1 AND revoked_at IS NULL',
      [marker.memberId]);
    await client.query(`INSERT INTO audit_log(principal_id,action,object_type,object_id,reason_code,
      after_state,trace_id) VALUES($1,'privacy.consent.withdraw','privacy_request',$2,
      'VERIFIED_MEMBER_WITHDRAWAL',$3,gen_random_uuid()::text)`,[`member:${marker.memberId}`,marker.requestId,
      {grantId:marker.grantId,purpose:marker.purpose,status,restoredReplay:request.status!=='received'}]);
  }
  const readback=(await client.query<{active:boolean;revoked:boolean;feed_visible:boolean}>(`
    SELECT cg.active,EXISTS(SELECT 1 FROM revocation_request rr WHERE rr.consent_grant_id=cg.id) AS revoked,
      EXISTS(SELECT 1 FROM feed_item f WHERE f.submission_id=cg.submission_id AND f.visible) AS feed_visible
    FROM consent_grant cg WHERE cg.id=$1 AND cg.member_id=$2`,[marker.grantId,marker.memberId])).rows[0];
  if(!readback||readback.active||!readback.revoked||complete&&readback.feed_visible)
    throw new Error('PRIVACY_WITHDRAWAL_READBACK_FAILED');
  return {id:marker.requestId,kind:'withdraw',status,version:
    (await client.query<{version:number}>('SELECT version FROM privacy_request WHERE id=$1',
      [marker.requestId])).rows[0]!.version};
}
