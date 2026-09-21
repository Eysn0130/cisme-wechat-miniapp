import type pg from "pg";
import { DomainError } from "@cisme/domain";
import { transaction } from "./db.js";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const kinds = ["refund", "settlement", "credit", "credit-cancel", "cancel", "cancel-verified"];
/** Reads only durable command facts already owned by the authenticated member.
 * A missing row does not prove a concurrent write failed. No provider call,
 * arbitrary response_body, payer identity, key, hash or confirmation package. */
export async function commerceCommandReceipt(pool: pg.Pool, memberId: string | undefined, principalId: string | undefined,
  kind: string, key: string, query: Record<string, unknown> = {}) {
  if (!memberId || !principalId) throw new DomainError("AUTH_REQUIRED", "请先登录后核对原操作", 401);
  const objectId = query.objectId;
  if (!kinds.includes(kind) || !/^[A-Za-z0-9._:-]{8,200}$/.test(key) || Object.keys(query).some(field => field !== "objectId") ||
    (["settlement", "credit"].includes(kind) ? objectId !== undefined : typeof objectId !== "string" || !UUID.test(objectId)))
    throw new DomainError("COMMERCE_RECEIPT_QUERY_INVALID", "原操作核对参数无效", 422);
  return transaction(pool, async client => {
    const member = await client.query("SELECT id FROM member WHERE id=$1 AND status='active'", [memberId]);
    if (!member.rows.length) throw new DomainError("AUTH_REVOKED", "会员身份不可用", 401);
    let record: { id: string; state: string; orderId?: string; amountCents?: number } | null = null;
    if (kind === "refund") {
      const row = (await client.query(`SELECT r.id,r.order_id,r.state,r.amount_cents FROM commerce_refund_request r
        JOIN commerce_order o ON o.id=r.order_id AND o.member_id=$1
        WHERE r.requested_by_member_id=$1 AND r.idempotency_key=$2 AND r.order_id=$3`, [memberId, key, objectId])).rows[0];
      if (row) record = { id: row.id, orderId: row.order_id, state: row.state, amountCents: Number(row.amount_cents) };
    } else if (kind === "settlement") {
      const row = (await client.query(`SELECT id,state,amount_cents FROM commission_settlement_request
        WHERE member_id=$1 AND requested_by_member_id=$1 AND idempotency_key=$2`, [memberId, key])).rows[0];
      if (row) record = { id: row.id, state: row.state, amountCents: Number(row.amount_cents) };
    } else if (kind === "credit") {
      const row = (await client.query(`SELECT id,state,credit_cents FROM commission_credit_conversion
        WHERE member_id=$1 AND idempotency_key=$2`, [memberId, key])).rows[0];
      if (row) record = { id: row.id, state: row.state, amountCents: Number(row.credit_cents) };
    } else if (kind === "credit-cancel") {
      const row = (await client.query(`SELECT id,state FROM commission_credit_conversion
        WHERE member_id=$1 AND cancel_key=$2 AND id=$3 AND state='cancelled'`, [memberId, key, objectId])).rows[0];
      if (row) record = { id: row.id, state: row.state };
    } else {
      const row = (await client.query(`SELECT o.id,o.status FROM idempotency_operation i
        JOIN commerce_order o ON o.id=$3 AND o.member_id=$1
        WHERE i.principal_id=$4 AND i.operation='commerce.order.cancel' AND i.idempotency_key=$2
          AND i.response_body->>'orderId'=o.id::text AND i.response_body->>'status'='cancelled'
          AND i.response_body->>'orderVersion'=o.version::text AND o.status='cancelled'
          AND i.business_key LIKE o.id::text||':%'`, [memberId, key, objectId, principalId])).rows[0];
      if (row) record = { id: row.id, state: row.status };
    }
    return { version: 1, memberId, kind, status: record ? "recorded" : "not_observed", record };
  }, "REPEATABLE READ");
}
