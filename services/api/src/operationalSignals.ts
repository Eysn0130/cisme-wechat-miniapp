import type pg from 'pg';
/** Aggregate evidence only: no member/order IDs, payloads or automatic redrive.
 * Unknown payment state remains unknown regardless of its age. */
export async function operationalSignals(pool:pg.Pool){
 const row=(await pool.query(`SELECT
  (SELECT count(*)::int FROM outbox_event WHERE processed_at IS NULL AND dead_lettered_at IS NULL) outbox_pending,
  (SELECT count(*)::int FROM outbox_event WHERE processed_at IS NULL AND dead_lettered_at IS NOT NULL) outbox_quarantined,
  (SELECT count(*)::int FROM media_cleanup_queue WHERE processed_at IS NULL AND dead_lettered_at IS NOT NULL) storage_cleanup_quarantined,
  (SELECT count(*)::int FROM commission_payment_inbox WHERE state='pending') payment_inbox_pending,
  (SELECT count(*)::int FROM commission_payment_inbox WHERE state='exception') payment_inbox_exception,
  (SELECT count(*)::int FROM commission_refund_inbox WHERE state='pending') refund_inbox_pending,
  (SELECT count(*)::int FROM commission_refund_inbox WHERE state='exception') refund_inbox_exception,
  (SELECT count(*)::int FROM commerce_payment_attempt WHERE state='unknown') payment_unknown,
  (SELECT count(*)::int FROM commission_refund_intent WHERE submission_state='unknown') refund_submission_unknown,
  (SELECT count(*)::int FROM commission_settlement_request WHERE state IN ('unknown','processing')) transfer_unresolved,
  (SELECT count(*)::int FROM commerce_trade_bill_row WHERE status='exception') trade_bill_exception,
  (SELECT count(*)::int FROM commission_payment_composition_observation) payment_composition_conflicts,
  (SELECT extract(epoch FROM clock_timestamp()-min(occurred_at))::bigint::text FROM outbox_event
    WHERE processed_at IS NULL AND dead_lettered_at IS NULL) oldest_outbox_seconds`)).rows[0];
 const counts=Object.fromEntries(Object.entries(row).filter(([k])=>k!=='oldest_outbox_seconds').map(([k,v])=>[k,Number(v)]));
 const signals=Object.entries(counts).filter(([key,value])=>value>0&&/quarantined|exception|unknown|unresolved|conflicts/.test(key))
  .map(([kind,count])=>({kind,count,action:'investigate_original_facts',automaticRetry:false,terminalFailureInferred:false}));
 return {schemaVersion:1,counts,oldestOutboxSeconds:row.oldest_outbox_seconds===null?null:Math.max(0,Number(row.oldest_outbox_seconds)),
  signals,thresholdPolicy:'presence of unresolved/exception facts; no invented SLA or terminal status',
  delivery:'local authenticated projection; no notification destination configured'};
}
