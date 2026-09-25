import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ request: vi.fn(), read: vi.fn(), authority: vi.fn(), operationKey: vi.fn() }));
vi.mock('../../apps/miniprogram/services/api', () => ({ request: m.request, requireMemberAccess: () => true,
  historicalCommerceToken:()=>token,historicalCommerceClosed:()=>false,requireHistoricalCommerceAccess:()=>Boolean(token) }));
vi.mock('../../apps/miniprogram/services/page-requests', () => ({
  pageRead: (_page: unknown, input: unknown) => m.read(input), cancelPageReads: vi.fn()
}));
vi.mock('../../apps/miniprogram/services/authority', () => ({ authorityProjection: m.authority }));
vi.mock('../../apps/miniprogram/services/layout', () => ({ currentChromeStyle: () => '' }));
vi.mock('../../apps/miniprogram/services/orders', () => ({ clientOperationKey: m.operationKey }));
vi.mock('../../apps/miniprogram/services/commerce-command-store', () => ({ commerceContextRevision: () => 0 }));
vi.mock('../../apps/miniprogram/services/commerce', () => ({ centsToYuan: (cents: number) => (cents / 100).toFixed(2) }));

let definition: any;
let token: string;
const record = {
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', orderId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  kind: 'return_refund', state: 'return_received', version: 1, amountCents: 10000,
  reason: '合成质检说明', lines: [], resolved: false, refund: null
};
const inspect = { currentTarget: { dataset: { action: 'inspect_return' } } };

beforeEach(() => {
  vi.resetModules(); vi.useFakeTimers(); token = 'synthetic-release-review';
  m.request.mockReset().mockResolvedValue({ ...record, state: 'quality_checked', version: 2 });
  m.read.mockReset().mockImplementation(async (input: { path: string }) =>
    input.path.includes('?') ? { items: [record], nextCursor: null } : record);
  m.authority.mockReset().mockResolvedValue({ version: 1, managementAvailable: true, capabilities: ['commerce.return.inspect'] });
  m.operationKey.mockReset().mockReturnValue('synthetic-inspection-key');
  (globalThis as any).Page = (page: any) => { definition = page; };
  (globalThis as any).getApp = () => ({ globalData: { sessionToken: token } });
  (globalThis as any).wx = {
    showModal: vi.fn((options: any) => options.success({ confirm: true })),
    navigateBack: vi.fn(), redirectTo: vi.fn()
  };
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

async function page() {
  await import('../../apps/miniprogram/pages/aftersale/index');
  const p = { ...definition, data: structuredClone(definition.data), setData(values: any) { Object.assign(this.data, values); } };
  p.onLoad({ mode: 'management', orderId: record.orderId });
  await p.onShow();
  p.setData({ selected: record, available: p.selectActions(record), note: '本次合成质检说明' });
  return p;
}

it('requires an explicit inspection choice before opening confirmation or writing', async () => {
  const p = await page();
  await p.submit(inspect);
  expect(m.request).not.toHaveBeenCalled();
  expect((globalThis as any).wx.showModal).not.toHaveBeenCalled();
  expect(p.data.notice).toContain('请选择本次实际质检结果');
});
it('rejects invalid inspection indices instead of treating them as sellable', async () => {
  const p = await page();
  for (const value of [-1, 3, Number.NaN, 1.5]) { p.data.qualityIndex = value; await p.submit(inspect); }
  expect(m.request).not.toHaveBeenCalled();
});
it('confirms and records an explicitly selected sellable result', async () => {
  const p = await page(); p.chooseQuality({ detail: { value: '1' } }); await p.submit(inspect);
  expect(m.request.mock.calls[0]![0].data.qualityResult).toBe('sellable');
  expect((globalThis as any).wx.showModal.mock.calls[0][0].content).toContain('质检结果：可售');
});
it('confirms and records an explicitly selected unsellable result', async () => {
  const p = await page(); p.chooseQuality({ detail: { value: '2' } }); await p.submit(inspect);
  expect(m.request.mock.calls[0]![0].data.qualityResult).toBe('unsellable');
  expect((globalThis as any).wx.showModal.mock.calls[0][0].content).toContain('质检结果：不可售');
});
it('clears the inspection choice when returning to the list', async () => {
  const p = await page(); p.data.qualityIndex = 2; p.list(); expect(p.data.qualityIndex).toBe(0);
});
it('clears the inspection choice when hiding the page', async () => {
  const p = await page(); p.data.qualityIndex = 2; p.onHide(); expect(p.data.qualityIndex).toBe(0);
});
it('clears the inspection choice before opening another case', async () => {
  const p = await page(); p.data.qualityIndex = 2;
  p.open({ currentTarget: { dataset: { id: record.id } } }); expect(p.data.qualityIndex).toBe(0);
  await vi.waitFor(() => expect(p.data.loading).toBe(false));
});
it('requires reselecting an unsubmitted inspection after refreshing server facts', async () => {
  const p = await page(); p.data.qualityIndex = 2; await p.load(); expect(p.data.qualityIndex).toBe(0);
});
it('resets malformed picker values to the non-factual placeholder', async () => {
  const p = await page(); p.data.qualityIndex = 2; p.chooseQuality({ detail: { value: 'invalid' } });
  expect(p.data.qualityIndex).toBe(0);
});
it('preserves the original inspection and idempotency key after an uncertain outcome', async () => {
  const p = await page(); p.chooseQuality({ detail: { value: '2' } });
  m.request.mockRejectedValueOnce({ status: 504 }); await p.submit(inspect);
  const pending = structuredClone(p.pending); expect(pending).not.toBeNull();
  p.data.qualityIndex = 1; await p.submit(inspect);
  expect(m.request).toHaveBeenCalledTimes(2);
  expect(m.request.mock.calls[1]![0].idempotencyKey).toBe(pending.key);
  expect(m.request.mock.calls[1]![0].data.qualityResult).toBe('unsellable');
});
it('still rejects a confirmation returned after the account changes', async () => {
  const p = await page(); p.chooseQuality({ detail: { value: '1' } });
  (globalThis as any).wx.showModal = (options: any) => { token = 'different-account'; options.success({ confirm: true }); };
  await p.submit(inspect); expect(m.request).not.toHaveBeenCalled();
});
it('names the native inspection control and provides a non-factual first option', async () => {
  const p = await page(); expect(p.data.qualityOptions).toEqual(['请选择质检结果', '可售', '不可售']);
  const template = readFileSync(new URL('../../apps/miniprogram/pages/aftersale/index.wxml', import.meta.url), 'utf8');
  expect(template).toContain('aria-label="质检结果"');
});
it('binds the management region to the normalized order projection without exposing more address fields', () => {
  const template = readFileSync(new URL('../../apps/miniprogram/pages/management-order-detail/index.wxml', import.meta.url), 'utf8');
  expect(template).toContain('{{order.addressSummary}}');
  expect(template).not.toContain('{{addressSummary}}');
  expect(template).toContain('{{order.address.recipientNameMasked}}');
  expect(template).toContain('{{order.address.phoneMasked}}');
});
