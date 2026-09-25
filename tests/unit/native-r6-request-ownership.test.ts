import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

const m = vi.hoisted(() => ({ token: 'member-a', revision: 0, orders: vi.fn(), order: vi.fn(),
  request: vi.fn(), download: vi.fn(), catalog: vi.fn(), addresses: vi.fn(), runtime: vi.fn(),
  quote: vi.fn(), create: vi.fn() }));
vi.mock('../../apps/miniprogram/services/api', () => ({
  historicalCommerceToken: () => m.token, historicalCommerceClosed: () => false,
  requireMemberAccess: () => true, requireHistoricalCommerceAccess: () => true,
  retainMemberSnapshot: () => true, request: m.request, downloadPrivateMedia: m.download,
  uploadAuthorized: vi.fn(), resumeAuthentication: vi.fn(), setSessionToken: vi.fn()
}));
vi.mock('../../apps/miniprogram/services/page-requests', () => ({ pageRead: vi.fn(), cancelPageReads: vi.fn() }));
vi.mock('../../apps/miniprogram/services/commerce-command-store', () => ({ commerceContextRevision: () => m.revision }));
vi.mock('../../apps/miniprogram/services/layout', () => ({ currentChromeStyle: () => '' }));
vi.mock('../../apps/miniprogram/services/commerce', () => ({ catalogDetail: m.catalog, centsToYuan: (v: number) => (v / 100).toFixed(2) }));
vi.mock('../../apps/miniprogram/services/orders', () => ({ myOrders: m.orders, myOrder: m.order,
  memberAddresses: m.addresses, orderRuntimeStatus: m.runtime, isolatedCreditSummary: vi.fn(),
  createCheckoutQuote: m.quote, createPendingOrder: m.create, clientOperationKey: () => 'cisme-private-data-copy-current' }));
let definition: any;
function deferred() {
  let resolve!: (value: any) => void, reject!: (error: any) => void;
  const promise = new Promise<any>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function instantiate() {
  return { ...definition, data: structuredClone(definition.data), setData(patch: any) { Object.assign(this.data, patch); } };
}
const orderId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const order = { id: orderId, orderNumber: 'ORDER1234', status: 'paid', totalCents: 1000, currency: 'CNY',
  lines: [{ productName: '护理精华', skuLabel: '30ml', quantity: 1 }] };
async function support() {
  await import('../../apps/miniprogram/pages/support/index');
  const page = instantiate(); Object.assign(page.data, { pageAlive: true, visible: true });
  page.measureComposer = vi.fn(); page.publishPresence = vi.fn(); page.append = vi.fn();
  page.markRead = vi.fn(); page.startPolling = vi.fn(); return page;
}
async function checkout() {
  await import('../../apps/miniprogram/pages/checkout/index');
  const page = instantiate(); page.mounted = true; page.visible = true;
  page.setData({ loading: false, runtimeEnabled: true, quantity: 1, productCode: 'serum',
    selectedSku: { id: 'sku', active: true, availableQuantity: 4, priceCents: 1000 }, selectedAddressId: 'address',
    addresses: [{ id: 'address', version: 1 }], quote: { id: 'quote', item: { skuId: 'sku' }, quantity: 1,
      addressId: 'address', addressVersion: 1, creditTenderCents: 0,
      expiresAt: new Date(Date.now() + 60000).toISOString(), serverTime: new Date().toISOString() } });
  return page;
}
async function privacy() {
  await import('../../apps/miniprogram/pages/privacy-rights/index');
  const page = instantiate();
  page.setData({ alive: true, authenticated: true, records: [{ id: 'request-a',
    execution: { scope: 'member_portable_copy_v1', downloadAvailable: true,
      unavailableMedia: [{ id: 'media-a', reason: 'inline_copy_size_limit', mimeType: 'image/jpeg' }] } }] });
  return page;
}
beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks(); vi.useFakeTimers(); m.token = 'member-a'; m.revision = 0;
  for (const fn of [m.orders, m.order, m.request, m.download, m.catalog, m.addresses, m.runtime, m.quote, m.create]) fn.mockReset();
  vi.stubGlobal('Page', (value: any) => { definition = value; });
  vi.stubGlobal('getApp', () => ({ globalData: { sessionToken: m.token } }));
  vi.stubGlobal('wx', { nextTick: (callback: () => void) => callback(), env: { USER_DATA_PATH: '/private' },
    getStorageSync: vi.fn(), navigateTo: vi.fn(), redirectTo: vi.fn(),
    getFileSystemManager: () => ({ writeFile: (options: any) => options.success(), unlink: vi.fn() }),
    shareFileMessage: vi.fn((options: any) => { options.success(); options.complete?.(); }) });
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('support order actions keep identity, route and user choice aligned', () => {
  it('discards an order list after the account changes', async () => {
    const page = await support(), read = deferred(); m.orders.mockReturnValue(read.promise);
    const pending = page.openOrderPicker(); m.token = 'member-b';
    read.resolve({ items: [order] }); await pending; expect(page.data.orderChoices).toEqual([]);
  });
  it('discards the A to B to A identity revision even with the same token text', async () => {
    const page = await support(), read = deferred(); m.orders.mockReturnValue(read.promise);
    const pending = page.openOrderPicker(); m.revision += 2;
    read.resolve({ items: [order] }); await pending; expect(page.data.orderChoices).toEqual([]);
  });
  it('keeps the new picker result after closing and reopening', async () => {
    const page = await support(), old = deferred(); m.orders.mockReturnValueOnce(old.promise);
    const pending = page.openOrderPicker(); page.closeOrderPicker();
    m.orders.mockResolvedValue({ items: [{ ...order, id: 'new-order' }] }); await page.openOrderPicker();
    old.resolve({ items: [order] }); await pending; expect(page.data.orderChoices.map((v: any) => v.id)).toEqual(['new-order']);
  });
  it('does not fill a closed picker', async () => {
    const page = await support(), read = deferred(); m.orders.mockReturnValue(read.promise);
    const pending = page.openOrderPicker(); page.closeOrderPicker(); read.resolve({ items: [order] }); await pending;
    expect(page.data.orderChoices).toEqual([]); expect(page.data.orderPickerLoading).toBe(false);
  });
  it('still shows an actionable error for the current picker', async () => {
    const page = await support(); m.orders.mockRejectedValue(new Error('offline')); await page.openOrderPicker();
    expect(page.data.orderPickerLoading).toBe(false); expect(page.data.orderPickerError).toContain('重试');
  });
  it('loads the linked card even while the user is typing', async () => {
    const page = await support(), read = deferred(); page.linkedOrderId = orderId; m.order.mockReturnValue(read.promise);
    const pending = page.loadLinkedOrder(); page.inputRevision++; page.data.input = '请查一下这个订单';
    read.resolve(order); await pending; expect(page.data.selectedOrder.id).toBe(orderId); expect(page.data.input).toContain('订单');
  });
  it('does not reattach a card removed while its read was pending', async () => {
    const page = await support(), read = deferred(); page.linkedOrderId = orderId; m.order.mockReturnValue(read.promise);
    const pending = page.loadLinkedOrder(); page.removeOrder(); read.resolve(order); await pending;
    expect(page.data.selectedOrder).toBeNull(); await page.loadLinkedOrder(); expect(m.order).toHaveBeenCalledTimes(1);
  });
  it('sends a general enquiry without the removed route order', async () => {
    const page = await support(); page.linkedOrderId = orderId; page.data.input = '普通咨询'; page.removeOrder();
    m.request.mockRejectedValue(new Error('unknown outcome')); await page.send();
    expect(m.request.mock.calls[0]![0].data.linkedOrderId).toBeNull(); expect(page.data.sendAttempt).not.toBeNull();
  });
  it('keeps the immutable historical order for a closed account', async () => {
    const page = await support(); page.data.closedRights = true; page.linkedOrderId = orderId; page.data.selectedOrder = order;
    page.removeOrder(); await page.openOrderPicker(); expect(page.data.selectedOrder).toEqual(order); expect(m.orders).not.toHaveBeenCalled();
  });
  it('does not expose unknown backend status values', async () => {
    const page = await support(); m.orders.mockResolvedValue({ items: [{ ...order, status: 'internal_future_state' }] });
    await page.openOrderPicker(); expect(page.data.orderChoices[0].statusLabel).toBe('状态待更新');
  });
  it('retries both the transcript and unresolved route card', async () => {
    const page = await support(); page.linkedOrderId = orderId; page.load = vi.fn(); page.loadLinkedOrder = vi.fn();
    page.retry(); expect(page.load).toHaveBeenCalledOnce(); expect(page.loadLinkedOrder).toHaveBeenCalledOnce();
  });
  it('keeps the original payload and key when an order card arrives after an unknown send', async () => {
    const page = await support(); page.data.input = '请帮我看一下';
    m.request.mockRejectedValueOnce(new Error('response lost')).mockResolvedValueOnce({
      message: { id: 'accepted', sequence: 1, senderType: 'user', body: '请帮我看一下', attachments: [], orderCard: null },
      conversation: { id: 'conversation', status: 'waiting_human', version: 2 }
    });
    await page.send();
    const first = m.request.mock.calls[0]![0].data;
    page.data.selectedOrder = { ...order, orderNumberTail: '1234', statusLabel: '已付款', totalYuan: '10.00', productName: '护理精华', productImage: null, itemSummary: '护理精华' };
    await page.retrySend();
    const second = m.request.mock.calls[1]![0].data;
    expect(second).toEqual(first);
    expect(second.linkedOrderId).toBeNull();
    expect(page.data.sendAttempt).toBeNull();
    expect(page.data.selectedOrder.id).toBe(orderId);
  });
  it('keeps the reading position when returning from a native preview', async () => {
    const page = await support(); page.data.loading = false;
    page.data.conversation = { id: 'conversation', status: 'waiting_human', version: 1 };
    page.data.atBottom = false; page.data.anchor = '';
    page.load = vi.fn(); page.poll = vi.fn(); page.downloadMedia = vi.fn();
    page.onHide(); page.onShow();
    expect(page.load).not.toHaveBeenCalled(); expect(page.poll).toHaveBeenCalledOnce();
    expect(page.data.atBottom).toBe(false); expect(page.data.anchor).toBe('');
  });
  it('drops a same-token snapshot after its identity revision changes', async () => {
    const page = await support(); page.data.loading = false; page.snapshotToken = m.token;
    page.data.conversation = { id: 'old-conversation', status: 'waiting_human', version: 1 };
    page.data.messages = [{ id: 'old-private-message' }]; page.load = vi.fn();
    m.revision++;
    page.onShow();
    expect(page.data.messages).toEqual([]);
    expect(page.load).toHaveBeenCalledOnce();
  });
  it('ignores an old composer measurement after hide and show', async () => {
    const page = await support(); let measure!: (rect: any) => void;
    (wx as any).createSelectorQuery = () => ({ select: () => ({ boundingClientRect(callback: any) { measure = callback; return { exec() {} }; } }) });
    page.measureComposer = definition.measureComposer;
    page.measureComposer(); const stale = measure; page.onHide(); page.onShow();
    const before = page.data.threadBottomStyle;
    stale({ height: 400 });
    expect(page.data.threadBottomStyle).toBe(before);
  });
  it('marks an interrupted write as unknown while preserving its original attempt', async () => {
    const page = await support(), response = deferred(); page.data.input = '请协助查看';
    m.request.mockReturnValue(response.promise);
    const pending = page.send(); const key = page.data.sendAttempt.id;
    page.onHide(); response.resolve({ message: { id: 'accepted' } }); await pending;
    expect(page.data.sendAttempt.id).toBe(key);
    expect(page.data.pendingMessage.localState).toBe('unknown');
    expect(page.data.error).toContain('尚未确认');
  });
  it('allows an album result after hide and show for the same identity', async () => {
    const page = await support(), chosen = deferred(); page.load = vi.fn(); page.uploadImage = vi.fn();
    (wx as any).requirePrivacyAuthorize = ({ success }: any) => success();
    (wx as any).chooseMedia = vi.fn(() => chosen.promise);
    const pending = page.chooseImage({ currentTarget: { dataset: { source: 'album' } } });
    await Promise.resolve(); page.onHide(); expect(page.choosingImage).toBe(true);
    chosen.resolve({ tempFiles: [{ tempFilePath: '/private/photo.jpg', size: 1000 }] });
    await Promise.resolve(); page.onShow(); expect(page.data.visible).toBe(true); await pending;
    expect(page.data.selectedImage.localPath).toBe('/private/photo.jpg');
    expect(page.uploadImage).toHaveBeenCalledOnce();
  });
  it('pages through older orders without replacing the first page', async () => {
    const page = await support();
    m.orders.mockResolvedValueOnce({ items: [order], nextCursor: 'older' })
      .mockResolvedValueOnce({ items: [order, { ...order, id: 'older-order' }], nextCursor: null });
    await page.openOrderPicker(); await page.loadMoreOrders();
    expect(m.orders).toHaveBeenNthCalledWith(2, 'older');
    expect(page.data.orderChoices.map((item: any) => item.id)).toEqual([orderId, 'older-order']);
    expect(page.data.orderPickerNextCursor).toBeNull();
  });
});

describe('checkout revalidation cannot race a purchase', () => {
  it.each(['loading', 'syncError', 'navigating'])('blocks both quote and order commands during %s', async (field) => {
    const page = await checkout(); page.data[field] = field === 'syncError' ? '网络不可用' : true;
    await page.requestQuote(); await page.confirmOrder(); expect(m.quote).not.toHaveBeenCalled(); expect(m.create).not.toHaveBeenCalled();
  });
  it('does not let a manual reload interrupt an in-flight write', async () => {
    const page = await checkout(); page.data.busy = true; await page.load(); expect(m.catalog).not.toHaveBeenCalled();
  });
  it('discards the older refresh response', async () => {
    const page = await checkout(), old = deferred(); page.data.quote = null;
    m.catalog.mockReturnValueOnce(old.promise).mockResolvedValueOnce({ variants: [{ id: 'new', active: true, availableQuantity: 3, priceCents: 2000 }] });
    m.addresses.mockResolvedValue({ enabled: true, addresses: [{ id: 'address', version: 1 }] });
    m.runtime.mockResolvedValue({ version: 2, scope: 'formal_commerce', currency: 'CNY', orderFlowEnabled: true,
      paymentAvailable: true, paymentOnboarding: 'READY', formalMoneyOperationsAvailable: true, formalRecoveryAvailable: true,
      isolatedMoneyOperationsAvailable: false, isolatedTransferAvailable: false, isolatedCreditCheckoutAvailable: false });
    const first = page.load(); await page.load();
    old.resolve({ variants: [{ id: 'old', active: true, availableQuantity: 8, priceCents: 1000 }] }); await first;
    expect(page.data.selectedSku.id).toBe('new');
  });
  it('normalizes a malformed fractional deep-link quantity without sending it to checkout', async () => {
    const page = await checkout(); page.onLoad({ quantity: '1.5' }); expect(page.data.quantity).toBe(1);
    page.onLoad({ quantity: '2' }); expect(page.data.quantity).toBe(2);
  });
});

describe('privacy file actions survive intentional native handoff', () => {
  it('does not report a canceled share as a failed data request', async () => {
    const page = await privacy(); m.request.mockResolvedValue({ schema: 'cisme.member.portable.v1' });
    (wx.shareFileMessage as any).mockImplementation((options: any) => { options.fail({ errMsg: 'shareFileMessage:fail cancel' }); options.complete?.(); });
    await page.viewExport({ currentTarget: { dataset: { id: 'request-a' } } });
    expect(page.data.error).toBe(''); expect(page.data.notice).toContain('已取消'); expect(page.data.exportBusy).toBe(false);
  });
  it('keeps a supplementary file until WeChat finishes sharing after onHide', async () => {
    const page = await privacy(), abort = vi.fn(); m.download.mockReturnValue({ promise: Promise.resolve('/private/image.jpg'), abort });
    (wx.shareFileMessage as any).mockImplementation((options: any) => {
      page.onHide(); expect(abort).not.toHaveBeenCalled(); options.success(); options.complete?.();
    });
    await page.viewSupplementary({ currentTarget: { dataset: { requestId: 'request-a', mediaId: 'media-a' } } });
    expect(abort).toHaveBeenCalled(); expect(page.supplementaryDownload).toBeNull();
  });
  it('aborts a download that has not yet been handed to WeChat', async () => {
    const page = await privacy(), read = deferred(), abort = vi.fn(); m.download.mockReturnValue({ promise: read.promise, abort });
    const pending = page.viewSupplementary({ currentTarget: { dataset: { requestId: 'request-a', mediaId: 'media-a' } } });
    page.onHide(); expect(abort).toHaveBeenCalled(); read.resolve('/private/image.jpg'); await pending;
    expect(wx.shareFileMessage).not.toHaveBeenCalled();
  });
  it('hides supplementary download actions for expired or revoked copies', () => {
    const view = readFileSync('apps/miniprogram/pages/privacy-rights/index.wxml', 'utf8');
    expect(view).toContain("item.execution.downloadAvailable && (asset.reason === 'inline_copy_size_limit'");
  });
});
