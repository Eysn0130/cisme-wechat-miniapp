import type pg from "pg";
import { transaction, type DbClient } from "./db.js";
import { enqueue } from "./outbox.js";

export async function closeRefundedAftersaleSupport(client: DbClient, owner: string): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`support-member:${owner}`]);
  const conversation = (await client.query<{ id: string; status: string; version: number; next_sequence: string }>(`
    SELECT s.id,s.status,s.version,s.next_sequence FROM support_conversation s
    JOIN member m ON m.id=s.member_id AND m.status='active'
    WHERE s.member_id=$1 AND s.status IN ('waiting_human','human_active') FOR UPDATE OF s`, [owner])).rows[0];
  if (!conversation) return;

  // A support row also serves ordinary consultations. Use the recorded intake
  // and the current human work's history to leave unrelated requests assigned.
  const completed = (await client.query<{ id: string; tail: string; execution_kind: string }>(`
    WITH previous_end AS (
      SELECT GREATEST(
        (SELECT max(occurred_at) FROM outbox_event WHERE aggregate_id=$1 AND aggregate_type='support_conversation'
          AND event_type='support.conversation.resolved.v1'),
        (SELECT max(created_at) FROM audit_log WHERE object_id=$1 AND object_type='support_conversation'
          AND action='support.conversation.resume_ai'), '-infinity'::timestamptz
      ) AS at
    ), intake AS (
      SELECT c.id,c.refund_request_id,o.order_number,
        GREATEST(case_message.created_at,(SELECT max(a.created_at) FROM audit_log a
          WHERE a.object_id=$1 AND a.object_type='support_conversation' AND a.action='support.conversation.reopen_for_aftersale'
          AND a.after_state->>'caseId'=c.id::text)) AS opened_at
      FROM commerce_aftersale_case c
      JOIN commerce_order o ON o.id=c.order_id AND o.member_id=c.member_id
      LEFT JOIN support_message case_message ON case_message.conversation_id=$1 AND case_message.sender_type='system'
        AND case_message.sender_principal_id='system:aftersale' AND case_message.client_message_id='aftersale-request:'||c.id::text
      WHERE c.member_id=$2 AND c.support_conversation_id=$1 AND c.state='refund_pending'
    )
    SELECT intake.id,right(intake.order_number,4) AS tail,i.execution_kind
    FROM intake JOIN commission_refund_intent i ON i.request_id=intake.refund_request_id
    CROSS JOIN previous_end e
    WHERE i.state='succeeded' AND intake.opened_at>e.at
      AND NOT EXISTS (SELECT 1 FROM commerce_aftersale_case c
        LEFT JOIN commission_refund_intent pending ON pending.request_id=c.refund_request_id
        WHERE c.member_id=$2 AND (c.support_conversation_id=$1 OR c.support_conversation_id IS NULL)
          AND c.state NOT IN ('cancelled','rejected')
          AND NOT (c.state='refund_pending' AND pending.state IS NOT DISTINCT FROM 'succeeded'))
      AND NOT EXISTS (SELECT 1 FROM outbox_event o WHERE o.aggregate_id=$1 AND o.aggregate_type='support_conversation'
        AND o.event_type='support.conversation.handoff_requested.v1' AND o.occurred_at>e.at)
      AND NOT EXISTS (SELECT 1 FROM audit_log a WHERE a.object_id=$1 AND a.object_type='support_conversation'
        AND a.action='support.conversation.claim' AND a.created_at>e.at
        AND (a.before_state->>'status'='ai_active' OR a.created_at<intake.opened_at))
    ORDER BY intake.opened_at,intake.id LIMIT 1`, [conversation.id, owner])).rows[0];
  if (!completed) return;

  const principal = "system:aftersale";
  const result = completed.execution_kind === "local_credit" ? "购物权益已退回，售后已办结。" : "退款已完成，售后已办结。";
  const message = (await client.query<{ id: string; created_at: Date }>(`
    INSERT INTO support_message
      (conversation_id,sequence,sender_type,sender_principal_id,body,content_type,retention_purpose,client_message_id)
    VALUES($1,$2,'system',$3,$4,'system','transaction',$5) RETURNING id,created_at`,
  [conversation.id, conversation.next_sequence, principal, `订单尾号 ${completed.tail}\n${result}`, `aftersale-refunded:${completed.id}`])).rows[0]!;
  const closed = (await client.query<{ version: number; resolved_at: Date }>(`
    UPDATE support_conversation SET status='resolved',current_handler_principal_id=NULL,resolved_at=clock_timestamp(),
      next_sequence=next_sequence+1,member_unread_count=member_unread_count+1,version=version+1,updated_at=clock_timestamp()
    WHERE id=$1 RETURNING version,resolved_at`, [conversation.id])).rows[0]!;
  await client.query(`UPDATE support_presence SET typing_expires_at=clock_timestamp(),online_expires_at=clock_timestamp(),updated_at=clock_timestamp()
    WHERE conversation_id=$1 AND actor_type='operator'`, [conversation.id]);
  await client.query(`INSERT INTO audit_log(principal_id,action,object_type,object_id,before_state,after_state,trace_id)
    VALUES($1,'support.conversation.resolve','support_conversation',$2,$3,$4,$5)`,
  [principal, conversation.id, { status: conversation.status, version: conversation.version },
    { status: "resolved", version: closed.version, aftersaleCaseId: completed.id }, `aftersale-refunded:${completed.id}`]);
  await enqueue(client, { eventType: "support.message.created.v1", aggregateType: "support_conversation", aggregateId: conversation.id,
    aggregateVersion: closed.version, businessKey: `support-message:${message.id}`, occurredAt: message.created_at,
    payload: { conversationId: conversation.id, messageId: message.id, senderType: "system", sequence: Number(conversation.next_sequence) } });
  await enqueue(client, { eventType: "support.conversation.resolved.v1", aggregateType: "support_conversation", aggregateId: conversation.id,
    aggregateVersion: closed.version, businessKey: `support-resolve:${conversation.id}:v${closed.version}`, occurredAt: closed.resolved_at,
    payload: { conversationId: conversation.id, resolvedBy: principal } });
}

export async function reconcileRefundedAftersaleSupport(pool: pg.Pool, owner: string): Promise<void> {
  const candidate = await pool.query(`SELECT 1 FROM support_conversation s
    JOIN commerce_aftersale_case c ON c.support_conversation_id=s.id AND c.member_id=s.member_id
    JOIN commission_refund_intent i ON i.request_id=c.refund_request_id
    WHERE s.member_id=$1 AND s.status IN ('waiting_human','human_active')
      AND c.state='refund_pending' AND i.state='succeeded' LIMIT 1`, [owner]);
  if (candidate.rowCount) await transaction(pool, client => closeRefundedAftersaleSupport(client, owner));
}
