import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TEST_DATABASE_URL, resetDatabase, testPool } from '@cisme/testkit';
import { purgeDueOrdinarySupport } from '../../services/api/src/supportRetention.js';

const pool=testPool();
const now=new Date('2026-09-23T12:00:00.000Z');
async function conversation(label:string,resolvedAt:string){
  const member=(await pool.query<{id:string}>('INSERT INTO member(display_name) VALUES($1) RETURNING id',[label])).rows[0]!;
  const row=(await pool.query<{id:string}>(`INSERT INTO support_conversation(member_id,status,resolved_at)
    VALUES($1,'resolved',$2) RETURNING id`,[member.id,resolvedAt])).rows[0]!;
  await pool.query(`INSERT INTO support_message(conversation_id,sequence,sender_type,sender_principal_id,body,client_message_id)
    VALUES($1,1,'user',$2,$3,$4)`,[row.id,`member:${member.id}`,label,`retention-${label}`]);
  return {id:row.id,memberId:member.id};
}

beforeAll(async()=>{await resetDatabase(pool);});
afterAll(async()=>{await pool.end();});

describe('ordinary support retention worker',()=>{
  it('requires an enabled finite policy and applies calendar months',async()=>{
    const old=await conversation('old ordinary inquiry','2026-07-01T12:00:00Z');
    const recent=await conversation('recent ordinary inquiry','2026-09-01T12:00:00Z');
    expect(await purgeDueOrdinarySupport(pool,now)).toBe(0);
    await pool.query(`UPDATE data_retention_policy SET duration_months=1,enforcement_state='enforced',active=true,
      version=version+1,updated_at=now() WHERE code='support_conversation_policy_pending'`);
    expect(await purgeDueOrdinarySupport(pool,now)).toBe(0);
    await pool.query(`UPDATE data_retention_policy SET automatic_purge_enabled=true,
      version=version+1,updated_at=now() WHERE code='support_conversation_policy_pending'`);
    expect(await purgeDueOrdinarySupport(pool,now)).toBe(1);
    expect((await pool.query('SELECT id FROM support_conversation WHERE id=$1',[old.id])).rowCount).toBe(0);
    expect((await pool.query('SELECT id FROM support_conversation WHERE id=$1',[recent.id])).rowCount).toBe(1);
    const audit=(await pool.query(`SELECT before_state,after_state FROM audit_log
      WHERE action='support.retention.purge' AND object_id=$1`,[old.id])).rows[0];
    expect(audit?.before_state).toMatchObject({policyCode:'support_conversation_policy_pending',messageCount:1});
    expect(JSON.stringify(audit)).not.toContain('old ordinary inquiry');
    expect((await pool.query(`SELECT after_state->>'automaticPurge' AS enabled FROM audit_log
      WHERE action='privacy.retention_policy.change' AND after_state->>'code'='support_conversation_policy_pending'
      ORDER BY created_at DESC,id DESC LIMIT 1`)).rows[0].enabled).toBe('true');
    expect(await purgeDueOrdinarySupport(pool,now)).toBe(0);
  });

  it('preserves a held conversation and deletes it only after release',async()=>{
    const held=await conversation('held ordinary inquiry','2026-07-01T12:00:00Z');
    const hold=(await pool.query<{id:string}>(`INSERT INTO legal_hold(reason_code,legal_basis,approved_by,review_at,expires_at)
      VALUES('SUPPORT_RETENTION_TEST','Isolated retention hold','test-reviewer',$1,$2) RETURNING id`,
      [new Date('2026-10-01T12:00:00Z'),new Date('2026-11-01T12:00:00Z')])).rows[0]!;
    await pool.query(`INSERT INTO legal_hold_binding(hold_id,object_type,object_id)
      VALUES($1,'support_conversation',$2)`,[hold.id,held.id]);
    const next=await conversation('later eligible inquiry','2026-08-01T12:00:00Z');
    expect(await purgeDueOrdinarySupport(pool,now,1)).toBe(1);
    expect((await pool.query('SELECT id FROM support_conversation WHERE id=$1',[next.id])).rowCount).toBe(0);
    expect((await pool.query('SELECT id FROM support_conversation WHERE id=$1',[held.id])).rowCount).toBe(1);
    expect(await purgeDueOrdinarySupport(pool,now)).toBe(0);
    await pool.query(`UPDATE legal_hold SET status='released',released_by='test-reviewer',released_at=$2
      WHERE id=$1`,[hold.id,now]);
    expect(await purgeDueOrdinarySupport(pool,now)).toBe(1);
    expect((await pool.query('SELECT id FROM support_conversation WHERE id=$1',[held.id])).rowCount).toBe(0);
  });
});
