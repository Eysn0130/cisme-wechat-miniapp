import {afterAll,beforeAll,it,expect} from 'vitest';
import {loadConfig} from '@cisme/config';
import {TEST_DATABASE_URL,resetDatabase,testPool} from '@cisme/testkit';
import {createApp} from '../../services/api/src/server';
import {createApiGatewayStorage} from '../../services/api/src/storage';
import {PlatformService} from '../../services/api/src/platformService';
import {SyntheticPrivacyExecution} from '../../services/api/src/privacyExecution';
import {PrivacyRights} from '../../services/api/src/privacyRights';
import {runWorkerCycle} from '../../services/worker/src/jobs';
import {operatorHeaders} from './operator-session';
const pool=testPool();
const config=loadConfig({APP_ENV:'test',DATABASE_URL:TEST_DATABASE_URL,APP_SESSION_SECRET:'privacy-test',ADMIN_API_TOKEN:'privacy-admin',UPLOAD_TOKEN_SECRET:'privacy-upload',OBJECT_STORAGE_DRIVER:'api_gateway',PRIVACY_SYNTHETIC_EXPORT_KEY:'7'.repeat(64)});
const storage=createApiGatewayStorage(config);const app=await createApp({pool,config,storage});
let token:string,otherToken:string,requestId:string,ownerMemberId:string;
const admin=(principal:string,extras:Record<string,string>={})=>operatorHeaders(config,principal,ownerMemberId,extras);
beforeAll(async()=>{await resetDatabase(pool);for(const [name,role] of [['support-user','support'],['lead-user','review_lead'],['second-lead','review_lead'],['other-user','reviewer']])await pool.query('INSERT INTO principal_role(principal_id,role) VALUES($1,$2)',[name,role]);
for(const id of ['owner','other']){const result=await app.inject({method:'POST',url:'/v1/identity/dev',payload:{externalUserId:id,displayName:id,consents:[{documentType:'privacy',version:'test'},{documentType:'terms',version:'test'}]}});expect(result.statusCode).toBe(200);if(id==='owner'){token=result.json().sessionToken;ownerMemberId=result.json().memberId;}else otherToken=result.json().sessionToken;}});
afterAll(async()=>{await app.close();await pool.end();});
it('requires a session, deduplicates repeated submission, and isolates members',async()=>{
expect((await app.inject({url:'/v1/me/privacy-requests'})).statusCode).toBe(401);
const payload={kind:'delete',message:'Please delete my uploaded photo'};
const first=await app.inject({method:'POST',url:'/v1/me/privacy-requests',headers:{authorization:`Bearer ${token}`},payload});expect(first.statusCode).toBe(200);requestId=first.json().id;
const again=await app.inject({method:'POST',url:'/v1/me/privacy-requests',headers:{authorization:`Bearer ${token}`},payload});expect(again.json().id).toBe(requestId);
expect((await app.inject({url:'/v1/me/privacy-requests',headers:{authorization:`Bearer ${otherToken}`}})).json()).toEqual([]);
expect((await pool.query('SELECT 1 FROM member')).rowCount).toBe(2);
});
it('enforces operator authorization and displays audited replies without performing deletion',async()=>{
const path=`/v1/admin/privacy-requests/${requestId}/response`,payload={status:'responded',response:'We received your request; processing is not yet complete.',expectedVersion:1};
expect((await app.inject({method:'POST',url:path,payload})).statusCode).toBe(401);
expect((await app.inject({method:'POST',url:path,headers:admin('other-user'),payload})).statusCode).toBe(403);
const result=await app.inject({method:'POST',url:path,headers:admin('support-user'),payload});expect(result.statusCode).toBe(200);
const rows=(await app.inject({url:'/v1/me/privacy-requests',headers:{authorization:`Bearer ${token}`}})).json();expect(rows[0]).toMatchObject({status:'responded',response:payload.response});
expect((await pool.query("SELECT 1 FROM audit_log WHERE action='privacy.respond'")).rowCount).toBe(1);expect((await pool.query('SELECT 1 FROM member')).rowCount).toBe(2);
});
it('allows only a review lead to create an idempotent dry-run erasure plan without deleting data',async()=>{
const path=`/v1/admin/privacy-requests/${requestId}/execution-plan`,payload={expectedVersion:2,reasonCode:'USER_RIGHTS_VERIFIED'};
const support=await app.inject({method:'POST',url:path,headers:admin('support-user',{'idempotency-key':'privacy-plan-support'}),payload});expect(support.statusCode).toBe(403);
const headers=admin('lead-user',{'idempotency-key':'privacy-plan-delete-v2'});
const first=await app.inject({method:'POST',url:path,headers,payload});expect(first.statusCode).toBe(200);expect(first.json()).toMatchObject({requestId,type:'erasure',status:'planned',executionMode:'dry_run',mode:'delete_scope',requestVersion:3});
const replay=await app.inject({method:'POST',url:path,headers,payload});expect(replay.statusCode).toBe(200);expect(replay.json()).toEqual(first.json());
const jobs=await pool.query('SELECT privacy_request_id,member_id,erasure_mode,dry_run,status FROM data_erasure_job');expect(jobs.rows).toHaveLength(1);expect(jobs.rows[0]).toMatchObject({privacy_request_id:requestId,erasure_mode:'delete_scope',dry_run:true,status:'planned'});
expect((await pool.query('SELECT 1 FROM data_export_job')).rowCount).toBe(0);
await expect(pool.query("INSERT INTO data_export_job(privacy_request_id,member_id,scope,requested_by) VALUES($1,$2,'{}','lead-user')",[requestId,jobs.rows[0].member_id])).rejects.toMatchObject({code:'23505'});
await expect(pool.query("UPDATE privacy_request_event SET event_type='canceled' WHERE privacy_request_id=$1",[requestId])).rejects.toMatchObject({code:'55000'});
const mine=(await app.inject({url:'/v1/me/privacy-requests',headers:{authorization:`Bearer ${token}`}})).json();expect(mine[0].execution).toMatchObject({type:'erasure',status:'planned',executionMode:'dry_run',mode:'delete_scope'});
expect((await pool.query('SELECT 1 FROM member')).rowCount).toBe(2);expect((await pool.query("SELECT 1 FROM audit_log WHERE action='privacy.execution.plan'")).rowCount).toBe(1);
});
it('keeps plan-only export artifact-free and blocks illegal lifecycle jumps',async()=>{
const message='Provide a portable copy without claiming it already exists';
const created=await app.inject({method:'POST',url:'/v1/me/privacy-requests',headers:{authorization:`Bearer ${token}`},payload:{kind:'access',message}});expect(created.statusCode).toBe(200);
const id=created.json().id;
await expect(pool.query("UPDATE privacy_request SET status='completed',completed_at=now() WHERE id=$1",[id])).rejects.toMatchObject({code:'23514'});
const planned=await app.inject({method:'POST',url:`/v1/admin/privacy-requests/${id}/execution-plan`,headers:admin('lead-user',{'idempotency-key':'privacy-plan-access-v1'}),payload:{expectedVersion:1,reasonCode:'USER_RIGHTS_VERIFIED'}});
expect(planned.statusCode).toBe(200);expect(planned.json()).toMatchObject({type:'export',status:'planned',executionMode:'plan_only'});
const job=(await pool.query('SELECT * FROM data_export_job WHERE privacy_request_id=$1',[id])).rows[0];
expect(job).toMatchObject({status:'planned',execution_mode:'plan_only',archive_object_key:null,result_sha256:null,completed_at:null});
await expect(pool.query("UPDATE data_export_job SET status='approved',approved_by='second-lead' WHERE id=$1",[job.id])).rejects.toMatchObject({code:'23514'});
await expect(pool.query("UPDATE data_export_job SET attempts=1 WHERE id=$1",[job.id])).rejects.toMatchObject({code:'23514'});
const evidence=JSON.stringify((await pool.query(`SELECT event.detail,audit.before_state,audit.after_state FROM privacy_request_event event
  LEFT JOIN audit_log audit ON audit.object_id=event.privacy_request_id WHERE event.privacy_request_id=$1`,[id])).rows);
expect(evidence).not.toContain(message);
});
it('records immutable consent evidence and makes legal holds visible to dry-run erasure without deleting',async()=>{
await pool.query(`INSERT INTO data_retention_policy(code,data_class,trigger_event,duration_days,disposition,legal_basis)
  VALUES('test_rights_retention','synthetic rights evidence','request completed',30,'delete','synthetic staging verification only')`);
await expect(pool.query("UPDATE data_retention_policy SET active=true WHERE code='test_rights_retention'")).rejects.toMatchObject({code:'23514'});
await pool.query(`INSERT INTO processing_purpose(code,title,description,lawful_basis,required,data_categories,retention_policy_code)
  VALUES('test_rights_purpose','权利验证','仅用于隔离测试账号的合成同意证据验证','consent',false,ARRAY['synthetic'], 'test_rights_retention')`);
const receipt=(await pool.query(`INSERT INTO consent_receipt(member_id,purpose_code,purpose_version,document_type,document_version,scope,channel,proof_sha256,granted_at)
  VALUES($1,'test_rights_purpose',1,'privacy','synthetic-v1','{"synthetic":true}','admin_assisted',$2,now()) RETURNING id`,[ownerMemberId,'a'.repeat(64)])).rows[0];
await expect(pool.query("UPDATE consent_receipt SET proof_sha256=$2 WHERE id=$1",[receipt.id,'b'.repeat(64)])).rejects.toMatchObject({code:'55000'});
await pool.query("UPDATE consent_receipt SET status='withdrawn',withdrawn_at=now() WHERE id=$1",[receipt.id]);
await expect(pool.query("UPDATE consent_receipt SET status='active',withdrawn_at=NULL WHERE id=$1",[receipt.id])).rejects.toMatchObject({code:'23514'});

const hold=(await pool.query(`INSERT INTO legal_hold(reason_code,legal_basis,approved_by,review_at,expires_at)
  VALUES('SYNTHETIC_RIGHTS_TEST','Synthetic staging-only legal hold behavior verification','lead-user',now()+interval '1 day',now()+interval '2 days') RETURNING id`)).rows[0];
await pool.query("INSERT INTO legal_hold_binding(hold_id,object_type,object_id) VALUES($1,'member',$2)",[hold.id,ownerMemberId]);
const created=await app.inject({method:'POST',url:'/v1/me/privacy-requests',headers:{authorization:`Bearer ${token}`},payload:{kind:'delete',message:'Synthetic held erasure scope'}});
const planned=await app.inject({method:'POST',url:`/v1/admin/privacy-requests/${created.json().id}/execution-plan`,headers:admin('lead-user',{'idempotency-key':'privacy-plan-held-delete-v1'}),payload:{expectedVersion:1,reasonCode:'USER_RIGHTS_VERIFIED'}});
expect(planned.statusCode).toBe(200);
const erasure=(await pool.query('SELECT id,dry_run,status,legal_hold_count FROM data_erasure_job WHERE privacy_request_id=$1',[created.json().id])).rows[0];
expect(erasure).toMatchObject({dry_run:true,status:'planned',legal_hold_count:1});
await expect(pool.query('UPDATE data_erasure_job SET dry_run=false WHERE id=$1',[erasure.id])).rejects.toMatchObject({code:'23514'});
await expect(pool.query("UPDATE data_erasure_job SET status='approved',approved_by='second-lead' WHERE id=$1",[erasure.id])).rejects.toMatchObject({code:'23514'});
expect((await pool.query('SELECT count(*)::int count FROM member WHERE id=$1',[ownerMemberId])).rows[0].count).toBe(1);
await pool.query("UPDATE legal_hold SET status='released',released_by='lead-user',released_at=now() WHERE id=$1",[hold.id]);
await expect(pool.query("UPDATE legal_hold SET status='active',released_by=NULL,released_at=NULL WHERE id=$1",[hold.id])).rejects.toMatchObject({code:'23514'});
await expect(pool.query("UPDATE legal_hold SET released_by='other-user' WHERE id=$1",[hold.id])).rejects.toMatchObject({code:'55000'});
});
it('requires a current separate cross-border consent before creating a production identity',async()=>{
for(const type of ['terms','privacy','cross_border'])await pool.query("INSERT INTO legal_document(document_type,version,title,body,operator_name,contact,active) VALUES($1,'v1','test','test','test','test',true)",[type]);
const service=new PlatformService(pool,config,storage);
const input={provider:'wechat_miniprogram' as const,appId:'test-app',openid:'new-real-flow',displayName:'member',adapter:'wechat' as const,consents:[{documentType:'terms',version:'v1'},{documentType:'privacy',version:'v1'}]};
await expect(service.identity(input,new Date())).rejects.toMatchObject({code:'LEGAL_VERSION_REQUIRED'});expect((await pool.query('SELECT 1 FROM member')).rowCount).toBe(2);
await service.identity({...input,consents:[...input.consents,{documentType:'cross_border',version:'v1'}]},new Date());expect((await pool.query('SELECT 1 FROM member')).rowCount).toBe(3);
expect((await app.inject({url:'/v1/legal'})).json().ready).toBe(true);
});
it('validates message length and limits repeated distinct requests',async()=>{
const send=(message:string)=>app.inject({method:'POST',url:'/v1/me/privacy-requests',headers:{authorization:`Bearer ${otherToken}`},payload:{kind:'other',message}});
expect((await send(' ')).statusCode).toBe(422);expect((await send('x'.repeat(2001))).statusCode).toBe(422);
for(let i=0;i<10;i++)expect((await send(`Request ${i}`)).statusCode).toBe(200);
expect((await send('Request 10')).statusCode).toBe(429);
});
it('keeps executable privacy job modes restricted to explicit synthetic dev identities at the database boundary',async()=>{
const planned=(await pool.query("SELECT id FROM data_export_job WHERE execution_mode='plan_only' LIMIT 1")).rows[0];
expect(planned?.id).toBeTruthy();
await expect(pool.query("UPDATE data_export_job SET execution_mode='generate_archive',approved_by='second-lead',status='approved' WHERE id=$1",[planned.id]))
  .rejects.toMatchObject({code:'23514'});
const devClient=await pool.connect();
try{
  await devClient.query('BEGIN');
  await devClient.query(`UPDATE data_export_job SET scope='{"syntheticOnly":true,"dataClass":"profile"}'::jsonb,
    execution_mode='generate_archive',approved_by='second-lead',status='approved' WHERE id=$1`,[planned.id]);
  expect((await devClient.query('SELECT execution_mode,status FROM data_export_job WHERE id=$1',[planned.id])).rows[0])
    .toMatchObject({execution_mode:'generate_archive',status:'approved'});
}finally{await devClient.query('ROLLBACK');devClient.release();}
const productionLike=(await pool.query("SELECT member_id FROM wechat_identity WHERE provider='wechat_miniprogram' LIMIT 1")).rows[0];
expect(productionLike?.member_id).toBeTruthy();
const request=(await pool.query("INSERT INTO privacy_request(member_id,kind,message,due_at) VALUES($1,'access','Synthetic non-dev guard probe',now()+interval '1 day') RETURNING id",[productionLike.member_id])).rows[0];
const job=(await pool.query(`INSERT INTO data_export_job(privacy_request_id,member_id,scope,requested_by)
  VALUES($1,$2,'{"syntheticOnly":true,"dataClass":"profile"}','lead-user') RETURNING id`,[request.id,productionLike.member_id])).rows[0];
await expect(pool.query("UPDATE data_export_job SET execution_mode='generate_archive',approved_by='second-lead',status='approved' WHERE id=$1",[job.id]))
  .rejects.toMatchObject({code:'23514'});
});
it('executes only a second-approved synthetic profile export with retry, owner-only delivery, expiry and revocation',async()=>{
const marker='SYNTHETIC_OWNER_PROFILE_ONLY';
await pool.query('UPDATE member SET display_name=$2 WHERE id=$1',[ownerMemberId,marker]);
await pool.query(`INSERT INTO member_contact(member_id,phone_encrypted,phone_hmac,phone_masked,key_version)
 VALUES($1,'DO_NOT_EXPORT_PHONE_CIPHERTEXT',$2,'188****0000','synthetic')`,[ownerMemberId,'d'.repeat(64)]);
const otherMember=(await pool.query("SELECT member_id FROM wechat_identity WHERE openid='dev:other' LIMIT 1")).rows[0]?.member_id;
expect(otherMember).toBeTruthy();
await pool.query("UPDATE member SET display_name='DO_NOT_EXPORT_OTHER_MEMBER' WHERE id=$1",[otherMember]);
const created=await app.inject({method:'POST',url:'/v1/me/privacy-requests',headers:{authorization:`Bearer ${token}`},payload:{kind:'access',message:'Synthetic profile subset export'}});
expect(created.statusCode).toBe(200);const id=created.json().id;
const plan=await app.inject({method:'POST',url:`/v1/admin/privacy-requests/${id}/execution-plan`,
  headers:admin('lead-user',{'idempotency-key':'synthetic-profile-plan-v1'}),payload:{expectedVersion:1,reasonCode:'SYNTHETIC_TEST'}});
expect(plan.statusCode).toBe(200);
const approval=`/v1/admin/privacy-requests/${id}/export-approval`;
expect((await app.inject({method:'POST',url:approval,headers:admin('lead-user'),payload:{reasonCode:'SYNTHETIC_TEST',expectedVersion:2}})).statusCode).toBe(403);
expect((await app.inject({method:'POST',url:approval,headers:admin('support-user'),payload:{reasonCode:'SYNTHETIC_TEST',expectedVersion:2}})).statusCode).toBe(403);
expect((await app.inject({method:'POST',url:approval,headers:admin('second-lead'),payload:{reasonCode:'SYNTHETIC_TEST',expectedVersion:1}})).statusCode).toBe(409);
expect((await app.inject({method:'POST',url:approval,headers:admin('second-lead',{'x-principal-id':'lead-user'}),payload:{reasonCode:'SYNTHETIC_TEST',expectedVersion:2}})).statusCode).toBe(403);
expect((await app.inject({method:'POST',url:approval,headers:admin('second-lead'),payload:{reasonCode:'SYNTHETIC_TEST',expectedVersion:2}})).statusCode).toBe(200);
expect((await pool.query("SELECT count(*)::int AS count FROM audit_log WHERE action='privacy.export.approve' AND object_id=$1",[id])).rows[0].count).toBe(1);
const executor=new SyntheticPrivacyExecution(pool,config.env,config.privacy.syntheticExportKey);
expect(await executor.runExportOnce(()=>{throw new Error('PRIVATE_FAILURE_MARKER');})).toBe(true);
const failed=(await pool.query('SELECT id,status,attempts,last_error_code FROM data_export_job WHERE privacy_request_id=$1',[id])).rows[0];
expect(failed).toMatchObject({status:'failed',attempts:1,last_error_code:'EXPORT_TASK_FAILED'});
expect((await pool.query('SELECT count(*)::int AS count FROM privacy_export_artifact WHERE job_id=$1',[failed.id])).rows[0].count).toBe(0);
expect(JSON.stringify((await pool.query('SELECT detail FROM privacy_request_event WHERE privacy_request_id=$1',[id])).rows)).not.toContain('PRIVATE_FAILURE_MARKER');
await pool.query("UPDATE data_export_job SET next_attempt_at=now()-interval '1 second' WHERE id=$1",[failed.id]);
expect((await runWorkerCycle(pool,storage,{ugcGoLiveGate:false,privacyEnvironment:'test',privacySyntheticExportKey:config.privacy.syntheticExportKey})).privacyExports).toBe(1);
expect(await executor.runExportOnce()).toBe(false);
const own=await app.inject({url:`/v1/me/privacy-requests/${id}/export`,headers:{authorization:`Bearer ${token}`}});
expect(own.statusCode).toBe(200);expect(own.headers['cache-control']).toBe('private, no-store');
expect(own.json()).toMatchObject({schema:'cisme.synthetic.member_profile.v1',scope:'member_profile_only',member:{id:ownerMemberId,displayName:marker}});
expect(own.body).not.toContain('DO_NOT_EXPORT_OTHER_MEMBER');expect(own.body).not.toContain(token);
expect(own.body).not.toContain('DO_NOT_EXPORT_PHONE_CIPHERTEXT');
expect((await pool.query("SELECT count(*)::int AS count FROM audit_log WHERE action='privacy.export.download' AND object_id=$1",[id])).rows[0].count).toBe(1);
const other=await app.inject({url:`/v1/me/privacy-requests/${id}/export`,headers:{authorization:`Bearer ${otherToken}`}});
expect(other.statusCode).toBe(404);
const artifact=(await pool.query('SELECT ciphertext FROM privacy_export_artifact WHERE job_id=$1',[failed.id])).rows[0];
expect(Buffer.from(artifact.ciphertext).toString('utf8')).not.toContain(marker);
expect((await app.inject({url:'/v1/me/privacy-requests',headers:{authorization:`Bearer ${token}`}})).json()
  .find((item:{id:string})=>item.id===id)).toMatchObject({status:'partially_completed',resolution_code:'SYNTHETIC_PROFILE_EXPORT_ONLY',execution:{scope:'member_profile_only',downloadAvailable:true,deliveryState:'available'}});
await pool.query("UPDATE privacy_export_artifact SET created_at=now()-interval '2 hours',expires_at=now()-interval '1 hour' WHERE job_id=$1",[failed.id]);
expect((await app.inject({url:`/v1/me/privacy-requests/${id}/export`,headers:{authorization:`Bearer ${token}`}})).statusCode).toBe(404);
expect((await app.inject({url:'/v1/me/privacy-requests',headers:{authorization:`Bearer ${token}`}})).json()
  .find((item:{id:string})=>item.id===id).execution.deliveryState).toBe('expired');
await pool.query("UPDATE privacy_export_artifact SET created_at=now(),expires_at=now()+interval '1 hour' WHERE job_id=$1",[failed.id]);
expect((await app.inject({method:'POST',url:`/v1/me/privacy-requests/${id}/export-revoke`,headers:{authorization:`Bearer ${otherToken}`}})).statusCode).toBe(404);
expect((await app.inject({method:'POST',url:`/v1/me/privacy-requests/${id}/export-revoke`,headers:{authorization:`Bearer ${otherToken}`},payload:{memberId:ownerMemberId}})).statusCode).toBe(404);
expect((await app.inject({method:'POST',url:`/v1/me/privacy-requests/${id}/export-revoke`,headers:{authorization:`Bearer ${token}`}})).statusCode).toBe(200);
expect((await app.inject({url:`/v1/me/privacy-requests/${id}/export`,headers:{authorization:`Bearer ${token}`}})).statusCode).toBe(404);
expect((await app.inject({url:'/v1/me/privacy-requests',headers:{authorization:`Bearer ${token}`}})).json()
  .find((item:{id:string})=>item.id===id).execution.deliveryState).toBe('revoked');
expect((await pool.query("SELECT count(*)::int AS count FROM audit_log WHERE action='privacy.export.revoke' AND object_id=$1",[id])).rows[0].count).toBe(1);
expect((await pool.query("SELECT count(*)::int AS count FROM privacy_request_event WHERE event_type='execution_partially_succeeded' AND privacy_request_id=$1",[id])).rows[0].count).toBe(1);
expect(await executor.purgeArtifacts()).toBe(1);
expect((await pool.query('SELECT count(*)::int AS count FROM privacy_export_artifact WHERE job_id=$1',[failed.id])).rows[0].count).toBe(0);
});
it('preserves an explicit synthetic deletion scope and rejects cross-kind or production-like scope injection',async()=>{
 const dev=(await pool.query(`INSERT INTO privacy_request(member_id,kind,message,due_at,scope_code)
   VALUES($1,'delete','Synthetic profile handle request',now()+interval '1 day','member_profile_handle_v1') RETURNING id,scope_code`,[ownerMemberId])).rows[0];
 expect(dev.scope_code).toBe('member_profile_handle_v1');
 await expect(pool.query("UPDATE privacy_request SET scope_code=NULL WHERE id=$1",[dev.id])).rejects.toMatchObject({code:'55000'});
 await expect(pool.query(`INSERT INTO privacy_request(member_id,kind,message,due_at,scope_code)
   VALUES($1,'withdraw','Wrong kind',now()+interval '1 day','member_profile_handle_v1')`,[ownerMemberId])).rejects.toMatchObject({code:'23514'});
 const real=(await pool.query("SELECT member_id FROM wechat_identity WHERE provider='wechat_miniprogram' LIMIT 1")).rows[0];
 expect(real?.member_id).toBeTruthy();
 await expect(pool.query(`INSERT INTO privacy_request(member_id,kind,message,due_at,scope_code)
   VALUES($1,'delete','Non dev scoped request',now()+interval '1 day','member_profile_handle_v1')`,[real.member_id])).rejects.toMatchObject({code:'23514'});
});
it('applies only the member-confirmed synthetic profile-handle scope after dual review, policy and hold checks',async()=>{
 await pool.query("INSERT INTO member_profile(member_id,wechat_handle,handle_source) VALUES($1,'Owner123','self_reported')",[ownerMemberId]);
 const otherMember=(await pool.query("SELECT member_id FROM wechat_identity WHERE openid='dev:other' LIMIT 1")).rows[0].member_id;
 await pool.query("INSERT INTO member_profile(member_id,wechat_handle,handle_source) VALUES($1,'Other123','self_reported')",[otherMember]);
 const scoped=await app.inject({method:'POST',url:'/v1/me/privacy-requests',headers:{authorization:`Bearer ${token}`},
   payload:{kind:'delete',message:'Remove my self-reported WeChat handle only',scopeCode:'member_profile_handle_v1'}});
 expect(scoped.statusCode).toBe(200);const id=scoped.json().id;
 const replay=await app.inject({method:'POST',url:'/v1/me/privacy-requests',headers:{authorization:`Bearer ${token}`},
   payload:{kind:'delete',message:'Remove my self-reported WeChat handle only',scopeCode:'member_profile_handle_v1'}});
 expect(replay.json().id).toBe(id);
 const unscoped=await app.inject({method:'POST',url:'/v1/me/privacy-requests',headers:{authorization:`Bearer ${token}`},
   payload:{kind:'delete',message:'Remove my self-reported WeChat handle only'}});
 expect(unscoped.statusCode).toBe(200);expect(unscoped.json().id).not.toBe(id);
 await expect(new PrivacyRights(pool,'staging').submit(ownerMemberId,{kind:'delete',message:'Scope should fail outside test',scopeCode:'member_profile_handle_v1'}))
   .rejects.toMatchObject({code:'PRIVACY_SCOPE_UNAVAILABLE'});
 expect((await app.inject({method:'POST',url:'/v1/me/privacy-requests',headers:{authorization:`Bearer ${otherToken}`},
   payload:{kind:'withdraw',message:'Wrong kind',scopeCode:'member_profile_handle_v1'}})).statusCode).toBe(422);
 const plan=await app.inject({method:'POST',url:`/v1/admin/privacy-requests/${id}/execution-plan`,
   headers:admin('lead-user',{'idempotency-key':'synthetic-erasure-plan-v1'}),payload:{expectedVersion:1,reasonCode:'SYNTHETIC_TEST'}});
 expect(plan.statusCode).toBe(200);expect(plan.json()).toMatchObject({type:'erasure',executionMode:'dry_run'});
 const approval=`/v1/admin/privacy-requests/${id}/erasure-approval`;
 const body={reasonCode:'SYNTHETIC_TEST',expectedVersion:2};
 expect((await app.inject({method:'POST',url:approval,headers:admin('lead-user'),payload:body})).statusCode).toBe(403);
 expect((await app.inject({method:'POST',url:approval,headers:admin('support-user'),payload:body})).statusCode).toBe(403);
 expect((await app.inject({method:'POST',url:approval,headers:admin('second-lead'),payload:body})).statusCode).toBe(409);
 await pool.query(`INSERT INTO data_retention_policy(code,data_class,trigger_event,duration_days,disposition,legal_basis,enforcement_state,active)
   VALUES('synthetic_profile_handle_v1','member_profile.wechat_handle','member explicit deletion request',NULL,'delete',
   'Synthetic test-only profile handle policy','enforced',true)`);
 expect((await app.inject({method:'POST',url:approval,headers:admin('second-lead'),payload:{...body,expectedVersion:1}})).statusCode).toBe(409);
 expect((await app.inject({method:'POST',url:approval,headers:admin('second-lead',{'x-principal-id':'lead-user'}),payload:body})).statusCode).toBe(403);
 const approvalHold=(await pool.query(`INSERT INTO legal_hold(reason_code,legal_basis,approved_by,review_at,expires_at)
   VALUES('SYNTHETIC_APPROVAL_HOLD','Synthetic member profile hold before approval','second-lead',
   now()+interval '1 day',now()+interval '2 days') RETURNING id`)).rows[0];
 await pool.query("INSERT INTO legal_hold_binding(hold_id,object_type,object_id) VALUES($1,'member_profile',$2)",[approvalHold.id,ownerMemberId]);
 expect((await app.inject({method:'POST',url:approval,headers:admin('second-lead'),payload:body})).statusCode).toBe(409);
 await pool.query("UPDATE legal_hold SET status='released',released_by='second-lead',released_at=now() WHERE id=$1",[approvalHold.id]);
 expect((await app.inject({method:'POST',url:approval,headers:admin('second-lead'),payload:body})).statusCode).toBe(200);
 expect((await pool.query("SELECT count(*)::int AS count FROM audit_log WHERE action='privacy.erasure.approve' AND object_id=$1",[id])).rows[0].count).toBe(1);
 const job=(await pool.query('SELECT id,dry_run,status,scope FROM data_erasure_job WHERE privacy_request_id=$1',[id])).rows[0];
 expect(job).toMatchObject({dry_run:false,status:'approved',scope:{syntheticOnly:true,scopeCode:'member_profile_handle_v1'}});
 const hold=(await pool.query(`INSERT INTO legal_hold(reason_code,legal_basis,approved_by,review_at,expires_at)
   VALUES('SYNTHETIC_PROFILE_HOLD','Synthetic hold inserted after approval to test recheck','second-lead',
   now()+interval '1 day',now()+interval '2 days') RETURNING id`)).rows[0];
 await pool.query("INSERT INTO legal_hold_binding(hold_id,object_type,object_id) VALUES($1,'member_profile',$2)",[hold.id,ownerMemberId]);
 const executor=new SyntheticPrivacyExecution(pool,config.env,config.privacy.syntheticExportKey);
 expect(await executor.runProfileErasureOnce()).toBe(true);
 expect((await pool.query('SELECT status,last_error_code,legal_hold_count FROM data_erasure_job WHERE id=$1',[job.id])).rows[0])
   .toMatchObject({status:'failed',last_error_code:'PRIVACY_LEGAL_HOLD_ACTIVE',legal_hold_count:1});
 expect((await pool.query('SELECT wechat_handle FROM member_profile WHERE member_id=$1',[ownerMemberId])).rows[0].wechat_handle).toBe('Owner123');
 await pool.query("UPDATE legal_hold SET status='released',released_by='second-lead',released_at=now() WHERE id=$1",[hold.id]);
 await pool.query("UPDATE data_erasure_job SET next_attempt_at=now()-interval '1 second' WHERE id=$1",[job.id]);
 expect(await executor.runProfileErasureOnce(()=>{throw new Error('ERASURE_PRIVATE_FAILURE_MARKER');})).toBe(true);
 expect((await pool.query('SELECT wechat_handle FROM member_profile WHERE member_id=$1',[ownerMemberId])).rows[0].wechat_handle).toBe('Owner123');
 expect((await pool.query('SELECT last_error_code FROM data_erasure_job WHERE id=$1',[job.id])).rows[0].last_error_code).toBe('ERASURE_TASK_FAILED');
 await pool.query("UPDATE data_erasure_job SET next_attempt_at=now()-interval '1 second' WHERE id=$1",[job.id]);
 expect((await runWorkerCycle(pool,storage,{ugcGoLiveGate:false,privacyEnvironment:'test',privacySyntheticExportKey:config.privacy.syntheticExportKey})).privacyErasures).toBe(1);
 expect((await pool.query('SELECT count(*)::int AS count FROM member_profile WHERE member_id=$1',[ownerMemberId])).rows[0].count).toBe(0);
 expect((await pool.query('SELECT wechat_handle FROM member_profile WHERE member_id=$1',[otherMember])).rows[0].wechat_handle).toBe('Other123');
 expect((await pool.query('SELECT count(*)::int AS count FROM member WHERE id=$1',[ownerMemberId])).rows[0].count).toBe(1);
 expect((await pool.query('SELECT count(*)::int AS count FROM member_contact WHERE member_id=$1',[ownerMemberId])).rows[0].count).toBe(1);
 const result=(await pool.query('SELECT status,manifest,legal_hold_count,result_sha256 FROM data_erasure_job WHERE id=$1',[job.id])).rows[0];
 expect(result).toMatchObject({status:'partially_succeeded',legal_hold_count:0,manifest:{scopeCode:'member_profile_handle_v1',deletedProfileRows:1}});
 expect(result.result_sha256).toMatch(/^[0-9a-f]{64}$/);
 expect((await app.inject({url:'/v1/me/privacy-requests',headers:{authorization:`Bearer ${token}`}})).json()
   .find((item:{id:string})=>item.id===id)).toMatchObject({status:'partially_completed',resolution_code:'SYNTHETIC_PROFILE_HANDLE_ONLY',execution:{status:'partially_succeeded',scopeCode:'member_profile_handle_v1'}});
 expect((await pool.query("SELECT count(*)::int AS count FROM audit_log WHERE action='privacy.erasure.apply' AND object_id=$1",[id])).rows[0].count).toBe(1);
 expect(JSON.stringify((await pool.query('SELECT detail FROM privacy_request_event WHERE privacy_request_id=$1',[id])).rows)).not.toContain('ERASURE_PRIVATE_FAILURE_MARKER');
});
it('requires a review lead to redrive an exhausted scoped job and keeps failed deletion atomic',async()=>{
 const identity=await app.inject({method:'POST',url:'/v1/identity/dev',payload:{externalUserId:'redrive-member',displayName:'redrive',
   consents:[{documentType:'privacy',version:'test'},{documentType:'terms',version:'test'}]}});
 expect(identity.statusCode).toBe(200);
 const redriveMemberId=identity.json().memberId,redriveToken=identity.json().sessionToken;
 await pool.query("INSERT INTO member_profile(member_id,wechat_handle,handle_source) VALUES($1,'Redrive123','self_reported')",[redriveMemberId]);
 const created=await app.inject({method:'POST',url:'/v1/me/privacy-requests',headers:{authorization:`Bearer ${redriveToken}`},
   payload:{kind:'delete',message:'Remove only my synthetic self-reported handle after failure',scopeCode:'member_profile_handle_v1'}});
 expect(created.statusCode).toBe(200);const id=created.json().id;
 expect((await app.inject({method:'POST',url:`/v1/admin/privacy-requests/${id}/execution-plan`,
   headers:admin('lead-user',{'idempotency-key':'synthetic-redrive-plan-v1'}),payload:{expectedVersion:1,reasonCode:'SYNTHETIC_TEST'}})).statusCode).toBe(200);
 expect((await app.inject({method:'POST',url:`/v1/admin/privacy-requests/${id}/erasure-approval`,
   headers:admin('second-lead'),payload:{expectedVersion:2,reasonCode:'SYNTHETIC_TEST'}})).statusCode).toBe(200);
 const executor=new SyntheticPrivacyExecution(pool,config.env,config.privacy.syntheticExportKey);
 for(let attempt=0;attempt<3;attempt++){
   if(attempt)await pool.query("UPDATE data_erasure_job SET next_attempt_at=now()-interval '1 second' WHERE privacy_request_id=$1",[id]);
   expect(await executor.runProfileErasureOnce(()=>{throw new Error('PRIVATE_EXHAUSTED_ERASURE');})).toBe(true);
 }
 expect((await pool.query('SELECT wechat_handle FROM member_profile WHERE member_id=$1',[redriveMemberId])).rows[0].wechat_handle).toBe('Redrive123');
 const exhausted=(await pool.query('SELECT status,version FROM privacy_request WHERE id=$1',[id])).rows[0];
 expect(exhausted.status).toBe('failed');
 const redrive=`/v1/admin/privacy-requests/${id}/execution-redrive`;
 expect((await app.inject({method:'POST',url:redrive,headers:admin('support-user'),payload:{expectedVersion:exhausted.version,reasonCode:'SYNTHETIC_RECHECK'}})).statusCode).toBe(403);
 expect((await app.inject({method:'POST',url:redrive,headers:admin('second-lead'),payload:{expectedVersion:exhausted.version-1,reasonCode:'SYNTHETIC_RECHECK'}})).statusCode).toBe(409);
 const redriveHold=(await pool.query(`INSERT INTO legal_hold(reason_code,legal_basis,approved_by,review_at,expires_at)
   VALUES('SYNTHETIC_REDRIVE_HOLD','Synthetic hold before exhausted erasure redrive','second-lead',
   now()+interval '1 day',now()+interval '2 days') RETURNING id`)).rows[0];
 await pool.query("INSERT INTO legal_hold_binding(hold_id,object_type,object_id) VALUES($1,'member',$2)",[redriveHold.id,redriveMemberId]);
 expect((await app.inject({method:'POST',url:redrive,headers:admin('second-lead'),payload:{expectedVersion:exhausted.version,reasonCode:'SYNTHETIC_RECHECK'}})).statusCode).toBe(409);
 await pool.query("UPDATE legal_hold SET status='released',released_by='second-lead',released_at=now() WHERE id=$1",[redriveHold.id]);
 expect((await app.inject({method:'POST',url:redrive,headers:admin('second-lead'),payload:{expectedVersion:exhausted.version,reasonCode:'SYNTHETIC_RECHECK'}})).statusCode).toBe(200);
 expect(await executor.runProfileErasureOnce()).toBe(true);
 expect((await pool.query('SELECT count(*)::int AS count FROM member_profile WHERE member_id=$1',[redriveMemberId])).rows[0].count).toBe(0);
 expect((await pool.query('SELECT status,attempts FROM data_erasure_job WHERE privacy_request_id=$1',[id])).rows[0]).toMatchObject({status:'partially_succeeded',attempts:1});
 expect((await pool.query("SELECT count(*)::int AS count FROM audit_log WHERE action='privacy.execution.redrive' AND object_id=$1",[id])).rows[0].count).toBe(1);
 expect(JSON.stringify((await pool.query('SELECT detail FROM privacy_request_event WHERE privacy_request_id=$1',[id])).rows)).not.toContain('PRIVATE_EXHAUSTED_ERASURE');
});
it('redrives an exhausted synthetic export without exposing an unfinished artifact',async()=>{
 const identity=await app.inject({method:'POST',url:'/v1/identity/dev',payload:{externalUserId:'export-redrive-member',displayName:'export redrive',
   consents:[{documentType:'privacy',version:'test'},{documentType:'terms',version:'test'}]}});
 expect(identity.statusCode).toBe(200);const session=identity.json().sessionToken;
 const created=await app.inject({method:'POST',url:'/v1/me/privacy-requests',headers:{authorization:`Bearer ${session}`},
   payload:{kind:'access',message:'Synthetic export with exhausted retry'}});
 expect(created.statusCode).toBe(200);const id=created.json().id;
 expect((await app.inject({method:'POST',url:`/v1/admin/privacy-requests/${id}/execution-plan`,
   headers:admin('lead-user',{'idempotency-key':'synthetic-export-redrive-v1'}),payload:{expectedVersion:1,reasonCode:'SYNTHETIC_TEST'}})).statusCode).toBe(200);
 expect((await app.inject({method:'POST',url:`/v1/admin/privacy-requests/${id}/export-approval`,
   headers:admin('second-lead'),payload:{expectedVersion:2,reasonCode:'SYNTHETIC_TEST'}})).statusCode).toBe(200);
 const executor=new SyntheticPrivacyExecution(pool,config.env,config.privacy.syntheticExportKey);
 for(let attempt=0;attempt<3;attempt++){
   if(attempt)await pool.query("UPDATE data_export_job SET next_attempt_at=now()-interval '1 second' WHERE privacy_request_id=$1",[id]);
   expect(await executor.runExportOnce(()=>{throw new Error('PRIVATE_EXHAUSTED_EXPORT');})).toBe(true);
 }
 expect((await pool.query('SELECT count(*)::int AS count FROM privacy_export_artifact a JOIN data_export_job j ON j.id=a.job_id WHERE j.privacy_request_id=$1',[id])).rows[0].count).toBe(0);
 const request=(await pool.query('SELECT status,version FROM privacy_request WHERE id=$1',[id])).rows[0];
 expect(request.status).toBe('failed');
 expect((await app.inject({method:'POST',url:`/v1/admin/privacy-requests/${id}/execution-redrive`,
   headers:admin('second-lead'),payload:{expectedVersion:request.version,reasonCode:'SYNTHETIC_RECHECK'}})).statusCode).toBe(200);
 expect(await executor.runExportOnce()).toBe(true);
 expect((await app.inject({url:`/v1/me/privacy-requests/${id}/export`,headers:{authorization:`Bearer ${session}`}})).statusCode).toBe(200);
 expect((await pool.query('SELECT status,attempts FROM data_export_job WHERE privacy_request_id=$1',[id])).rows[0]).toMatchObject({status:'succeeded',attempts:1});
 expect(JSON.stringify((await pool.query('SELECT detail FROM privacy_request_event WHERE privacy_request_id=$1',[id])).rows)).not.toContain('PRIVATE_EXHAUSTED_EXPORT');
});
