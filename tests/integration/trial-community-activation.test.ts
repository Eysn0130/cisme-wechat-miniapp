import {afterAll,beforeEach,expect,it} from 'vitest';
import {resetDatabase,testPool} from '@cisme/testkit';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';

// Operational JavaScript is also exercised against the owned disposable DB.
const {activateTrialCommunity}=await import(new URL('../../infra/tencent/activate-trial-community.mjs',import.meta.url).href);
const pool=testPool();
const documents=JSON.parse(await readFile('docs/legal/community-direct-publishing-20261103/publication-candidate.json','utf8'));
beforeEach(async()=>{
  await resetDatabase(pool);
  for(const d of documents)await pool.query(`INSERT INTO legal_document(document_type,version,title,body,operator_name,contact,active)
    VALUES($1,'2026-10-28-v4','prior','prior',$2,$3,true)`,[d.type,d.operatorName,d.contact]);
});
afterAll(async()=>{await pool.end();});
async function input(){return {reference:'cisme-user-direct-publication-20261104',sourceHead:'1'.repeat(40),probeSha256:'2'.repeat(64),documents,
  legalBaselineSha256:(await pool.query("SELECT encode(digest(jsonb_agg(to_jsonb(l) ORDER BY document_type,version)::text,'sha256'),'hex') hash FROM legal_document l")).rows[0].hash};}
const run=async(value:unknown)=>{const client=await pool.connect();try{return await activateTrialCommunity(client,value);}finally{client.release();}};
it('opens only the declared community release, preserves other switches, and creates no member consent, grant or post',async()=>{
  const before=(await pool.query("SELECT * FROM emergency_switch WHERE key<>'community' ORDER BY key")).rows;
  const value=await input();const result=await run(value);
  expect(result).toMatchObject({publicSwitchEnabled:true,memberConsentCreated:false,authorityGranted:false});
  expect((await pool.query('SELECT document_type,version FROM legal_document WHERE active ORDER BY document_type')).rows)
    .toEqual([{document_type:'privacy',version:'2026-11-03-v5'},{document_type:'terms',version:'2026-11-03-v5'}]);
  expect((await pool.query("SELECT * FROM emergency_switch WHERE key<>'community' ORDER BY key")).rows).toEqual(before);
  for(const table of ['consent_acceptance','authority_grant','ugc_post','ugc_safety_scan'])
    expect((await pool.query(`SELECT count(*)::int n FROM ${table}`)).rows[0].n).toBe(0);
  expect((await pool.query('SELECT count(*)::int n FROM ugc_go_live_approval')).rows[0].n).toBe(1);
  await expect(run(value)).rejects.toThrow('ACTIVATION_LEGAL_DRIFT');
});
it('rolls back legal publication and release activation on any stale baseline or notice mismatch',async()=>{
  const audits=(await pool.query('SELECT count(*)::int n FROM audit_log')).rows[0].n;
  const value=await input();await expect(run({...value,legalBaselineSha256:'0'.repeat(64)})).rejects.toThrow('ACTIVATION_LEGAL_DRIFT');
  await expect(run({...value,documents:value.documents.map((d:Record<string,unknown>)=>({...d,operatorName:'wrong operator'}))})).rejects.toThrow('ACTIVATION_OPERATOR_DRIFT');
  expect((await pool.query('SELECT count(*)::int n FROM ugc_go_live_approval')).rows[0].n).toBe(0);
  expect((await pool.query("SELECT enabled FROM emergency_switch WHERE key='community'")).rows[0].enabled).toBe(false);
  expect((await pool.query("SELECT version FROM legal_document WHERE active")).rows.every(row=>row.version==='2026-10-28-v4')).toBe(true);
  expect((await pool.query('SELECT count(*)::int n FROM audit_log')).rows[0].n).toBe(audits);
});
it('does not overwrite an existing current release authorization',async()=>{
  const value=await input();await pool.query(`INSERT INTO ugc_go_live_approval(approval_reference,signed_by,evidence,signed_at,expires_at)
    VALUES($1,'prior operator','{"scope":"prior"}',now(),now()+interval '1 hour')`,[randomUUID()]);
  await expect(run(value)).rejects.toThrow('ACTIVATION_EXISTING_APPROVAL_REFUSED');
  expect((await pool.query("SELECT enabled FROM emergency_switch WHERE key='community'")).rows[0].enabled).toBe(false);
});
