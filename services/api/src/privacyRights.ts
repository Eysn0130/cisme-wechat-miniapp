import { createHash } from 'node:crypto';
import type pg from 'pg';
import { DomainError } from '@cisme/domain';
import { transaction, type DbClient } from './db.js';
import { requirePrivacyActor } from './privacyAuthority.js';
import type { AppEnvironment } from '@cisme/config';
import { AuthorityService } from './authority.js';
import { AccountClosure, applyAccountClosure, applyProfileErasure, applyConsentWithdrawal, type ConsentWithdrawalMarker } from './accountClosure.js';
import { randomUUID } from 'node:crypto';

const pageSize=30;
const base64UrlPattern=/^[A-Za-z0-9_-]+$/;
const terminalPrivacyStatuses=['completed','partially_completed','rejected','canceled'] as const;
const terminalPrivacySql=`pr.status IN (${terminalPrivacyStatuses.map(status=>`'${status}'`).join(',')})`;
type PrivacyPageCursor={v:1;scope:'member'|'queue';createdAt:string;id:string;dueAt?:string;terminal?:boolean};

function parsePageCursor(value:string|undefined,scope:PrivacyPageCursor['scope']):PrivacyPageCursor|null {
  if(value===undefined)return null;
  if(value.length>512||!base64UrlPattern.test(value))throw new DomainError('PRIVACY_PAGE_INVALID','分页位置无效，请刷新记录',422);
  try {
    const parsed=JSON.parse(Buffer.from(value,'base64url').toString('utf8')) as PrivacyPageCursor;
    const validDate=(date:unknown)=>typeof date==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(date)&&
      Number.isFinite(Date.parse(date))&&new Date(date).toISOString().slice(0,19)===date.slice(0,19);
    if(parsed.v!==1||parsed.scope!==scope||!uuidPattern.test(parsed.id)||!validDate(parsed.createdAt)||
      (scope==='queue'&&(!validDate(parsed.dueAt)||typeof parsed.terminal!=='boolean')))
      throw new Error('invalid cursor');
    return parsed;
  } catch {throw new DomainError('PRIVACY_PAGE_INVALID','分页位置无效，请刷新记录',422);}
}

function pageResult<T extends {id:string;cursor_created_at:string;cursor_due_at?:string;status?:string}>(rows:T[],scope:PrivacyPageCursor['scope']) {
  const items=rows.slice(0,pageSize),last=items.at(-1);
  const nextCursor=rows.length>pageSize&&last?Buffer.from(JSON.stringify({v:1,scope,createdAt:last.cursor_created_at,id:last.id,
    ...(scope==='queue'?{dueAt:last.cursor_due_at!,terminal:(terminalPrivacyStatuses as readonly string[]).includes(last.status!)}:{})} satisfies PrivacyPageCursor)).toString('base64url'):null;
  return {items:items.map(({cursor_created_at:unusedCreated,cursor_due_at:unusedDue,...row})=>row),nextCursor};
}

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
    'scope',CASE WHEN job.scope->>'formalSelfService'='true' THEN 'member_portable_copy_v1'
      WHEN job.execution_mode='generate_archive' THEN 'member_profile_only' ELSE 'plan_only' END,
    'downloadAvailable',EXISTS(SELECT 1 FROM privacy_export_artifact artifact WHERE artifact.job_id=job.id
      AND artifact.revoked_at IS NULL AND artifact.expires_at>now() AND job.status='succeeded'
      AND (job.manifest->>'schema' IS DISTINCT FROM 'cisme.member.portable.v2' OR
        (SELECT count(*)=(job.manifest->>'partCount')::int AND min(part_number)=1
          AND max(part_number)=(job.manifest->>'partCount')::int
         FROM privacy_export_part part WHERE part.job_id=job.id))),
    'partCount',CASE WHEN job.manifest->>'schema'='cisme.member.portable.v2'
      THEN (job.manifest->>'partCount')::int ELSE NULL END,
    'unavailableMediaCount',CASE WHEN job.manifest->>'schema'='cisme.member.portable.v2'
      THEN (job.manifest->>'unavailableMediaCount')::int ELSE NULL END,
    'deliveryState',CASE
      WHEN EXISTS(SELECT 1 FROM privacy_export_artifact artifact WHERE artifact.job_id=job.id AND artifact.revoked_at IS NOT NULL) THEN 'revoked'
      WHEN EXISTS(SELECT 1 FROM privacy_export_artifact artifact WHERE artifact.job_id=job.id AND artifact.expires_at<=now()) THEN 'expired'
      WHEN EXISTS(SELECT 1 FROM privacy_export_artifact artifact WHERE artifact.job_id=job.id AND artifact.revoked_at IS NULL AND artifact.expires_at>now()) THEN 'available'
      WHEN job.status='succeeded' THEN 'removed'
      ELSE 'not_ready' END,
    'archiveExpiresAt',job.archive_expires_at,
    'unavailableMedia',CASE WHEN job.scope->>'formalSelfService'='true'
      THEN COALESCE(job.manifest->'unavailableMedia','[]'::jsonb) ELSE '[]'::jsonb END,
    'lastErrorCode',job.last_error_code,
    'createdAt',job.created_at,'updatedAt',job.updated_at,'completedAt',job.completed_at
  ) FROM data_export_job job WHERE job.privacy_request_id=pr.id),
  (SELECT jsonb_build_object(
    'type','erasure','id',job.id,'status',job.status,'executionMode',CASE WHEN job.dry_run THEN 'dry_run' ELSE 'apply' END,
    'mode',job.erasure_mode,'scopeCode',job.scope->>'scopeCode','legalHoldCount',job.legal_hold_count,
    'createdAt',job.created_at,'updatedAt',job.updated_at,'completedAt',job.completed_at
  ) FROM data_erasure_job job WHERE job.privacy_request_id=pr.id)
) AS execution`;

const replyHistoryProjection = `(SELECT COALESCE(jsonb_agg(jsonb_build_object(
  'actor',history.actor,'body',history.body,'createdAt',history.created_at,'version',history.request_version)
  ORDER BY history.created_at,history.id), '[]'::jsonb) FROM (
    SELECT actor,body,created_at,request_version,id FROM (
      SELECT 'operator'::text AS actor,body,created_at,request_version,id FROM privacy_request_operator_reply
        WHERE privacy_request_id=pr.id
      UNION ALL
      SELECT 'member'::text AS actor,body,created_at,request_version,id FROM privacy_request_member_reply
        WHERE privacy_request_id=pr.id
    ) replies ORDER BY created_at DESC,id DESC LIMIT 20
  ) history) AS "replyHistory"`;

export class PrivacyRights {
  private readonly authority: AuthorityService;
  constructor(private pool: pg.Pool, private environment:AppEnvironment='production',private accountClosure?:AccountClosure,
    private formalExportEnabled=false) {
    this.authority=new AuthorityService(pool,environment);
  }

  private async requireQueueOperator(principalId:string,actorMemberId:string|undefined,mode:'role'|'capability',client?:DbClient) {
    if(mode==='capability') {
      if(client)await this.authority.requireWithClient(client,actorMemberId,'privacy.request.manage');
      else await this.authority.require(actorMemberId,'privacy.request.manage');
    } else await this.requireOperator(principalId,client);
  }

  async list(memberId: string | undefined, page?:{cursor?:string},closedRights=false) {
    const id=owner(memberId);
    const cursor=page?parsePageCursor(page.cursor,'member'):null;
    return transaction(this.pool,async client=>{
      const active=await client.query("SELECT id FROM member WHERE id=$1 AND status=$2 FOR SHARE",[id,closedRights?'deleted':'active']);
      if(!active.rowCount)throw new DomainError('MEMBER_NOT_ACTIVE','账号暂不可访问数据权利记录',403);
      const rows=(await client.query(`SELECT pr.id,pr.kind,pr.message,pr.scope_code,pr.target_ref,pr.status,pr.waiting_on AS "waitingOn",pr.response,pr.version,pr.due_at,pr.resolution_code,pr.completed_at,pr.created_at,pr.updated_at,
      (SELECT jsonb_build_object('body',reply.body,'createdAt',reply.created_at) FROM privacy_request_member_reply reply
        WHERE reply.privacy_request_id=pr.id ORDER BY reply.created_at DESC,reply.id DESC LIMIT 1) AS "latestMemberReply",
      ${page?`to_char(pr.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_created_at,`:''}
      ${replyHistoryProjection},${executionProjection}
      FROM privacy_request pr WHERE pr.member_id=$1
      ${cursor?'AND (pr.created_at,pr.id)<($2::timestamptz,$3::uuid)':''}
      ORDER BY pr.created_at DESC,pr.id DESC LIMIT ${page?pageSize+1:100}`,
      cursor?[id,cursor.createdAt,cursor.id]:[id])).rows;
      return page?pageResult(rows,'member'):rows;
    });
  }

  async submit(memberId: string | undefined, input: {kind?:unknown;message?:unknown;scopeCode?:unknown;consentGrantId?:unknown},closedRights=false) {
    const id=owner(memberId);
    if(input?.kind==='withdraw'&&input.consentGrantId!==undefined){
      if(closedRights)throw new DomainError('PRIVACY_SCOPE_UNAVAILABLE','注销账号后不能撤回新的授权',409);
      if(input.scopeCode!==undefined||!uuidPattern.test(String(input.consentGrantId)))
        throw new DomainError('PRIVACY_SCOPE_UNAVAILABLE','请选择本人已有的授权',422);
      return this.withdrawSubmissionConsent(id,String(input.consentGrantId));
    }
    if(input?.consentGrantId!==undefined)
      throw new DomainError('PRIVACY_SCOPE_UNAVAILABLE','该请求不能指定授权',422);
    if(!input || typeof input.kind!=='string' || !kinds.has(input.kind) || typeof input.message!=='string' || !input.message.trim() || Array.from(input.message).length>2000) {
      throw new DomainError('PRIVACY_REQUEST_INVALID','请选择请求类型并填写不超过 2000 字的说明',422);
    }
    if(closedRights&&input.kind==='close_account')
      throw new DomainError('PRIVACY_ACCOUNT_ALREADY_CLOSED','账号已注销，可继续申请处理历史资料',409);
    if(input.kind==='access'&&this.environment==='production'&&!this.formalExportEnabled)
      throw new DomainError('PRIVACY_EXPORT_UNAVAILABLE','数据副本暂不可生成，请稍后重试',503);
    const scopeCode=input.scopeCode??null;
    const syntheticScope=this.environment==='test'&&input.kind==='delete'&&scopeCode==='member_profile_handle_v1';
    const formalScope=!closedRights&&input.kind==='delete'&&scopeCode==='member_optional_profile_v1';
    if(scopeCode!==null&&!syntheticScope&&!formalScope)
      throw new DomainError('PRIVACY_SCOPE_UNAVAILABLE','当前环境或请求类型不支持此精确数据范围',422);
    const message=input.message.trim();
    if(input.kind==='close_account')return this.closeAccount(id);
    if(formalScope)return this.eraseOptionalProfile(id);
    return transaction(this.pool,async client=>{
      // Prevent duplicate taps and unbounded per-account submission bursts.
      const active=await client.query("SELECT id FROM member WHERE id=$1 AND status=$2 FOR UPDATE",[id,closedRights?'deleted':'active']);
      if(!active.rowCount)throw new DomainError('MEMBER_NOT_ACTIVE','账号暂不可提交数据权利请求',403);
      if(syntheticScope){
        const identity=await client.query("SELECT 1 FROM wechat_identity WHERE member_id=$1 AND provider='dev_test'",[id]);
        if(!identity.rowCount)throw new DomainError('PRIVACY_SYNTHETIC_IDENTITY_REQUIRED','此精确数据范围仅供合成测试身份使用',403);
      }
      const existing=await client.query(`SELECT id,kind,status,version,due_at,created_at,scope_code FROM privacy_request WHERE member_id=$1 AND kind=$2 AND message=$3 AND scope_code IS NOT DISTINCT FROM $4 AND status NOT IN ('completed','partially_completed','rejected','canceled') ORDER BY created_at DESC LIMIT 1`,[id,input.kind,message,scopeCode]);
      if(existing.rows[0])return existing.rows[0];
      const count=await client.query(`SELECT count(*)::int AS count FROM privacy_request WHERE member_id=$1 AND created_at>now()-interval '1 day'`,[id]);
      if(count.rows[0].count>=10)throw new DomainError('PRIVACY_REQUEST_LIMIT','今天已提交多项请求，请查看已有受理记录',429);
      const created=(await client.query(`INSERT INTO privacy_request(member_id,kind,message,due_at,scope_code)
        VALUES($1,$2,$3,now()+interval '30 days',$4) RETURNING id,kind,status,version,due_at,created_at,scope_code`,[id,input.kind,message,scopeCode])).rows[0];
      await client.query(`INSERT INTO privacy_request_event(privacy_request_id,actor_id,event_type,detail)
        VALUES($1,$2,'received',jsonb_build_object('kind',$3::text))`,[created.id,`member:${id}`,input.kind]);
      if(input.kind==='access'&&this.formalExportEnabled){
        const formal=(await client.query(`SELECT 1 FROM wechat_identity
          WHERE member_id=$1 AND provider='wechat_miniprogram'`,[id])).rowCount;
        if(formal){
          const job=(await client.query<{id:string}>(`INSERT INTO data_export_job
            (privacy_request_id,member_id,scope,requested_by)
            VALUES($1,$2,$3,$4) RETURNING id`,[created.id,id,
              {formalSelfService:true,dataClass:'member_portable_copy_v1'},`member:${id}`])).rows[0]!;
          await client.query(`UPDATE data_export_job SET execution_mode='generate_archive',status='approved',
            approved_by='system:verified-self',updated_at=now() WHERE id=$1`,[job.id]);
          await client.query("UPDATE privacy_request SET status='reviewing',version=version+1,updated_at=now() WHERE id=$1",[created.id]);
          await client.query("UPDATE privacy_request SET status='approved',version=version+1,updated_at=now() WHERE id=$1",[created.id]);
          await client.query(`INSERT INTO privacy_request_event(privacy_request_id,actor_id,event_type,detail)
            VALUES($1,$2,'approved',$3)`,[created.id,`member:${id}`,{jobId:job.id,verifiedSelf:true}]);
          return {...created,status:'approved',version:3};
        }
      }
      return created;
    });
  }

  /** An independently persisted marker is published before the SQL effect,
   * so a restored backup cannot reactivate this exact consent grant. */
  private async withdrawSubmissionConsent(memberId:string,grantId:string){
    const suppression=this.accountClosure;
    if(!suppression)throw new DomainError('CONSENT_WITHDRAWAL_UNAVAILABLE','授权撤回暂不可用，请稍后重试',503);
    return transaction(this.pool,async client=>{
      const member=await client.query("SELECT id FROM member WHERE id=$1 AND status='active' FOR UPDATE",[memberId]);
      if(!member.rowCount)throw new DomainError('MEMBER_NOT_ACTIVE','账号暂不可撤回授权',403);
      const identity=(await client.query<{provider:string;app_id:string;openid:string}>(
        'SELECT provider,app_id,openid FROM wechat_identity WHERE member_id=$1 FOR SHARE',[memberId])).rows[0];
      if(!identity)throw new DomainError('AUTH_REVOKED','微信身份已变化，请重新登录',401);
      const grant=(await client.query<{submission_id:string;purpose:string;active:boolean}>(
        'SELECT submission_id,purpose,active FROM consent_grant WHERE id=$1 AND member_id=$2 FOR UPDATE',
        [grantId,memberId])).rows[0];
      if(!grant)throw new DomainError('CONSENT_GRANT_NOT_FOUND','授权不存在或不属于当前账号',404);
      if(!['feed_readonly','publication'].includes(grant.purpose))
        throw new DomainError('PRIVACY_SCOPE_UNAVAILABLE','这项授权需要人工核验后办理',409);
      const previous=(await client.query<{id:string;kind:string;status:string;version:number}>(
        "SELECT id,kind,status,version FROM privacy_request WHERE member_id=$1 AND target_ref=$2 AND kind='withdraw'",
        [memberId,grantId])).rows[0];
      if(previous){
        if(grant.active)throw new DomainError('CONSENT_WITHDRAWAL_RESTORE_PENDING','授权状态正在恢复，请稍后重试',503);
        return previous;
      }
      if(!grant.active)throw new DomainError('CONSENT_ALREADY_WITHDRAWN','这项授权已撤回，请刷新授权记录',409);
      const markerInput:Omit<ConsentWithdrawalMarker,'version'|'scope'>={memberId,grantId,
        identityDigest:AccountClosure.identityDigest(identity.provider,identity.app_id,identity.openid),
        requestId:randomUUID(),createdAt:new Date().toISOString(),submissionId:grant.submission_id,
        purpose:grant.purpose as ConsentWithdrawalMarker['purpose']};
      const marker=await suppression.recordConsentWithdrawal(markerInput);
      return applyConsentWithdrawal(client,marker);
    });
  }

  private async closeAccount(memberId:string) {
    if(!this.accountClosure)throw new DomainError('ACCOUNT_CLOSURE_UNAVAILABLE','注销服务暂不可用，请稍后重试',503);
    const identity=await transaction(this.pool,async client=>{
      const member=await client.query("SELECT id FROM member WHERE id=$1 AND status='active' FOR SHARE",[memberId]);
      if(!member.rowCount)throw new DomainError('MEMBER_NOT_ACTIVE','账号暂不可提交注销请求',403);
      const row=(await client.query<{provider:string;app_id:string;openid:string}>(
        'SELECT provider,app_id,openid FROM wechat_identity WHERE member_id=$1 FOR SHARE',[memberId])).rows[0];
      if(!row)throw new DomainError('AUTH_REVOKED','微信身份已变化，请重新登录',401);
      return row;
    });
    // Durable local and COS markers are written outside the short SQL transaction.
    const marker=await this.accountClosure.record(memberId,
      AccountClosure.identityDigest(identity.provider,identity.app_id,identity.openid),randomUUID());
    try{return await transaction(this.pool,client=>applyAccountClosure(client,marker));}catch(error){
      // The independent marker is written before the database transaction.
      // If that transaction failed, retry the same idempotent closure now.
      if(await this.accountClosure.hasMember(memberId)){
        const repaired=await this.accountClosure.replayMember(this.pool,memberId);
        if(repaired?.status==='completed')return repaired;
      }
      throw error;
    }
  }

  private async eraseOptionalProfile(memberId:string){
    if(!this.accountClosure)throw new DomainError('PROFILE_ERASURE_UNAVAILABLE','删除服务暂不可用，请稍后重试',503);
    const identity=await transaction(this.pool,async client=>{
      const row=(await client.query<{display_name:string;provider:string;app_id:string;openid:string;decision_time:string}>(`
        SELECT m.display_name,w.provider,w.app_id,w.openid,clock_timestamp()::text AS decision_time FROM member m
        JOIN wechat_identity w ON w.member_id=m.id
        WHERE m.id=$1 AND m.status='active' AND w.provider='wechat_miniprogram' FOR SHARE OF m,w`,
        [memberId])).rows[0];
      if(!row)throw new DomainError('PRIVACY_FORMAL_IDENTITY_REQUIRED','请用当前微信身份重新登录后再试',403);
      return row;
    });
    const marker=await this.accountClosure.recordProfileErasure(memberId,
      AccountClosure.identityDigest(identity.provider,identity.app_id,identity.openid),randomUUID(),
      createHash('sha256').update(identity.display_name).digest('hex'),identity.decision_time);
    try{return await transaction(this.pool,client=>applyProfileErasure(client,marker));}
    catch(error){
      try{return await transaction(this.pool,client=>applyProfileErasure(client,marker));}
      catch{throw error;}
    }
  }

  async requireOperator(principalId:string,client?:DbClient) {
    const result=await (client??this.pool).query("SELECT 1 FROM principal_role WHERE principal_id=$1 AND role IN ('support','review_lead')"+(client?' FOR SHARE':''),[principalId]);
    if(!result.rowCount)throw new DomainError('PRIVACY_OPERATOR_REQUIRED','仅授权受理人员可访问数据权利请求',403);
  }

  async requireExecutor(principalId:string,client?:DbClient) {
    const result=await (client??this.pool).query("SELECT 1 FROM principal_role WHERE principal_id=$1 AND role='review_lead'"+(client?' FOR SHARE':''),[principalId]);
    if(!result.rowCount)throw new DomainError('PRIVACY_EXECUTOR_REQUIRED','仅复核负责人可建立数据权利执行计划',403);
  }

  async queue(principalId:string,actorMemberId?:string,mode:'role'|'capability'='role',page?:{cursor?:string}) {
    const cursor=page?parsePageCursor(page.cursor,'queue'):null;
    return transaction(this.pool,async client=>{
      await requirePrivacyActor(client,actorMemberId);
      await this.requireQueueOperator(principalId,actorMemberId,mode,client);
      const rows=(await client.query(`SELECT pr.id,pr.member_id,pr.kind,pr.message,pr.scope_code,pr.target_ref,pr.status,pr.waiting_on AS "waitingOn",pr.response,pr.version,pr.due_at,pr.resolution_code,pr.completed_at,pr.created_at,pr.updated_at,
      (SELECT COALESCE(profile_revision,0) FROM member_profile WHERE member_id=pr.member_id) AS "profileVersion",
      (SELECT jsonb_build_object('body',reply.body,'createdAt',reply.created_at) FROM privacy_request_member_reply reply
        WHERE reply.privacy_request_id=pr.id ORDER BY reply.created_at DESC,reply.id DESC LIMIT 1) AS "latestMemberReply",
      ${page?`to_char(pr.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_created_at,
        to_char(pr.due_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_due_at,`:''}
      ${replyHistoryProjection},${executionProjection}
      FROM privacy_request pr
      ${cursor?`WHERE ((${terminalPrivacySql}),pr.due_at,pr.created_at,pr.id)>($1::boolean,$2::timestamptz,$3::timestamptz,$4::uuid)`:''}
      ORDER BY (${terminalPrivacySql}),pr.due_at,pr.created_at,pr.id LIMIT ${page?pageSize+1:100}`,
      cursor?[cursor.terminal,cursor.dueAt,cursor.createdAt,cursor.id]:[])).rows;
      return page?pageResult(rows,'queue'):rows;
    });
  }

  async respond(principalId:string,id:string,input:{status?:unknown;response?:unknown;expectedVersion?:unknown;waitingOn?:unknown},actorMemberId?:string,mode:'role'|'capability'='role') {
    await this.requireQueueOperator(principalId,actorMemberId,mode);
    if(!uuidPattern.test(id))throw new DomainError('PRIVACY_REQUEST_NOT_FOUND','受理记录不存在',404);
    if(!input || !['reviewing','responded'].includes(String(input.status)) || typeof input.response!=='string' || !input.response.trim() || Array.from(input.response).length>4000 || !Number.isInteger(input.expectedVersion) || Number(input.expectedVersion)<1) {
      throw new DomainError('PRIVACY_RESPONSE_INVALID','请填写处理状态、具体回复与当前版本',422);
    }
    const waitingOn=input.waitingOn??'operator';
    if(!['operator','member'].includes(String(waitingOn))||input.status==='reviewing'&&waitingOn!=='operator')
      throw new DomainError('PRIVACY_RESPONSE_INVALID','请选择正确的下一步处理人',422);
    const response=input.response.trim();
    return transaction(this.pool,async client=>{
      const current=await client.query<{status:string;version:number}>('SELECT status,version FROM privacy_request WHERE id=$1 FOR UPDATE',[id]);
      await requirePrivacyActor(client,actorMemberId);
      await this.requireQueueOperator(principalId,actorMemberId,mode,client);
      if(!current.rowCount)throw new DomainError('PRIVACY_REQUEST_NOT_FOUND','受理记录不存在',404);
      if(current.rows[0]!.version!==input.expectedVersion)throw new DomainError('PRIVACY_REQUEST_CHANGED','受理记录已变化，请刷新后重试',409);
      if(['completed','partially_completed','rejected','canceled'].includes(current.rows[0]!.status))throw new DomainError('PRIVACY_REQUEST_CLOSED','受理记录已关闭，不可覆盖结果',409);
      const state=current.rows[0]!.status;
      if(!['received','verifying','reviewing','responded','failed'].includes(state)||(state==='failed'&&input.status!=='reviewing'))
        throw new DomainError('PRIVACY_RESPONSE_STATE_INVALID','当前执行状态不能被回复覆盖，请刷新并核验执行记录',409);
      const result=await client.query(`UPDATE privacy_request SET status=$2,response=$3,responded_by=$4,
        waiting_on=$5,version=version+1,updated_at=now()
        WHERE id=$1 RETURNING id,status,response,waiting_on AS "waitingOn",version,due_at,updated_at`,[id,input.status,response,principalId,waitingOn]);
      await client.query(`INSERT INTO privacy_request_operator_reply
        (privacy_request_id,actor_principal_id,body,waiting_on,request_version)
        VALUES($1,$2,$3,$4,$5)`,[id,principalId,response,waitingOn,result.rows[0].version]);
      await client.query(`INSERT INTO privacy_request_event(privacy_request_id,actor_id,event_type,detail)
        VALUES($1,$2,$3,jsonb_build_object('memberVisibleReply',true,'waitingOn',$4::text))`,[id,principalId,input.status==='reviewing'?'review_started':'responded',waitingOn]);
      await client.query(`INSERT INTO audit_log(principal_id,action,object_type,object_id,reason_code,before_state,after_state,trace_id)
        VALUES($1,'privacy.respond','privacy_request',$2,'USER_RIGHTS_RESPONSE',jsonb_build_object('status',$3::text,'version',$4::integer),jsonb_build_object('status',$5::text,'version',$6::integer),gen_random_uuid()::text)`,
      [principalId,id,current.rows[0]!.status,current.rows[0]!.version,input.status,result.rows[0].version]);
      // A reply never claims that deletion/export has actually been executed.
      return result.rows[0];
    });
  }

  /** Apply only an exact, member-authored profile correction. An unstructured
   * request remains in review until the member specifies one supported field. */
  async executeProfileCorrection(principalId:string,id:string,input:{expectedVersion?:unknown;expectedProfileVersion?:unknown},
    actorMemberId?:string,mode:'role'|'capability'='role') {
    if(!uuidPattern.test(id))throw new DomainError('PRIVACY_REQUEST_NOT_FOUND','受理记录不存在',404);
    if(!Number.isSafeInteger(input?.expectedVersion)||Number(input.expectedVersion)<1||
      !Number.isSafeInteger(input?.expectedProfileVersion)||Number(input.expectedProfileVersion)<0)
      throw new DomainError('PRIVACY_CORRECTION_VERSION_REQUIRED','请刷新受理记录与资料版本',422);
    return transaction(this.pool,async client=>{
      // Profile edits take the member lock first. Read the request owner before
      // locking it, then recheck its version after both profile locks.
      const located=(await client.query<{member_id:string}>(
        'SELECT member_id FROM privacy_request WHERE id=$1',[id])).rows[0];
      if(!located)throw new DomainError('PRIVACY_REQUEST_NOT_FOUND','受理记录不存在',404);
      const member=(await client.query<{id:string}>(
        "SELECT id FROM member WHERE id=$1 AND status='active' FOR UPDATE",[located.member_id])).rows[0];
      if(!member)throw new DomainError('PRIVACY_CORRECTION_MEMBER_UNAVAILABLE','会员资料暂不可更正',409);
      const profile=(await client.query<{profile_revision:number;community_visible:boolean}>(
        'SELECT profile_revision,community_visible FROM member_profile WHERE member_id=$1 FOR UPDATE',
        [located.member_id])).rows[0];
      const row=(await client.query<{member_id:string;kind:string;status:string;version:number;message:string;latest_reply:string|null}>(`
        SELECT p.member_id,p.kind,p.status,p.version,p.message,
          (SELECT body FROM privacy_request_member_reply WHERE privacy_request_id=p.id
            ORDER BY created_at DESC,id DESC LIMIT 1) AS latest_reply
        FROM privacy_request p WHERE p.id=$1 FOR UPDATE`,[id])).rows[0];
      await requirePrivacyActor(client,actorMemberId);
      await this.requireQueueOperator(principalId,actorMemberId,mode,client);
      if(!row||row.member_id!==located.member_id||row.kind!=='correct')
        throw new DomainError('PRIVACY_CORRECTION_SCOPE_INVALID','该请求不是资料更正',409);
      if(row.version!==input.expectedVersion||!profile||profile.profile_revision!==input.expectedProfileVersion)
        throw new DomainError('PRIVACY_REQUEST_CHANGED','受理记录或会员资料已变化，请刷新后重试',409);
      if(!['received','verifying','reviewing','responded'].includes(row.status))
        throw new DomainError('PRIVACY_REQUEST_CLOSED','当前请求不能执行资料更正',409);
      const match=/^(昵称|微信号)：([^\r\n]+)$/.exec((row.latest_reply??row.message).trim());
      if(!match)throw new DomainError('PRIVACY_CORRECTION_TARGET_REQUIRED','请用户按“昵称：新昵称”或“微信号：新微信号”明确目标',409);
      const field=match[1]!,value=match[2]!.trim();
      if(field==='昵称'){
        if(!value||Array.from(value).length>40||/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/.test(value))
          throw new DomainError('PRIVACY_CORRECTION_VALUE_INVALID','昵称须为 1–40 字',422);
      }else if(!/^[A-Za-z][A-Za-z0-9_-]{5,19}$/.test(value))
        throw new DomainError('PRIVACY_CORRECTION_VALUE_INVALID','微信号格式不正确',422);
      await client.query('LOCK TABLE legal_hold IN SHARE MODE');
      await client.query('LOCK TABLE legal_hold_binding IN SHARE MODE');
      const hold=await client.query(`SELECT 1 FROM legal_hold_binding b JOIN legal_hold h ON h.id=b.hold_id
        WHERE h.status='active' AND h.expires_at>clock_timestamp()
          AND b.object_type IN ('member','member_profile') AND b.object_id=$1 LIMIT 1`,[located.member_id]);
      if(hold.rowCount)throw new DomainError('PRIVACY_LEGAL_HOLD_ACTIVE','资料存在保留要求，暂不能更正',423);
      if(field==='昵称'){
        await client.query('UPDATE member SET display_name=$2 WHERE id=$1',[located.member_id,value]);
        await client.query(`UPDATE member_profile SET profile_revision=profile_revision+1,
          public_status=CASE WHEN community_visible THEN 'pending' ELSE public_status END,
          public_review_note=CASE WHEN community_visible THEN NULL ELSE public_review_note END,
          public_reviewed_by=CASE WHEN community_visible THEN NULL ELSE public_reviewed_by END,
          public_reviewed_at=CASE WHEN community_visible THEN NULL ELSE public_reviewed_at END,
          updated_at=clock_timestamp() WHERE member_id=$1`,[located.member_id]);
      }else await client.query(`UPDATE member_profile SET wechat_handle=$2,handle_source='self_reported',
        profile_revision=profile_revision+1,updated_at=clock_timestamp() WHERE member_id=$1`,[located.member_id,value]);
      const verified=field==='昵称'
        ?(await client.query<{value:string}>('SELECT display_name AS value FROM member WHERE id=$1',[located.member_id])).rows[0]?.value
        :(await client.query<{value:string}>('SELECT wechat_handle AS value FROM member_profile WHERE member_id=$1',[located.member_id])).rows[0]?.value;
      if(verified!==value)throw new DomainError('PRIVACY_CORRECTION_UNVERIFIED','资料更正未能读回确认',503);
      // Existing copies contain the old value and must no longer be delivered.
      await client.query(`UPDATE privacy_export_artifact a SET revoked_at=clock_timestamp()
        FROM data_export_job j WHERE a.job_id=j.id AND j.member_id=$1 AND a.revoked_at IS NULL`,[located.member_id]);
      await client.query('UPDATE member SET privacy_erasure_revision=privacy_erasure_revision+1 WHERE id=$1',[located.member_id]);
      for(const status of ['reviewing','approved','executing','completed']){
        if(status==='reviewing'&&row.status==='reviewing')continue;
        if(status==='reviewing'&&row.status==='responded')continue;
        await client.query(`UPDATE privacy_request SET status=$2,
          version=version+1,updated_at=clock_timestamp(),
          completed_at=CASE WHEN $2='completed' THEN clock_timestamp() ELSE completed_at END,
          resolution_code=CASE WHEN $2='completed' THEN 'PROFILE_CORRECTION_VERIFIED' ELSE resolution_code END,
          response=CASE WHEN $2='completed' THEN $3 ELSE response END WHERE id=$1`,
          [id,status,field==='昵称'?'昵称已更正并读回确认。':'微信号已更正并读回确认。']);
      }
      const done=(await client.query<{version:number;status:string;response:string}>(
        'SELECT version,status,response FROM privacy_request WHERE id=$1',[id])).rows[0]!;
      await client.query(`INSERT INTO privacy_request_operator_reply
        (privacy_request_id,actor_principal_id,body,waiting_on,request_version)
        VALUES($1,$2,$3,'operator',$4)`,[id,principalId,done.response,done.version]);
      await client.query(`INSERT INTO privacy_request_event(privacy_request_id,actor_id,event_type,detail)
        VALUES($1,$2,'execution_succeeded',$3)`,[id,principalId,{field:field==='昵称'?'display_name':'wechat_handle',profileVersion:profile.profile_revision+1}]);
      await client.query(`INSERT INTO audit_log(principal_id,action,object_type,object_id,reason_code,
        before_state,after_state,trace_id) VALUES($1,'privacy.profile.correct','privacy_request',$2,
        'MEMBER_EXACT_CORRECTION',$3,$4,gen_random_uuid()::text)`,[principalId,id,
          {requestVersion:row.version,profileVersion:profile.profile_revision},
          {status:'completed',field:field==='昵称'?'display_name':'wechat_handle',profileVersion:profile.profile_revision+1}]);
      return {requestId:id,status:'completed',version:done.version,profileVersion:profile.profile_revision+1};
    });
  }

  async memberReply(memberId:string|undefined,id:string,idempotencyKey:string,input:{message?:unknown;expectedVersion?:unknown},closedRights=false) {
    const member=owner(memberId);
    if(!uuidPattern.test(id))throw new DomainError('PRIVACY_REQUEST_NOT_FOUND','受理记录不存在',404);
    if(typeof input?.message!=='string'||!input.message.trim()||Array.from(input.message.trim()).length>2000||
      !Number.isSafeInteger(input.expectedVersion)||Number(input.expectedVersion)<1)
      throw new DomainError('PRIVACY_REPLY_INVALID','请填写不超过 2000 字的补充说明并刷新当前记录',422);
    const message=input.message.trim(),fingerprint=requestDigest({id,message,expectedVersion:input.expectedVersion});
    return transaction(this.pool,async client=>{
      const subject=await client.query("SELECT id FROM member WHERE id=$1 AND status=$2 FOR SHARE",[member,closedRights?'deleted':'active']);
      if(!subject.rowCount)throw new DomainError('MEMBER_NOT_ACTIVE','账号暂不可补充请求',403);
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`privacy-member-reply:${member}:${idempotencyKey}`]);
      const previous=(await client.query<{privacy_request_id:string;request_hash:string;request_version:number}>(
        'SELECT privacy_request_id,request_hash,request_version FROM privacy_request_member_reply WHERE member_id=$1 AND idempotency_key=$2',
        [member,idempotencyKey])).rows[0];
      if(previous){
        if(previous.privacy_request_id!==id||previous.request_hash!==fingerprint)
          throw new DomainError('IDEMPOTENCY_CONFLICT','请求编号已用于其他补充内容',409);
        return {requestId:id,status:'reviewing',version:previous.request_version,waitingOn:'operator'};
      }
      const request=(await client.query<{member_id:string;status:string;waiting_on:string;version:number}>(
        'SELECT member_id,status,waiting_on,version FROM privacy_request WHERE id=$1 FOR UPDATE',[id])).rows[0];
      if(!request||request.member_id!==member)throw new DomainError('PRIVACY_REQUEST_NOT_FOUND','受理记录不存在',404);
      if(request.version!==input.expectedVersion)throw new DomainError('PRIVACY_REQUEST_CHANGED','受理记录已变化，请刷新后重试',409);
      if(request.status!=='responded'||request.waiting_on!=='member')
        throw new DomainError('PRIVACY_REPLY_NOT_EXPECTED','当前请求无需补充信息',409);
      const version=request.version+1;
      const reply=(await client.query<{id:string}>(`INSERT INTO privacy_request_member_reply
        (privacy_request_id,member_id,body,idempotency_key,request_hash,request_version)
        VALUES($1,$2,$3,$4,$5,$6) RETURNING id`,[id,member,message,idempotencyKey,fingerprint,version])).rows[0]!;
      await client.query("UPDATE privacy_request SET status='reviewing',waiting_on='operator',version=$2,updated_at=now() WHERE id=$1",[id,version]);
      await client.query(`INSERT INTO privacy_request_event(privacy_request_id,actor_id,event_type,detail)
        VALUES($1,$2,'review_started',$3)`,[id,`member:${member}`,{memberReplyId:reply.id,waitingOn:'operator'}]);
      await client.query(`INSERT INTO audit_log(principal_id,action,object_type,object_id,reason_code,
        before_state,after_state,trace_id) VALUES($1,'privacy.member_reply','privacy_request',$2,'MEMBER_SUPPLEMENT',$3,$4,gen_random_uuid()::text)`,
        [`member:${member}`,id,{status:request.status,version:request.version},
          {status:'reviewing',version,memberReplyId:reply.id}]);
      return {requestId:id,status:'reviewing',version,waitingOn:'operator'};
    });
  }

  async planExecution(principalId:string,id:string,idempotencyKey:string,input:{expectedVersion?:unknown;reasonCode?:unknown},actorMemberId?:string) {
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
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`${operation}:${principalId}:${idempotencyKey}`]);
      const replay=await client.query<{request_hash:string;response_body:Record<string,unknown>}>(`SELECT request_hash,response_body FROM idempotency_operation
        WHERE principal_id=$1 AND operation=$2 AND idempotency_key=$3`,[principalId,operation,idempotencyKey]);
      if(replay.rows[0]) {
        await requirePrivacyActor(client,actorMemberId);
        await this.requireExecutor(principalId,client);
        if(replay.rows[0].request_hash!==hash)throw new DomainError('IDEMPOTENCY_CONFLICT','幂等键已用于不同的执行计划',409);
        return replay.rows[0].response_body;
      }
      const current=await client.query<{member_id:string;kind:string;status:string;waiting_on:string;version:number;scope_code:string|null}>('SELECT member_id,kind,status,waiting_on,version,scope_code FROM privacy_request WHERE id=$1 FOR UPDATE',[id]);
      await requirePrivacyActor(client,actorMemberId);
      await this.requireExecutor(principalId,client);
      if(!current.rowCount)throw new DomainError('PRIVACY_REQUEST_NOT_FOUND','受理记录不存在',404);
      const row=current.rows[0]!;
      if(row.version!==expectedVersion)throw new DomainError('PRIVACY_REQUEST_CHANGED','受理记录已变化，请刷新后重试',409);
      if(row.waiting_on==='member')throw new DomainError('PRIVACY_MEMBER_REPLY_PENDING','等待用户补充信息后再建立执行计划',409);
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
          VALUES($1,$2,$3,true,$4,$5) RETURNING id,status`,[id,row.member_id,mode,
          row.scope_code?{scopeCode:row.scope_code}:{requestMessageScoped:true},principalId])).rows[0]!;
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
