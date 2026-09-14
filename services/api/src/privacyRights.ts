import { createHash } from 'node:crypto';
import type pg from 'pg';
import { DomainError } from '@cisme/domain';
import { transaction, type DbClient } from './db.js';

const kinds = new Set(['access','correct','delete','close_account','withdraw','other']);
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function owner(id: string | undefined) {
  if (!id) throw new DomainError('AUTH_REQUIRED','请先登录以确认请求所属账号',401);
  return id;
}

function requestDigest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

const executionProjection = `COALESCE(
  (SELECT jsonb_build_object(
    'type','export','id',job.id,'status',job.status,'executionMode',job.execution_mode,
    'scope',CASE WHEN job.execution_mode='generate_archive' THEN 'member_profile_only' ELSE 'plan_only' END,
    'downloadAvailable',EXISTS(SELECT 1 FROM privacy_export_artifact artifact WHERE artifact.job_id=job.id
      AND artifact.revoked_at IS NULL AND artifact.expires_at>now() AND job.status='succeeded'),
    'deliveryState',CASE
      WHEN EXISTS(SELECT 1 FROM privacy_export_artifact artifact WHERE artifact.job_id=job.id AND artifact.revoked_at IS NOT NULL) THEN 'revoked'
      WHEN EXISTS(SELECT 1 FROM privacy_export_artifact artifact WHERE artifact.job_id=job.id AND artifact.expires_at<=now()) THEN 'expired'
      WHEN EXISTS(SELECT 1 FROM privacy_export_artifact artifact WHERE artifact.job_id=job.id AND artifact.revoked_at IS NULL AND artifact.expires_at>now()) THEN 'available'
      WHEN job.status='succeeded' THEN 'removed'
      ELSE 'not_ready' END,
    'archiveExpiresAt',job.archive_expires_at,
    'createdAt',job.created_at,'updatedAt',job.updated_at,'completedAt',job.completed_at
  ) FROM data_export_job job WHERE job.privacy_request_id=pr.id),
  (SELECT jsonb_build_object(
    'type','erasure','id',job.id,'status',job.status,'executionMode',CASE WHEN job.dry_run THEN 'dry_run' ELSE 'apply' END,
    'mode',job.erasure_mode,'legalHoldCount',job.legal_hold_count,
    'createdAt',job.created_at,'updatedAt',job.updated_at,'completedAt',job.completed_at
  ) FROM data_erasure_job job WHERE job.privacy_request_id=pr.id)
) AS execution`;

export class PrivacyRights {
  constructor(private pool: pg.Pool) {}

  async list(memberId: string | undefined) {
    return (await this.pool.query(`SELECT pr.id,pr.kind,pr.message,pr.status,pr.response,pr.version,pr.due_at,pr.resolution_code,pr.completed_at,pr.created_at,pr.updated_at,
      ${executionProjection}
      FROM privacy_request pr WHERE pr.member_id=$1 ORDER BY pr.created_at DESC LIMIT 100`,[owner(memberId)])).rows;
  }

  async submit(memberId: string | undefined, input: {kind?:unknown;message?:unknown}) {
    const id=owner(memberId);
    if(!input || typeof input.kind!=='string' || !kinds.has(input.kind) || typeof input.message!=='string' || !input.message.trim() || Array.from(input.message).length>2000) {
      throw new DomainError('PRIVACY_REQUEST_INVALID','请选择请求类型并填写不超过 2000 字的说明',422);
    }
    const message=input.message.trim();
    return transaction(this.pool,async client=>{
      // Prevent duplicate taps and unbounded per-account submission bursts.
      await client.query('SELECT id FROM member WHERE id=$1 FOR UPDATE',[id]);
      const existing=await client.query(`SELECT id,kind,status,version,due_at,created_at FROM privacy_request WHERE member_id=$1 AND kind=$2 AND message=$3 AND status NOT IN ('completed','rejected','canceled') ORDER BY created_at DESC LIMIT 1`,[id,input.kind,message]);
      if(existing.rows[0])return existing.rows[0];
      const count=await client.query(`SELECT count(*)::int AS count FROM privacy_request WHERE member_id=$1 AND created_at>now()-interval '1 day'`,[id]);
      if(count.rows[0].count>=10)throw new DomainError('PRIVACY_REQUEST_LIMIT','今天已提交多项请求，请查看已有受理记录',429);
      const created=(await client.query(`INSERT INTO privacy_request(member_id,kind,message,due_at)
        VALUES($1,$2,$3,now()+interval '30 days') RETURNING id,kind,status,version,due_at,created_at`,[id,input.kind,message])).rows[0];
      await client.query(`INSERT INTO privacy_request_event(privacy_request_id,actor_id,event_type,detail)
        VALUES($1,$2,'received',jsonb_build_object('kind',$3::text))`,[created.id,`member:${id}`,input.kind]);
      return created;
    });
  }

  async requireOperator(principalId:string) {
    const result=await this.pool.query("SELECT 1 FROM principal_role WHERE principal_id=$1 AND role IN ('support','review_lead')",[principalId]);
    if(!result.rowCount)throw new DomainError('PRIVACY_OPERATOR_REQUIRED','仅授权受理人员可访问数据权利请求',403);
  }

  async requireExecutor(principalId:string) {
    const result=await this.pool.query("SELECT 1 FROM principal_role WHERE principal_id=$1 AND role='review_lead'",[principalId]);
    if(!result.rowCount)throw new DomainError('PRIVACY_EXECUTOR_REQUIRED','仅复核负责人可建立数据权利执行计划',403);
  }

  async queue() {
    return (await this.pool.query(`SELECT pr.id,pr.member_id,pr.kind,pr.message,pr.status,pr.response,pr.version,pr.due_at,pr.resolution_code,pr.completed_at,pr.created_at,pr.updated_at,
      ${executionProjection}
      FROM privacy_request pr ORDER BY (pr.status IN ('completed','rejected','canceled')),pr.due_at,pr.created_at LIMIT 100`)).rows;
  }

  async respond(principalId:string,id:string,input:{status?:unknown;response?:unknown;expectedVersion?:unknown}) {
    await this.requireOperator(principalId);
    if(!uuidPattern.test(id))throw new DomainError('PRIVACY_REQUEST_NOT_FOUND','受理记录不存在',404);
    if(!input || !['reviewing','responded'].includes(String(input.status)) || typeof input.response!=='string' || !input.response.trim() || Array.from(input.response).length>4000 || !Number.isInteger(input.expectedVersion) || Number(input.expectedVersion)<1) {
      throw new DomainError('PRIVACY_RESPONSE_INVALID','请填写处理状态、具体回复与当前版本',422);
    }
    const response=input.response.trim();
    return transaction(this.pool,async client=>{
      const current=await client.query<{status:string;version:number}>('SELECT status,version FROM privacy_request WHERE id=$1 FOR UPDATE',[id]);
      if(!current.rowCount)throw new DomainError('PRIVACY_REQUEST_NOT_FOUND','受理记录不存在',404);
      if(current.rows[0]!.version!==input.expectedVersion)throw new DomainError('PRIVACY_REQUEST_CHANGED','受理记录已变化，请刷新后重试',409);
      if(['completed','partially_completed','rejected','canceled'].includes(current.rows[0]!.status))throw new DomainError('PRIVACY_REQUEST_CLOSED','受理记录已关闭，不可覆盖结果',409);
      const result=await client.query(`UPDATE privacy_request SET status=$2,response=$3,responded_by=$4,version=version+1,updated_at=now()
        WHERE id=$1 RETURNING id,status,response,version,due_at,updated_at`,[id,input.status,response,principalId]);
      await client.query(`INSERT INTO privacy_request_event(privacy_request_id,actor_id,event_type,detail)
        VALUES($1,$2,$3,jsonb_build_object('memberVisibleReply',true))`,[id,principalId,input.status==='reviewing'?'review_started':'responded']);
      await client.query(`INSERT INTO audit_log(principal_id,action,object_type,object_id,reason_code,before_state,after_state,trace_id)
        VALUES($1,'privacy.respond','privacy_request',$2,'USER_RIGHTS_RESPONSE',jsonb_build_object('status',$3::text,'version',$4::integer),jsonb_build_object('status',$5::text,'version',$6::integer),gen_random_uuid()::text)`,
      [principalId,id,current.rows[0]!.status,current.rows[0]!.version,input.status,result.rows[0].version]);
      // A reply never claims that deletion/export has actually been executed.
      return result.rows[0];
    });
  }

  async planExecution(principalId:string,id:string,idempotencyKey:string,input:{expectedVersion?:unknown;reasonCode?:unknown}) {
    await this.requireExecutor(principalId);
    if(!uuidPattern.test(id))throw new DomainError('PRIVACY_REQUEST_NOT_FOUND','受理记录不存在',404);
    if(!Number.isInteger(input?.expectedVersion) || Number(input.expectedVersion)<1 || typeof input?.reasonCode!=='string' || !/^[A-Z][A-Z0-9_]{2,79}$/.test(input.reasonCode)) {
      throw new DomainError('PRIVACY_EXECUTION_PLAN_INVALID','当前版本与大写原因码为必填',422);
    }
    const expectedVersion=Number(input.expectedVersion);
    const reasonCode=input.reasonCode;
    const operation='privacy.execution.plan';
    const hash=requestDigest({id,expectedVersion,reasonCode});
    return transaction(this.pool,async client=>{
      const replay=await client.query<{request_hash:string;response_body:Record<string,unknown>}>(`SELECT request_hash,response_body FROM idempotency_operation
        WHERE principal_id=$1 AND operation=$2 AND idempotency_key=$3`,[principalId,operation,idempotencyKey]);
      if(replay.rows[0]) {
        if(replay.rows[0].request_hash!==hash)throw new DomainError('IDEMPOTENCY_CONFLICT','幂等键已用于不同的执行计划',409);
        return replay.rows[0].response_body;
      }
      const current=await client.query<{member_id:string;kind:string;status:string;version:number}>('SELECT member_id,kind,status,version FROM privacy_request WHERE id=$1 FOR UPDATE',[id]);
      if(!current.rowCount)throw new DomainError('PRIVACY_REQUEST_NOT_FOUND','受理记录不存在',404);
      const row=current.rows[0]!;
      if(row.version!==expectedVersion)throw new DomainError('PRIVACY_REQUEST_CHANGED','受理记录已变化，请刷新后重试',409);
      if(['completed','partially_completed','rejected','canceled','executing'].includes(row.status))throw new DomainError('PRIVACY_REQUEST_CLOSED','当前状态不能建立新的执行计划',409);
      const existing=await client.query(`SELECT id FROM data_export_job WHERE privacy_request_id=$1 UNION ALL SELECT id FROM data_erasure_job WHERE privacy_request_id=$1 LIMIT 1`,[id]);
      if(existing.rowCount)throw new DomainError('PRIVACY_EXECUTION_ALREADY_PLANNED','该请求已有执行计划，请读取现有计划',409);

      let job:{id:string;status:string};
      let type:'export'|'erasure';
      let mode:string|undefined;
      if(row.kind==='access') {
        type='export';
        job=(await client.query<{id:string;status:string}>(`INSERT INTO data_export_job(privacy_request_id,member_id,scope,requested_by)
          VALUES($1,$2,$3,$4) RETURNING id,status`,[id,row.member_id,{profile:'member_portable_copy_v1'},principalId])).rows[0]!;
      } else if(['delete','close_account','withdraw'].includes(row.kind)) {
        type='erasure';
        mode=row.kind==='delete'?'delete_scope':row.kind==='close_account'?'close_account':'withdraw_purpose';
        job=(await client.query<{id:string;status:string}>(`INSERT INTO data_erasure_job(privacy_request_id,member_id,erasure_mode,dry_run,scope,requested_by)
          VALUES($1,$2,$3,true,$4,$5) RETURNING id,status`,[id,row.member_id,mode,{requestMessageScoped:true},principalId])).rows[0]!;
      } else {
        throw new DomainError('PRIVACY_EXECUTION_MANUAL_ONLY','更正与其他请求需要人工核验，不能生成自动执行计划',409);
      }
      const requestVersion=expectedVersion+1;
      await client.query("UPDATE privacy_request SET status='reviewing',version=$2,updated_at=now() WHERE id=$1",[id,requestVersion]);
      const response={requestId:id,requestVersion,jobId:job.id,type,status:job.status,executionMode:type==='erasure'?'dry_run':'plan_only',...(mode?{mode}:{})};
      await client.query(`INSERT INTO privacy_request_event(privacy_request_id,actor_id,event_type,detail)
        VALUES($1,$2,'execution_planned',$3)`,[id,principalId,{jobId:job.id,type,executionMode:response.executionMode}]);
      await client.query(`INSERT INTO audit_log(principal_id,action,object_type,object_id,reason_code,before_state,after_state,trace_id)
        VALUES($1,'privacy.execution.plan','privacy_request',$2,$3,jsonb_build_object('status',$4::text,'version',$5::integer),$6,gen_random_uuid()::text)`,
      [principalId,id,reasonCode,row.status,row.version,response]);
      await this.saveIdempotency(client,{principalId,operation,idempotencyKey,businessKey:`privacy-request:${id}:plan:v${expectedVersion}`,requestHash:hash,response});
      return response;
    });
  }

  private async saveIdempotency(client:DbClient,input:{principalId:string;operation:string;idempotencyKey:string;businessKey:string;requestHash:string;response:unknown}) {
    await client.query(`INSERT INTO idempotency_operation(principal_id,operation,idempotency_key,business_key,request_hash,response_status,response_body)
      VALUES($1,$2,$3,$4,$5,200,$6)`,[input.principalId,input.operation,input.idempotencyKey,input.businessKey,input.requestHash,input.response]);
  }
}
