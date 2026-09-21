import type pg from "pg";
import { DomainError } from "@cisme/domain";
import { transaction } from "./db.js";
import { finishPage, pageLimit, pageScope, readPageCursor } from "./keysetPage.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const kinds = ["refund", "settlement", "credit", "credit-cancel", "cancel", "cancel-verified"];
/** Discovery after loss of local keys, not permission to repeat a command.
 * Only retained domain facts are exposed. No original key/payload is returned
 * or reconstructed, no unlock/replay is performed, and absence is inconclusive.
 * cancel/cancel-verified are aliases of the same durable order-cancel fact. */
export async function discoverCommerceCommands(pool: pg.Pool, memberId: string | undefined,
  principalId: string | undefined, environment: string, kind: string, query: Record<string, unknown> = {}) {
  if (!memberId || !principalId) throw new DomainError("AUTH_REQUIRED", "请先登录后核对历史操作", 401);
  const objectId = query.objectId ?? null;
  if (!kinds.includes(kind) || Object.keys(query).some(field => !["objectId", "limit", "cursor"].includes(field)) ||
    (objectId !== null && (typeof objectId !== "string" || !UUID.test(objectId))))
    throw new DomainError("COMMERCE_DISCOVERY_QUERY_INVALID", "历史操作查询参数无效", 422);
  const limit = pageLimit(query.limit), scope = pageScope(["recorded-commerce-v1", environment, memberId, principalId, kind, objectId]);
  const cursor = readPageCursor(query.cursor, scope);
  return transaction(pool, async client => {
    const member = await client.query("SELECT id FROM member WHERE id=$1 AND status='active'", [memberId]);
    if (!member.rows.length) throw new DomainError("AUTH_REVOKED", "会员身份不可用", 401);
    // Every branch has its own owner predicate. SQL fragments are static;
    // objectId is always a parameter and never grants access to another owner.
    let facts: string;
    if (kind === "refund") {
      facts = `SELECT r.id,r.order_id AS object_id,r.state,r.version AS record_version,r.created_at AS command_at
        FROM commerce_refund_request r JOIN commerce_order o ON o.id=r.order_id AND o.member_id=$1
        WHERE r.requested_by_member_id=$1`;
    } else if (kind === "settlement") {
      facts = `SELECT id,id AS object_id,state,version AS record_version,created_at AS command_at
        FROM commission_settlement_request WHERE member_id=$1 AND requested_by_member_id=$1`;
    } else if (kind === "credit" || kind === "credit-cancel") {
      facts = kind === "credit"
        ? `SELECT id,id AS object_id,state,NULL::integer AS record_version,created_at AS command_at
            FROM commission_credit_conversion WHERE member_id=$1`
        : `SELECT id,id AS object_id,state,NULL::integer AS record_version,cancelled_at AS command_at
            FROM commission_credit_conversion WHERE member_id=$1 AND state='cancelled' AND cancel_key IS NOT NULL`;
    } else {
      facts = `SELECT o.id,o.id AS object_id,o.status AS state,o.version AS record_version,i.created_at AS command_at
        FROM idempotency_operation i JOIN commerce_order o ON o.member_id=$1
          AND i.response_body->>'orderId'=o.id::text
        WHERE i.principal_id=$6 AND i.operation='commerce.order.cancel'
          AND i.response_body->>'status'='cancelled' AND i.response_body->>'orderVersion'=o.version::text
          AND o.status='cancelled' AND i.business_key LIKE o.id::text||':%'`;
    }
    const params: unknown[] = [memberId, objectId, cursor?.at ?? null, cursor?.id ?? null, limit + 1];
    if (kind === "cancel" || kind === "cancel-verified") params.push(principalId);
    const rows = (await client.query(`WITH facts AS (${facts})
      SELECT id,object_id,state,record_version,
        to_char(command_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS command_at
      FROM facts WHERE ($2::uuid IS NULL OR object_id=$2)
        AND ($3::timestamptz IS NULL OR (command_at,id)<($3::timestamptz,$4::uuid))
      ORDER BY facts.command_at DESC,id DESC LIMIT $5`, params)).rows;
    // Keep PostgreSQL microseconds in the cursor; converting to a JS Date would
    // silently skip commands created within the last row's millisecond.
    const page = finishPage(rows.map(row => ({ id: row.id as string, objectId: row.object_id as string,
      state: row.state as string, recordVersion: row.record_version as number | null,
      commandCreatedAt: row.command_at as string, cursorAt: row.command_at as string })), limit, scope);
    return { version: 1, kind, coverage: "retained_recorded_facts_only", absenceIsFailure: false,
      ...page, items: page.items.map(({ cursorAt: _cursorAt, ...record }) => record) };
  }, "REPEATABLE READ");
}
