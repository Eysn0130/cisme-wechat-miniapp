import {beforeAll,afterAll,it,expect} from 'vitest';
import {readFile} from 'node:fs/promises';
import {testPool,resetDatabase} from '@cisme/testkit';
const pool=testPool();let up:string,down:string;
beforeAll(async()=>{await resetDatabase(pool);[up,down]=(await readFile('db/migrations/202611140001_sharing_officer.sql','utf8')).split('-- migrate:down') as [string,string];});
afterAll(async()=>{await pool.end();});
it('removes only the unused bootstrap and reapplies while preserving prior tables',async()=>{
 const c=await pool.connect();try{await c.query('BEGIN');await c.query(down);
  expect((await c.query("SELECT to_regclass('public.sharing_officer') AS name")).rows[0].name).toBeNull();
  expect((await c.query("SELECT to_regclass('public.activity_reward_claim') AS name")).rows[0].name).toBe('activity_reward_claim');
  await c.query(up);expect((await c.query("SELECT count(*)::int AS n FROM sharing_policy WHERE basis_points=1000 AND attribution_days IS NULL AND priority='first' AND NOT self_purchase")).rows[0].n).toBe(1);
 }finally{await c.query('ROLLBACK');c.release();}
});
it('refuses rollback as soon as an applicant or a company policy exists',async()=>{
 for(const mode of ['applicant','policy']){
  const c=await pool.connect();try{await c.query('BEGIN');const actor=(await c.query("INSERT INTO member(display_name) VALUES('synthetic sharing migration guard') RETURNING id")).rows[0].id;
   if(mode==='applicant')await c.query("INSERT INTO sharing_officer(member_id,referral_code,state) VALUES($1,'SO1234567890','pending')",[actor]);
   else await c.query("INSERT INTO sharing_policy(enabled,attribution_days,priority,self_purchase,basis_points,release_days,reason,created_by,created_principal) VALUES(true,NULL,'first',false,1500,7,'synthetic reviewed policy',$1,'synthetic-policy-review')",[actor]);
   await expect(c.query(down)).rejects.toThrow('SHARING_ROLLBACK_REQUIRES_DATA_PRESERVATION');
  }finally{await c.query('ROLLBACK');c.release();}
 }
});
