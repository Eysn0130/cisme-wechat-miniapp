import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ token: "member-a", request: vi.fn() }));
vi.mock("../../apps/miniprogram/services/api", () => ({ request: mocks.request, requireMemberAccess: () => Boolean(mocks.token),
  historicalCommerceToken:()=>mocks.token,historicalCommerceClosed:()=>false,requireHistoricalCommerceAccess:()=>Boolean(mocks.token) }));
vi.mock("../../apps/miniprogram/services/layout", () => ({ currentChromeStyle: () => "" }));
const deferred = <T = any>() => {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const order = { id, version: 2, orderNumber: "SYNTHETIC-ONLY-1", status: "pending_payment", transactionSourceKind: "verified_commerce", currency: "CNY",
  totalCents: 1200, subtotalCents: 1200, memberDiscountCents: 0, shippingCents: 0, creditTenderCents: 0, cashPayableCents: 1200,
  createdAt: "2026-09-20T00:00:00Z", expiresAt: "2026-09-20T00:30:00Z", pricingRuleVersion: "synthetic-v1", lines: [], address: null };
const runtime = { version: 1, orderFlowEnabled: true, paymentAvailable: false, paymentOnboarding: "IN_PROGRESS", currency: "CNY",
  scope: "verified_isolated_test", isolatedMoneyOperationsAvailable: true, isolatedTransferAvailable: true, isolatedCreditCheckoutAvailable: true };
const corePath = () => `/v1/me/orders/${id}`;
let page: any, core: ReturnType<typeof deferred>, auxiliary: ReturnType<typeof deferred>;
async function loadPage() {
  await import("../../apps/miniprogram/pages/order-detail/index"); page.onLoad({ id });
}
beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks(); mocks.token = "member-a"; core = deferred(); auxiliary = deferred();
  mocks.request.mockImplementation((options: any) => {
    if (options.path === "/v1/commerce/orders/status") return auxiliary.promise;
    if (options.path === corePath()) return core.promise;
    if (options.path.includes("/refund-requests?")) return Promise.resolve({ items: [], totalCount: 0, nextCursor: null });
    throw new Error(`Unexpected synthetic request: ${options.path}`);
  });
  (globalThis as any).getApp = () => ({ globalData: { sessionToken: mocks.token } });
  (globalThis as any).wx = { showModal: vi.fn().mockResolvedValue({ confirm: true }) };
  (globalThis as any).Page = (definition: any) => {
    page = { ...definition, data: structuredClone(definition.data), setData(patch: any, callback?: () => void) { Object.assign(this.data, patch); callback?.(); } };
  };
});

describe("native payment follow-up ownership", () => {
  async function prepare(nativeCancelled = false) {
    await loadPage(); void page.load();
    core.resolve({ ...order, status: "pending_payment" }); auxiliary.resolve(runtime); await flush();
    const query = deferred(), original = mocks.request.getMockImplementation()!;
    mocks.request.mockImplementation(options => options.path.endsWith("/payment-intent")
      ? options.method === "POST" ? Promise.resolve({ state: "prepared", simulation: false, requestPayment: {} }) : query.promise
      : original(options));
    (globalThis as any).wx.requestPayment = nativeCancelled
      ? vi.fn().mockRejectedValue(new Error("synthetic native cancel")) : vi.fn().mockResolvedValue({});
    return query;
  }
  it.each([
    { nativeCancelled: false, queryFails: false }, { nativeCancelled: false, queryFails: true },
    { nativeCancelled: true, queryFails: false }, { nativeCancelled: true, queryFails: true }
  ])("retains busy until the authoritative query settles: %j", async ({ nativeCancelled, queryFails }) => {
    const query = await prepare(nativeCancelled), first = page.preparePayment(); await flush();
    const busyWhilePending = page.data.busy;
    const furtherTaps = Promise.all([page.recheckPayment(), page.preparePayment(), page.cancel()]); await flush();
    const callsWhilePending = mocks.request.mock.calls.map(([options]) => options);
    if (queryFails) query.reject(new Error("synthetic query response lost")); else query.resolve({ state: "notpay" });
    await Promise.all([first, furtherTaps]); await flush();
    expect(busyWhilePending).toBe(true);
    expect(callsWhilePending.filter(o => o.path.endsWith("/payment-intent") && o.method !== "POST")).toHaveLength(1);
    expect(callsWhilePending.filter(o => o.method === "POST")).toHaveLength(1);
    expect((globalThis as any).wx.requestPayment).toHaveBeenCalledTimes(1);
    expect((globalThis as any).wx.showModal).not.toHaveBeenCalled();
    expect(page.data.busy).toBe(false);
    if (queryFails) expect(page.data.actionError).not.toBe("");
  });
  it("does not replace a pending payment query with an onShow read and refreshes after settlement", async () => {
    const query = await prepare(), first = page.preparePayment(); await flush();
    core = deferred(); page.onHide(); page.onShow(); await flush();
    expect(page.data.busy).toBe(true);
    expect(mocks.request.mock.calls.filter(([o]) => o.path === corePath())).toHaveLength(1);
    query.resolve({ state: "notpay" }); await first; await flush();
    expect(page.data.busy).toBe(false); expect(page.data.coreReady).toBe(false);
    expect(mocks.request.mock.calls.filter(([o]) => o.path === corePath())).toHaveLength(2);
    core.resolve({ ...order, status: "pending_payment", version: 3 }); await flush();
    expect(page.data.order.version).toBe(3); expect(page.data.coreReady).toBe(true);
  });
  it.each([false, true])("checks the original order when the native callback arrives while hidden (cancelled: %s)", async nativeCancelled => {
    const query = await prepare(), native = deferred();
    vi.mocked(wx.requestPayment).mockReturnValueOnce(native.promise);
    const payment = page.preparePayment(); await flush();
    expect(wx.requestPayment).toHaveBeenCalledTimes(1);
    page.onHide();
    if (nativeCancelled) native.reject(new Error("synthetic native cancel")); else native.resolve({});
    await flush();
    const busyWhileHidden = page.data.busy;
    const queries = () => mocks.request.mock.calls.filter(([options]) => options.path.endsWith("/payment-intent") && options.method !== "POST");
    const queriesBeforeReturn = queries().length;

    core = deferred(); page.onShow(); await flush();
    const coreReadsWhileChecking = mocks.request.mock.calls.filter(([options]) => options.path === corePath()).length;
    query.resolve({ state: nativeCancelled ? "notpay" : "paid" });
    await payment; await flush();
    core.resolve({ ...order, status: nativeCancelled ? "pending_payment" : "paid", version: 3 });
    await flush();
    expect(busyWhileHidden).toBe(true);
    expect(queriesBeforeReturn).toBe(1);
    expect(coreReadsWhileChecking).toBe(1);
    expect(queries()).toHaveLength(1);
    expect(page.data.order.status).toBe(nativeCancelled ? "pending_payment" : "paid");
    expect(page.data.busy).toBe(false);
  });
  it("does not query the previous account's order when the native callback arrives after a session change", async () => {
    const query = await prepare(), native = deferred();
    vi.mocked(wx.requestPayment).mockReturnValueOnce(native.promise);
    const payment = page.preparePayment(); await flush();
    expect(wx.requestPayment).toHaveBeenCalledTimes(1);
    page.onHide();
    mocks.token = "member-b";
    core = deferred(); auxiliary = deferred(); page.onShow();
    native.resolve({}); query.resolve({ state: "paid" });
    await payment; await flush();
    expect(mocks.request.mock.calls.filter(([o]) => o.path.endsWith("/payment-intent") && o.method !== "POST")).toHaveLength(0);
    expect(page.data.order).toBeNull();
    expect(page.data.actionStatus).toBe("");
  });
  it("cannot let the old query overwrite a newly signed-in account", async () => {
    const query = await prepare(), first = page.preparePayment(); await flush();
    mocks.token = "member-b"; core = deferred(); auxiliary = deferred(); page.onShow();
    query.resolve({ state: "paid" }); await first; await flush();
    expect(page.data.order).toBeNull(); expect(page.data.coreReady).toBe(false);
    expect(page.data.actionStatus).toBe(""); expect(page.data.busy).toBe(false);
    expect(mocks.request.mock.calls.filter(([o]) => o.path === corePath())).toHaveLength(2);
  });

  it.each([false, true])("automatically shows an ordinary order once payment settles (cashier returned while hidden: %s)", async hidden => {
    vi.useFakeTimers();
    try {
      const query = await prepare(), payment = page.preparePayment();
      await flush();
      if (hidden) page.onHide();
      query.resolve({ state: "verified_pending" }); await payment; await flush();
      expect(page.data.order.status).toBe("pending_payment");

      if (hidden) {
        await vi.advanceTimersByTimeAsync(6_000);
        expect(mocks.request.mock.calls.filter(([o]) => o.path === corePath())).toHaveLength(1);
        page.onShow(); await flush();
      }
      core = deferred();
      core.resolve({ ...order, status: "paid", version: 3 });
      await vi.advanceTimersByTimeAsync(700);
      await flush();
      expect(page.data.order.status).toBe("paid");
      expect(page.data.actionStatus).toBe("付款已确认。");
      expect(mocks.request.mock.calls.filter(([o]) => o.method === "POST")).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
