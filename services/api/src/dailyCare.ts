import { createHash } from "node:crypto";
import type pg from "pg";
import { DAILY_CARE_PROTOCOL_VERSION, type DailyCareRecordInput, type DailyCareRecordView, type DailyCareRecordResult, type DailyCareRecordPage } from "@cisme/contracts";
import { DomainError } from "@cisme/domain";
import { transaction, type DbClient } from "./db.js";
import { requireCareRecordDetails } from "./careRecordDetails.js";
import { finishPage, pageLimit, pageScope, readPageCursor } from "./keysetPage.js";

type Row = { id: string; operation_id: string; request_sha256: string; completed_at: Date; cursor_at?: string;
  timezone: "Asia/Shanghai"; protocol_version: string; step_codes: DailyCareRecordInput["stepCodes"];
  self_assessment: DailyCareRecordInput["selfAssessment"]; suppressed_at: Date | null };

export function dailyCareInput(value: unknown): DailyCareRecordInput {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !["stepCodes", "selfAssessment"].includes(key))) {
    throw new DomainError("DAILY_CARE_INPUT_INVALID", "请仅提交本次四步护理和护理后感受", 422);
  }
  return requireCareRecordDetails(value as DailyCareRecordInput);
}
function view(row: Row): DailyCareRecordView {
  return { id: row.id, source: "daily", operationId: row.operation_id, completedAt: row.completed_at.toISOString(),
    timezone: row.timezone, protocolVersion: row.protocol_version, stepCodes: [...row.step_codes], selfAssessment: row.self_assessment };
}
async function activeMember(client: DbClient, memberId: string | undefined): Promise<string> {
  if (!memberId) throw new DomainError("MEMBER_REQUIRED", "Member identity is required", 401);
  // Account closure locks this same row FOR UPDATE before suppressing data.
  const owner = await client.query("SELECT id FROM member WHERE id=$1 AND status='active' FOR SHARE", [memberId]);
  if (!owner.rowCount) throw new DomainError("AUTH_REVOKED", "账号状态已变化，请重新核验身份", 401);
  return memberId;
}

/** Member-owned daily facts; no cycle, qualification, reward or invitation is created. */
export class DailyCareService {
  constructor(private pool: pg.Pool) {}
  async create(memberId: string | undefined, operationId: string, input: unknown, now = new Date()): Promise<DailyCareRecordResult> {
    if (typeof operationId !== "string" || operationId.length < 8 || operationId.length > 200) throw new DomainError("IDEMPOTENCY_KEY_INVALID", "Idempotency-Key must be 8 to 200 characters", 400);
    const details = dailyCareInput(input), hash = createHash("sha256").update(JSON.stringify(details)).digest("hex");
    return transaction(this.pool, async client => {
      const owner = await activeMember(client, memberId);
      const inserted = await client.query<Row>(`INSERT INTO daily_care_record(member_id,operation_id,request_sha256,completed_at,timezone,protocol_version,step_codes,self_assessment)
        VALUES($1,$2,$3,$4,'Asia/Shanghai',$5,$6,$7) ON CONFLICT(member_id,operation_id) DO NOTHING RETURNING *`,
        [owner, operationId, hash, now, DAILY_CARE_PROTOCOL_VERSION, details.stepCodes, details.selfAssessment]);
      const row = inserted.rows[0] ?? (await client.query<Row>("SELECT * FROM daily_care_record WHERE member_id=$1 AND operation_id=$2", [owner, operationId])).rows[0];
      if (!row || row.suppressed_at) throw new DomainError("DAILY_CARE_RECORD_UNAVAILABLE", "这条护理记录已不可用，请重新核对", 409);
      if (row.request_sha256 !== hash) throw new DomainError("IDEMPOTENCY_CONFLICT", "本次提交标识已用于不同护理内容，请先核对记录", 409);
      return { record: view(row), replayed: inserted.rowCount === 0 };
    });
  }
  async list(memberId: string | undefined, input: { limit?: unknown; cursor?: unknown } = {}): Promise<DailyCareRecordPage> {
    const limit = pageLimit(input.limit, 20, 50), scope = pageScope(["daily-care-records", memberId]), cursor = readPageCursor(input.cursor, scope);
    return transaction(this.pool, async client => {
      const owner = await activeMember(client, memberId);
      const result = await client.query<Row>(`SELECT *,completed_at::text AS cursor_at FROM daily_care_record
        WHERE member_id=$1 AND suppressed_at IS NULL AND ($2::timestamptz IS NULL OR (completed_at,id)<($2,$3::uuid))
        ORDER BY completed_at DESC,id DESC LIMIT $4`, [owner, cursor?.at ?? null, cursor?.id ?? null, limit + 1]);
      const page = finishPage(result.rows.map(row => ({ ...row, cursorAt: row.cursor_at! })), limit, scope);
      return { items: page.items.map(view), loadedCount: page.loadedCount, hasMore: page.hasMore, nextCursor: page.nextCursor };
    }, "REPEATABLE READ");
  }
}
