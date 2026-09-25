import {afterAll,beforeAll,expect,it} from 'vitest';
import {loadConfig} from '@cisme/config';
import {TEST_DATABASE_URL,resetDatabase,testPool} from '@cisme/testkit';
import {createApp} from '../../services/api/src/server';
import {createApiGatewayStorage} from '../../services/api/src/storage';

const pool=testPool();
const config=loadConfig({APP_ENV:'test',DATABASE_URL:TEST_DATABASE_URL,
  APP_SESSION_SECRET:'synthetic-privacy-correction',UPLOAD_TOKEN_SECRET:'synthetic-upload',OBJECT_STORAGE_DRIVER:'api_gateway'});
const app=await createApp({pool,config,storage:createApiGatewayStorage(config)});
let owner:{id:string;token:string},operator:{id:string;token:string},outsider:{id:string;token:string};
const auth=(token:string)=>({authorization:`Bearer ${token}`});
async function identity(name:string){
  const result=await app.inject({method:'POST',url:'/v1/identity/dev',payload:{externalUserId:`correction-${name}`,
    displayName:name,consents:[{documentType:'privacy',version:'test'},{documentType:'terms',version:'test'}]}});
  expect(result.statusCode).toBe(200);
  return {id:result.json().memberId as string,token:result.json().sessionToken as string};
}
async function request(message:string){
  const response=await app.inject({method:'POST',url:'/v1/me/privacy-requests',headers:auth(owner.token),
    payload:{kind:'correct',message}});
  expect(response.statusCode).toBe(200);
  return response.json() as {id:string;version:number};
}
async function queueRow(id:string){
  const response=await app.inject({url:'/v1/management/privacy-requests',headers:auth(operator.token)});
  expect(response.statusCode).toBe(200);
  return (response.json() as Array<{id:string;version:number;profileVersion:number}>).find(row=>row.id===id)!;
}
const path=(id:string)=>`/v1/management/privacy-requests/${id}/profile-correction`;
beforeAll(async()=>{
  await resetDatabase(pool);
  owner=await identity('owner');operator=await identity('operator');outsider=await identity('outsider');
  await pool.query("INSERT INTO authority_grant(member_id,capability,environment,granted_by,grant_reason) VALUES($1,'privacy.request.manage','test','test','Synthetic correction review')",[operator.id]);
  const profile=await app.inject({method:'PUT',url:'/v1/me/profile',headers:auth(owner.token),
    payload:{displayName:'原昵称',wechatHandle:'oldname123',expectedVersion:0}});
  expect(profile.statusCode).toBe(200);
});
afterAll(async()=>{await app.close();await pool.end();});
it('requires current authority, exact member target and fresh request/profile versions',async()=>{
  const unstructured=await request('请帮我更正资料');
  const row=await queueRow(unstructured.id);
  const body={expectedVersion:row.version,expectedProfileVersion:row.profileVersion};
  expect((await app.inject({method:'POST',url:path(unstructured.id),headers:auth(outsider.token),payload:body})).statusCode).toBe(403);
  const vague=await app.inject({method:'POST',url:path(unstructured.id),headers:auth(operator.token),payload:body});
  expect(vague.statusCode).toBe(409);
  expect(vague.json().code).toBe('PRIVACY_CORRECTION_TARGET_REQUIRED');
  expect((await pool.query('SELECT display_name FROM member WHERE id=$1',[owner.id])).rows[0].display_name).toBe('原昵称');
  const requested=await request('昵称：更正后的昵称');
  const chosen=await queueRow(requested.id);
  const stale=await app.inject({method:'POST',url:path(requested.id),headers:auth(operator.token),
    payload:{expectedVersion:chosen.version,expectedProfileVersion:chosen.profileVersion+1}});
  expect(stale.statusCode).toBe(409);
  expect((await pool.query('SELECT display_name FROM member WHERE id=$1',[owner.id])).rows[0].display_name).toBe('原昵称');
  const done=await app.inject({method:'POST',url:path(requested.id),headers:auth(operator.token),
    payload:{expectedVersion:chosen.version,expectedProfileVersion:chosen.profileVersion}});
  expect(done.statusCode).toBe(200);
  expect(done.json()).toMatchObject({requestId:requested.id,status:'completed'});
  expect((await app.inject({method:'POST',url:path(requested.id),headers:auth(operator.token),
    payload:{expectedVersion:chosen.version,expectedProfileVersion:chosen.profileVersion}})).statusCode).toBe(409);
  const profile=(await app.inject({url:'/v1/me/profile',headers:auth(owner.token)})).json();
  expect(profile).toMatchObject({display_name:'更正后的昵称',wechat_handle:'oldname123'});
  const mine=(await app.inject({url:'/v1/me/privacy-requests',headers:auth(owner.token)})).json() as Array<{id:string;status:string;response:string}>;
  expect(mine.find(item=>item.id===requested.id)).toMatchObject({status:'completed',response:'昵称已更正并读回确认。'});
  expect((await pool.query("SELECT 1 FROM audit_log WHERE action='privacy.profile.correct' AND object_id=$1",[requested.id])).rowCount).toBe(1);
});
it('checks legal hold before changing the exact self-reported handle',async()=>{
  const requested=await request('微信号：newname123');
  const chosen=await queueRow(requested.id);
  const hold=(await pool.query(`INSERT INTO legal_hold(reason_code,legal_basis,approved_by,review_at,expires_at)
    VALUES('TEST_HOLD','Synthetic correction hold','test',now()+interval '1 day',now()+interval '2 days') RETURNING id`)).rows[0].id;
  await pool.query("INSERT INTO legal_hold_binding(hold_id,object_type,object_id) VALUES($1,'member_profile',$2)",[hold,owner.id]);
  const attempt=()=>app.inject({method:'POST',url:path(requested.id),headers:auth(operator.token),
    payload:{expectedVersion:chosen.version,expectedProfileVersion:chosen.profileVersion}});
  const blocked=await attempt();expect(blocked.statusCode).toBe(423);
  expect((await app.inject({url:'/v1/me/profile',headers:auth(owner.token)})).json().wechat_handle).toBe('oldname123');
  await pool.query("UPDATE legal_hold SET status='released',released_by='test',released_at=now() WHERE id=$1",[hold]);
  const done=await attempt();expect(done.statusCode).toBe(200);
  expect((await app.inject({url:'/v1/me/profile',headers:auth(owner.token)})).json().wechat_handle).toBe('newname123');
});
