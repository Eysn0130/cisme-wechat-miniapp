import { request } from './api';
import { pageRead } from './page-requests';
import { validCareDay } from './daily-care';

export const careUsagePath = '/v1/me/points/checkin';
export const careProducts = [
  { id: 'net_run', label: '净润洗发水', hint: '温和清洁，滋润头皮' },
  { id: 'net_xie', label: '净屑洗发水', hint: '清洁头皮，减少头屑困扰' },
  { id: 'essence', label: '护理精华', hint: '不洗头时也可以单独使用' }
] as const;
export type CareProduct = typeof careProducts[number]['id'];
export interface CareUsageInput { products: CareProduct[]; note: string; serverDay: string; expectedVersion?: number }
export interface TodayUsage { id: string; operationId?: string; products: CareProduct[]; note: string; version: number }
export interface CareUsageOverview { serverDay: string; today: TodayUsage | null; enabled: boolean; streak: number }
export interface CareUsageRecord extends TodayUsage { careDay: string; completedAt: string; updatedAt: string }
export interface CareUsageHistory { items: CareUsageRecord[]; totalCount: number; nextBefore: string | null }
function invalid(): never { throw new Error('CARE_USAGE_RESPONSE_INVALID'); }
function products(value: unknown): value is CareProduct[] {
  return Array.isArray(value) && value.length > 0 && value.length <= careProducts.length
    && new Set(value).size === value.length && value.every(id => careProducts.some(p => p.id === id));
}
function validRecord(value: unknown): value is TodayUsage {
  const row = value as TodayUsage | null;
  return !!row && typeof row.id === 'string' && row.id.length > 0 && products(row.products)
    && typeof row.note === 'string' && Array.from(row.note).length <= 500
    && Number.isSafeInteger(row.version) && row.version >= 1
    && (row.operationId === undefined || typeof row.operationId === 'string');
}
export async function readCareUsage(page: object): Promise<CareUsageOverview> {
  const value = await pageRead<CareUsageOverview>(page, { path: '/v1/me/points/club', cacheTags: ['care', 'points', 'member'] });
  if (!value || !validCareDay(value.serverDay) || typeof value.enabled !== 'boolean'
    || !Number.isSafeInteger(value.streak) || value.streak < 0 || value.today !== null && !validRecord(value.today)) invalid();
  // Keep only the care fields: birthdays and reward administration do not belong in home page state.
  return { serverDay: value.serverDay, today: value.today, enabled: value.enabled, streak: value.streak };
}
export async function saveCareUsage(input: CareUsageInput, key: string) {
  if (!products(input.products) || !validCareDay(input.serverDay) || typeof input.note !== 'string'
    || Array.from(input.note).length > 500 || input.expectedVersion !== undefined && (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1)) invalid();
  const result = await request<{ recordId: string; operationId: string; replayed: boolean; careDay: string }>({ path: careUsagePath, method: 'POST', idempotencyKey: key,
    data: { ...input, products: [...input.products] }, cacheTags: ['care', 'points', 'member'] });
  if (!result || typeof result.recordId !== 'string' || !result.recordId || result.operationId !== key || typeof result.replayed !== 'boolean' || result.careDay !== input.serverDay) invalid();
  return result;
}
export function careUsageConfirmed(key: string, input: CareUsageInput, value: CareUsageOverview | null): boolean {
  const row = value?.today;
  return !!row && row.operationId === key && value?.serverDay === input.serverDay
    && row.note === input.note.trim() && [...row.products].sort().join(',') === [...input.products].sort().join(',');
}
export async function readCareUsageHistory(page: object, before: string | null = null): Promise<CareUsageHistory> {
  if (before !== null && !validCareDay(before)) invalid();
  const value = await pageRead<CareUsageHistory>(page, { path: '/v1/me/care-usage-records?limit=20' + (before ? '&before=' + before : ''), cacheTags: ['care'] });
  if (!value || !Array.isArray(value.items) || value.items.length > 20 || !Number.isSafeInteger(value.totalCount) || value.totalCount < value.items.length
    || !(value.nextBefore === null || validCareDay(value.nextBefore)) || value.nextBefore !== null && (!value.items.length || value.nextBefore !== value.items[value.items.length - 1]?.careDay)) invalid();
  if (value.items.some((row, index) => !validRecord(row) || !validCareDay(row.careDay) || before && row.careDay >= before
    || index > 0 && row.careDay >= value.items[index - 1]!.careDay
    || !Number.isFinite(Date.parse(row.completedAt)) || !Number.isFinite(Date.parse(row.updatedAt)))) invalid();
  return value;
}
