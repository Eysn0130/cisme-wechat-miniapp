import { afterAll, beforeAll, expect, it } from 'vitest';
import { loadConfig } from '@cisme/config';
import { TEST_DATABASE_URL, resetDatabase, testPool } from '@cisme/testkit';
import { createApp } from '../../services/api/src/server';
import { createApiGatewayStorage } from '../../services/api/src/storage';
import { AccountClosure, type Marker, type SuppressionRemote } from '../../services/api/src/accountClosure';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const pool=testPool();
const directory=await mkdtemp(join(tmpdir(),'cisme-consent-withdrawal-'));
await chmod(directory,0o700);
const markers=new Map<string,Marker>();
const remote:SuppressionRemote={async put(row){markers.set(`${row.memberId}:${row.version}:${row.version===5?row.batchId:row.requestId}`,row);},
  async list(){return [...markers.values()];}};
const config=loadConfig({APP_ENV:'test',DATABASE_URL:TEST_DATABASE_URL,
  APP_SESSION_SECRET:'scoped-withdrawal-fixture',UPLOAD_TOKEN_SECRET:'scoped-withdrawal-storage',
  OBJECT_STORAGE_DRIVER:'api_gateway',PRIVACY_SUPPRESSION_DIR:directory});
const app=await createApp({pool,config,storage:createApiGatewayStorage(config),suppressionRemote:remote});
beforeAll(async()=>{await resetDatabase(pool);});
afterAll(async()=>{await app.close();await pool.end();await rm(directory,{recursive:true,force:true});});

async function member(name:string){
  const result=await app.inject({method:'POST',url:'/v1/identity/dev',payload:{externalUserId:name,
    displayName:name,consents:[{documentType:'privacy',version:'test'},{documentType:'terms',version:'test'}]}});
  expect(result.statusCode,result.body).toBe(200);
  return result.json() as {memberId:string;sessionToken:string};
}
const authorization=(token:string)=>({authorization:`Bearer ${token}`});

it('withdraws one owned feed grant, reads back its state, and returns the same result on retry',async()=>{
  const owner=await member('withdraw-owner'),other=await member('withdraw-other');
  const submission=(await pool.query<{id:string}>(`INSERT INTO submission(member_id,status)
    VALUES($1,'draft') RETURNING id`,[owner.memberId])).rows[0]!;
  const grant=(await pool.query<{id:string}>(`INSERT INTO consent_grant
    (submission_id,member_id,purpose,granted_at) VALUES($1,$2,'feed_readonly',now()) RETURNING id`,
    [submission.id,owner.memberId])).rows[0]!;
  await pool.query(`INSERT INTO feed_item(submission_id,member_id,title,excerpt,published_at)
    VALUES($1,$2,'合成展示','仅用于隔离测试',now())`,[submission.id,owner.memberId]);
  await expect(pool.query(`INSERT INTO privacy_request(member_id,kind,message,due_at,target_ref)
    VALUES($1,'withdraw','cross owner',now()+interval '30 days',$2)`,
    [other.memberId,grant.id])).rejects.toMatchObject({code:'23514'});
  const payload={kind:'withdraw',consentGrantId:grant.id};
  const cross=await app.inject({method:'POST',url:'/v1/me/privacy-requests',
    headers:authorization(other.sessionToken),payload});
  expect(cross.statusCode).toBe(404);
  const first=await app.inject({method:'POST',url:'/v1/me/privacy-requests',
    headers:authorization(owner.sessionToken),payload});
  expect(first.statusCode,first.body).toBe(200);
  expect(first.json()).toMatchObject({kind:'withdraw',status:'completed'});
  const second=await app.inject({method:'POST',url:'/v1/me/privacy-requests',
    headers:authorization(owner.sessionToken),payload});
  expect(second.json()).toEqual(first.json());
  const state=(await pool.query<{active:boolean;revocations:number;requests:number}>(`
    SELECT cg.active,(SELECT count(*)::int FROM revocation_request WHERE consent_grant_id=cg.id) AS revocations,
      (SELECT count(*)::int FROM privacy_request WHERE target_ref=cg.id) AS requests
    FROM consent_grant cg WHERE cg.id=$1`,[grant.id])).rows[0]!;
  expect(state).toEqual({active:false,revocations:1,requests:1});
  expect((await pool.query('SELECT visible FROM feed_item WHERE submission_id=$1',
    [submission.id])).rows[0].visible).toBe(false);
  const visible=(await app.inject({url:'/v1/me/privacy-requests',
    headers:authorization(owner.sessionToken)})).json();
  expect(visible[0]).toMatchObject({id:first.json().id,status:'completed',
    resolution_code:'SUBMISSION_FEED_CONSENT_WITHDRAWN'});
  expect((await app.inject({url:'/v1/me/privacy-requests',
    headers:authorization(other.sessionToken)})).json()).toEqual([]);
  expect([...markers.values()].some(row=>row.version===4&&row.grantId===grant.id)).toBe(true);
  await pool.query('UPDATE consent_grant SET active=true WHERE id=$1',[grant.id]);
  await pool.query('UPDATE feed_item SET visible=true WHERE submission_id=$1',[submission.id]);
  expect(await new AccountClosure(directory,remote).replayPendingErasure(pool)).toBeGreaterThan(0);
  expect((await pool.query('SELECT active FROM consent_grant WHERE id=$1',[grant.id])).rows[0].active).toBe(false);
  expect((await pool.query('SELECT visible FROM feed_item WHERE submission_id=$1',[submission.id])).rows[0].visible).toBe(false);
});

it('records publication consent as partially complete while blocking new use',async()=>{
  const owner=await member('withdraw-publication');
  const submission=(await pool.query<{id:string}>(`INSERT INTO submission(member_id,status)
    VALUES($1,'draft') RETURNING id`,[owner.memberId])).rows[0]!;
  const grant=(await pool.query<{id:string}>(`INSERT INTO consent_grant
    (submission_id,member_id,purpose,granted_at) VALUES($1,$2,'publication',now()) RETURNING id`,
    [submission.id,owner.memberId])).rows[0]!;
  const result=await app.inject({method:'POST',url:'/v1/me/privacy-requests',
    headers:authorization(owner.sessionToken),payload:{kind:'withdraw',consentGrantId:grant.id}});
  expect(result.statusCode,result.body).toBe(200);
  expect(result.json().status).toBe('partially_completed');
  expect((await pool.query('SELECT active FROM consent_grant WHERE id=$1',[grant.id])).rows[0].active).toBe(false);
});

it('replays the independent marker into a synthetic old backup with no request or revocation',async()=>{
  const marker=[...markers.values()].find((row):row is Extract<Marker,{version:4}>=>
    row.version===4&&row.purpose==='feed_readonly')!;
  const identity=(await pool.query<{provider:string;app_id:string;openid:string;adapter:string}>(
    'SELECT provider,app_id,openid,adapter FROM wechat_identity WHERE member_id=$1',
    [marker.memberId])).rows[0]!;
  await resetDatabase(pool);
  await pool.query("INSERT INTO member(id,display_name) VALUES($1,'已恢复的合成用户')",[marker.memberId]);
  await pool.query(`INSERT INTO wechat_identity(member_id,provider,app_id,openid,adapter)
    VALUES($1,$2,$3,$4,$5)`,[marker.memberId,identity.provider,identity.app_id,identity.openid,identity.adapter]);
  await pool.query("INSERT INTO submission(id,member_id,status) VALUES($1,$2,'draft')",
    [marker.submissionId,marker.memberId]);
  await pool.query(`INSERT INTO consent_grant(id,submission_id,member_id,purpose,granted_at)
    VALUES($1,$2,$3,$4,now())`,[marker.grantId,marker.submissionId,marker.memberId,marker.purpose]);
  await pool.query(`INSERT INTO feed_item(submission_id,member_id,title,excerpt,published_at)
    VALUES($1,$2,'旧备份展示','仅用于隔离测试',now())`,[marker.submissionId,marker.memberId]);
  await new AccountClosure(directory,remote).replay(pool);
  const grant=(await pool.query('SELECT active FROM consent_grant WHERE id=$1',[marker.grantId])).rows[0];
  const request=(await pool.query(`SELECT status,target_ref FROM privacy_request WHERE id=$1`,[marker.requestId])).rows[0];
  expect(grant.active).toBe(false);
  expect(request).toMatchObject({status:'completed',target_ref:marker.grantId});
  expect((await pool.query('SELECT visible FROM feed_item WHERE submission_id=$1',
    [marker.submissionId])).rows[0].visible).toBe(false);
  expect((await pool.query('SELECT 1 FROM revocation_request WHERE consent_grant_id=$1',
    [marker.grantId])).rowCount).toBe(1);
});
