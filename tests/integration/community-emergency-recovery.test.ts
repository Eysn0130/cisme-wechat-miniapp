import {beforeEach,afterAll,expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {loadConfig} from '@cisme/config';
import {testPool,resetDatabase,TEST_DATABASE_URL} from '@cisme/testkit';
import {PlatformService} from '../../services/api/src/platformService';
import {createApiGatewayStorage} from '../../services/api/src/storage';

const pool=testPool();
const config=loadConfig({APP_ENV:'test',DATABASE_URL:TEST_DATABASE_URL,APP_SESSION_SECRET:'synthetic-emergency-session',
  UPLOAD_TOKEN_SECRET:'synthetic-emergency-upload',OBJECT_STORAGE_DRIVER:'api_gateway'});
const service=(enabled=true)=>new PlatformService(pool,{...config,ugcGoLiveGate:enabled},createApiGatewayStorage(config));
const state=async()=>(await pool.query<{enabled:boolean;version:number}>("SELECT enabled,version FROM emergency_switch WHERE key='community'")).rows[0]!;
const set=async(enabled:boolean,version:number,key=randomUUID(),actor='synthetic-review-lead',configured=true)=>
  service(configured).setEmergencySwitch(actor,'community',key,{enabled,expectedVersion:version,reason:'synthetic operational recovery'},new Date());
const approval=async()=>pool.query(`INSERT INTO ugc_go_live_approval(approval_reference,signed_by,evidence,signed_at,expires_at)
  VALUES($1,'synthetic approval owner','{"scope":"disposable-only"}',now()-interval '1 minute',now()+interval '1 hour') RETURNING id`,[randomUUID()]);
beforeEach(async()=>{await resetDatabase(pool);await pool.query("INSERT INTO principal_role(principal_id,role) VALUES('synthetic-review-lead','review_lead')");});
afterAll(async()=>pool.end());

it('reopens a previously approved release after an emergency stop, without creating content, consent or approval',async()=>{
  await approval();const original=await state();const id=randomUUID();
  const first=await set(true,original.version,id);expect(first).toMatchObject({enabled:true,version:original.version+1});
  await expect(set(true,original.version,id)).resolves.toEqual(first);
  await set(false,(await state()).version);const reopen=await set(true,(await state()).version);
  expect(reopen.enabled).toBe(true);expect((await state()).version).toBe(original.version+3);
  expect((await pool.query("SELECT count(*)::int n FROM audit_log WHERE action='emergency_switch.update'")).rows[0].n).toBe(3);
  expect((await pool.query('SELECT count(*)::int n FROM ugc_go_live_approval')).rows[0].n).toBe(1);
  for(const table of ['ugc_post','consent_acceptance','authority_grant'])expect((await pool.query(`SELECT count(*)::int n FROM ${table}`)).rows[0].n).toBe(0);
});
it('keeps authorization and runtime configuration independent, and rejects stale or unauthorized operations',async()=>{
  await approval();const before=await state();
  await expect(set(true,before.version,randomUUID(),'unprivileged')).rejects.toMatchObject({code:'RBAC_FORBIDDEN'});
  await expect(set(true,before.version,randomUUID(),'synthetic-review-lead',false)).rejects.toMatchObject({code:'UGC_GO_LIVE_GATE_CLOSED'});
  await expect(set(true,before.version+1)).rejects.toMatchObject({code:'VERSION_CONFLICT'});
  expect(await state()).toEqual(before);
});
it.each(['missing','expired','revoked','future'])('cannot reopen with %s release authorization',async kind=>{
  if(kind!=='missing'){
    const a=await approval(),id=a.rows[0].id;
    if(kind==='expired')await pool.query("UPDATE ugc_go_live_approval SET signed_at=now()-interval '2 hours',expires_at=now()-interval '1 hour' WHERE id=$1",[id]);
    if(kind==='revoked')await pool.query('UPDATE ugc_go_live_approval SET revoked_at=now() WHERE id=$1',[id]);
    if(kind==='future')await pool.query("UPDATE ugc_go_live_approval SET signed_at=now()+interval '1 hour',expires_at=now()+interval '2 hours' WHERE id=$1",[id]);
  }
  const before=await state();await expect(set(true,before.version)).rejects.toMatchObject({code:'UGC_GO_LIVE_GATE_CLOSED'});expect(await state()).toEqual(before);
});
it('can still stop publication after the release authorization has been revoked',async()=>{
  await approval();await set(true,(await state()).version);await pool.query('UPDATE ugc_go_live_approval SET revoked_at=now()');
  const before=await state();await expect(set(false,before.version,randomUUID(),'synthetic-review-lead',false)).resolves.toMatchObject({enabled:false});
  expect((await state()).enabled).toBe(false);
});
