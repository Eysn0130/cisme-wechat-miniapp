import { pageRead } from './page-requests';
import { commerceContextRevision, commerceUuid, type CommerceCommandKind } from './commerce-command-store';
import type { RecoveryScope } from './commerce-command-recovery';

export interface RecordedGroup {
  kind: CommerceCommandKind; title: string; loading: boolean; error: string; nextCursor: string | null;
  rows: Array<{ id: string; objectId: string; label: string; createdLabel: string }>;
}
interface PageHost { data: { recordedGroups: RecordedGroup[] }; setData(data: { recordedGroups: RecordedGroup[] }): void }
interface Fact { id: string; objectId: string; state: string; recordVersion: number | null; commandCreatedAt: string }
interface FactsPage { version: number; kind: string; coverage: string; absenceIsFailure: boolean;
  items: Fact[]; nextCursor: string | null; hasMore: boolean }
const titles: Record<CommerceCommandKind, string> = { refund: '退款申请记录', settlement: '结算意向记录',
  credit: '权益转换记录', 'credit-cancel': '权益撤销记录', cancel: '订单取消记录', 'cancel-verified': '渠道核对取消记录' };
const states: Record<string, string> = { requested: '已记录申请，等待处理', approved: '申请已核准，渠道结果另行核对',
  rejected: '申请未通过', reserved: '已预占，尚未确认到账', unknown: '渠道结果待核对', processing: '渠道处理中',
  succeeded: '服务端记录已完成', failed: '服务端记录未完成', cancelled: '已取消', available: '权益已记录' };
const attempts = new WeakMap<object, number>();

/** Discovery is deliberately independent of the local command journal. It
 * neither reconstructs a key nor retires/unlocks/replays an unknown command. */
export async function loadRecordedCommands(page: PageHost, scope: RecoveryScope, current: () => boolean,
  moreKind?: CommerceCommandKind): Promise<void> {
  const token = getApp<IAppOption>().globalData.sessionToken;
  const revision = commerceContextRevision();
  const target = JSON.stringify([getApp<IAppOption>().globalData.apiBaseUrl, getApp<IAppOption>().globalData.cloudFunction]);
  const generation = moreKind ? (attempts.get(page) ?? 0) : (attempts.get(page) ?? 0) + 1;
  if (!moreKind) attempts.set(page, generation);
  const valid = () => Boolean(token) && current() && revision === commerceContextRevision() &&
    token === getApp<IAppOption>().globalData.sessionToken && generation === attempts.get(page) &&
    target === JSON.stringify([getApp<IAppOption>().globalData.apiBaseUrl, getApp<IAppOption>().globalData.cloudFunction]);
  if (!valid()) return;
  const kinds: CommerceCommandKind[] = scope.group === 'order' ? ['refund', 'cancel', 'cancel-verified'] : ['settlement', 'credit', 'credit-cancel'];
  if (!moreKind) page.setData({ recordedGroups: kinds.map(kind => ({ kind, title: titles[kind], rows: [], nextCursor: null, loading: false, error: '' })) });
  const selected = moreKind ? kinds.filter(kind => kind === moreKind) : kinds;
  await Promise.all(selected.map(async kind => {
    const group = page.data.recordedGroups.find(item => item.kind === kind);
    if (!group || group.loading || moreKind && !group.nextCursor) return;
    const cursor = moreKind ? group.nextCursor : null;
    const update = (patch: Partial<RecordedGroup>) => {
      if (valid()) page.setData({ recordedGroups: page.data.recordedGroups.map(item => item.kind === kind ? { ...item, ...patch } : item) });
    };
    update({ loading: true, error: '' });
    try {
      const query = [`limit=10`, ...(scope.group === 'order' ? [`objectId=${encodeURIComponent(scope.objectId)}`] : []),
        ...(cursor ? [`cursor=${encodeURIComponent(cursor)}`] : [])].join('&');
      const value = await pageRead<FactsPage>(page, { path: `/v1/me/commerce/recorded-commands/${kind}?${query}` });
      if (!valid()) return;
      if (!value || value.version !== 1 || value.kind !== kind || value.coverage !== 'retained_recorded_facts_only' ||
        value.absenceIsFailure !== false || !Array.isArray(value.items) || value.items.length > 10 ||
        (value.nextCursor !== null && (typeof value.nextCursor !== 'string' || value.nextCursor.length > 600 || !/^[A-Za-z0-9_-]+$/.test(value.nextCursor))) ||
        value.hasMore !== Boolean(value.nextCursor) || cursor && value.nextCursor === cursor ||
        value.items.some(row => !row || !commerceUuid.test(row.id) || !commerceUuid.test(row.objectId) ||
          !states[row.state] || !Number.isFinite(Date.parse(row.commandCreatedAt)) ||
          scope.group === 'order' && row.objectId !== scope.objectId)) throw new Error('INVALID_RECORDED_COMMAND_PAGE');
      const rows = new Map((moreKind ? group.rows : []).map(row => [row.id, row]));
      for (const row of value.items) rows.set(row.id, { id: row.id, objectId: row.objectId, label: states[row.state]!,
        createdLabel: new Date(row.commandCreatedAt).toLocaleString('zh-CN', { hour12: false }) });
      update({ rows: [...rows.values()], nextCursor: value.nextCursor, loading: false });
    } catch {
      if (generation === attempts.get(page) && !getApp<IAppOption>().globalData.sessionToken) {
        page.setData({ recordedGroups: [] }); return;
      }
      update({ loading: false, error: '暂时无法核对。请重试查询或联系客服，不要重复提交未知操作。' });
    }
  }));
}
