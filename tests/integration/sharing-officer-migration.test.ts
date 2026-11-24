import {beforeAll,afterAll,it,expect} from 'vitest';
import {readFile} from 'node:fs/promises';
import {testPool,resetDatabase} from '@cisme/testkit';
const pool=testPool();let up:string,down:string,v2Up:string,v2Down:string;
beforeAll(async()=>{
 await resetDatabase(pool);
 [up,down]=(await readFile('db/migrations/202611140001_sharing_officer.sql','utf8')).split('-- migrate:down') as [string,string];
 [v2Up,v2Down]=(await readFile('db/migrations/202611240001_sharing_agreement_v2.sql','utf8')).split('-- migrate:down') as [string,string];
});
afterAll(async()=>{await pool.end();});
it('removes only the unused bootstrap and reapplies while preserving prior tables',async()=>{
 const c=await pool.connect();try{await c.query('BEGIN');await c.query(v2Down);await c.query(down);
  expect((await c.query("SELECT to_regclass('public.sharing_officer') AS name")).rows[0].name).toBeNull();
  expect((await c.query("SELECT to_regclass('public.activity_reward_claim') AS name")).rows[0].name).toBe('activity_reward_claim');
  await c.query(up);expect((await c.query("SELECT count(*)::int AS n FROM sharing_policy WHERE basis_points=1000 AND attribution_days IS NULL AND priority='first' AND NOT self_purchase")).rows[0].n).toBe(1);
  await c.query(v2Up);
  expect((await c.query("SELECT to_regclass('public.sharing_v2_agreement_document') AS name")).rows[0].name).toBe('sharing_v2_agreement_document');
 }finally{await c.query('ROLLBACK');c.release();}
});
it('preserves the exact published agreement when a V2 rollback is attempted',async()=>{
 const c=await pool.connect();
 try{
  await c.query('BEGIN');
  await c.query(`INSERT INTO sharing_v2_agreement_document(agreement_version,agreement_digest,effective_on,body_snapshot)
   SELECT 'V2.0',encode(digest(body,'sha256'),'hex'),'2026-01-01',body::json
   FROM (SELECT '{"version":"V2.0","effectiveOn":"2026-01-01","title":"Synthetic agreement"}' AS body) fixture`);
  await expect(c.query(v2Down)).rejects.toThrow('SHARING_V2_ROLLBACK_REQUIRES_EVIDENCE_PRESERVATION');
 }finally{await c.query('ROLLBACK');c.release();}
});
it('refuses rollback as soon as an applicant or a company policy exists',async()=>{
 for(const mode of ['applicant','policy']){
  const c=await pool.connect();try{await c.query('BEGIN');const actor=(await c.query("INSERT INTO member(display_name) VALUES('synthetic sharing migration guard') RETURNING id")).rows[0].id;
   if(mode==='applicant')await c.query("INSERT INTO sharing_officer(member_id,referral_code,state) SELECT $1,user_code,'pending' FROM member_card_number WHERE member_id=$1",[actor]);
   else await c.query("INSERT INTO sharing_policy(enabled,attribution_days,priority,self_purchase,basis_points,release_days,reason,created_by,created_principal) VALUES(true,NULL,'first',false,1500,7,'synthetic reviewed policy',$1,'synthetic-policy-review')",[actor]);
   await expect(c.query(down)).rejects.toThrow('SHARING_ROLLBACK_REQUIRES_DATA_PRESERVATION');
  }finally{await c.query('ROLLBACK');c.release();}
 }
});
