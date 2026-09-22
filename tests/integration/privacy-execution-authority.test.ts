import {afterAll,beforeAll,expect,it} from 'vitest';
import {loadConfig} from '@cisme/config';
import {TEST_DATABASE_URL,resetDatabase,testPool} from '@cisme/testkit';
import {createApp} from '../../services/api/src/server';
import {createApiGatewayStorage} from '../../services/api/src/storage';
import {PrivacyRights} from '../../services/api/src/privacyRights';
import {SyntheticPrivacyExecution} from '../../services/api/src/privacyExecution';

const pool=testPool();
const config=loadConfig({APP_ENV:'test',DATABASE_URL:TEST_DATABASE_URL,APP_SESSION_SECRET:'privacy-authority-test',
  UPLOAD_TOKEN_SECRET:'privacy-authority-upload',OBJECT_STORAGE_DRIVER:'api_gateway'});
const app=await createApp({pool,config,storage:createApiGatewayStorage(config)});
const rights=new PrivacyRights(pool,'test'),executor=new SyntheticPrivacyExecution(pool,'test','7'.repeat(64));
let memberId:string;
let serial=0;
beforeAll(async()=>{
  await resetDatabase(pool);
  const identity=await app.inject({method:'POST',url:'/v1/identity/dev',payload:{externalUserId:'privacy-authority-owner',
    displayName:'synthetic owner',consents:[{documentType:'privacy',version:'test'},{documentType:'terms',version:'test'}]}});
  expect(identity.statusCode).toBe(200);memberId=identity.json().memberId;
  await pool.query("INSERT INTO principal_role(principal_id,role) VALUES('maker','review_lead'),('checker','review_lead')");
});
afterAll(async()=>{await app.close();await pool.end();});
async function approved(kind:'access'|'delete'='access',subject=memberId){
  const request=await rights.submit(subject,{kind,message:`Synthetic authority case ${++serial}`,...(kind==='delete'?{scopeCode:'member_profile_handle_v1'}:{})});
  await rights.planExecution('maker',request.id,`privacy-authority-${serial}`,{expectedVersion:1,reasonCode:'SYNTHETIC_TEST'});
  if(kind==='access')await executor.approveExport('checker',request.id,{expectedVersion:2,reasonCode:'SYNTHETIC_TEST'});
  else await executor.approveProfileErasure('checker',request.id,{expectedVersion:2,reasonCode:'SYNTHETIC_TEST'});
  return request.id as string;
}
it('does not generate an archive after its independent approver loses authority',async()=>{
  const id=await approved();
  await pool.query("DELETE FROM principal_role WHERE principal_id='checker'");
  try{
    expect(await executor.runExportOnce()).toBe(true);
    expect((await pool.query(`SELECT a.job_id FROM privacy_export_artifact a JOIN data_export_job j ON j.id=a.job_id WHERE j.privacy_request_id=$1`,[id])).rowCount).toBe(0);
    expect((await pool.query('SELECT status FROM data_export_job WHERE privacy_request_id=$1',[id])).rows[0].status).toBe('failed');
  }finally{
    await pool.query("INSERT INTO principal_role(principal_id,role) VALUES('checker','review_lead')");
    await pool.query("UPDATE data_export_job SET next_attempt_at=now()+interval '1 day' WHERE privacy_request_id=$1",[id]);
  }
});
it('checks active subject again at execution and direct artifact delivery',async()=>{
  const id=await approved();
  await pool.query("UPDATE member SET status='blocked' WHERE id=$1",[memberId]);
  try{
    expect(await executor.runExportOnce()).toBe(true);
    expect((await pool.query(`SELECT a.job_id FROM privacy_export_artifact a JOIN data_export_job j ON j.id=a.job_id WHERE j.privacy_request_id=$1`,[id])).rowCount).toBe(0);
  }finally{
    await pool.query("UPDATE member SET status='active' WHERE id=$1",[memberId]);
    await pool.query("UPDATE data_export_job SET next_attempt_at=now()+interval '1 day' WHERE privacy_request_id=$1",[id]);
  }
  const delivered=await approved();await executor.runExportOnce();
  await pool.query("UPDATE member SET status='blocked' WHERE id=$1",[memberId]);
  try{await expect(executor.download(memberId,delivered)).rejects.toMatchObject({code:'PRIVACY_EXPORT_NOT_FOUND'});}
  finally{await pool.query("UPDATE member SET status='active' WHERE id=$1",[memberId]);}
});
it('serializes delivery with artifact revocation on an independent database connection',async()=>{
  const id=await approved();await executor.runExportOnce();
  const revoker=await pool.connect();let pending:Promise<unknown>|undefined;
  try{
    await revoker.query('BEGIN');
    await revoker.query(`UPDATE privacy_export_artifact a SET revoked_at=now() FROM data_export_job j
      WHERE a.job_id=j.id AND j.privacy_request_id=$1`,[id]);
    let settled=false;
    pending=executor.download(memberId,id).then(()=>({delivered:true}),error=>({code:error.code})).finally(()=>{settled=true;});
    await new Promise(resolve=>setTimeout(resolve,75));expect(settled).toBe(false);
    await revoker.query('COMMIT');expect(await pending).toEqual({code:'PRIVACY_EXPORT_NOT_FOUND'});
    expect((await pool.query("SELECT 1 FROM audit_log WHERE object_id=$1 AND action='privacy.export.download'",[id])).rowCount).toBe(0);
  }finally{await revoker.query('ROLLBACK');revoker.release();await pending;}
});

for(const changed of ['maker','request'] as const)it(`rejects an export after ${changed} changes without data delivery`,async()=>{
  const id=await approved();
  if(changed==='maker')await pool.query("DELETE FROM principal_role WHERE principal_id='maker'");
  if(changed==='request')await pool.query("UPDATE privacy_request SET status='canceled' WHERE id=$1",[id]);
  try{
    await executor.runExportOnce();
    expect((await pool.query(`SELECT 1 FROM privacy_export_artifact a JOIN data_export_job j ON j.id=a.job_id WHERE j.privacy_request_id=$1`,[id])).rowCount).toBe(0);
    expect((await pool.query('SELECT status FROM data_export_job WHERE privacy_request_id=$1',[id])).rows[0].status).toBe('failed');
  }finally{
    if(changed==='maker')await pool.query("INSERT INTO principal_role(principal_id,role) VALUES('maker','review_lead')");
    await pool.query("UPDATE data_export_job SET next_attempt_at=now()+interval '1 day' WHERE privacy_request_id=$1",[id]);
  }
});
it('keeps scoped profile data after erasure approval is revoked',async()=>{
  await pool.query(`INSERT INTO data_retention_policy(code,data_class,trigger_event,legal_basis,disposition,enforcement_state,active)
    VALUES('synthetic_profile_handle_v1','member_profile.wechat_handle','member explicit deletion request','Synthetic test only','delete','enforced',true)
    ON CONFLICT(code) DO UPDATE SET active=true,enforcement_state='enforced'`);
  await pool.query("INSERT INTO member_profile(member_id,wechat_handle,handle_source) VALUES($1,'KeepSynthetic','self_reported')",[memberId]);
  const id=await approved('delete');
  await pool.query("DELETE FROM principal_role WHERE principal_id='checker'");
  try{
    expect(await executor.runProfileErasureOnce()).toBe(true);
    expect((await pool.query('SELECT wechat_handle FROM member_profile WHERE member_id=$1',[memberId])).rows[0].wechat_handle).toBe('KeepSynthetic');
    expect((await pool.query("SELECT 1 FROM audit_log WHERE object_id=$1 AND action='privacy.erasure.apply'",[id])).rowCount).toBe(0);
  }finally{await pool.query("INSERT INTO principal_role(principal_id,role) VALUES('checker','review_lead')");}
});

it('keeps approved scope immutable at the database boundary',async()=>{
 const id=await approved();
 await expect(pool.query("UPDATE data_export_job SET scope='{}' WHERE privacy_request_id=$1",[id])).rejects.toMatchObject({code:'55000'});
 await pool.query("UPDATE data_export_job SET next_attempt_at=now()+interval '1 day' WHERE privacy_request_id=$1",[id]);
});

it('rejects an archive that expires while delivery waits for a job lock without a row update',async()=>{
  const id=await approved();await executor.runExportOnce();
  const blocker=await pool.connect();let pending:Promise<unknown>|undefined;
  try{
    await pool.query(`UPDATE privacy_export_artifact a SET expires_at=clock_timestamp()+interval '250 milliseconds'
      FROM data_export_job j WHERE a.job_id=j.id AND j.privacy_request_id=$1`,[id]);
    await blocker.query('BEGIN');
    await blocker.query('SELECT id FROM data_export_job WHERE privacy_request_id=$1 FOR UPDATE',[id]);
    let settled=false;
    pending=executor.download(memberId,id).then(()=>({delivered:true}),error=>({code:error.code})).finally(()=>{settled=true;});
    for(let i=0;i<50;i++){
      const waiting=await pool.query(`SELECT 1 FROM pg_stat_activity WHERE datname=current_database()
        AND wait_event_type='Lock' AND (query LIKE '%FROM privacy_export_artifact a%' OR query LIKE '%FROM data_export_job WHERE privacy_request_id=%')`);
      if(waiting.rowCount)break;
      if(i===49)throw new Error('download did not reach expected lock');
      await new Promise(resolve=>setTimeout(resolve,10));
    }
    expect(settled).toBe(false);
    await pool.query('SELECT pg_sleep(0.35)');
    await blocker.query('COMMIT');
    expect(await pending).toEqual({code:'PRIVACY_EXPORT_NOT_FOUND'});
    expect((await pool.query("SELECT 1 FROM audit_log WHERE object_id=$1 AND action='privacy.export.download'",[id])).rowCount).toBe(0);
  }finally{await blocker.query('ROLLBACK');blocker.release();await pending;}
});

it('erases only the approved handle field while preserving avatar and public review facts',async()=>{
  await pool.query(`INSERT INTO member_profile(member_id,wechat_handle,handle_source,avatar_data_url,avatar_revision,profile_revision,
    completed_at,community_visible,public_status,public_review_note,public_reviewed_by,public_reviewed_at)
    VALUES($1,'Scope123','self_reported','data:image/jpeg;base64,synthetic-only','avatar-synthetic-1',4,
    '2026-01-01T00:00:00Z',true,'approved','synthetic public approval','synthetic-reviewer','2026-01-02T00:00:00Z')
    ON CONFLICT(member_id) DO UPDATE SET wechat_handle=excluded.wechat_handle,avatar_data_url=excluded.avatar_data_url,
    avatar_revision=excluded.avatar_revision,profile_revision=excluded.profile_revision,completed_at=excluded.completed_at,
    community_visible=excluded.community_visible,public_status=excluded.public_status,public_review_note=excluded.public_review_note,
    public_reviewed_by=excluded.public_reviewed_by,public_reviewed_at=excluded.public_reviewed_at`,[memberId]);
  const before=(await pool.query('SELECT * FROM member_profile WHERE member_id=$1',[memberId])).rows[0];
  const id=await approved('delete');await executor.runProfileErasureOnce();
  const after=(await pool.query('SELECT * FROM member_profile WHERE member_id=$1',[memberId])).rows[0];
  expect(after).toMatchObject({...before,wechat_handle:null,profile_revision:5,updated_at:expect.any(Date)});
  const manifest=(await pool.query('SELECT manifest FROM data_erasure_job WHERE privacy_request_id=$1',[id])).rows[0].manifest;
  expect(manifest).toMatchObject({scopeCode:'member_profile_handle_v1',deletedProfileRows:0,clearedHandleRows:1});
});

it('does not hold an artifact lock while waiting for the job needed by cleanup',async()=>{
 const identity=await app.inject({method:'POST',url:'/v1/identity/dev',payload:{externalUserId:'privacy-cleanup-subject',
  displayName:'synthetic cleanup owner',consents:[{documentType:'privacy',version:'test'},{documentType:'terms',version:'test'}]}});
 expect(identity.statusCode).toBe(200);const owner=identity.json().memberId;
 const id=await approved('access',owner);await executor.runExportOnce();
 const cleanup=await pool.connect();let pending:Promise<unknown>|undefined;
 try{
  await cleanup.query('BEGIN');await cleanup.query("SET LOCAL lock_timeout='100ms'");
  const job=(await cleanup.query('SELECT id FROM data_export_job WHERE privacy_request_id=$1 FOR UPDATE',[id])).rows[0].id;
  let settled=false;pending=executor.download(owner,id).then(()=>({delivered:true}),error=>({code:error.code})).finally(()=>{settled=true;});
  let waiting=false;
  for(let i=0;i<50&&!settled;i++){
   waiting=Boolean((await pool.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND pid<>pg_backend_pid()")).rowCount);
   if(waiting)break;await new Promise(resolve=>setTimeout(resolve,5));
  }
  expect(waiting).toBe(true);
  // Cleanup already owns job and then deletes its artifact. Delivery must
  // wait at job before taking artifact, rather than closing a lock cycle.
  await cleanup.query('DELETE FROM privacy_export_artifact WHERE job_id=$1',[job]);
  await cleanup.query("UPDATE data_export_job SET status='expired' WHERE id=$1",[job]);
  await cleanup.query('COMMIT');
  expect(await pending).toEqual({code:'PRIVACY_EXPORT_NOT_FOUND'});
  expect((await pool.query("SELECT 1 FROM audit_log WHERE action='privacy.export.download' AND object_id=$1",[id])).rowCount).toBe(0);
 }finally{await cleanup.query('ROLLBACK');cleanup.release();await pending;}
});
