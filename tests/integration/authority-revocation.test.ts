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
