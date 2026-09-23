import type pg from 'pg';
import { transaction } from './db.js';
import { enqueue } from './outbox.js';

type Policy={code:string;version:number;duration_days:number|null;duration_months:number|null;
  active:boolean;enforcement_state:string;automatic_purge_enabled:boolean};
type Candidate={id:string;member_id:string;version:number;resolved_at:Date};

/** Runs only after operations explicitly enables a finite ordinary-support
 * policy. Linked order/aftersale evidence remains outside this purge path. */
export async function purgeDueOrdinarySupport(pool:pg.Pool,now=new Date(),limit=20):Promise<number>{
  if(!Number.isSafeInteger(limit)||limit<1||limit>100)throw new Error('SUPPORT_RETENTION_LIMIT_INVALID');
  return transaction(pool,async client=>{
    const policy=(await client.query<Policy>(`SELECT code,version,duration_days,duration_months,active,
      enforcement_state,automatic_purge_enabled
      FROM data_retention_policy WHERE code='support_conversation_policy_pending' FOR SHARE`)).rows[0];
    if(!policy||!policy.active||!policy.automatic_purge_enabled||policy.enforcement_state!=='enforced'||
      policy.duration_days===null&&policy.duration_months===null)return 0;
    // Message creation and aftersale intake lock this conversation. A selected
    // row is rechecked after its lock; another worker skips it.
    const due=(await client.query<Candidate>(`SELECT c.id,c.member_id,c.version,c.resolved_at
      FROM support_conversation c WHERE c.status='resolved' AND c.resolved_at IS NOT NULL
        AND c.resolved_at+make_interval(days=>$1,months=>$2)<=$3
        AND NOT EXISTS(SELECT 1 FROM support_message m WHERE m.conversation_id=c.id
          AND (m.linked_order_id IS NOT NULL OR m.linked_case_id IS NOT NULL))
        AND NOT EXISTS(SELECT 1 FROM commerce_aftersale_case a WHERE
          a.support_conversation_id=c.id OR a.support_conversation_id IS NULL AND a.member_id=c.member_id)
        AND NOT EXISTS(SELECT 1 FROM legal_hold_binding b JOIN legal_hold h ON h.id=b.hold_id
          WHERE h.status='active' AND h.expires_at>$3 AND
            (b.object_type='support_conversation' AND b.object_id=c.id::text OR
             b.object_type='member' AND b.object_id=c.member_id::text))
      ORDER BY c.resolved_at,c.id LIMIT $4 FOR UPDATE OF c SKIP LOCKED`,
      [policy.duration_days??0,policy.duration_months??0,now,limit])).rows;
    if(!due.length)return 0;
    // Hold creation and release cannot cross the final eligibility check.
    await client.query('LOCK TABLE legal_hold IN SHARE MODE');
    await client.query('LOCK TABLE legal_hold_binding IN SHARE MODE');
    let purged=0;
    for(const row of due){
      const linked=(await client.query<{linked:boolean}>(`SELECT (
        EXISTS(SELECT 1 FROM support_message m WHERE m.conversation_id=$1
          AND (m.linked_order_id IS NOT NULL OR m.linked_case_id IS NOT NULL))
        OR EXISTS(SELECT 1 FROM commerce_aftersale_case a
          WHERE a.support_conversation_id=$1 OR a.support_conversation_id IS NULL AND a.member_id=$2)
      ) AS linked`,[row.id,row.member_id])).rows[0]?.linked;
      if(linked)continue;
      const held=(await client.query<{held:boolean}>(`SELECT EXISTS(
        SELECT 1 FROM legal_hold_binding b JOIN legal_hold h ON h.id=b.hold_id
        WHERE h.status='active' AND h.expires_at>$3 AND
          (b.object_type='support_conversation' AND b.object_id=$1 OR
           b.object_type='member' AND b.object_id=$2)) AS held`,[row.id,row.member_id,now])).rows[0]?.held;
      if(held)continue;
      const messages=(await client.query<{count:number}>(`SELECT count(*)::int AS count
        FROM support_message WHERE conversation_id=$1`,[row.id])).rows[0]?.count??0;
      await client.query(`INSERT INTO media_cleanup_queue(media_id,object_key,reason,next_attempt_at)
        SELECT id,object_key,'support_purged',$2 FROM media_object
        WHERE support_conversation_id=$1 AND upload_state IN ('authorized','uploaded')
        ON CONFLICT DO NOTHING`,[row.id,now]);
      await client.query("SELECT set_config('cisme.support_purge_conversation_id',$1,true)",[row.id]);
      await client.query('DELETE FROM support_message WHERE conversation_id=$1',[row.id]);
      await client.query('DELETE FROM support_conversation WHERE id=$1',[row.id]);
      await client.query(`INSERT INTO audit_log(principal_id,action,object_type,object_id,reason_code,
        before_state,after_state,trace_id)
        VALUES('worker:support-retention','support.retention.purge','support_conversation',$1,
          'SUPPORT_RETENTION_POLICY',$2,$3,$4)`,[row.id,
          {policyCode:policy.code,policyVersion:policy.version,messageCount:messages,resolvedAt:row.resolved_at},
          {purged:true},`support-retention:${row.id}`]);
      await enqueue(client,{eventType:'support.conversation.purged.v1',aggregateType:'support_conversation',
        aggregateId:row.id,aggregateVersion:row.version+1,businessKey:`support-purge:${row.id}`,
        payload:{conversationId:row.id,policyCode:policy.code,policyVersion:policy.version,messageCount:messages},
        occurredAt:now});
      purged++;
    }
    return purged;
  });
}
