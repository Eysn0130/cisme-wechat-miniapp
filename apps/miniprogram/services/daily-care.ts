import { request } from "./api";
import { pageRead } from "./page-requests";
import type { CareSelfAssessmentValue } from "./care-protocol";

export const dailyCarePath = "/v1/me/daily-care-records";
export interface DailyCareInput { careDay: string; stepCodes: string[]; selfAssessment: CareSelfAssessmentValue }
export interface DailyCareRecord extends DailyCareInput {
  id: string; source: "daily"; operationId: string; completedAt: string;
  timezone: "Asia/Shanghai"; protocolVersion: "daily-care-v1";
  version: number; updatedAt: string; deleted: boolean;
}
export interface DailyCareResult { record: DailyCareRecord; replayed: boolean; current: boolean }
export interface DailyCarePage { items: DailyCareRecord[]; loadedCount: number; hasMore: boolean; nextCursor: string | null; serverDay: string; today: DailyCareRecord | null; totalCount: number }
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const steps = (value: unknown): value is string[] => Array.isArray(value) && value.length === 4 && value.every((code, index) => code === ["00", "01", "02", "03"][index]);
function assessment(value: unknown): value is CareSelfAssessmentValue { return value === "comfortable" || value === "neutral" || value === "attention"; }
function invalid(): never { throw new Error("INVALID_DAILY_CARE_RESPONSE"); }
function timestamp(value: unknown): value is string { return typeof value === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(value) && Number.isFinite(Date.parse(value)); }
export function validCareDay(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d\d-\d\d$/.test(value) && Number.isFinite(Date.parse(value + "T00:00:00Z")) && new Date(value + "T00:00:00Z").toISOString().slice(0, 10) === value;
}
export function isDailyCarePath(path: string): boolean { return path === dailyCarePath || path.startsWith(dailyCarePath + "/") && uuid.test(path.slice(dailyCarePath.length + 1)); }
export function validateDailyCareRecord(value: unknown): DailyCareRecord {
  const row = value as DailyCareRecord | null;
  if (!row || typeof row !== "object" || typeof row.id !== "string" || !uuid.test(row.id) || row.source !== "daily"
    || typeof row.operationId !== "string" || row.operationId.length < 8 || row.operationId.length > 200
    || !timestamp(row.completedAt) || !timestamp(row.updatedAt) || !validCareDay(row.careDay)
    || !Number.isSafeInteger(row.version) || row.version < 1 || typeof row.deleted !== "boolean"
    || row.timezone !== "Asia/Shanghai" || row.protocolVersion !== "daily-care-v1" || !steps(row.stepCodes) || !assessment(row.selfAssessment)) invalid();
  return row;
}
export async function createDailyCareRecord(input: DailyCareInput, operationId: string): Promise<DailyCareResult> {
  return saveDailyCareRecord(input, operationId);
}
export async function saveDailyCareRecord(input: DailyCareInput, operationId: string, target?: { id: string; version: number }): Promise<DailyCareResult> {
  if (!validCareDay(input.careDay) || !steps(input.stepCodes) || !assessment(input.selfAssessment) || target && (!uuid.test(target.id) || !Number.isSafeInteger(target.version) || target.version < 1)) invalid();
  const value = await request<DailyCareResult>({ path: dailyCarePath + (target ? "/" + target.id : ""), method: target ? "PUT" : "POST", idempotencyKey: operationId,
    data: { careDay: input.careDay, stepCodes: [...input.stepCodes], selfAssessment: input.selfAssessment, ...(target ? { expectedVersion: target.version } : {}) }, cacheTags: ["care"] });
  const record = validateDailyCareRecord(value?.record);
  if (typeof value.replayed !== "boolean" || typeof value.current !== "boolean" || record.deleted || record.operationId !== operationId
    || record.careDay !== input.careDay || record.selfAssessment !== input.selfAssessment || target && (record.id !== target.id || record.version !== target.version + 1)) invalid();
  return value;
}
export async function changeDailyCareRecord(id: string, expectedVersion: number, operationId: string, restore = false): Promise<DailyCareResult> {
  if (!uuid.test(id) || !Number.isSafeInteger(expectedVersion) || expectedVersion < 1) invalid();
  const value = await request<DailyCareResult>({ path: `${dailyCarePath}/${id}${restore ? "/restore" : ""}`, method: restore ? "POST" : "DELETE", idempotencyKey: operationId, data: { expectedVersion }, cacheTags: ["care"] });
  const record = validateDailyCareRecord(value?.record);
  if (typeof value.replayed !== "boolean" || typeof value.current !== "boolean" || record.id !== id || record.operationId !== operationId || record.version !== expectedVersion + 1 || record.deleted !== !restore) invalid();
  return value;
}
export function dailyCareCommandConfirmed(key: string, input: DailyCareInput, records: readonly DailyCareRecord[], id?: string): boolean {
  return records.some(row => !row.deleted && row.operationId === key && (!id || row.id === id) && row.careDay === input.careDay && row.selfAssessment === input.selfAssessment && steps(row.stepCodes) && steps(input.stepCodes));
}
export async function readDailyCareRecords(page: object, cursor: string | null = null): Promise<DailyCarePage> {
  const value = await pageRead<DailyCarePage>(page, { path: `${dailyCarePath}?limit=20${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`, cacheTags: ["care"] });
  if (!value || !Array.isArray(value.items) || value.items.length > 20 || value.loadedCount !== value.items.length
    || typeof value.hasMore !== "boolean" || !(value.nextCursor === null || typeof value.nextCursor === "string" && value.nextCursor.length > 0 && value.nextCursor.length <= 4096)
    || value.hasMore !== (value.nextCursor !== null) || value.hasMore && (!value.items.length || value.nextCursor === cursor)
    || !validCareDay(value.serverDay) || !Number.isSafeInteger(value.totalCount) || value.totalCount < value.items.length) invalid();
  value.items.forEach(validateDailyCareRecord);
  if (value.today !== null) {
    const today = validateDailyCareRecord(value.today);
    if (today.deleted || today.careDay !== value.serverDay || value.totalCount < 1) invalid();
    const duplicate = value.items.find(row => row.id === today.id || row.careDay === today.careDay);
    if (duplicate && (duplicate.id !== today.id || duplicate.version !== today.version || duplicate.operationId !== today.operationId || duplicate.careDay !== today.careDay || duplicate.completedAt !== today.completedAt || duplicate.updatedAt !== today.updatedAt || duplicate.selfAssessment !== today.selfAssessment)) invalid();
  }
  if (value.items.some(row => row.deleted || row.careDay > value.serverDay) || new Set(value.items.map(row => row.id)).size !== value.items.length || new Set(value.items.map(row => row.operationId)).size !== value.items.length || new Set(value.items.map(row => row.careDay)).size !== value.items.length || value.today === null && value.items.some(row => row.careDay === value.serverDay)) invalid();
  return value;
}
