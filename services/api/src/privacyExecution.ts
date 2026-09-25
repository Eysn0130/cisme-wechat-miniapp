import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import type pg from 'pg';
import { DomainError } from '@cisme/domain';
import { transaction, type DbClient } from './db.js';
import { requirePrivacyActor } from './privacyAuthority.js';

const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const reason=/^[A-Z][A-Z0-9_]{2,79}$/;
const maxArchiveBytes=1024*1024;
const archiveLifetimeMs=60*60*1000; // synthetic test policy, not an external retention promise

type ExportJob={id:string;privacy_request_id:string;member_id:string;requested_by:string;status:string;attempts:number};
type ExecutableJob=ExportJob&{approved_by:string|null;scope:Record<string,unknown>};
type ErasureJob=ExportJob&{dry_run:boolean;erasure_mode:string;scope:Record<string,unknown>;request_status:string;request_version:number;scope_code:string|null};

/** This executor has no production mode. Every operation requires a test-only key. */
export class SyntheticPrivacyExecution {
  constructor(private pool:pg.Pool, private environment:string, private keyHex:string|null) {}

  private key():Buffer {
    if(this.environment!=='test'||!this.keyHex||!/^[0-9a-fA-F]{64}$/.test(this.keyHex))
      throw new DomainError('PRIVACY_SYNTHETIC_EXECUTION_DISABLED','合成隐私执行未启用',503);
    return Buffer.from(this.keyHex,'hex');
  }

  async approveExport(principalId:string,requestId:string,input:{reasonCode?:unknown;expectedVersion?:unknown}|undefined,actorMemberId?:string) {
    this.key();
    if(!uuid.test(requestId))throw new DomainError('PRIVACY_REQUEST_NOT_FOUND','受理记录不存在',404);
    if(typeof input?.reasonCode!=='string'||!reason.test(input.reasonCode)||!Number.isInteger(input.expectedVersion)||Number(input.expectedVersion)<1)
      throw new DomainError('PRIVACY_APPROVAL_INVALID','请提供有效原因码和当前版本',422);
    const reasonCode=input.reasonCode;
    return transaction(this.pool,async client=>{
      const role=await client.query("SELECT 1 FROM principal_role WHERE principal_id=$1 AND role='review_lead'",[principalId]);
      if(!role.rowCount)throw new DomainError('PRIVACY_EXECUTOR_REQUIRED','仅复核负责人可批准',403);
      // Match worker lock order: job, request, then current authority.
      await client.query('SELECT id FROM data_export_job WHERE privacy_request_id=$1 FOR UPDATE',[requestId]);
      const found=await client.query<ExportJob&{request_status:string;request_version:number;scope:Record<string,unknown>}>(`SELECT j.id,j.privacy_request_id,j.member_id,j.requested_by,j.status,j.attempts,j.scope,pr.status AS request_status,pr.version AS request_version
        FROM data_export_job j JOIN privacy_request pr ON pr.id=j.privacy_request_id WHERE pr.id=$1 FOR UPDATE OF j,pr`,[requestId]);
      await requirePrivacyActor(client,actorMemberId);
      await this.requireReviewer(client,principalId);
      const job=found.rows[0];
      if(!job)throw new DomainError('PRIVACY_EXPORT_NOT_FOUND','导出计划不存在',404);
      if(job.requested_by===principalId)throw new DomainError('PRIVACY_DUAL_REVIEW_REQUIRED','计划人与复核人必须不同',403);
      if(job.request_version!==input.expectedVersion)throw new DomainError('PRIVACY_REQUEST_CHANGED','受理记录已变化，请刷新后重试',409);
      if(job.status!=='planned'||job.request_status!=='reviewing'||job.scope.profile!=='member_portable_copy_v1')
        throw new DomainError('PRIVACY_EXPORT_NOT_APPROVABLE','计划状态或范围不允许批准',409);
      const dev=await client.query("SELECT 1 FROM wechat_identity WHERE member_id=$1 AND provider='dev_test'",[job.member_id]);
      if(!dev.rowCount)throw new DomainError('PRIVACY_SYNTHETIC_IDENTITY_REQUIRED','仅合成身份可执行',403);
      await client.query(`UPDATE data_export_job SET scope=$2,execution_mode='generate_archive',approved_by=$3,status='approved',updated_at=now() WHERE id=$1`,
        [job.id,{syntheticOnly:true,profile:'member_portable_copy_v1'},principalId]);
      await client.query("UPDATE privacy_request SET status='approved',version=version+1,updated_at=now() WHERE id=$1",[requestId]);
      await client.query(`INSERT INTO privacy_request_event(privacy_request_id,actor_id,event_type,detail)
        VALUES($1,$2,'approved',$3)`,[requestId,principalId,{jobId:job.id,scope:'member_portable_copy_v1'}]);
      await client.query(`INSERT INTO audit_log(principal_id,action,object_type,object_id,reason_code,before_state,after_state,trace_id)
        VALUES($1,'privacy.export.approve','privacy_request',$2,$3,$4,$5,gen_random_uuid()::text)`,
        [principalId,requestId,reasonCode,{jobStatus:job.status,requestStatus:job.request_status},{jobStatus:'approved',scope:'member_portable_copy_v1'}]);
      return {requestId,jobId:job.id,status:'approved',scope:'member_portable_copy_v1'};
    });
  }

  async approveProfileErasure(principalId:string,requestId:string,input:{reasonCode?:unknown;expectedVersion?:unknown}|undefined,actorMemberId?:string) {
    this.key();
    if(!uuid.test(requestId))throw new DomainError('PRIVACY_REQUEST_NOT_FOUND','受理记录不存在',404);
    if(typeof input?.reasonCode!=='string'||!reason.test(input.reasonCode)||!Number.isInteger(input.expectedVersion)||Number(input.expectedVersion)<1)
      throw new DomainError('PRIVACY_APPROVAL_INVALID','请提供有效原因码和当前版本',422);
    return transaction(this.pool,async client=>{
      const role=await client.query("SELECT 1 FROM principal_role WHERE principal_id=$1 AND role='review_lead'",[principalId]);
      if(!role.rowCount)throw new DomainError('PRIVACY_EXECUTOR_REQUIRED','仅复核负责人可批准',403);
      await client.query('SELECT id FROM data_erasure_job WHERE privacy_request_id=$1 FOR UPDATE',[requestId]);
      const job=(await client.query<ErasureJob>(`SELECT j.id,j.privacy_request_id,j.member_id,j.requested_by,j.status,j.attempts,j.dry_run,j.erasure_mode,j.scope,
        pr.status AS request_status,pr.version AS request_version,pr.scope_code FROM data_erasure_job j
        JOIN privacy_request pr ON pr.id=j.privacy_request_id WHERE pr.id=$1 FOR UPDATE OF j,pr`,[requestId])).rows[0];
      await requirePrivacyActor(client,actorMemberId);
      await this.requireReviewer(client,principalId);
      if(!job)throw new DomainError('PRIVACY_ERASURE_NOT_FOUND','删除计划不存在',404);
      if(job.requested_by===principalId)throw new DomainError('PRIVACY_DUAL_REVIEW_REQUIRED','计划人与复核人必须不同',403);
      if(job.request_version!==input.expectedVersion)throw new DomainError('PRIVACY_REQUEST_CHANGED','受理记录已变化，请刷新后重试',409);
      if(job.status!=='planned'||job.request_status!=='reviewing'||!job.dry_run||job.erasure_mode!=='delete_scope'||
        job.scope_code!=='member_profile_handle_v1'||job.scope.scopeCode!==job.scope_code)
        throw new DomainError('PRIVACY_ERASURE_NOT_APPROVABLE','计划状态或范围不允许批准',409);
      const dev=await client.query("SELECT 1 FROM wechat_identity WHERE member_id=$1 AND provider='dev_test'",[job.member_id]);
      if(!dev.rowCount)throw new DomainError('PRIVACY_SYNTHETIC_IDENTITY_REQUIRED','仅合成身份可执行',403);
      const policy=await client.query(`SELECT 1 FROM data_retention_policy WHERE code='synthetic_profile_handle_v1'
        AND data_class='member_profile.wechat_handle' AND disposition='delete' AND enforcement_state='enforced' AND active=true`);
      if(!policy.rowCount)throw new DomainError('PRIVACY_RETENTION_POLICY_PENDING','合成资料字段政策尚未启用',409);
      const held=await client.query(`SELECT 1 FROM legal_hold_binding binding JOIN legal_hold hold ON hold.id=binding.hold_id
        WHERE binding.object_type IN ('member','member_profile') AND binding.object_id=$1 AND hold.status='active' AND hold.expires_at>now() LIMIT 1`,[job.member_id]);
      if(held.rowCount)throw new DomainError('PRIVACY_LEGAL_HOLD_ACTIVE','存在有效保留，不能批准删除',409);
      await client.query(`UPDATE data_erasure_job SET scope=$2,dry_run=false,approved_by=$3,status='approved',updated_at=now() WHERE id=$1`,
        [job.id,{syntheticOnly:true,scopeCode:job.scope_code},principalId]);
      await client.query("UPDATE privacy_request SET status='approved',version=version+1,updated_at=now() WHERE id=$1",[requestId]);
      await client.query(`INSERT INTO privacy_request_event(privacy_request_id,actor_id,event_type,detail)
        VALUES($1,$2,'approved',$3)`,[requestId,principalId,{jobId:job.id,scopeCode:job.scope_code}]);
      await client.query(`INSERT INTO audit_log(principal_id,action,object_type,object_id,reason_code,before_state,after_state,trace_id)
        VALUES($1,'privacy.erasure.approve','privacy_request',$2,$3,$4,$5,gen_random_uuid()::text)`,
        [principalId,requestId,input.reasonCode,{jobStatus:job.status,requestStatus:job.request_status},
          {jobStatus:'approved',scopeCode:job.scope_code}]);
      return {requestId,jobId:job.id,status:'approved',scopeCode:job.scope_code};
    });
  }

  private async requireReviewer(client:DbClient,principalId:string) {
    const role=await client.query("SELECT 1 FROM principal_role WHERE principal_id=$1 AND role='review_lead' FOR SHARE",[principalId]);
    if(!role.rowCount)throw new DomainError('PRIVACY_EXECUTOR_REQUIRED','复核权限已变化，请刷新后重试',403);
  }

  private async archive(client:DbClient,memberId:string):Promise<Buffer> {
    // Fixed allow-list: no identity tokens, contact ciphertext, other members,
    // internal audit, security configuration, or shared UGC/order facts.
    const member=(await client.query<{id:string;display_name:string;created_at:Date}>(
      'SELECT id,display_name,created_at FROM member WHERE id=$1',[memberId])).rows[0];
    if(!member)throw new DomainError('PRIVACY_EXPORT_MEMBER_MISSING','申请主体不存在',409);
    const profile=(await client.query<{wechat_handle:string|null;updated_at:Date}>(
      'SELECT wechat_handle,updated_at FROM member_profile WHERE member_id=$1',[memberId])).rows[0]??null;
    const bytes=Buffer.from(JSON.stringify({schema:'cisme.synthetic.member_profile.v1',scope:'member_profile_only',
      member:{id:member.id,displayName:member.display_name,createdAt:member.created_at},
      profile:profile?{wechatHandle:profile.wechat_handle,updatedAt:profile.updated_at}:null}),'utf8');
    if(bytes.length>maxArchiveBytes)throw new DomainError('PRIVACY_EXPORT_TOO_LARGE','导出范围超出合成上限',409);
    return bytes;
  }

  private async requireExecutionAuthority(client:DbClient,job:ExecutableJob,type:'export'|'erasure') {
    // Approval is not a permanent grant. Hold the subject and both current
    // authorities through the same transaction as the resulting data change.
    const member=await client.query("SELECT 1 FROM member WHERE id=$1 AND status='active' FOR SHARE",[job.member_id]);
    const identity=await client.query("SELECT 1 FROM wechat_identity WHERE member_id=$1 AND provider='dev_test' FOR SHARE",[job.member_id]);
    const roles=await client.query(`SELECT principal_id FROM principal_role WHERE principal_id=ANY($1::text[])
      AND role='review_lead' ORDER BY principal_id FOR SHARE`,[[job.requested_by,job.approved_by]]);
    const request=(await client.query<{member_id:string;status:string;kind:string;scope_code:string|null}>(
      'SELECT member_id,status,kind,scope_code FROM privacy_request WHERE id=$1 FOR UPDATE',[job.privacy_request_id])).rows[0];
    if(!member.rowCount||!identity.rowCount||!job.approved_by||job.requested_by===job.approved_by||roles.rowCount!==2||
      !request||request.member_id!==job.member_id||request.status!=='executing'||job.scope.syntheticOnly!==true||
      (type==='export'?(request.kind!=='access'||job.scope.profile!=='member_portable_copy_v1'):
        (request.kind!=='delete'||request.scope_code!=='member_profile_handle_v1'||job.scope.scopeCode!==request.scope_code)))
      throw new DomainError('PRIVACY_EXECUTION_AUTHORITY_CHANGED','执行主体、审批权限或范围已变化',409);
  }

  /** One short transaction is the execution task: crash rolls back all facts. */
  async runExportOnce(failBeforeArchiveWrite?:()=>void):Promise<boolean> {
    const key=this.key();
    return transaction(this.pool,async client=>{
      const job=(await client.query<ExecutableJob>(`SELECT id,privacy_request_id,member_id,requested_by,approved_by,scope,status,attempts FROM data_export_job
        WHERE execution_mode='generate_archive' AND status IN ('approved','failed') AND attempts<3 AND next_attempt_at<=now()
        ORDER BY next_attempt_at,created_at FOR UPDATE SKIP LOCKED LIMIT 1`)).rows[0];
      if(!job)return false;
      await client.query("UPDATE data_export_job SET status='running',attempts=attempts+1,updated_at=now() WHERE id=$1",[job.id]);
      await client.query("UPDATE privacy_request SET status='executing',version=version+1,updated_at=now() WHERE id=$1 AND status='approved'",[job.privacy_request_id]);
      await client.query('SAVEPOINT archive_work');
      try{
        await this.requireExecutionAuthority(client,job,'export');
        const plaintext=await this.archive(client,job.member_id);
        failBeforeArchiveWrite?.();
        const iv=randomBytes(12);
        const cipher=createCipheriv('aes-256-gcm',key,iv);
        const ciphertext=Buffer.concat([cipher.update(plaintext),cipher.final()]);
        const authTag=cipher.getAuthTag();
        const expiresAt=new Date(Date.now()+archiveLifetimeMs);
        await client.query(`INSERT INTO privacy_export_artifact(job_id,member_id,ciphertext,iv,auth_tag,expires_at)
          VALUES($1,$2,$3,$4,$5,$6)`,[job.id,job.member_id,ciphertext,iv,authTag,expiresAt]);
        const sha=createHash('sha256').update(ciphertext).digest('hex');
        await client.query(`UPDATE data_export_job SET status='succeeded',manifest=$2,archive_object_key=$3,
          result_sha256=$4,archive_expires_at=$5,completed_at=now(),last_error_code=NULL,updated_at=now() WHERE id=$1`,
          [job.id,{scope:'member_profile_only',format:'json',bytes:plaintext.length},`private-db/${job.id}`,sha,expiresAt]);
        // This is explicitly partial: a member profile copy is not a full account export.
        await client.query(`UPDATE privacy_request SET status='partially_completed',resolution_code='SYNTHETIC_PROFILE_EXPORT_ONLY',
          completed_at=now(),version=version+1,updated_at=now() WHERE id=$1`,[job.privacy_request_id]);
        await client.query(`INSERT INTO privacy_request_event(privacy_request_id,actor_id,event_type,detail)
          VALUES($1,'worker:synthetic-privacy','execution_partially_succeeded',$2)`, [job.privacy_request_id,{jobId:job.id,scope:'member_profile_only',expiresAt}]);
      }catch(_error){
        await client.query('ROLLBACK TO SAVEPOINT archive_work');
        const exhausted=job.attempts+1>=3;
        await client.query(`UPDATE data_export_job SET status='failed',last_error_code='EXPORT_TASK_FAILED',
          next_attempt_at=now()+interval '5 seconds',updated_at=now() WHERE id=$1`,[job.id]);
        if(exhausted)await client.query("UPDATE privacy_request SET status='failed',version=version+1,updated_at=now() WHERE id=$1 AND status='executing'",[job.privacy_request_id]);
        await client.query(`INSERT INTO privacy_request_event(privacy_request_id,actor_id,event_type,detail)
          VALUES($1,'worker:synthetic-privacy','execution_failed',$2)`,[job.privacy_request_id,{jobId:job.id,retryable:!exhausted}]);
      }
      return true;
    });
  }

  /** A single explicitly scoped field erasure. Preserve the profile row and all other fields. */
  async runProfileErasureOnce(failAfterErasure?:()=>void):Promise<boolean> {
    this.key();
    return transaction(this.pool,async client=>{
      const job=(await client.query<ExecutableJob>(`SELECT id,privacy_request_id,member_id,requested_by,approved_by,scope,status,attempts FROM data_erasure_job
        WHERE dry_run=false AND erasure_mode='delete_scope' AND scope->>'syntheticOnly'='true'
        AND scope->>'scopeCode'='member_profile_handle_v1' AND status IN ('approved','failed')
        AND attempts<3 AND next_attempt_at<=now() ORDER BY next_attempt_at,created_at FOR UPDATE SKIP LOCKED LIMIT 1`)).rows[0];
      if(!job)return false;
      await client.query("UPDATE data_erasure_job SET status='running',attempts=attempts+1,updated_at=now() WHERE id=$1",[job.id]);
      await client.query("UPDATE privacy_request SET status='executing',version=version+1,updated_at=now() WHERE id=$1 AND status='approved'",[job.privacy_request_id]);
      await client.query('SAVEPOINT erasure_work');
      let activeHoldCount=0;
      try{
        await this.requireExecutionAuthority(client,job,'erasure');
        // The synthetic transaction blocks concurrent hold insertion/release
        // until its scoped row deletion and result receipt commit together.
        await client.query('LOCK TABLE legal_hold IN SHARE MODE');
        await client.query('LOCK TABLE legal_hold_binding IN SHARE MODE');
        activeHoldCount=Number((await client.query<{count:number}>(`SELECT count(*)::int AS count FROM legal_hold_binding binding
          JOIN legal_hold hold ON hold.id=binding.hold_id WHERE binding.object_type IN ('member','member_profile')
          AND binding.object_id=$1 AND hold.status='active' AND hold.expires_at>now()`,[job.member_id])).rows[0]?.count??0);
        if(activeHoldCount>0)throw new DomainError('PRIVACY_LEGAL_HOLD_ACTIVE','存在有效保留，不能删除',409);
        const policy=await client.query(`SELECT 1 FROM data_retention_policy WHERE code='synthetic_profile_handle_v1'
          AND data_class='member_profile.wechat_handle' AND disposition='delete' AND enforcement_state='enforced' AND active=true FOR SHARE`);
        if(!policy.rowCount)throw new DomainError('PRIVACY_RETENTION_POLICY_PENDING','合成资料字段政策尚未启用',409);
        const cleared=await client.query(`UPDATE member_profile SET wechat_handle=NULL,
          profile_revision=profile_revision+1,updated_at=clock_timestamp()
          WHERE member_id=$1 AND wechat_handle IS NOT NULL`,[job.member_id]);
        failAfterErasure?.();
        const manifest={scopeCode:'member_profile_handle_v1',deletedProfileRows:0,clearedHandleRows:cleared.rowCount??0,
          excludedClasses:['member','contact','address','care','orders','ugc','audit','object_storage']};
        const digest=createHash('sha256').update(JSON.stringify(manifest)).digest('hex');
        await client.query(`UPDATE data_erasure_job SET status='partially_succeeded',legal_hold_count=0,manifest=$2,
          result_sha256=$3,completed_at=now(),last_error_code=NULL,updated_at=now() WHERE id=$1`,[job.id,manifest,digest]);
        await client.query(`UPDATE privacy_request SET status='partially_completed',resolution_code='SYNTHETIC_PROFILE_HANDLE_ONLY',
          completed_at=now(),version=version+1,updated_at=now() WHERE id=$1`,[job.privacy_request_id]);
        await client.query(`INSERT INTO privacy_request_event(privacy_request_id,actor_id,event_type,detail)
          VALUES($1,'worker:synthetic-privacy','execution_partially_succeeded',$2)`,[job.privacy_request_id,{jobId:job.id,...manifest}]);
        await client.query(`INSERT INTO audit_log(principal_id,action,object_type,object_id,reason_code,before_state,after_state,trace_id)
          VALUES('worker:synthetic-privacy','privacy.erasure.apply','privacy_request',$1,'SYNTHETIC_PROFILE_HANDLE_ONLY',$2,$3,gen_random_uuid()::text)`,
          [job.privacy_request_id,{scopeCode:'member_profile_handle_v1',status:'running'},manifest]);
      }catch(error){
        await client.query('ROLLBACK TO SAVEPOINT erasure_work');
        const code=error instanceof DomainError && ['PRIVACY_LEGAL_HOLD_ACTIVE','PRIVACY_RETENTION_POLICY_PENDING'].includes(error.code)
          ?error.code:'ERASURE_TASK_FAILED';
        const exhausted=job.attempts+1>=3;
        await client.query(`UPDATE data_erasure_job SET status='failed',last_error_code=$2,legal_hold_count=$3,
          next_attempt_at=now()+interval '5 seconds',updated_at=now() WHERE id=$1`,[job.id,code,activeHoldCount]);
        if(exhausted)await client.query("UPDATE privacy_request SET status='failed',version=version+1,updated_at=now() WHERE id=$1 AND status='executing'",[job.privacy_request_id]);
        await client.query(`INSERT INTO privacy_request_event(privacy_request_id,actor_id,event_type,detail)
          VALUES($1,'worker:synthetic-privacy','execution_failed',$2)`,
          [job.privacy_request_id,{jobId:job.id,code,retryable:!exhausted}]);
      }
      return true;
    });
  }

  async redrive(principalId:string,requestId:string,input:{reasonCode?:unknown;expectedVersion?:unknown}|undefined,actorMemberId?:string) {
    this.key();
    if(!uuid.test(requestId))throw new DomainError('PRIVACY_REQUEST_NOT_FOUND','受理记录不存在',404);
    if(typeof input?.reasonCode!=='string'||!reason.test(input.reasonCode)||!Number.isInteger(input.expectedVersion)||Number(input.expectedVersion)<1)
      throw new DomainError('PRIVACY_REDRIVE_INVALID','请提供有效原因码和当前版本',422);
    return transaction(this.pool,async client=>{
      const role=await client.query("SELECT 1 FROM principal_role WHERE principal_id=$1 AND role='review_lead'",[principalId]);
      if(!role.rowCount)throw new DomainError('PRIVACY_EXECUTOR_REQUIRED','仅复核负责人可恢复执行',403);
      const exportJob=(await client.query<{id:string;status:string;attempts:number;execution_mode:string;scope:Record<string,unknown>}>(
        'SELECT id,status,attempts,execution_mode,scope FROM data_export_job WHERE privacy_request_id=$1 FOR UPDATE',[requestId])).rows[0];
      const erasureJob=exportJob?null:(await client.query<{id:string;status:string;attempts:number;dry_run:boolean;scope:Record<string,unknown>}>(
        'SELECT id,status,attempts,dry_run,scope FROM data_erasure_job WHERE privacy_request_id=$1 FOR UPDATE',[requestId])).rows[0];
      const request=(await client.query<{status:string;version:number;member_id:string;scope_code:string|null}>(
        'SELECT status,version,member_id,scope_code FROM privacy_request WHERE id=$1 FOR UPDATE',[requestId])).rows[0];
      await requirePrivacyActor(client,actorMemberId);
      await this.requireReviewer(client,principalId);
      if(!request)throw new DomainError('PRIVACY_REQUEST_NOT_FOUND','受理记录不存在',404);
      if(request.version!==input.expectedVersion)throw new DomainError('PRIVACY_REQUEST_CHANGED','受理记录已变化，请刷新后重试',409);
      if(request.status!=='failed')throw new DomainError('PRIVACY_REDRIVE_NOT_READY','请求尚未进入终止失败状态',409);
      const dev=await client.query("SELECT 1 FROM wechat_identity WHERE member_id=$1 AND provider='dev_test'",[request.member_id]);
      if(!dev.rowCount)throw new DomainError('PRIVACY_SYNTHETIC_IDENTITY_REQUIRED','仅合成身份可执行',403);
      let type:'export'|'erasure',jobId:string;
      if(exportJob && exportJob.status==='failed' && exportJob.attempts>=3 && exportJob.execution_mode==='generate_archive' &&
        exportJob.scope.syntheticOnly===true && exportJob.scope.profile==='member_portable_copy_v1') {
        type='export';jobId=exportJob.id;
        await client.query("UPDATE data_export_job SET attempts=0,last_error_code=NULL,next_attempt_at=now(),updated_at=now() WHERE id=$1",[jobId]);
      }else if(erasureJob && erasureJob.status==='failed' && erasureJob.attempts>=3 && !erasureJob.dry_run &&
        erasureJob.scope.syntheticOnly===true && erasureJob.scope.scopeCode==='member_profile_handle_v1' &&
        request.scope_code==='member_profile_handle_v1') {
        const policy=await client.query(`SELECT 1 FROM data_retention_policy WHERE code='synthetic_profile_handle_v1'
          AND data_class='member_profile.wechat_handle' AND disposition='delete' AND enforcement_state='enforced' AND active=true`);
        if(!policy.rowCount)throw new DomainError('PRIVACY_RETENTION_POLICY_PENDING','合成资料字段政策尚未启用',409);
        const hold=await client.query(`SELECT 1 FROM legal_hold_binding binding JOIN legal_hold hold ON hold.id=binding.hold_id
          WHERE binding.object_type IN ('member','member_profile') AND binding.object_id=$1 AND hold.status='active' AND hold.expires_at>now() LIMIT 1`,[request.member_id]);
        if(hold.rowCount)throw new DomainError('PRIVACY_LEGAL_HOLD_ACTIVE','存在有效保留，不能恢复删除',409);
        type='erasure';jobId=erasureJob.id;
        await client.query("UPDATE data_erasure_job SET attempts=0,last_error_code=NULL,next_attempt_at=now(),legal_hold_count=0,updated_at=now() WHERE id=$1",[jobId]);
      }else throw new DomainError('PRIVACY_REDRIVE_NOT_READY','作业未达到可复核恢复状态',409);
      await client.query("UPDATE privacy_request SET status='approved',version=version+1,updated_at=now() WHERE id=$1",[requestId]);
      await client.query(`INSERT INTO privacy_request_event(privacy_request_id,actor_id,event_type,detail)
        VALUES($1,$2,'approved',$3)`,[requestId,principalId,{redrive:true,type,jobId}]);
      await client.query(`INSERT INTO audit_log(principal_id,action,object_type,object_id,reason_code,before_state,after_state,trace_id)
        VALUES($1,'privacy.execution.redrive','privacy_request',$2,$3,$4,$5,gen_random_uuid()::text)`,
        [principalId,requestId,input.reasonCode,{status:'failed',attempts:3,type},{status:'approved',attempts:0,type}]);
      return {requestId,jobId,type,status:'approved',redriven:true};
    });
  }

  async download(memberId:string|undefined,requestId:string):Promise<Buffer> {
    const key=this.key();
    if(!memberId||!uuid.test(requestId))throw new DomainError('PRIVACY_EXPORT_NOT_FOUND','导出结果不存在',404);
    return transaction(this.pool,async client=>{
      // Workers/cleanup take job before artifact. Do not let the joined read
      // take artifact first and then wait for a job held by its own cleanup.
      const job=await client.query('SELECT id FROM data_export_job WHERE privacy_request_id=$1 AND member_id=$2 FOR SHARE',
        [requestId,memberId]);
      if(!job.rowCount)throw new DomainError('PRIVACY_EXPORT_NOT_FOUND','导出结果不存在或已失效',404);
      const subject=await client.query("SELECT 1 FROM member WHERE id=$1 AND status='active' FOR SHARE",[memberId]);
      if(!subject.rowCount)throw new DomainError('PRIVACY_EXPORT_NOT_FOUND','导出结果不存在或已失效',404);
      // A revocation already holding the artifact row must commit before this
      // read can authorize delivery. Audit and authorization commit together.
      const found=await client.query<{ciphertext:Buffer;iv:Buffer;auth_tag:Buffer;artifact_expires_at:Date;archive_expires_at:Date}>(`SELECT a.ciphertext,a.iv,a.auth_tag,
        a.expires_at AS artifact_expires_at,j.archive_expires_at FROM privacy_export_artifact a
        JOIN data_export_job j ON j.id=a.job_id JOIN privacy_request pr ON pr.id=j.privacy_request_id
        WHERE j.privacy_request_id=$1 AND j.member_id=$2 AND pr.member_id=$2
        AND a.member_id=$2 AND j.status='succeeded' AND a.revoked_at IS NULL AND a.expires_at>clock_timestamp()
        AND j.archive_expires_at>clock_timestamp() FOR SHARE OF a,j,pr`,[requestId,memberId]);
      const artifact=found.rows[0];
      if(!artifact)throw new DomainError('PRIVACY_EXPORT_NOT_FOUND','导出结果不存在或已失效',404);
      // A SELECT predicate may have been evaluated before a row-lock wait.
      // Recheck database wall time after all delivery locks are held.
      const valid=(await client.query<{valid:boolean}>(
        'SELECT LEAST($1::timestamptz,$2::timestamptz)>clock_timestamp() AS valid',
        [artifact.artifact_expires_at,artifact.archive_expires_at])).rows[0]?.valid;
      if(!valid)throw new DomainError('PRIVACY_EXPORT_NOT_FOUND','导出结果不存在或已失效',404);
      try{
        const decipher=createDecipheriv('aes-256-gcm',key,artifact.iv);
        decipher.setAuthTag(artifact.auth_tag);
        const bytes=Buffer.concat([decipher.update(artifact.ciphertext),decipher.final()]);
        await client.query(`INSERT INTO audit_log(principal_id,action,object_type,object_id,reason_code,before_state,after_state,trace_id)
          VALUES($1,'privacy.export.download','privacy_request',$2,'MEMBER_VIEW',
            jsonb_build_object('available',true),jsonb_build_object('deliveredBytes',$3::integer),gen_random_uuid()::text)`,
          [`member:${memberId}`,requestId,bytes.length]);
        return bytes;
      }catch{
        throw new DomainError('PRIVACY_EXPORT_UNAVAILABLE','导出结果暂不可读取',503);
      }
    });
  }

  async revoke(memberId:string|undefined,requestId:string) {
    this.key();
    if(!memberId||!uuid.test(requestId))throw new DomainError('PRIVACY_EXPORT_NOT_FOUND','导出结果不存在',404);
    return transaction(this.pool,async client=>{
      const active=await client.query("SELECT id FROM member WHERE id=$1 AND status='active' FOR SHARE",[memberId]);
      if(!active.rowCount)throw new DomainError('MEMBER_NOT_ACTIVE','账号暂不可变更导出结果',403);
      const result=await client.query<{privacy_request_id:string;job_id:string}>(`UPDATE privacy_export_artifact a SET revoked_at=now()
        FROM data_export_job j WHERE a.job_id=j.id AND j.privacy_request_id=$1 AND j.member_id=$2
        AND a.member_id=$2 AND a.revoked_at IS NULL RETURNING j.privacy_request_id,a.job_id`,[requestId,memberId]);
      if(!result.rows[0])throw new DomainError('PRIVACY_EXPORT_NOT_FOUND','导出结果不存在或已撤销',404);
      await client.query(`INSERT INTO audit_log(principal_id,action,object_type,object_id,reason_code,before_state,after_state,trace_id)
        VALUES($1,'privacy.export.revoke','privacy_request',$2,'MEMBER_REVOKE',
          jsonb_build_object('available',true),jsonb_build_object('available',false),gen_random_uuid()::text)`,
        [`member:${memberId}`,requestId]);
      return {requestId,revoked:true};
    });
  }

  async purgeArtifacts():Promise<number> {
    return purgeExpiredPrivacyArtifacts(this.pool);
  }
}

/** Ciphertext expiry is independent of the synthetic executor key. A restored
 * production database must not keep an expired or revoked downloadable copy. */
export async function purgeExpiredPrivacyArtifacts(pool:pg.Pool,limit=50):Promise<number> {
  if(!Number.isSafeInteger(limit)||limit<1||limit>100)throw new Error('PRIVACY_ARTIFACT_PURGE_LIMIT_INVALID');
  return transaction(pool,async client=>{
    const due=(await client.query<{job_id:string;privacy_request_id:string;expires_at:Date;revoked_at:Date|null;status:string;expired:boolean}>(
      `SELECT a.job_id,j.privacy_request_id,a.expires_at,a.revoked_at,j.status,
        a.expires_at<=clock_timestamp() AS expired
       FROM privacy_export_artifact a JOIN data_export_job j ON j.id=a.job_id
       WHERE a.expires_at<=clock_timestamp() OR a.revoked_at IS NOT NULL
       ORDER BY a.expires_at,a.job_id LIMIT $1 FOR UPDATE OF j,a SKIP LOCKED`,[limit])).rows;
    for(const row of due){
      if(row.status==='succeeded'&&row.expired)
        await client.query("UPDATE data_export_job SET status='expired',updated_at=now() WHERE id=$1",[row.job_id]);
      await client.query('DELETE FROM privacy_export_part WHERE job_id=$1',[row.job_id]);
      await client.query('DELETE FROM privacy_export_artifact WHERE job_id=$1',[row.job_id]);
      await client.query(`INSERT INTO audit_log(principal_id,action,object_type,object_id,reason_code,before_state,after_state,trace_id)
        VALUES('worker:privacy-retention','privacy.export.artifact_purge','privacy_request',$1,'EXPORT_COPY_EXPIRED_OR_REVOKED',$2,$3,gen_random_uuid()::text)`,
        [row.privacy_request_id,{jobId:row.job_id,expiresAt:row.expires_at,revoked:Boolean(row.revoked_at)},
          {ciphertextRemoved:true}]);
    }
    return due.length;
  });
}
