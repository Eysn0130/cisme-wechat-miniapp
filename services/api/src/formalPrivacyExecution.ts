import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import type pg from 'pg';
import type { AppConfig } from '@cisme/config';
import { DomainError } from '@cisme/domain';
import { transaction, type DbClient } from './db.js';
import type { ObjectStorage } from './storage.js';
import { DeliveryAddressService } from './deliveryAddress.js';
import { collectMemberPortableData, materializeMemberPortableData } from './privacyPortableData.js';
import { OperationBudget, runWithOperationBudget } from './operationBudget.js';

const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const lifetimeMs=60*60*1000;
const maxSupplementaryBytes=64*1024*1024;
type Job={id:string;privacy_request_id:string;member_id:string;attempts:number;status:string};

// Request creation time is not a deletion barrier: a held request may have
// existed before the export snapshot and execute while objects are read.
// Reuse existing immutable request IDs + monotonic versions as the subject's
// erasure revision. The final read is protected by the same member row lock
// that every supported profile erasure and account-closure writer takes.
async function erasureRevision(client:DbClient,memberId:string):Promise<string>{
  return (await client.query<{revision:string}>(`SELECT jsonb_build_object(
    'requests',(SELECT COALESCE(jsonb_agg(jsonb_build_array(id,version,status,resolution_code) ORDER BY id),'[]'::jsonb)
      FROM privacy_request WHERE member_id=m.id AND
        (scope_code='member_optional_profile_v1' OR kind='close_account')),
    'addressErasureRevision',m.privacy_erasure_revision)::text AS revision
    FROM member m WHERE m.id=$1`,[memberId])).rows[0]!.revision;
}

/** Existing privacy jobs and artifact table, with a verified WeChat subject.
 * This never reads a dev_test identity or inherits the synthetic approval. */
export class FormalPrivacyExecution {
  private readonly addresses:DeliveryAddressService;
  constructor(private readonly pool:pg.Pool,private readonly config:AppConfig,private readonly storage:ObjectStorage){
    this.addresses=new DeliveryAddressService(pool,config);
  }
  enabled(){return Boolean(this.config.privacy.formalExportKey);}
  private key(){
    const value=this.config.privacy.formalExportKey;
    if(!value||!/^[0-9a-fA-F]{64}$/.test(value))
      throw new DomainError('PRIVACY_EXPORT_UNAVAILABLE','数据副本暂不可生成，请稍后重试',503);
    return Buffer.from(value,'hex');
  }

  async runExportOnce(failBeforeArchiveWrite?:()=>void|Promise<void>):Promise<boolean>{
    const key=this.key();
    const claim=await transaction(this.pool,async client=>{
      const job=(await client.query<Job>(`SELECT id,privacy_request_id,member_id,attempts,status
        FROM data_export_job WHERE execution_mode='generate_archive'
          AND scope->>'formalSelfService'='true' AND scope->>'dataClass'='member_portable_copy_v1'
          AND next_attempt_at<=now() AND
          ((status IN ('approved','failed') AND attempts<3) OR status='running')
        ORDER BY next_attempt_at,created_at FOR UPDATE SKIP LOCKED LIMIT 1`)).rows[0];
      if(!job)return {job:null as Job|null,processed:false};
      if(job.status==='running'&&job.attempts>=3){
        await client.query("UPDATE data_export_job SET status='failed',last_error_code='WORKER_INTERRUPTED',updated_at=now() WHERE id=$1",[job.id]);
        await client.query("UPDATE privacy_request SET status='failed',response='数据副本生成中断，请点击重试。',version=version+1,updated_at=now() WHERE id=$1 AND status='executing'",[job.privacy_request_id]);
        await client.query(`INSERT INTO privacy_request_event(privacy_request_id,actor_id,event_type,detail)
          VALUES($1,'worker:formal-privacy','execution_failed',$2)`,[job.privacy_request_id,
          {jobId:job.id,code:'WORKER_INTERRUPTED',retryable:false}]);
        return {job:null as Job|null,processed:true};
      }
      const attempts=job.attempts+1;
      await client.query(`UPDATE data_export_job SET status='running',attempts=$2,
        next_attempt_at=now()+interval '3 minutes',updated_at=now() WHERE id=$1`,[job.id,attempts]);
      await client.query("UPDATE privacy_request SET status='executing',version=version+1,updated_at=now() WHERE id=$1 AND status='approved'",[job.privacy_request_id]);
      return {job:{...job,attempts,status:'running'},processed:true};
    });
    if(!claim.processed)return false;
    if(!claim.job)return true;
    const job=claim.job;
    try{
      const snapshot=await transaction(this.pool,async client=>{
        const revision=await erasureRevision(client,job.member_id);
        const authority=(await client.query<{valid:boolean}>(`SELECT EXISTS(
          SELECT 1 FROM privacy_request p JOIN member m ON m.id=p.member_id
          JOIN wechat_identity w ON w.member_id=m.id
          JOIN data_export_job j ON j.privacy_request_id=p.id
          WHERE p.id=$1 AND p.member_id=$2 AND p.kind='access' AND p.status='executing'
            AND m.status IN ('active','deleted') AND w.provider='wechat_miniprogram'
            AND j.id=$3 AND j.member_id=m.id AND j.status='running' AND j.attempts=$4
            AND j.requested_by='member:'||m.id::text
            AND j.approved_by='system:verified-self' AND j.scope->>'formalSelfService'='true') AS valid`,
          [job.privacy_request_id,job.member_id,job.id,job.attempts])).rows[0]?.valid;
        if(!authority)throw new DomainError('PRIVACY_EXECUTION_AUTHORITY_CHANGED','申请身份或范围已变化',409);
        return {revision,data:await collectMemberPortableData(client,this.config,this.addresses,job.member_id)};
      },'REPEATABLE READ READ ONLY',1,20_000);
      const budget=new OperationBudget(120_000);
      let copy:Awaited<ReturnType<typeof materializeMemberPortableData>>;
      try{copy=await runWithOperationBudget(budget,()=>materializeMemberPortableData(snapshot.data,this.storage));}
      finally{budget.dispose();}
      await failBeforeArchiveWrite?.();
      const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv);
      const ciphertext=Buffer.concat([cipher.update(copy.bytes),cipher.final()]);
      const digest=createHash('sha256').update(ciphertext).digest('hex');
      await transaction(this.pool,async client=>{
        const locked=(await client.query<{attempts:number;status:string}>(
          'SELECT attempts,status FROM data_export_job WHERE id=$1 FOR UPDATE',[job.id])).rows[0];
        if(!locked||locked.status!=='running'||locked.attempts!==job.attempts)
          throw new DomainError('PRIVACY_EXPORT_LEASE_CHANGED','数据副本处理状态已变化',409);
        // Hold the subject through publication. A concurrent erasure either
        // completes first and changes the revision, or waits and then revokes
        // this new artifact. No unlocked check/insert window is permitted.
        const subject=await client.query(`SELECT m.id FROM member m
          JOIN wechat_identity w ON w.member_id=m.id WHERE m.id=$1
          AND m.status IN ('active','deleted') AND w.provider='wechat_miniprogram'
          FOR SHARE OF m,w`,[job.member_id]);
        const request=await client.query(`SELECT id FROM privacy_request
          WHERE id=$1 AND member_id=$2 AND kind='access' AND status='executing'
          FOR UPDATE`,[job.privacy_request_id,job.member_id]);
        if(!subject.rowCount||!request.rowCount||
          await erasureRevision(client,job.member_id)!==snapshot.revision)
          throw new DomainError('PRIVACY_EXECUTION_AUTHORITY_CHANGED','申请身份或范围已变化',409);
        const dbTime=(await client.query<{now:Date}>('SELECT clock_timestamp() AS now')).rows[0]!.now;
        const expiresAt=new Date(dbTime.getTime()+lifetimeMs);
        await client.query(`INSERT INTO privacy_export_artifact(job_id,member_id,ciphertext,iv,auth_tag,expires_at)
          VALUES($1,$2,$3,$4,$5,$6)`,[job.id,job.member_id,ciphertext,iv,cipher.getAuthTag(),expiresAt]);
        const manifest={schema:'cisme.member.portable.v1',format:'json',bytes:copy.bytes.length,
          sections:copy.sectionNames,unavailableMedia:copy.unavailableMedia};
        await client.query(`UPDATE data_export_job SET status='succeeded',manifest=$2,archive_object_key=$3,
          result_sha256=$4,archive_expires_at=$5,completed_at=now(),last_error_code=NULL,updated_at=now()
          WHERE id=$1`,[job.id,manifest,`private-db/${job.id}`,digest,expiresAt]);
        await client.query(`UPDATE privacy_request SET status=$2,resolution_code=$3,response=$4,
          completed_at=now(),version=version+1,updated_at=now() WHERE id=$1`,[job.privacy_request_id,
          copy.complete?'completed':'partially_completed',copy.complete?'FORMAL_DATA_COPY_READY':'FORMAL_DATA_COPY_MEDIA_PENDING',
          copy.complete?'数据副本已生成，请在有效期内获取。':'数据副本已生成；部分素材需通过小程序客服继续获取。']);
        await client.query(`INSERT INTO privacy_request_event(privacy_request_id,actor_id,event_type,detail)
          VALUES($1,'worker:formal-privacy',$2,$3)`,[job.privacy_request_id,
          copy.complete?'execution_succeeded':'execution_partially_succeeded',
          {jobId:job.id,expiresAt,sections:copy.sectionNames,unavailableMediaCount:copy.unavailableMedia.length}]);
        await client.query(`INSERT INTO audit_log(principal_id,action,object_type,object_id,reason_code,
          after_state,trace_id) VALUES('worker:formal-privacy','privacy.export.generate','privacy_request',$1,
          'VERIFIED_MEMBER_EXPORT',$2,gen_random_uuid()::text)`,[job.privacy_request_id,
          {jobId:job.id,bytes:copy.bytes.length,complete:copy.complete}]);
      },'READ COMMITTED',1,20_000);
    }catch(error){
      const code=error instanceof DomainError?error.code:'EXPORT_TASK_FAILED';
      const terminal=code==='PRIVACY_EXPORT_TOO_LARGE';
      await transaction(this.pool,async client=>{
        const changed=await client.query(`UPDATE data_export_job SET status='failed',attempts=CASE WHEN $3 THEN 3 ELSE attempts END,
          last_error_code=$2,next_attempt_at=now()+interval '30 seconds',updated_at=now()
          WHERE id=$1 AND status='running' AND attempts=$4 RETURNING id`,[job.id,code,terminal,job.attempts]);
        if(!changed.rowCount)return;
        const exhausted=terminal||job.attempts>=3;
        if(exhausted)await client.query(`UPDATE privacy_request SET status='failed',response=$2,
          version=version+1,updated_at=now() WHERE id=$1 AND status='executing'`,[job.privacy_request_id,
          terminal?'数据量超出单次副本上限，当前无法生成完整副本；请联系小程序客服说明所需资料范围。':'数据副本生成未完成，请点击重试。']);
        await client.query(`INSERT INTO privacy_request_event(privacy_request_id,actor_id,event_type,detail)
          VALUES($1,'worker:formal-privacy','execution_failed',$2)`,[job.privacy_request_id,
          {jobId:job.id,code,retryable:!exhausted}]);
      });
    }
    return true;
  }

  async download(memberId:string|undefined,requestId:string,closedRights=false):Promise<Buffer>{
    const key=this.key();
    if(!memberId||!uuid.test(requestId))throw new DomainError('PRIVACY_EXPORT_NOT_FOUND','数据副本不存在',404);
    return transaction(this.pool,async client=>{
      const job=await client.query(`SELECT id FROM data_export_job WHERE privacy_request_id=$1 AND member_id=$2
        AND scope->>'formalSelfService'='true' FOR SHARE`,[requestId,memberId]);
      if(!job.rowCount)throw new DomainError('PRIVACY_EXPORT_NOT_FOUND','数据副本不存在',404);
      const subject=await client.query(`SELECT 1 FROM member m JOIN wechat_identity w ON w.member_id=m.id
        WHERE m.id=$1 AND m.status=$2 AND w.provider='wechat_miniprogram' FOR SHARE`,
        [memberId,closedRights?'deleted':'active']);
      if(!subject.rowCount)throw new DomainError('PRIVACY_EXPORT_NOT_FOUND','数据副本不存在',404);
      const artifact=(await client.query<{ciphertext:Buffer;iv:Buffer;auth_tag:Buffer;expires_at:Date}>(`SELECT a.ciphertext,a.iv,a.auth_tag,a.expires_at
        FROM privacy_export_artifact a JOIN data_export_job j ON j.id=a.job_id
        JOIN privacy_request p ON p.id=j.privacy_request_id
        WHERE p.id=$1 AND p.member_id=$2 AND j.member_id=$2 AND a.member_id=$2
          AND j.status='succeeded' AND a.revoked_at IS NULL AND a.expires_at>clock_timestamp()
          AND j.archive_expires_at>clock_timestamp() FOR SHARE OF a,j,p`,[requestId,memberId])).rows[0];
      if(!artifact)throw new DomainError('PRIVACY_EXPORT_NOT_FOUND','数据副本不存在或已失效',404);
      if(artifact.expires_at<=new Date())throw new DomainError('PRIVACY_EXPORT_NOT_FOUND','数据副本已过期',404);
      try{
        const decipher=createDecipheriv('aes-256-gcm',key,artifact.iv);
        decipher.setAuthTag(artifact.auth_tag);
        const bytes=Buffer.concat([decipher.update(artifact.ciphertext),decipher.final()]);
        await client.query(`INSERT INTO audit_log(principal_id,action,object_type,object_id,
          reason_code,after_state,trace_id) VALUES($1,'privacy.export.download','privacy_request',$2,
          'VERIFIED_MEMBER_DOWNLOAD',$3,gen_random_uuid()::text)`,[`member:${memberId}`,requestId,{bytes:bytes.length}]);
        return bytes;
      }catch{throw new DomainError('PRIVACY_EXPORT_UNAVAILABLE','数据副本暂不可读取',503);}
    });
  }

  /** Deliver a single owned asset omitted from the bounded inline archive.
   * Keep the subject, artifact and media locked while reading COS so
   * a concurrent erasure cannot revoke the copy during this response. */
  async downloadSupplementaryMedia(memberId:string|undefined,requestId:string,mediaId:string,closedRights=false){
    this.key();
    if(!memberId||!uuid.test(requestId)||!uuid.test(mediaId))
      throw new DomainError('PRIVACY_EXPORT_NOT_FOUND','补充素材不存在',404);
    return transaction(this.pool,async client=>{
      const subject=await client.query(`SELECT 1 FROM member m JOIN wechat_identity w ON w.member_id=m.id
        WHERE m.id=$1 AND m.status=$2 AND w.provider='wechat_miniprogram' FOR SHARE OF m,w`,
        [memberId,closedRights?'deleted':'active']);
      if(!subject.rowCount)throw new DomainError('PRIVACY_EXPORT_NOT_FOUND','补充素材不存在',404);
      const job=(await client.query<{manifest:{unavailableMedia?:Array<{id:string;kind:string;reason:string}>}}>(`
        SELECT j.manifest FROM data_export_job j JOIN privacy_request p ON p.id=j.privacy_request_id
        JOIN privacy_export_artifact a ON a.job_id=j.id
        WHERE p.id=$1 AND p.member_id=$2 AND p.kind='access' AND p.status='partially_completed'
          AND j.member_id=$2 AND j.status='succeeded' AND j.scope->>'formalSelfService'='true'
          AND a.member_id=$2 AND a.revoked_at IS NULL AND a.expires_at>clock_timestamp()
          AND j.archive_expires_at>clock_timestamp() FOR SHARE OF j,p,a`,[requestId,memberId])).rows[0];
      const listed=job?.manifest?.unavailableMedia?.find(row=>row.id===mediaId&&
        ['inline_copy_size_limit','video_requires_separate_copy'].includes(row.reason)&&
        ['member_upload','community_upload'].includes(row.kind));
      if(!listed)throw new DomainError('PRIVACY_EXPORT_NOT_FOUND','补充素材不存在或已失效',404);
      const media=listed.kind==='community_upload'
        ?(await client.query<{object_key:string;mime_type:string;size_bytes:string}>(`
          SELECT object_key,mime_type,size_bytes FROM ugc_media_asset WHERE id=$1 AND owner_member_id=$2
          AND kind=$3 AND state IN ('uploaded','scanning','approved','rejected') FOR SHARE`,
          [mediaId,memberId,listed.reason==='video_requires_separate_copy'?'video':'image'])).rows[0]
        :(await client.query<{object_key:string;mime_type:string;size_bytes:string}>(`
          SELECT m.object_key,m.mime_type,m.size_bytes FROM media_object m
          WHERE m.id=$1 AND m.upload_state='uploaded' AND m.deleted_at IS NULL AND
          (EXISTS(SELECT 1 FROM submission s WHERE s.id=m.submission_id AND s.member_id=$2)
            OR EXISTS(SELECT 1 FROM support_conversation c WHERE c.id=m.support_conversation_id AND c.member_id=$2))
          FOR SHARE OF m`,[mediaId,memberId])).rows[0];
      const expectedMime=listed.reason==='video_requires_separate_copy'?'video/mp4':null;
      const size=Number(media?.size_bytes);
      if(!media||!Number.isSafeInteger(size)||size<1||size>maxSupplementaryBytes||
        (expectedMime?media.mime_type!==expectedMime:!['image/jpeg','image/png','image/webp'].includes(media.mime_type)))
        throw new DomainError('PRIVACY_EXPORT_NOT_FOUND','补充素材不存在或已失效',404);
      const object=await this.storage.read(media.object_key,maxSupplementaryBytes).catch(error=>{
        if(error instanceof DomainError&&error.code==='STORAGE_READ_LIMIT_EXCEEDED')
          throw new DomainError('PRIVACY_EXPORT_UNAVAILABLE','补充素材暂不可读取',503);
        throw error;
      });
      if(object.mimeType!==media.mime_type||object.bytes.byteLength>maxSupplementaryBytes)
        throw new DomainError('PRIVACY_EXPORT_UNAVAILABLE','补充素材暂不可读取',503);
      await client.query(`INSERT INTO audit_log(principal_id,action,object_type,object_id,reason_code,
        after_state,trace_id) VALUES($1,'privacy.export.supplementary_media','privacy_request',$2,
        'VERIFIED_MEMBER_MEDIA_DOWNLOAD',$3,gen_random_uuid()::text)`,[`member:${memberId}`,requestId,
        {mediaId,kind:listed.kind,bytes:object.bytes.byteLength}]);
      return object;
    },'READ COMMITTED',1,40_000);
  }

  async revoke(memberId:string|undefined,requestId:string,closedRights=false){
    this.key();
    if(!memberId||!uuid.test(requestId))throw new DomainError('PRIVACY_EXPORT_NOT_FOUND','数据副本不存在',404);
    return transaction(this.pool,async client=>{
      const subject=await client.query(`SELECT 1 FROM member m JOIN wechat_identity w ON w.member_id=m.id
        WHERE m.id=$1 AND m.status=$2 AND w.provider='wechat_miniprogram' FOR SHARE`,
        [memberId,closedRights?'deleted':'active']);
      if(!subject.rowCount)throw new DomainError('PRIVACY_EXPORT_NOT_FOUND','数据副本不存在',404);
      const result=await client.query(`UPDATE privacy_export_artifact a SET revoked_at=now()
        FROM data_export_job j WHERE a.job_id=j.id AND j.privacy_request_id=$1 AND j.member_id=$2
          AND j.scope->>'formalSelfService'='true' AND a.member_id=$2 AND a.revoked_at IS NULL
        RETURNING a.job_id`,[requestId,memberId]);
      if(!result.rowCount)throw new DomainError('PRIVACY_EXPORT_NOT_FOUND','数据副本不存在或已撤销',404);
      await client.query(`INSERT INTO audit_log(principal_id,action,object_type,object_id,
        reason_code,trace_id) VALUES($1,'privacy.export.revoke','privacy_request',$2,
        'VERIFIED_MEMBER_REVOKE',gen_random_uuid()::text)`,[`member:${memberId}`,requestId]);
      return {requestId,revoked:true};
    });
  }

  async retry(memberId:string|undefined,requestId:string,closedRights=false){
    this.key();
    if(!memberId||!uuid.test(requestId))throw new DomainError('PRIVACY_EXPORT_NOT_FOUND','数据副本申请不存在',404);
    return transaction(this.pool,async client=>{
      const job=(await client.query<{id:string;status:string;attempts:number;member_id:string;last_error_code:string|null}>(`SELECT id,status,attempts,member_id,last_error_code
        FROM data_export_job WHERE privacy_request_id=$1 AND member_id=$2
          AND scope->>'formalSelfService'='true' FOR UPDATE`,[requestId,memberId])).rows[0];
      const request=(await client.query<{status:string;member_id:string;kind:string}>(`SELECT status,member_id,kind
        FROM privacy_request WHERE id=$1 FOR UPDATE`,[requestId])).rows[0];
      const subject=(await client.query(`SELECT 1 FROM member m JOIN wechat_identity w ON w.member_id=m.id
        WHERE m.id=$1 AND m.status=$2 AND w.provider='wechat_miniprogram' FOR SHARE`,
        [memberId,closedRights?'deleted':'active'])).rowCount;
      if(!job||!request||request.member_id!==memberId||request.kind!=='access'||!subject)
        throw new DomainError('PRIVACY_EXPORT_NOT_FOUND','数据副本申请不存在',404);
      if(job.last_error_code==='PRIVACY_EXPORT_TOO_LARGE')
        throw new DomainError('PRIVACY_EXPORT_RETRY_NOT_SUPPORTED','副本超过单次上限，原样重试无法完成；请联系小程序客服说明所需资料范围',409);
      if(job.status!=='failed'||job.attempts<3||request.status!=='failed')
        throw new DomainError('PRIVACY_EXPORT_RETRY_NOT_READY','请先刷新处理结果',409);
      await client.query(`UPDATE data_export_job SET attempts=0,next_attempt_at=now(),last_error_code=NULL,
        updated_at=now() WHERE id=$1`,[job.id]);
      await client.query("UPDATE privacy_request SET status='approved',version=version+1,updated_at=now() WHERE id=$1",[requestId]);
      await client.query(`INSERT INTO privacy_request_event(privacy_request_id,actor_id,event_type,detail)
        VALUES($1,$2,'approved',$3)`,[requestId,`member:${memberId}`,{jobId:job.id,retry:true}]);
      await client.query(`INSERT INTO audit_log(principal_id,action,object_type,object_id,reason_code,
        trace_id) VALUES($1,'privacy.export.retry','privacy_request',$2,
        'VERIFIED_MEMBER_RETRY',gen_random_uuid()::text)`,[`member:${memberId}`,requestId]);
      return {requestId,status:'approved',retry:true};
    });
  }
}
