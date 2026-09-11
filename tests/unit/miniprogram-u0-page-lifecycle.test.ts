import { beforeEach, describe, expect, it, vi } from "vitest";
import { createQuoteClock } from "../../apps/miniprogram/services/checkout-state";
import { productEditableRevision } from "../../apps/miniprogram/services/product-draft-state";

const requestMock = vi.hoisted(() => vi.fn());
const requireMemberAccessMock = vi.hoisted(() => vi.fn(() => true));
const retainMemberSnapshotMock = vi.hoisted(() => vi.fn(() => true));

vi.mock("../../apps/miniprogram/services/api", () => ({
  request: requestMock,
  requireMemberAccess: requireMemberAccessMock,
  retainMemberSnapshot: retainMemberSnapshotMock
}));
vi.mock("../../apps/miniprogram/services/layout", () => ({ currentChromeStyle: () => "" }));

type PageDefinition = Record<string, any> & { data: Record<string, any> };
let capturedPage: PageDefinition | null = null;
let session = "member-a";

function mountedPage(definition: PageDefinition, overrides: Record<string, any> = {}, fields: Record<string, any> = {}) {
  const context: Record<string, any> = {
    data: { ...definition.data, ...overrides },
    setData(patch: Record<string, any>, callback?: () => void) { Object.assign(this.data, patch); callback?.(); },
    ...fields
  };
  for (const [key, value] of Object.entries(definition)) if (typeof value === "function") context[key] = value;
  return context;
}

beforeEach(() => {
  vi.resetModules();
  requestMock.mockReset();
  requireMemberAccessMock.mockReset();
  requireMemberAccessMock.mockReturnValue(true);
  retainMemberSnapshotMock.mockReset();
  retainMemberSnapshotMock.mockReturnValue(true);
  session = "member-a";
  capturedPage = null;
  (globalThis as any).getApp = () => ({ globalData: { sessionToken: session } });
  (globalThis as any).Page = (definition: PageDefinition) => { capturedPage = definition; };
  (globalThis as any).wx = {
    nextTick: (callback: () => void) => callback(),
    createSelectorQuery: undefined,
    navigateTo: vi.fn(), redirectTo: vi.fn(), navigateBack: vi.fn(), switchTab: vi.fn(), showToast: vi.fn(),
    enableAlertBeforeUnload: vi.fn(), disableAlertBeforeUnload: vi.fn(), showModal: vi.fn()
  };
});

describe("U0 native page lifecycle regressions", () => {
  it("scrubs checkout PII and quote facts before an unauthenticated return can render", async () => {
    retainMemberSnapshotMock.mockReturnValue(false);
    requireMemberAccessMock.mockReturnValue(false);
    session = "";
    await vi.importActual("../../apps/miniprogram/pages/checkout/index");
    const page = mountedPage(capturedPage!, {
      addresses: [{ id: "private-address" }], selectedAddressId: "private-address", quote: { id: "private-quote" },
      quoteClock: { expiresAtMs: Date.now() + 10_000, serverOffsetMs: 0 }, totalYuan: "269.00", quoteKey: "quote-key", createKey: "order-key"
    }, { requestEpoch: 0, mounted: true, visible: false, countdownTimer: null });
    page.load = vi.fn();

    page.onShow();

    expect(page.data).toMatchObject({ addresses: [], selectedAddressId: "", quote: null, quoteClock: null, totalYuan: "", quoteKey: "", createKey: "" });
    expect(page.load).not.toHaveBeenCalled();
  });

  it("restarts a retained checkout countdown after background return", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-12T00:00:00.000Z"));
    await vi.importActual("../../apps/miniprogram/pages/checkout/index");
    const quote = { id: "q", expiresAt: "2026-09-12T00:10:00.000Z", serverTime: "2026-09-12T00:00:00.000Z" };
    const page = mountedPage(capturedPage!, { quote, quoteClock: createQuoteClock(quote.expiresAt, quote.serverTime), countdown: "" }, { requestEpoch: 0, mounted: true, visible: false, countdownTimer: null });
    page.load = vi.fn();

    page.onShow();
    expect(page.data.countdown).toBe("10:00");
    expect(page.countdownTimer).not.toBeNull();
    page.onHide();
    expect(page.countdownTimer).toBeNull();
    vi.setSystemTime(new Date("2026-09-12T00:11:00.000Z"));
    page.onShow();
    expect(page.data).toMatchObject({ countdown: "已过期", quoteExpired: true });
    expect(page.countdownTimer).toBeNull();
    vi.useRealTimers();
  });

  it("invalidates a retained quote when an edited address returns with a new version", async () => {
    const product = {
      id: "product-1", productId: "product-1", variants: [{ id: "sku-1", active: true, availableQuantity: 5, priceCents: 26900 }]
    };
    requestMock
      .mockResolvedValueOnce(product)
      .mockResolvedValueOnce({ enabled: true, addresses: [{ id: "address-1", version: 2, isDefault: true }] })
      .mockResolvedValueOnce({ orderFlowEnabled: true });
    await vi.importActual("../../apps/miniprogram/pages/checkout/index");
    const page = mountedPage(capturedPage!, {
      productCode: "product-1", requestedSkuId: "sku-1", quantity: 1,
      selectedAddressId: "address-1", quote: { id: "quote-1", addressId: "address-1", addressVersion: 1, quantity: 1, item: { skuId: "sku-1" } },
      quoteClock: createQuoteClock("2026-09-12T01:00:00.000Z", "2026-09-12T00:00:00.000Z"), totalYuan: "269.00"
    }, { requestEpoch: 3, mounted: true, visible: true, countdownTimer: null });

    await page.load();

    expect(page.data).toMatchObject({ quote: null, quoteClock: null, totalYuan: "", selectedAddressId: "address-1" });
    expect(page.data.error).toBe("收货地址或商品信息已变化，请重新确认价格。");
  });

  it("retains a stale-order failure while clearing the unusable quote", async () => {
    requestMock.mockRejectedValueOnce({ code: "QUOTE_STALE" });
    await vi.importActual("../../apps/miniprogram/pages/checkout/index");
    const page = mountedPage(capturedPage!, {
      quote: { id: "quote-1", expiresAt: "2026-09-12T01:00:00.000Z", serverTime: "2026-09-12T00:00:00.000Z" },
      quoteClock: createQuoteClock("2026-09-12T01:00:00.000Z", "2026-09-12T00:00:00.000Z"), busy: false, createKey: ""
    }, { requestEpoch: 4, mounted: true, visible: true, countdownTimer: null });
    page.load = vi.fn();

    await page.confirmOrder();

    expect(page.data.quote).toBeNull();
    expect(page.data.error).toBe("商品或价格已变化，请重新报价。");
    expect(page.load).toHaveBeenCalledTimes(1);
  });

  it("does not start a second order creation while the first submission is pending", async () => {
    let resolveCreate!: (value: unknown) => void;
    requestMock.mockImplementationOnce(() => new Promise((resolve) => { resolveCreate = resolve; }));
    await vi.importActual("../../apps/miniprogram/pages/checkout/index");
    const page = mountedPage(capturedPage!, {
      quote: { id: "quote-1", expiresAt: "2099-09-12T01:00:00.000Z", serverTime: "2099-09-12T00:00:00.000Z" },
      quoteClock: createQuoteClock("2099-09-12T01:00:00.000Z", "2099-09-12T00:00:00.000Z"), busy: false, createKey: ""
    }, { requestEpoch: 5, mounted: true, visible: true, countdownTimer: null });

    const first = page.confirmOrder();
    await page.confirmOrder();
    expect(requestMock).toHaveBeenCalledTimes(1);
    resolveCreate({ id: "order-1" });
    await first;
  });

  it("unlocks a retained checkout after an in-flight request was interrupted by backgrounding", async () => {
    await vi.importActual("../../apps/miniprogram/pages/checkout/index");
    const page = mountedPage(capturedPage!, {
      busy: true, navigating: true, quote: { id: "quote-1" },
      quoteClock: createQuoteClock("2099-09-12T01:00:00.000Z", "2099-09-12T00:00:00.000Z")
    }, { requestEpoch: 8, mounted: true, visible: false, countdownTimer: null });
    page.load = vi.fn();

    page.onShow();

    expect(page.data).toMatchObject({ busy: false, navigating: false });
    expect(page.load).toHaveBeenCalledTimes(1);
  });

  it("drops checkout bootstrap results that return after the page was hidden", async () => {
    const pending: Array<(value: unknown) => void> = [];
    requestMock.mockImplementation(() => new Promise((resolve) => pending.push(resolve)));
    await vi.importActual("../../apps/miniprogram/pages/checkout/index");
    const page = mountedPage(capturedPage!, { productCode: "serum", loading: false, addresses: [], product: null }, {
      requestEpoch: 1, mounted: true, visible: true, countdownTimer: null
    });

    const load = page.load();
    page.onHide();
    pending[0]!({ id: "product-1", variants: [] });
    pending[1]!({ enabled: true, addresses: [{ id: "private-address" }] });
    pending[2]!({ orderFlowEnabled: true });
    await load;

    expect(page.data.product).toBeNull();
    expect(page.data.addresses).toEqual([]);
  });

  it("drops a support poll that returns after the page was hidden and does not mark it read", async () => {
    let resolvePoll!: (value: unknown) => void;
    requestMock.mockImplementationOnce(() => new Promise((resolve) => { resolvePoll = resolve; }));
    await vi.importActual("../../apps/miniprogram/pages/support/index");
    const page = mountedPage(capturedPage!, {
      pageAlive: true, visible: true, loading: false, sending: false, conversation: { id: "c", status: "human_active" },
      messages: [{ id: "m-100", sequence: 100, senderType: "admin", body: "old" }], syncCursor: 100, maxSeenSequence: 100, readCursor: 100, atBottom: true
    }, { lifecycleEpoch: 1, pollInFlight: false, pollFailures: 0, pollTimer: null, inputRevision: 0, lastScrollTop: 0 });

    const pending = page.poll();
    page.onHide();
    resolvePoll({ messages: [{ id: "m-101", sequence: 101, senderType: "admin", body: "new" }], latestCursor: 101, conversation: page.data.conversation });
    await pending;

    expect(page.data.messages.map((item: any) => item.sequence)).toEqual([100]);
    expect(requestMock).toHaveBeenCalledTimes(1);
    expect(page.pollTimer).toBeNull();
  });

  it("keeps the member new-message notice across later empty polls while history is being read", async () => {
    requestMock
      .mockResolvedValueOnce({ messages: [{ id: "m-101", sequence: 101, senderType: "admin", body: "new" }], latestCursor: 101 })
      .mockResolvedValueOnce({ messages: [], latestCursor: 101 });
    await vi.importActual("../../apps/miniprogram/pages/support/index");
    const page = mountedPage(capturedPage!, {
      pageAlive: true, visible: true, loading: false, sending: false, conversation: { id: "c", status: "human_active" },
      messages: [{ id: "m-100", sequence: 100, senderType: "admin", body: "old" }], syncCursor: 100, maxSeenSequence: 100,
      readCursor: 100, atBottom: false, newMessagesBelow: false, anchor: ""
    }, { lifecycleEpoch: 1, pollInFlight: false, pollFailures: 0, pollTimer: null, inputRevision: 0, lastScrollTop: 50 });
    page.schedulePoll = vi.fn();
    page.markRead = vi.fn();

    await page.poll();
    expect(page.data.newMessagesBelow).toBe(true);
    const renderedMessages = page.data.messages;
    await page.poll();

    expect(page.data.newMessagesBelow).toBe(true);
    expect(page.data.anchor).toBe("");
    expect(page.data.messages).toBe(renderedMessages);
  });

  it("drops a user message acknowledgement that returns in another member session", async () => {
    let resolveSend!: (value: unknown) => void;
    requestMock.mockImplementationOnce(() => new Promise((resolve) => { resolveSend = resolve; }));
    await vi.importActual("../../apps/miniprogram/pages/support/index");
    const page = mountedPage(capturedPage!, {
      pageAlive: true, visible: true, loading: false, sending: false, input: "A 的私密消息",
      conversation: { id: "conversation-a", status: "human_active" }, messages: [], atBottom: true
    }, { lifecycleEpoch: 1, pollInFlight: false, pollFailures: 0, pollTimer: null, inputRevision: 0, lastScrollTop: 0 });
    page.load = vi.fn();

    const pending = page.send();
    page.onHide();
    session = "member-b";
    retainMemberSnapshotMock.mockReturnValue(false);
    page.onShow();
    page.updateInput({ detail: { value: "B 的新草稿" } });
    resolveSend({
      message: { id: "message-a", sequence: 3, senderType: "user", body: "A 的私密消息" },
      conversation: { id: "conversation-a", status: "human_active" }
    });
    await pending;

    expect(page.data.messages).toEqual([]);
    expect(page.data.input).toBe("B 的新草稿");
    expect(page.data.sending).toBe(false);
  });

  it("does not let a late AI suggestion overwrite text typed while it was pending", async () => {
    let resolveSuggestion!: (value: unknown) => void;
    requestMock.mockImplementationOnce(() => new Promise((resolve) => { resolveSuggestion = resolve; }));
    await vi.importActual("../../apps/miniprogram/pages/management-support-chat/index");
    const page = mountedPage(capturedPage!, { id: "conversation-1", pageAlive: true, visible: true, aiProviderAvailable: true, assignedToMe: true, busy: false, input: "" }, { lifecycleEpoch: 1, inputRevision: 0 });

    const pending = page.suggest();
    page.updateInput({ detail: { value: "人工正在输入" } });
    resolveSuggestion({ text: "迟到的建议" });
    await pending;

    expect(page.data.input).toBe("人工正在输入");
  });

  it("drops an operator suggestion that returns after the task changed sessions", async () => {
    let resolveSuggestion!: (value: unknown) => void;
    requestMock.mockImplementationOnce(() => new Promise((resolve) => { resolveSuggestion = resolve; }));
    await vi.importActual("../../apps/miniprogram/pages/management-support-chat/index");
    const page = mountedPage(capturedPage!, { id: "conversation-a", pageAlive: true, visible: true, aiProviderAvailable: true, assignedToMe: true, busy: false, input: "" }, { lifecycleEpoch: 4, inputRevision: 0 });

    const pending = page.suggest();
    page.onHide();
    session = "operator-b";
    page.data.visible = true;
    page.setData({ input: "B 会话的空白草稿", busy: false });
    resolveSuggestion({ text: "A 会话的迟到建议" });
    await pending;

    expect(page.data.input).toBe("B 会话的空白草稿");
    expect(page.data.busy).toBe(false);
  });

  it("keeps the operator new-message notice across later empty polls while history is being read", async () => {
    const conversation = { id: "conversation-1", status: "human_active", version: 2 };
    requestMock
      .mockResolvedValueOnce({ messages: [{ id: "m-8", sequence: 8, senderType: "user", body: "new" }], latestCursor: 8, conversation })
      .mockResolvedValueOnce({ messages: [], latestCursor: 8, conversation });
    await vi.importActual("../../apps/miniprogram/pages/management-support-chat/index");
    const page = mountedPage(capturedPage!, {
      id: "conversation-1", pageAlive: true, visible: true, loading: false, busy: false, conversation,
      messages: [{ id: "m-7", sequence: 7, senderType: "user", body: "old" }], syncCursor: 7, maxSeenSequence: 7,
      readCursor: 7, atBottom: false, newMessagesBelow: false, anchor: ""
    }, { lifecycleEpoch: 2, pollInFlight: false, pollFailures: 0, pollTimer: null, inputRevision: 0, lastScrollTop: 50 });
    page.schedulePoll = vi.fn();
    page.markRead = vi.fn();

    await page.poll();
    expect(page.data.newMessagesBelow).toBe(true);
    const renderedMessages = page.data.messages;
    await page.poll();

    expect(page.data.newMessagesBelow).toBe(true);
    expect(page.data.anchor).toBe("");
    expect(page.data.messages).toBe(renderedMessages);
  });

  it("keeps product fields on background refresh and blocks save on a remote revision conflict", async () => {
    const base = {
      id: "product-1", productId: "product-1", code: "serum", name: "服务端名称", subtitle: "服务端副标题", description: "说明", image: "/image.jpg",
      sourceKind: "admin", qualificationStatus: "eligible", publicationStatus: "draft", version: 1, currency: "CNY", price: 26900,
      stockOnHand: 2, inStock: true, purchaseEnabled: false, sellability: "browse_only",
      variants: [{ id: "sku-1", code: "SERUM_30", label: "30ml", currency: "CNY", priceCents: 26900, priceVersion: 1, stockOnHand: 2, availableQuantity: 2, inventoryVersion: 1, inStock: true, purchaseEnabled: false, active: true, version: 1 }]
    };
    requestMock.mockResolvedValueOnce({ ...base, version: 2, name: "远端新名称", variants: [{ ...base.variants[0], version: 2, priceVersion: 2 }] });
    await vi.importActual("../../apps/miniprogram/pages/management-product/index");
    const page = mountedPage(capturedPage!, {
      id: "product-1", product: base, loading: false, dirty: true, name: "本地未保存名称", code: base.code, subtitle: base.subtitle,
      description: base.description, imagePath: base.image, skuCode: "SERUM_30", skuLabel: "30ml", priceYuan: "269.00",
      baseRevision: productEditableRevision(base), conflict: false, canSaveDraft: true
    }, { dirty: true, lifecycleEpoch: 1, visible: true });

    await page.load("refresh");

    expect(page.data.name).toBe("本地未保存名称");
    expect(page.data).toMatchObject({ dirty: true, conflict: true, canSaveDraft: false });
  });

  it("fetches the latest product revision after a save conflict without erasing the draft", async () => {
    const base = {
      id: "product-1", productId: "product-1", code: "serum", name: "服务端名称", subtitle: "服务端副标题", description: "说明", image: "/image.jpg",
      sourceKind: "admin", qualificationStatus: "eligible", publicationStatus: "draft", version: 1, currency: "CNY", price: 26900,
      stockOnHand: 2, inStock: true, purchaseEnabled: false, sellability: "browse_only",
      variants: [{ id: "sku-1", code: "SERUM_30", label: "30ml", currency: "CNY", priceCents: 26900, priceVersion: 1, stockOnHand: 2, availableQuantity: 2, inventoryVersion: 1, inStock: true, purchaseEnabled: false, active: true, version: 1 }]
    };
    const latest = { ...base, version: 2, name: "远端第二版", variants: [{ ...base.variants[0], version: 2, priceVersion: 2 }] };
    requestMock.mockRejectedValueOnce({ status: 409, code: "VERSION_CONFLICT" }).mockResolvedValueOnce(latest);
    await vi.importActual("../../apps/miniprogram/pages/management-product/index");
    const page = mountedPage(capturedPage!, {
      id: "product-1", product: base, loading: false, dirty: true, canProduct: true, name: "本地未保存名称", code: base.code,
      subtitle: base.subtitle, description: base.description, imagePath: base.image, skuCode: "SERUM_30", skuLabel: "30ml", priceYuan: "269.00",
      baseRevision: productEditableRevision(base), conflict: false, canSaveDraft: true
    }, { dirty: true, lifecycleEpoch: 2, visible: true });

    await page.save();

    expect(requestMock).toHaveBeenCalledTimes(2);
    expect(page.data.product.version).toBe(2);
    expect(page.data.name).toBe("本地未保存名称");
    expect(page.data).toMatchObject({ dirty: true, conflict: true, canSaveDraft: false, saving: false });
    expect(page.data.error).toContain("商品已被其他操作更新");
  });

  it("drops a product save response after the editor changed sessions", async () => {
    const base = {
      id: "product-1", productId: "product-1", code: "serum", name: "A 的商品", subtitle: "副标题", description: "说明", image: "/image.jpg",
      sourceKind: "admin", qualificationStatus: "eligible", publicationStatus: "draft", version: 1, currency: "CNY", price: 26900,
      stockOnHand: 2, inStock: true, purchaseEnabled: false, sellability: "browse_only",
      variants: [{ id: "sku-1", code: "SERUM_30", label: "30ml", currency: "CNY", priceCents: 26900, priceVersion: 1, stockOnHand: 2, availableQuantity: 2, inventoryVersion: 1, inStock: true, purchaseEnabled: false, active: true, version: 1 }]
    };
    let resolveSave!: (value: unknown) => void;
    requestMock.mockImplementationOnce(() => new Promise((resolve) => { resolveSave = resolve; }));
    await vi.importActual("../../apps/miniprogram/pages/management-product/index");
    const page = mountedPage(capturedPage!, {
      id: "product-1", product: base, loading: false, dirty: true, canProduct: true, name: "A 未保存名称", code: base.code,
      subtitle: base.subtitle, description: base.description, imagePath: base.image, skuCode: "SERUM_30", skuLabel: "30ml", priceYuan: "269.00",
      baseRevision: productEditableRevision(base), conflict: false, canSaveDraft: true
    }, { dirty: true, lifecycleEpoch: 6, visible: true });

    const pending = page.save();
    page.onHide();
    session = "operator-b";
    page.clearSensitiveDraft();
    page.visible = true;
    resolveSave({ ...base, version: 2, name: "A 已保存商品" });
    await pending;

    expect(page.data.product).toBeNull();
    expect(page.data.name).toBe("");
    expect(page.data.saving).toBe(false);
  });

  it("keeps a dirty product draft visible after an ordinary save failure", async () => {
    const base = {
      id: "product-1", productId: "product-1", code: "serum", name: "服务端名称", subtitle: "副标题", description: "说明", image: "/image.jpg",
      sourceKind: "admin", qualificationStatus: "eligible", publicationStatus: "draft", version: 1, currency: "CNY", price: 26900,
      stockOnHand: 2, inStock: true, purchaseEnabled: false, sellability: "browse_only",
      variants: [{ id: "sku-1", code: "SERUM_30", label: "30ml", currency: "CNY", priceCents: 26900, priceVersion: 1, stockOnHand: 2, availableQuantity: 2, inventoryVersion: 1, inStock: true, purchaseEnabled: false, active: true, version: 1 }]
    };
    requestMock.mockRejectedValueOnce({ title: "本地网络失败" });
    await vi.importActual("../../apps/miniprogram/pages/management-product/index");
    const page = mountedPage(capturedPage!, {
      id: "product-1", product: base, loading: false, dirty: true, canProduct: true, name: "未保存名称", code: base.code,
      subtitle: base.subtitle, description: base.description, imagePath: base.image, skuCode: "SERUM_30", skuLabel: "30ml", priceYuan: "269.00",
      baseRevision: productEditableRevision(base), conflict: false, canSaveDraft: true
    }, { dirty: true, lifecycleEpoch: 3, visible: true });

    await page.save();

    expect(page.data.name).toBe("未保存名称");
    expect(page.data).toMatchObject({ dirty: true, saving: false, error: "本地网络失败" });
  });

  it("adopts an inventory result without erasing unrelated dirty product fields", async () => {
    const base = {
      id: "product-1", productId: "product-1", code: "serum", name: "服务端名称", subtitle: "副标题", description: "说明", image: "/image.jpg",
      sourceKind: "admin", qualificationStatus: "eligible", publicationStatus: "draft", version: 1, currency: "CNY", price: 26900,
      stockOnHand: 2, inStock: true, purchaseEnabled: false, sellability: "browse_only",
      variants: [{ id: "sku-1", code: "SERUM_30", label: "30ml", currency: "CNY", priceCents: 26900, priceVersion: 1, stockOnHand: 2, availableQuantity: 2, inventoryVersion: 1, inStock: true, purchaseEnabled: false, active: true, version: 1 }]
    };
    const adjusted = { ...base, stockOnHand: 3, variants: [{ ...base.variants[0], stockOnHand: 3, availableQuantity: 3, inventoryVersion: 2 }] };
    requestMock.mockResolvedValueOnce({}).mockResolvedValueOnce(adjusted);
    await vi.importActual("../../apps/miniprogram/pages/management-product/index");
    const page = mountedPage(capturedPage!, {
      id: "product-1", product: base, loading: false, dirty: true, canInventory: true, name: base.name, code: base.code,
      subtitle: "未保存副标题", description: base.description, imagePath: base.image, skuCode: "SERUM_30", skuLabel: "30ml", priceYuan: "269.00",
      baseRevision: productEditableRevision(base), conflict: false, canSaveDraft: true, stockDelta: "1", stockReason: "本地验收"
    }, { dirty: true, lifecycleEpoch: 4, visible: true });

    await page.inventory();

    expect(page.data.subtitle).toBe("未保存副标题");
    expect(page.data.product.variants[0].inventoryVersion).toBe(2);
    expect(page.data).toMatchObject({ dirty: true, saving: false, stockDelta: "", stockReason: "" });
  });
});
