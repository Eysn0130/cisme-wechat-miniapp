import {afterAll,beforeEach,expect,it} from 'vitest';
import {loadConfig} from '@cisme/config';
import {TEST_DATABASE_URL,resetDatabase,testPool} from '@cisme/testkit';
import {createApp} from '../../services/api/src/server';
import {createApiGatewayStorage} from '../../services/api/src/storage';
import {PrivacyRights} from '../../services/api/src/privacyRights';
import {SyntheticPrivacyExecution} from '../../services/api/src/privacyExecution';
import {operatorHeaders} from './operator-session';

const pool=testPool();
const config=loadConfig({APP_ENV:'test',DATABASE_URL:TEST_DATABASE_URL,APP_SESSION_SECRET:'privacy-entry-test',
  UPLOAD_TOKEN_SECRET:'privacy-entry-upload',OBJECT_STORAGE_DRIVER:'api_gateway',PRIVACY_SYNTHETIC_EXPORT_KEY:'8'.repeat(64)});
const app=await createApp({pool,config,storage:createApiGatewayStorage(config)});
const rights=new PrivacyRights(pool,'test'),executor=new SyntheticPrivacyExecution(pool,'test',config.privacy.syntheticExportKey);
let memberId:string,token:string;
const memberHeaders=()=>({authorization:`Bearer ${token}`});
const admin=(principal:string)=>operatorHeaders(config,principal,memberId);
beforeEach(async()=>{
  await resetDatabase(pool);
  const response=await app.inject({method:'POST',url:'/v1/identity/dev',payload:{externalUserId:'privacy-entry-owner',displayName:'synthetic owner',
    consents:[{documentType:'privacy',version:'test'},{documentType:'terms',version:'test'}]}});
  expect(response.statusCode).toBe(200);memberId=response.json().memberId;token=response.json().sessionToken;
  await pool.query("INSERT INTO principal_role(principal_id,role) VALUES('support','support'),('maker','review_lead'),('checker','review_lead')");
  await pool.query(`INSERT INTO data_retention_policy(code,data_class,trigger_event,duration_days,disposition,legal_basis,enforcement_state,active)
    VALUES('synthetic_profile_handle_v1','member_profile.wechat_handle','member explicit deletion request',NULL,'delete','Synthetic test-only policy','enforced',true)`);
});
afterAll(async()=>{await app.close();await pool.end();});
async function request(kind:'access'|'delete'='access'){
  return rights.submit(memberId,{kind,message:'PRIVATE_SYNTHETIC_REQUEST_MARKER',...(kind==='delete'?{scopeCode:'member_profile_handle_v1'}:{})});
}
async function plan(kind:'access'|'delete'='access'){
  const created=await request(kind);
  await rights.planExecution('maker',created.id,'privacy-entry-plan-01',{expectedVersion:1,reasonCode:'SYNTHETIC_TEST'});
  return created.id as string;
}
async function approve(){const id=await plan();await executor.approveExport('checker',id,{expectedVersion:2,reasonCode:'SYNTHETIC_TEST'});return id;}
async function waitUntilSettledOrLocked(settled:()=>boolean,minLocks=1){
  for(let n=0;n<50;n++){
    if(settled())return;
    const row=await pool.query<{n:number}>(`SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE datname=current_database() AND wait_event_type='Lock'`);
    if(row.rows[0]!.n>=minLocks)return;
    await new Promise(resolve=>setTimeout(resolve,5));
  }
  throw new Error('expected request or database lock was not observed');
}
// Real independent transactions: preHandler/initial reads see the committed
// old authority; the service must wait and re-evaluate after revocation commits.
async function revokeWhile<T>(kind:'role'|'member',principal:string,operation:()=>Promise<T>){
  const blocker=await pool.connect();let pending:Promise<T>|undefined;
  try{
    await blocker.query('BEGIN');
    if(kind==='role')await blocker.query('DELETE FROM principal_role WHERE principal_id=$1',[principal]);
    else await blocker.query("UPDATE member SET status='blocked' WHERE id=$1",[memberId]);
    let settled=false;pending=operation().finally(()=>{settled=true;});
    await waitUntilSettledOrLocked(()=>settled);
    await blocker.query('COMMIT');return await pending;
  }finally{await blocker.query('ROLLBACK');blocker.release();await pending;}
}
for(const revocation of ['role','member'] as const)for(const kind of ['queue','response','plan'] as const)it(`rejects a ${kind} request after its operator ${revocation} authority is revoked concurrently`,async()=>{
  const created=await request();const principal=kind==='plan'?'maker':'support';
  const response=await revokeWhile(revocation,principal,()=>app.inject(kind==='queue'?{url:'/v1/admin/privacy-requests',headers:admin(principal)}:
    {method:'POST',url:`/v1/admin/privacy-requests/${created.id}/${kind==='plan'?'execution-plan':'response'}`,
      headers:{...admin(principal),'idempotency-key':'privacy-entry-request-01'},payload:kind==='plan'?{expectedVersion:1,reasonCode:'SYNTHETIC_TEST'}:
        {expectedVersion:1,status:'reviewing',response:'Synthetic reviewed response'}}));
  expect(response.statusCode).toBe(403);expect(response.body).not.toContain('PRIVATE_SYNTHETIC_REQUEST_MARKER');
  expect((await pool.query('SELECT status,version,response FROM privacy_request WHERE id=$1',[created.id])).rows[0])
    .toMatchObject({status:'received',version:1,response:null});
  expect((await pool.query('SELECT 1 FROM data_export_job WHERE privacy_request_id=$1',[created.id])).rowCount).toBe(0);
  expect((await pool.query("SELECT 1 FROM audit_log WHERE object_id=$1 AND action IN ('privacy.respond','privacy.execution.plan')",[created.id])).rowCount).toBe(0);
});
for(const revocation of ['role','member'] as const)for(const kind of ['access','delete'] as const)it(`rejects ${kind} approval after approver ${revocation} revocation wins the lock`,async()=>{
  const id=await plan(kind),job=kind==='access'?'data_export_job':'data_erasure_job';
  const response=await revokeWhile(revocation,'checker',()=>app.inject({method:'POST',url:`/v1/admin/privacy-requests/${id}/${kind==='access'?'export':'erasure'}-approval`,
    headers:admin('checker'),payload:{expectedVersion:2,reasonCode:'SYNTHETIC_TEST'}}));
  expect(response.statusCode).toBe(403);
  expect((await pool.query(`SELECT status,approved_by FROM ${job} WHERE privacy_request_id=$1`,[id])).rows[0]).toEqual({status:'planned',approved_by:null});
  expect((await pool.query('SELECT status,version FROM privacy_request WHERE id=$1',[id])).rows[0]).toEqual({status:'reviewing',version:2});
});
for(const revocation of ['role','member'] as const)it(`does not redrive a failed job after the reviewer loses ${revocation} authority concurrently`,async()=>{
  const id=await approve();
  for(let n=0;n<3;n++){
    await pool.query("UPDATE data_export_job SET next_attempt_at=now()-interval '1 second' WHERE privacy_request_id=$1",[id]);
    await executor.runExportOnce(()=>{throw new Error('SYNTHETIC_TASK_FAILURE');});
  }
  const before=(await pool.query('SELECT status,version FROM privacy_request WHERE id=$1',[id])).rows[0];
  const response=await revokeWhile(revocation,'checker',()=>app.inject({method:'POST',url:`/v1/admin/privacy-requests/${id}/execution-redrive`,headers:admin('checker'),
    payload:{expectedVersion:before.version,reasonCode:'SYNTHETIC_RECHECK'}}));
  expect(response.statusCode).toBe(403);
  expect((await pool.query('SELECT status,version FROM privacy_request WHERE id=$1',[id])).rows[0]).toEqual(before);
  expect((await pool.query('SELECT status,attempts FROM data_export_job WHERE privacy_request_id=$1',[id])).rows[0]).toEqual({status:'failed',attempts:3});
});
for(const kind of ['list','submit'] as const)it(`rechecks active member at privacy ${kind} after the initial HTTP authentication`,async()=>{
  if(kind==='list')await request();
  const response=await revokeWhile('member','',()=>app.inject(kind==='list'?{url:'/v1/me/privacy-requests',headers:memberHeaders()}:
    {method:'POST',url:'/v1/me/privacy-requests',headers:memberHeaders(),payload:{kind:'access',message:'PRIVATE_SYNTHETIC_REQUEST_MARKER'}}));
  expect(response.statusCode).toBe(403);expect(response.body).not.toContain('PRIVATE_SYNTHETIC_REQUEST_MARKER');
  expect((await pool.query('SELECT count(*)::int AS n FROM privacy_request WHERE member_id=$1',[memberId])).rows[0].n).toBe(kind==='list'?1:0);
});
it('does not revoke an archive after the owning member is blocked before the action linearizes',async()=>{
  const id=await approve();await executor.runExportOnce();
  const response=await revokeWhile('member','',()=>app.inject({method:'POST',url:`/v1/me/privacy-requests/${id}/export-revoke`,headers:memberHeaders()}));
  expect(response.statusCode).toBe(403);
  expect((await pool.query(`SELECT a.revoked_at FROM privacy_export_artifact a JOIN data_export_job j ON j.id=a.job_id WHERE j.privacy_request_id=$1`,[id])).rows[0].revoked_at).toBeNull();
  expect((await pool.query("SELECT 1 FROM audit_log WHERE object_id=$1 AND action='privacy.export.revoke'",[id])).rowCount).toBe(0);
});
it('returns one durable plan to simultaneous same-key requests instead of a spurious version conflict',async()=>{
  const created=await request(),blocker=await pool.connect();let pending:Promise<unknown>[]=[];
  try{
    await blocker.query('BEGIN');await blocker.query('SELECT id FROM privacy_request WHERE id=$1 FOR UPDATE',[created.id]);
    const options={method:'POST' as const,url:`/v1/admin/privacy-requests/${created.id}/execution-plan`,headers:{...admin('maker'),'idempotency-key':'privacy-entry-concurrent-01'},
      payload:{expectedVersion:1,reasonCode:'SYNTHETIC_TEST'}};
    let settled=0;const first=app.inject(options),second=app.inject(options);pending=[first,second];void first.then(()=>{settled++;});void second.then(()=>{settled++;});
    await waitUntilSettledOrLocked(()=>settled===2,2);await blocker.query('COMMIT');
    const responses=await Promise.all([first,second]);expect(responses.map(r=>r.statusCode)).toEqual([200,200]);expect(responses[0].json()).toEqual(responses[1].json());
    expect((await pool.query('SELECT 1 FROM data_export_job WHERE privacy_request_id=$1',[created.id])).rowCount).toBe(1);
    expect((await pool.query("SELECT 1 FROM audit_log WHERE object_id=$1 AND action='privacy.execution.plan'",[created.id])).rowCount).toBe(1);
  }finally{await blocker.query('ROLLBACK');blocker.release();await Promise.all(pending);}
});
