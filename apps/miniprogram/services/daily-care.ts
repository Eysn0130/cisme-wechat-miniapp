import { request } from "./api";
import { pageRead } from "./page-requests";
import type { CareSelfAssessmentValue } from "./care-protocol";

export const dailyCarePath = "/v1/me/daily-care-records";
export interface DailyCareInput { stepCodes: string[]; selfAssessment: CareSelfAssessmentValue }
export interface DailyCareRecord extends DailyCareInput {
  id: string; source: "daily"; operationId: string; completedAt: string;
  timezone: "Asia/Shanghai"; protocolVersion: "daily-care-v1";
}
export interface DailyCareResult { record: DailyCareRecord; replayed: boolean }
export interface DailyCarePage { items: DailyCareRecord[]; loadedCount: number; hasMore: boolean; nextCursor: string | null }
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const steps = (value: unknown): value is string[] => Array.isArray(value) && value.length === 4 && value.every((code, index) => code === ["00", "01", "02", "03"][index]);
function assessment(value: unknown): value is CareSelfAssessmentValue { return value === "comfortable" || value === "neutral" || value === "attention"; }
function invalid(): never { throw new Error("INVALID_DAILY_CARE_RESPONSE"); }
export function validateDailyCareRecord(value: unknown): DailyCareRecord {
  const row = value as DailyCareRecord | null;
  if (!row || typeof row !== "object" || typeof row.id !== "string" || !uuid.test(row.id) || row.source !== "daily"
    || typeof row.operationId !== "string" || row.operationId.length < 8 || row.operationId.length > 200
    || typeof row.completedAt !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(row.completedAt) || !Number.isFinite(Date.parse(row.completedAt))
    || row.timezone !== "Asia/Shanghai" || row.protocolVersion !== "daily-care-v1" || !steps(row.stepCodes) || !assessment(row.selfAssessment)) invalid();
  return row;
}
export async function createDailyCareRecord(input: DailyCareInput, operationId: string): Promise<DailyCareResult> {
  const value = await request<DailyCareResult>({ path: dailyCarePath, method: "POST", idempotencyKey: operationId,
    data: { stepCodes: [...input.stepCodes], selfAssessment: input.selfAssessment }, cacheTags: ["care"] });
  const record = validateDailyCareRecord(value?.record);
  if (typeof value.replayed !== "boolean" || record.operationId !== operationId || !steps(input.stepCodes)
    || record.selfAssessment !== input.selfAssessment) invalid();
  return value;
}
export async function readDailyCareRecords(page: object, cursor: string | null = null): Promise<DailyCarePage> {
  const value = await pageRead<DailyCarePage>(page, { path: `${dailyCarePath}?limit=20${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`, cacheTags: ["care"] });
  if (!value || !Array.isArray(value.items) || value.items.length > 20 || value.loadedCount !== value.items.length
    || typeof value.hasMore !== "boolean" || !(value.nextCursor === null || typeof value.nextCursor === "string" && value.nextCursor.length > 0 && value.nextCursor.length <= 4096)
    || value.hasMore !== (value.nextCursor !== null) || value.hasMore && (!value.items.length || value.nextCursor === cursor)) invalid();
  value.items.forEach(validateDailyCareRecord);
  if (new Set(value.items.map(row => row.id)).size !== value.items.length || new Set(value.items.map(row => row.operationId)).size !== value.items.length) invalid();
  return value;
}
