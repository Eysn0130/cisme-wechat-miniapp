import { createHash, randomUUID } from "node:crypto";
import type pg from "pg";
import { DAILY_CARE_PROTOCOL_VERSION, type DailyCareRecordInput, type DailyCareRecordView, type DailyCareRecordResult, type DailyCareRecordPage } from "@cisme/contracts";
import { DomainError } from "@cisme/domain";
import { transaction, type DbClient } from "./db.js";
import { requireCareRecordDetails } from "./careRecordDetails.js";
import { finishPage, pageLimit, pageScope, readPageCursor } from "./keysetPage.js";
import type { AccountClosure, DailyCareVisibilityMarker } from './accountClosure.js';

type Row = { id: string; operation_id: string; request_sha256: string; completed_at: Date; cursor_at?: string;
  member_id:string;care_day:string;completed_exact?:string;version:number;updated_at:Date;latest_operation_id:string;deleted_at:Date|null;superseded_by:string|null;
  timezone: "Asia/Shanghai"; protocol_version: string; step_codes: DailyCareRecordInput["stepCodes"];
  self_assessment: DailyCareRecordInput["selfAssessment"]; suppressed_at: Date | null };

export function dailyCareInput(value: unknown): DailyCareRecordInput {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !["stepCodes", "selfAssessment"].includes(key))) {
    throw new DomainError("DAILY_CARE_INPUT_INVALID", "请仅提交本次四步护理和护理后感受", 422);
  }
  return requireCareRecordDetails(value as DailyCareRecordInput);
}
function view(row: Row): DailyCareRecordView {
  return { id: row.id, source: "daily", operationId: row.latest_operation_id, completedAt: row.completed_at.toISOString(),
    timezone: row.timezone, protocolVersion: row.protocol_version, stepCodes: [...row.step_codes], selfAssessment: row.self_assessment,
    careDay:row.care_day,version:row.version,updatedAt:row.updated_at.toISOString(),deleted:row.deleted_at!==null };
}
async function activeMember(client: DbClient, memberId: string | undefined): Promise<string> {
  if (!memberId) throw new DomainError("MEMBER_REQUIRED", "Member identity is required", 401);
  // Account closure locks this same row FOR UPDATE before suppressing data.
  const owner = await client.query("SELECT id FROM member WHERE id=$1 AND status='active' FOR UPDATE", [memberId]);
  if (!owner.rowCount) throw new DomainError("AUTH_REVOKED", "账号状态已变化，请重新核验身份", 401);
  return memberId;
}

type Action='create'|'update'|'delete'|'restore';
type Revision={action:Action|'baseline';record_id:string;version:number;request_sha256:string;snapshot:DailyCareRecordView};
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const live='suppressed_at IS NULL AND deleted_at IS NULL AND superseded_by IS NULL';
function fail(code:string,message:string,status=409):never{throw new DomainError(code,message,status);}
function object(value:unknown,allowed:string[]):Record<string,unknown>{
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!allowed.includes(k)))
    fail('DAILY_CARE_INPUT_INVALID','请仅提交本次护理内容',422);
  return value as Record<string,unknown>;
}
function careDay(value:unknown):string{
  if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value)||!Number.isFinite(Date.parse(value+'T00:00:00Z'))
    ||new Date(value+'T00:00:00Z').toISOString().slice(0,10)!==value)fail('DAILY_CARE_DAY_INVALID','护理日期无效，请重新加载后再试',422);
  return value;
}
export function dailyCareServerDay(now:Date):string{
  const parts=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(now);
  const part=(kind:Intl.DateTimeFormatPartTypes)=>parts.find(p=>p.type===kind)!.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}
function expectedVersion(value:unknown):number{
  if(!Number.isSafeInteger(value)||(value as number)<1)fail('DAILY_CARE_VERSION_REQUIRED','请重新加载这条记录后再试',422);
  return value as number;
}
function operation(value:string){if(typeof value!=='string'||value.length<8||value.length>200)fail('IDEMPOTENCY_KEY_INVALID','本次操作编号无效',400);return value;}
async function rowFor(client:DbClient,owner:string,id:string):Promise<Row>{
  if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))fail('DAILY_CARE_RECORD_NOT_FOUND','未找到这条护理记录',404);
  const row=(await client.query<Row>(`SELECT *,care_day::text AS care_day,
    to_char(completed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS completed_exact
    FROM daily_care_record WHERE id=$1 AND member_id=$2 FOR UPDATE`,[id,owner])).rows[0];
  if(!row)fail('DAILY_CARE_RECORD_NOT_FOUND','未找到这条护理记录',404);return row;
}
function usable(row:Row){if(row.suppressed_at||row.superseded_by)fail('DAILY_CARE_RECORD_UNAVAILABLE','这条护理记录已不可用，请重新核对');}
async function dayExists(client:DbClient,owner:string,day:string,except:string|null=null){
  return Boolean((await client.query(`SELECT 1 FROM daily_care_record WHERE member_id=$1 AND care_day=$2::date AND ${live} AND ($3::uuid IS NULL OR id<>$3)`,[owner,day,except])).rowCount);
}
export function dailyCareFactHash(row:Pick<Row,'id'|'member_id'|'care_day'|'completed_at'|'completed_exact'|'timezone'|'protocol_version'|'step_codes'|'self_assessment'>):string{
  return hash([row.id,row.member_id,row.care_day,row.completed_exact??row.completed_at.toISOString(),row.timezone,row.protocol_version,row.step_codes,row.self_assessment]);
}
async function revision(client:DbClient,row:Row,action:Action,key:string,requestHash:string,now:Date){
  await client.query(`INSERT INTO daily_care_record_revision(record_id,member_id,version,action,operation_id,request_sha256,snapshot,source_fact,recorded_at)
    SELECT d.id,d.member_id,$3,$4,$5,$6,$7::jsonb,jsonb_build_object('id',d.id,'member_id',d.member_id,
      'operation_id',d.operation_id,'request_sha256',d.request_sha256,'completed_at',d.completed_at,
      'timezone',d.timezone,'protocol_version',d.protocol_version,'step_codes',d.step_codes,
      'self_assessment',d.self_assessment,'suppressed_at',d.suppressed_at),$8
    FROM daily_care_record d WHERE d.id=$1 AND d.member_id=$2`,
    [row.id,row.member_id,row.version,action,key,requestHash,JSON.stringify(view(row)),now]);
}

/** Versions compare within a record only. Final deletes release their daily
 * slots before final restores; the full immutable marker history stays intact. */
export function latestDailyCareVisibility(markers:readonly DailyCareVisibilityMarker[]):DailyCareVisibilityMarker[]{
  const latest=new Map<string,DailyCareVisibilityMarker>();
  for(const marker of markers){
    const key=`${marker.memberId}:${marker.recordId}`,old=latest.get(key);
    if(old&&old.recordVersion===marker.recordVersion&&(old.action!==marker.action||old.operationId!==marker.operationId
      ||old.requestSha256!==marker.requestSha256||old.factsSha256!==marker.factsSha256))throw new Error('DAILY_CARE_MARKER_VERSION_CONFLICT');
    if(!old||marker.recordVersion>old.recordVersion)latest.set(key,marker);
  }
  return [...latest.values()].sort((a,b)=>Number(a.action==='restore')-Number(b.action==='restore')
    ||a.memberId.localeCompare(b.memberId)||a.recordId.localeCompare(b.recordId));
}

/** Replay an exact-record visibility intent. Never create a record or clear
 * erasure/QA suppression; a backup missing newer facts remains isolated. */
export async function applyDailyCareVisibility(client:DbClient,marker:DailyCareVisibilityMarker):Promise<boolean>{
  const member=(await client.query<{status:string}>('SELECT status FROM member WHERE id=$1 FOR UPDATE',[marker.memberId])).rows[0];
  if(member?.status!=='active')return false;
  const row=(await client.query<Row>(`SELECT *,care_day::text AS care_day,
    to_char(completed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS completed_exact
    FROM daily_care_record WHERE id=$1 AND member_id=$2 FOR UPDATE`,[marker.recordId,marker.memberId])).rows[0];
  if(!row||row.suppressed_at||row.superseded_by||row.version>=marker.recordVersion)return false;
  const identity=(await client.query<{provider:string;app_id:string;openid:string}>('SELECT provider,app_id,openid FROM wechat_identity WHERE member_id=$1',[marker.memberId])).rows[0];
  if(!identity||hash([identity.provider,identity.app_id,identity.openid])!==marker.identityDigest)throw new Error('DAILY_CARE_MARKER_IDENTITY_MISMATCH');
  if(dailyCareFactHash(row)!==marker.factsSha256){
    await client.query('UPDATE daily_care_record SET suppressed_at=COALESCE(suppressed_at,$2),deleted_at=COALESCE(deleted_at,$2) WHERE id=$1',[row.id,marker.createdAt]);
    return true;
  }
  if(marker.action==='restore'&&await dayExists(client,marker.memberId,row.care_day,row.id))return false;
  const updated=(await client.query<Row>(`UPDATE daily_care_record SET deleted_at=$2,version=$3,updated_at=$4,latest_operation_id=$5
    WHERE id=$1 RETURNING *,care_day::text AS care_day`,[row.id,marker.action==='delete'?marker.createdAt:null,marker.recordVersion,marker.createdAt,marker.operationId])).rows[0]!;
  const old=(await client.query<Revision>('SELECT action,record_id,version,request_sha256,snapshot FROM daily_care_record_revision WHERE member_id=$1 AND operation_id=$2',[marker.memberId,marker.operationId])).rows[0];
  if(old){if(old.record_id!==row.id||old.version!==marker.recordVersion||old.request_sha256!==marker.requestSha256)throw new Error('DAILY_CARE_MARKER_OPERATION_MISMATCH');}
  else await revision(client,updated,marker.action,marker.operationId,marker.requestSha256,new Date(marker.createdAt));
  return true;
}

/** Member-owned daily facts; no cycle, qualification, reward or invitation is created. */
export class DailyCareService {
  constructor(private pool: pg.Pool,private suppression?:AccountClosure) {}
  private async sync(client:DbClient,owner:string){for(const marker of await this.suppression?.dailyCareMarkers(owner)??[])await applyDailyCareVisibility(client,marker);}
  private requestHash(action:Action,input:Record<string,unknown>,id?:string,defaultDay?:string){
    return hash({action,...(id?{id}:{}),...(action==='create'||action==='update'?{careDay:input.careDay??defaultDay}:{}),
      ...(action!=='create'?{expectedVersion:input.expectedVersion}:{}),
      ...(action==='create'||action==='update'?{stepCodes:input.stepCodes,selfAssessment:input.selfAssessment}:{})});
  }
  private async replay(client:DbClient,owner:string,key:string,action:Action,input:Record<string,unknown>,id?:string):Promise<DailyCareRecordResult|null>{
    const r=(await client.query<Revision>('SELECT action,record_id,version,request_sha256,snapshot FROM daily_care_record_revision WHERE member_id=$1 AND operation_id=$2',[owner,key])).rows[0];
    if(!r)return null;
    const row=await rowFor(client,owner,r.record_id);usable(row);
    let expected:string;
    if(r.action==='baseline'&&action==='create'){
      if(input.careDay!==undefined&&input.careDay!==r.snapshot.careDay)fail('IDEMPOTENCY_CONFLICT','本次操作编号已用于不同内容');
      expected=hash({stepCodes:input.stepCodes,selfAssessment:input.selfAssessment});
    }else expected=this.requestHash(action,input,id,r.snapshot.careDay);
    if((r.action!=='baseline'&&r.action!==action)||r.request_sha256!==expected||(id&&id!==r.record_id))
      fail('IDEMPOTENCY_CONFLICT','本次操作编号已用于不同内容，请先核对记录');
    const s=r.snapshot;
    if(s.id!==r.record_id||s.version!==r.version||s.operationId!==key||s.source!=='daily')throw new Error('DAILY_CARE_REVISION_INVALID');
    // Stored snapshots are not arbitrary response objects; future internal
    // fields must not silently expand the member-facing replay contract.
    const record:DailyCareRecordView={id:s.id,source:s.source,operationId:s.operationId,completedAt:s.completedAt,
      timezone:s.timezone,protocolVersion:s.protocolVersion,stepCodes:[...s.stepCodes],selfAssessment:s.selfAssessment,
      careDay:s.careDay,version:s.version,updatedAt:s.updatedAt,deleted:s.deleted};
    return {record,replayed:true,current:row.version===r.version};
  }
  async create(memberId: string | undefined, operationId: string, input: unknown, now = new Date()): Promise<DailyCareRecordResult> {
    const key=operation(operationId),body=object(input,['stepCodes','selfAssessment','careDay']);
    const details=dailyCareInput({stepCodes:body.stepCodes,selfAssessment:body.selfAssessment});
    if(body.careDay!==undefined)careDay(body.careDay);
    return transaction(this.pool, async client => {
      const owner = await activeMember(client, memberId);await this.sync(client,owner);
      const replay=await this.replay(client,owner,key,'create',{...details,...(body.careDay===undefined?{}:{careDay:body.careDay})});if(replay)return replay;
      const day=dailyCareServerDay(now);if(body.careDay!==undefined&&body.careDay!==day)fail('DAILY_CARE_DAY_CHANGED','日期已更新，请核对今天的记录后再保存');
      if(await dayExists(client,owner,day))fail('DAILY_CARE_DAY_EXISTS','今天已有护理记录，请打开后修改');
      const requestHash=this.requestHash('create',{...details,careDay:day});
      const inserted = await client.query<Row>(`INSERT INTO daily_care_record(member_id,operation_id,request_sha256,completed_at,timezone,protocol_version,
        step_codes,self_assessment,care_day,updated_at,latest_operation_id)
        VALUES($1,$2,$3,$4,'Asia/Shanghai',$5,$6,$7,$8::date,$4,$2) RETURNING *,care_day::text AS care_day`,
        [owner,key,requestHash,now,DAILY_CARE_PROTOCOL_VERSION,details.stepCodes,details.selfAssessment,day]);
      const row=inserted.rows[0]!;
      await revision(client,row,'create',key,requestHash,now);return {record:view(row),replayed:false,current:true};
    });
  }
  async update(memberId:string|undefined,id:string,operationId:string,input:unknown,now=new Date()):Promise<DailyCareRecordResult>{
    const key=operation(operationId),body=object(input,['stepCodes','selfAssessment','careDay','expectedVersion']);
    const details=dailyCareInput({stepCodes:body.stepCodes,selfAssessment:body.selfAssessment}),day=careDay(body.careDay),expected=expectedVersion(body.expectedVersion);
    return transaction(this.pool,async client=>{
      const owner=await activeMember(client,memberId);await this.sync(client,owner);
      const replay=await this.replay(client,owner,key,'update',{...details,careDay:day,expectedVersion:expected},id);if(replay)return replay;
      const row=await rowFor(client,owner,id);usable(row);if(row.deleted_at)fail('DAILY_CARE_RECORD_DELETED','这条记录已删除，请先核对');
      if(row.version!==expected)fail('VERSION_CONFLICT','这条记录已更新，请重新加载后再试');
      if(day!==dailyCareServerDay(now)||row.care_day!==day)fail('DAILY_CARE_DAY_CHANGED','日期已更新，请核对今天的记录后再保存');
      const next=(await client.query<Row>(`UPDATE daily_care_record SET version=version+1,completed_at=$3,updated_at=$3,latest_operation_id=$4,
        step_codes=$5,self_assessment=$6 WHERE id=$1 AND member_id=$2 RETURNING *,care_day::text AS care_day`,[id,owner,now,key,details.stepCodes,details.selfAssessment])).rows[0]!;
      await revision(client,next,'update',key,this.requestHash('update',{...details,careDay:day,expectedVersion:expected},id),now);
      return {record:view(next),replayed:false,current:true};
    });
  }
  async visibility(memberId:string|undefined,id:string,operationId:string,input:unknown,action:'delete'|'restore',now=new Date()):Promise<DailyCareRecordResult>{
    const key=operation(operationId),body=object(input,['expectedVersion']),expected=expectedVersion(body.expectedVersion);
    return transaction(this.pool,async client=>{
      const owner=await activeMember(client,memberId);await this.sync(client,owner);
      const replay=await this.replay(client,owner,key,action,{expectedVersion:expected},id);if(replay)return replay;
      const row=await rowFor(client,owner,id);usable(row);
      if(row.version!==expected)fail('VERSION_CONFLICT','这条记录已更新，请重新加载后再试');
      if(action==='delete'&&row.deleted_at)fail('DAILY_CARE_RECORD_DELETED','这条记录已删除');
      if(action==='restore'&&!row.deleted_at)fail('DAILY_CARE_RECORD_NOT_DELETED','这条记录已恢复，请刷新查看');
      if(action==='restore'&&await dayExists(client,owner,row.care_day,id))fail('DAILY_CARE_DAY_EXISTS','这一天已有另一条护理记录，不能覆盖');
      if(!this.suppression?.suppressionEnabled())fail('DAILY_CARE_RECOVERY_UNAVAILABLE','记录恢复保护暂不可用，请稍后再试',503);
      const identity=(await client.query<{provider:string;app_id:string;openid:string}>('SELECT provider,app_id,openid FROM wechat_identity WHERE member_id=$1',[owner])).rows[0];
      if(!identity)fail('AUTH_REVOKED','账号身份已变化，请重新登录',401);
      const requestHash=this.requestHash(action,{expectedVersion:expected},id);
      const marker=await this.suppression.recordDailyCareVisibility({memberId:owner,recordId:id,requestId:randomUUID(),
        identityDigest:hash([identity.provider,identity.app_id,identity.openid]),recordVersion:expected+1,action,
        operationId:key,requestSha256:requestHash,factsSha256:dailyCareFactHash(row),createdAt:now.toISOString()});
      await applyDailyCareVisibility(client,marker);
      const next=await rowFor(client,owner,id);
      if(next.version!==expected+1||Boolean(next.deleted_at)!==(action==='delete')||next.suppressed_at||next.superseded_by)
        fail('DAILY_CARE_RECOVERY_PENDING','操作结果尚未确认，请稍后核对记录',503);
      return {record:view(next),replayed:false,current:true};
    });
  }
  async list(memberId: string | undefined, input: { limit?: unknown; cursor?: unknown } = {},now=new Date()): Promise<DailyCareRecordPage> {
    const limit = pageLimit(input.limit, 20, 50), scope = pageScope(["daily-care-records-v2", memberId]), cursor = readPageCursor(input.cursor, scope),serverDay=dailyCareServerDay(now);
    return transaction(this.pool, async client => {
      const owner = await activeMember(client, memberId);await this.sync(client,owner);
      const total=(await client.query<{n:string}>(`SELECT count(*) AS n FROM daily_care_record WHERE member_id=$1 AND ${live}`,[owner])).rows[0]!;
      const today=(await client.query<Row>(`SELECT *,care_day::text AS care_day FROM daily_care_record WHERE member_id=$1 AND care_day=$2::date AND ${live}`,[owner,serverDay])).rows[0];
      const result = await client.query<Row>(`SELECT *,care_day::text AS care_day,completed_at::text AS cursor_at FROM daily_care_record
        WHERE member_id=$1 AND ${live} AND ($2::timestamptz IS NULL OR (completed_at,id)<($2,$3::uuid))
        ORDER BY completed_at DESC,id DESC LIMIT $4`, [owner, cursor?.at ?? null, cursor?.id ?? null, limit + 1]);
      const page = finishPage(result.rows.map(row => ({ ...row, cursorAt: row.cursor_at! })), limit, scope);
      return { items: page.items.map(view), loadedCount: page.loadedCount, hasMore: page.hasMore, nextCursor: page.nextCursor,
        serverDay,today:today?view(today):null,totalCount:Number(total.n) };
    });
  }
}
