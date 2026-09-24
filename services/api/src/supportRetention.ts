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
          a.support_conversation_id=c.id OR a.support_conversation_id IS NULL
            AND a.member_id=c.member_id AND a.created_at<=c.resolved_at)
        AND NOT EXISTS(SELECT 1 FROM privacy_request p WHERE p.member_id=c.member_id
          AND p.status NOT IN ('completed','partially_completed','rejected','canceled'))
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
    await client.query('LOCK TABLE privacy_request IN SHARE MODE');
    let purged=0;
    for(const row of due){
      const linked=(await client.query<{linked:boolean}>(`SELECT (
        EXISTS(SELECT 1 FROM support_message m WHERE m.conversation_id=$1
          AND (m.linked_order_id IS NOT NULL OR m.linked_case_id IS NOT NULL))
        OR EXISTS(SELECT 1 FROM commerce_aftersale_case a
          WHERE a.support_conversation_id=$1 OR a.support_conversation_id IS NULL
            AND a.member_id=$2 AND a.created_at<=$3)
      ) AS linked`,[row.id,row.member_id,row.resolved_at])).rows[0]?.linked;
      if(linked)continue;
      const openRights=(await client.query<{open:boolean}>(`SELECT EXISTS(
        SELECT 1 FROM privacy_request WHERE member_id=$1
          AND status NOT IN ('completed','partially_completed','rejected','canceled')) AS open`,
        [row.member_id])).rows[0]?.open;
      if(openRights)continue;
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

type LinkedOrder={id:string;status:string;cancelled_at:Date|null;expired_at:Date|null;
  receipt_confirmed_at:Date|null;verified_delivered_at:Date|null;total_cents:string;
  succeeded_refund_cents:string;refund_finalized_at:Date|null};
type LinkedCase={id:string;state:string;updated_at:Date;refund_state:string|null;refund_finalized_at:Date|null};

/** A paid order with no delivery can end through a verified full refund.
 * Partial or unknown refunds do not establish a transaction end date. */
export function linkedOrderTerminalAt(order:LinkedOrder):Date|null {
  if(order.status==='cancelled')return order.cancelled_at;
  if(order.status==='expired')return order.expired_at;
  if(order.status!=='paid')return null;
  const delivery=order.receipt_confirmed_at??order.verified_delivered_at;
  if(delivery)return order.refund_finalized_at&&order.refund_finalized_at>delivery
    ?order.refund_finalized_at:delivery;
  return BigInt(order.succeeded_refund_cents)===BigInt(order.total_cents)
    ?order.refund_finalized_at:null;
}

/** A member has one support conversation, so mixed consultation and commerce
 * messages share a clock. Purge only after the later of resolution and every
 * related transaction's terminal fact; an unfinished order/case blocks it.
 * Cases retain the conversation row for their FK, while message bodies and
 * attachments are removed. The policy is off by default on migration. */
export async function purgeDueLinkedSupport(pool:pg.Pool,now=new Date(),limit=20):Promise<number>{
  if(!Number.isSafeInteger(limit)||limit<1||limit>100)throw new Error('SUPPORT_RETENTION_LIMIT_INVALID');
  return transaction(pool,async client=>{
    const policy=(await client.query<Policy>(`SELECT code,version,duration_days,duration_months,active,
      enforcement_state,automatic_purge_enabled FROM data_retention_policy
      WHERE code='support_transaction_three_years' FOR SHARE`)).rows[0];
    if(!policy||!policy.active||!policy.automatic_purge_enabled||policy.enforcement_state!=='enforced'||
      policy.duration_months===null||policy.duration_days!==null)return 0;
    const candidates=(await client.query<Candidate>(`SELECT c.id,c.member_id,c.version,c.resolved_at
      FROM support_conversation c WHERE c.status='resolved' AND c.resolved_at IS NOT NULL
        AND c.resolved_at+make_interval(months=>$1)<=$2
        AND EXISTS(SELECT 1 FROM support_message m WHERE m.conversation_id=c.id)
        AND (EXISTS(SELECT 1 FROM support_message m WHERE m.conversation_id=c.id
          AND (m.linked_order_id IS NOT NULL OR m.linked_case_id IS NOT NULL))
          OR EXISTS(SELECT 1 FROM commerce_aftersale_case a WHERE
            a.support_conversation_id=c.id OR a.support_conversation_id IS NULL
              AND a.member_id=c.member_id AND a.created_at<=c.resolved_at))
      ORDER BY c.resolved_at,c.id LIMIT $3 FOR UPDATE OF c SKIP LOCKED`,
      [policy.duration_months,now,limit])).rows;
    if(!candidates.length)return 0;
    await client.query('LOCK TABLE legal_hold IN SHARE MODE');
    await client.query('LOCK TABLE legal_hold_binding IN SHARE MODE');
    await client.query('LOCK TABLE privacy_request IN SHARE MODE');
    let purged=0;
    for(const row of candidates){
      const openRights=(await client.query<{open:boolean}>(`SELECT EXISTS(SELECT 1 FROM privacy_request
        WHERE member_id=$1 AND status NOT IN ('completed','partially_completed','rejected','canceled')) AS open`,
        [row.member_id])).rows[0]?.open;
      if(openRights)continue;
      // Explicit order cards and case links define the conversation's trade
      // scope. For legacy free-text threads without either, conservatively
      // retain orders that existed when this conversation was resolved; a
      // later unrelated purchase cannot extend the old thread indefinitely.
      const orders=(await client.query<LinkedOrder>(`SELECT o.id,o.status,o.cancelled_at,o.expired_at,
        o.total_cents,s.receipt_confirmed_at,f.delivered_at AS verified_delivered_at,
        COALESCE(refunds.succeeded_refund_cents,0)::text AS succeeded_refund_cents,
        refunds.refund_finalized_at
        FROM commerce_order o LEFT JOIN commerce_shipment s ON s.order_id=o.id
        LEFT JOIN commerce_fulfillment_attestation f ON f.order_id=o.id AND f.state='verified'
        LEFT JOIN LATERAL (
          SELECT sum(r.amount_cents) AS succeeded_refund_cents,max(i.finalized_at) AS refund_finalized_at
          FROM commission_refund_intent i JOIN commerce_refund_request r ON r.id=i.request_id
          WHERE i.order_id=o.id AND i.state='succeeded'
        ) refunds ON true
        WHERE o.member_id=$1 AND (
          EXISTS(SELECT 1 FROM support_message m WHERE m.conversation_id=$2 AND m.linked_order_id=o.id)
          OR EXISTS(SELECT 1 FROM commerce_aftersale_case a WHERE a.order_id=o.id
            AND a.support_conversation_id=$2)
          OR EXISTS(SELECT 1 FROM commerce_aftersale_case a JOIN support_message m
            ON m.linked_case_id=a.id WHERE a.order_id=o.id AND m.conversation_id=$2)
          OR (o.created_at<=$3 AND NOT EXISTS(SELECT 1 FROM support_message m
            WHERE m.conversation_id=$2 AND (m.linked_order_id IS NOT NULL OR m.linked_case_id IS NOT NULL))
            AND NOT EXISTS(SELECT 1 FROM commerce_aftersale_case a WHERE a.support_conversation_id=$2))
        )`,[row.member_id,row.id,row.resolved_at])).rows;
      const cases=(await client.query<LinkedCase>(`SELECT c.id,c.state,c.updated_at,
        i.state AS refund_state,i.finalized_at AS refund_finalized_at
        FROM commerce_aftersale_case c LEFT JOIN commission_refund_intent i ON i.request_id=c.refund_request_id
        WHERE c.member_id=$1 AND (c.support_conversation_id=$2 OR c.order_id=ANY($3::uuid[]) OR
          EXISTS(SELECT 1 FROM support_message m WHERE m.conversation_id=$2 AND m.linked_case_id=c.id) OR
          c.support_conversation_id IS NULL AND c.created_at<=$4 AND NOT EXISTS(
            SELECT 1 FROM support_message m WHERE m.conversation_id=$2
              AND (m.linked_order_id IS NOT NULL OR m.linked_case_id IS NOT NULL)))`,
        [row.member_id,row.id,orders.map(order=>order.id),row.resolved_at])).rows;
      let terminalAt=row.resolved_at,unfinished=false;
      for(const order of orders){
        const end=linkedOrderTerminalAt(order);
        if(!end){unfinished=true;break;}
        if(end>terminalAt)terminalAt=end;
      }
      if(unfinished)continue;
      for(const item of cases){
        const end=['rejected','cancelled'].includes(item.state)?item.updated_at:
          item.state==='refund_pending'&&item.refund_state==='succeeded'?item.refund_finalized_at:null;
        if(!end){unfinished=true;break;}
        if(end>terminalAt)terminalAt=end;
      }
      if(unfinished)continue;
      const due=(await client.query<{due:boolean}>(`SELECT $1::timestamptz+make_interval(months=>$2)<=$3 AS due`,
        [terminalAt,policy.duration_months,now])).rows[0]?.due;
      if(!due)continue;
      const media=(await client.query<{id:string}>(
        'SELECT id FROM media_object WHERE support_conversation_id=$1',[row.id])).rows;
      const protectedIds=[row.member_id,row.id,...orders.map(order=>order.id),...cases.map(item=>item.id),...media.map(item=>item.id)];
      const held=(await client.query<{held:boolean}>(`SELECT EXISTS(SELECT 1 FROM legal_hold_binding b
        JOIN legal_hold h ON h.id=b.hold_id WHERE h.status='active' AND h.expires_at>$2
        AND (b.object_id=ANY($1::text[]) OR b.object_type='support_message' AND EXISTS(
          SELECT 1 FROM support_message m WHERE m.conversation_id=$3 AND m.id::text=b.object_id))) AS held`,
        [protectedIds,now,row.id])).rows[0]?.held;
      if(held)continue;
      const messages=(await client.query<{count:number}>(`SELECT count(*)::int AS count
        FROM support_message WHERE conversation_id=$1`,[row.id])).rows[0]?.count??0;
      if(!messages)continue;
      await client.query(`INSERT INTO media_cleanup_queue(media_id,object_key,reason,next_attempt_at)
        SELECT id,object_key,'support_purged',$2 FROM media_object
        WHERE support_conversation_id=$1 AND upload_state IN ('authorized','uploaded')
        ON CONFLICT DO NOTHING`,[row.id,now]);
      await client.query("SELECT set_config('cisme.support_purge_conversation_id',$1,true)",[row.id]);
      await client.query('DELETE FROM support_message WHERE conversation_id=$1',[row.id]);
      const referenced=cases.length>0&&Boolean((await client.query(`SELECT 1 FROM commerce_aftersale_case
        WHERE support_conversation_id=$1 LIMIT 1`,[row.id])).rowCount);
      if(referenced)await client.query(`UPDATE support_conversation SET member_unread_count=0,
        team_unread_count=0,member_last_read_sequence=next_sequence-1,
        team_last_read_sequence=next_sequence-1,version=version+1,updated_at=clock_timestamp()
        WHERE id=$1`,[row.id]);
      else await client.query('DELETE FROM support_conversation WHERE id=$1',[row.id]);
      await client.query(`INSERT INTO audit_log(principal_id,action,object_type,object_id,reason_code,
        before_state,after_state,trace_id)
        VALUES('worker:support-retention','support.transaction.retention.purge','support_conversation',$1,
          'SUPPORT_TRANSACTION_RETENTION',$2,$3,gen_random_uuid()::text)`,
        [row.id,{policyCode:policy.code,policyVersion:policy.version,messageCount:messages,
          resolvedAt:row.resolved_at,terminalAt,orderCount:orders.length,caseCount:cases.length},
          {messagesPurged:true,conversationRetained:referenced}]);
      if(!referenced)await enqueue(client,{eventType:'support.conversation.purged.v1',aggregateType:'support_conversation',
        aggregateId:row.id,aggregateVersion:row.version+1,businessKey:`support-purge:${row.id}`,
        payload:{conversationId:row.id,policyCode:policy.code,policyVersion:policy.version,messageCount:messages},
        occurredAt:now});
      purged++;
    }
    return purged;
  });
}
