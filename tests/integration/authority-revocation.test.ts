import { beforeAll,afterAll,it,expect } from 'vitest';
import { testPool,resetDatabase } from '@cisme/testkit';
import { AuthorityService } from '../../services/api/src/authority';
const pool=testPool(),authority=new AuthorityService(pool,'test');let memberId:string;
beforeAll(async()=>{
 await resetDatabase(pool);memberId=(await pool.query("INSERT INTO member(display_name) VALUES('synthetic authority') RETURNING id")).rows[0].id;
 await pool.query("INSERT INTO authority_grant(member_id,capability,granted_by,grant_reason,environment,grant_source) VALUES($1,'commerce.refund.approve','fixture','synthetic concurrency','test','integration_fixture')",[memberId]);
});
afterAll(async()=>pool.end());
it('serializes capability withdrawal against an already-authorized transaction',async()=>{
 const command=await pool.connect(),revoker=await pool.connect();
 try{
  await command.query('BEGIN');await authority.requireWithClient(command,memberId,'commerce.refund.approve');
  await revoker.query("SET lock_timeout='100ms'");
  await expect(revoker.query("UPDATE authority_grant SET revoked_at=now(),revoked_by='fixture',revoke_reason='synthetic withdrawal' WHERE member_id=$1",[memberId])).rejects.toMatchObject({code:'55P03'});
  await command.query('COMMIT');
  await revoker.query("UPDATE authority_grant SET revoked_at=now(),revoked_by='fixture',revoke_reason='synthetic withdrawal' WHERE member_id=$1",[memberId]);
  await expect(authority.require(memberId,'commerce.refund.approve')).rejects.toMatchObject({code:'CAPABILITY_REQUIRED'});
 }finally{await command.query('ROLLBACK');await revoker.query('RESET lock_timeout');command.release();revoker.release();}
});
it('does not project a still-present grant for a blocked member',async()=>{
 await pool.query("INSERT INTO authority_grant(member_id,capability,granted_by,grant_reason,environment,grant_source) VALUES($1,'commerce.order.read','fixture','synthetic blocked member','test','integration_fixture')",[memberId]);
 await pool.query("UPDATE member SET status='blocked' WHERE id=$1",[memberId]);
 expect(await authority.has(memberId,'commerce.order.read')).toBe(false);
 expect((await authority.projection(memberId)).capabilities).toEqual([]);
 await expect(authority.requireAny(memberId,['commerce.order.read'])).rejects.toMatchObject({code:'CAPABILITY_REQUIRED'});
});

it('denies a capability that expires while its authorization waits for the member lock',async()=>{
 const subject=(await pool.query("INSERT INTO member(display_name) VALUES('expiring synthetic authority') RETURNING id")).rows[0].id;
 await pool.query(`INSERT INTO authority_grant(member_id,capability,granted_by,grant_reason,environment,grant_source,expires_at)
  VALUES($1,'commerce.refund.approve','fixture','synthetic expiring approval','test','integration_fixture',clock_timestamp()+interval '300 milliseconds')`,[subject]);
 const holder=await pool.connect(),reader=await pool.connect();let pending:Promise<unknown>|undefined;
 try{
  await holder.query('BEGIN');await holder.query('SELECT id FROM member WHERE id=$1 FOR UPDATE',[subject]);
  await reader.query('BEGIN');const pid=(await reader.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
  pending=authority.requireWithClient(reader,subject,'commerce.refund.approve').then(value=>({allowed:true,value}),error=>({allowed:false,code:error.code}));
  let waiting=false;
  for(let n=0;n<50;n++){
   waiting=Boolean((await pool.query("SELECT 1 FROM pg_stat_activity WHERE pid=$1 AND wait_event_type='Lock'",[pid])).rowCount);
   if(waiting)break;await new Promise(resolve=>setTimeout(resolve,5));
  }
  expect(waiting).toBe(true);
  await new Promise(resolve=>setTimeout(resolve,350));await holder.query('COMMIT');
  expect(await pending).toEqual({allowed:false,code:'CAPABILITY_REQUIRED'});
 }finally{await holder.query('ROLLBACK');await reader.query('ROLLBACK');holder.release();reader.release();await pending;}
});
