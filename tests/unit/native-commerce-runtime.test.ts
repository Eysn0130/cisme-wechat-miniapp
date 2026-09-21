import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
const mocks = vi.hoisted(() => ({ token: "member-a", request: vi.fn() }));
vi.mock("../../apps/miniprogram/services/api", () => ({ request: mocks.request, requireMemberAccess: () => Boolean(mocks.token) }));
vi.mock("../../apps/miniprogram/services/layout", () => ({ currentChromeStyle: () => "" }));
const deferred = <T = any>() => {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const authority = { version: 1, managementAvailable: true, capabilities: ["support.read", "commerce.refund.approve"] };
const membership = { eligible: true, membershipState: "active", expiresAt: null, directReferralCount: 0, verifiedOrderCount: 1, settlementAvailable: false,
  commission: { availableCents: 1200, pendingCents: 0, paymentHeldCents: 0, settledCents: 0, recoveryCents: 0, reservedRecoveryCents: 0, netEarnedCents: 1200, currency: "CNY" } };
const order = { id, version: 2, orderNumber: "SYNTHETIC-ONLY-1", status: "paid", transactionSourceKind: "verified_commerce", currency: "CNY",
  totalCents: 1200, subtotalCents: 1200, memberDiscountCents: 0, shippingCents: 0, creditTenderCents: 0, cashPayableCents: 1200,
  createdAt: "2026-09-20T00:00:00Z", expiresAt: "2026-09-20T00:30:00Z", pricingRuleVersion: "synthetic-v1", lines: [], address: null };
const runtime = { version: 1, orderFlowEnabled: true, paymentAvailable: false, paymentOnboarding: "IN_PROGRESS", currency: "CNY",
  scope: "verified_isolated_test", isolatedMoneyOperationsAvailable: true, isolatedTransferAvailable: true, isolatedCreditCheckoutAvailable: true };
type Name = "management" | "commission" | "order-detail";
let page: any, core: ReturnType<typeof deferred>, auxiliary: ReturnType<typeof deferred>, aborts: Map<string, ReturnType<typeof vi.fn>>;
async function loadPage(name: Name) {
  if (name === "management") await import("../../apps/miniprogram/pages/management/index");
  else if (name === "commission") await import("../../apps/miniprogram/pages/commission/index");
  else { await import("../../apps/miniprogram/pages/order-detail/index"); page.onLoad({ id }); }
  return page;
}
const coreValue = (name: Name) => name === "management" ? authority : name === "commission" ? membership : order;
const corePath = (name: Name) => name === "management" ? "/v1/me/authority" : name === "commission" ? "/v1/me/commercial-membership" : `/v1/me/orders/${id}`;
const facts = (name: Name) => name === "management" ? page.data.authority : name === "commission" ? page.data.status : page.data.order;
const closed = (name: Name) => {
  if (name === "management") expect(page.data.canFinance).toBe(false);
  else if (name === "commission") { expect(page.data.isolatedTransfer).toBe(false); expect(page.data.isolatedCredit).toBe(false); }
  else expect(page.data.isolatedPayment).toBe(false);
};
beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks(); mocks.token = "member-a"; core = deferred(); auxiliary = deferred(); aborts = new Map();
  mocks.request.mockImplementation((options: any) => {
    const abort = vi.fn(); aborts.set(options.path, abort); options.registerAbort?.(abort);
    if (options.path === "/v1/commerce/orders/status") return auxiliary.promise;
    if (["/v1/me/authority", "/v1/me/commercial-membership", `/v1/me/orders/${id}`].includes(options.path)) return core.promise;
    if (options.path.includes("refund-requests")) return Promise.resolve({ items: [], totalCount: 0, nextCursor: null });
    if (options.path.includes("settlement-requests")) return Promise.resolve({ items: [], totalCount: 0, nextCursor: null });
    if (options.path.includes("credit-conversions")) return Promise.resolve({ items: [], totalCount: 0, availableCents: 0, nextCursor: null });
    throw new Error(`Unexpected synthetic request: ${options.path}`);
  });
  (globalThis as any).getApp = () => ({ globalData: { sessionToken: mocks.token } });
  (globalThis as any).wx = { navigateTo: vi.fn(), navigateBack: vi.fn(), switchTab: vi.fn(), showToast: vi.fn(), showModal: vi.fn().mockResolvedValue({ confirm: true }) };
  (globalThis as any).Page = (definition: any) => { page = { ...definition, data: structuredClone(definition.data), setData(patch: any, callback?: () => void) { Object.assign(this.data, patch); callback?.(); } }; };
});
describe.each<Name>(["management", "commission", "order-detail"])("PERF-11/12: %s", name => {
  it("renders core facts and their actual display fields while runtime never settles", async () => {
    await loadPage(name); void page.load(); core.resolve(coreValue(name)); await flush();
    expect(page.data.loading).toBe(false); expect(facts(name)).toMatchObject(coreValue(name));
    expect(page.data.runtimeState).toBe("loading"); closed(name);
    if (name === "commission") expect(page.data.availableLabel).toBe("12.00");
    if (name === "order-detail") expect(page.data.order).toMatchObject({ totalYuan: "12.00", statusLabel: "已支付，待履约" });
    if (name === "management") expect(page.data.canSupport).toBe(true);
  });
  it("keeps core usable on runtime failure and retries only the auxiliary request", async () => {
    await loadPage(name); void page.load(); core.resolve(coreValue(name)); auxiliary.reject(new Error("synthetic offline")); await flush();
    expect(page.data.runtimeState).toBe("error"); expect(facts(name)).toMatchObject(coreValue(name)); closed(name);
    auxiliary = deferred(); page.retryRuntime(); await flush();
    expect(mocks.request.mock.calls.filter(([o]) => o.path === corePath(name))).toHaveLength(1);
    expect(facts(name)).toMatchObject(coreValue(name)); auxiliary.resolve(runtime); await flush();
    expect(page.data.runtimeState).toBe("ready");
  });
  it("does not open financial actions when runtime precedes unresolved or failed core", async () => {
    await loadPage(name); void page.load(); auxiliary.resolve(runtime); await flush(); closed(name);
    core.reject(new Error("synthetic unavailable core")); await flush(); closed(name); expect(page.data.error).not.toBe("");
  });
  it.each(["hide", "unload", "session"])("rejects late reads after %s and requests cancellation of its read subscriptions", async kind => {
    await loadPage(name); void page.load(); await flush();
    if (kind === "hide") page.onHide(); else if (kind === "unload") page.onUnload(); else mocks.token = "member-b";
    if (kind !== "session") { expect(aborts.get(corePath(name))).toHaveBeenCalledTimes(1); expect(aborts.get("/v1/commerce/orders/status")).toHaveBeenCalledTimes(1); }
    core.resolve(coreValue(name)); auxiliary.resolve(runtime); await flush(); expect(facts(name)).toBeNull(); closed(name);
  });
  it("does not let a stale runtime retry reopen a newer closed gate", async () => {
    await loadPage(name); void page.load(); core.resolve(coreValue(name)); await flush();
    const old = auxiliary; auxiliary = deferred(); page.retryRuntime(); auxiliary.resolve({ ...runtime, scope: "disabled", isolatedMoneyOperationsAvailable: false, isolatedTransferAvailable: false, isolatedCreditCheckoutAvailable: false }); await flush();
    old.resolve(runtime); await flush(); expect(page.data.runtimeMode).toBe("disabled"); closed(name);
  });
  it.each([{ ...runtime, scope: "formal" }, { ...runtime, version: 2 }, { ...runtime, paymentAvailable: true }, { ...runtime, isolatedMoneyOperationsAvailable: "true" }])("fails closed on unsupported or malformed capability contract %j", async value => {
    await loadPage(name); void page.load(); core.resolve(coreValue(name)); auxiliary.resolve(value); await flush();
    closed(name); expect(page.data.runtimeState).toBe("error"); expect(page.data.runtimeMode).toBe("unknown");
  });
  it("renders runtime status and retry in the actual WXML rather than data alone", () => {
    const wxml = readFileSync(`apps/miniprogram/pages/${name}/index.wxml`, "utf8");
    expect(wxml).toContain("runtimeCopy"); expect(wxml).toContain('bindtap="retryRuntime"');
  });
});

describe.each<Name>(["management", "commission", "order-detail"])("positive and refresh boundaries: %s", name => {
  it("opens only the existing isolated capabilities after both verified facts arrive", async () => {
    await loadPage(name); void page.load(); auxiliary.resolve(runtime); core.resolve(coreValue(name)); await flush();
    expect(page.data.coreReady).toBe(true); expect(page.data.runtimeMode).toBe("test");
    if (name === "management") expect(page.data.canFinance).toBe(true);
    else if (name === "commission") expect(page.data).toMatchObject({ isolatedTransfer: true, isolatedCredit: true });
    else expect(page.data.isolatedPayment).toBe(true);
  });
  it("starts a new core read rather than authorizing an old account's snapshot on runtime retry", async () => {
    await loadPage(name); void page.load(); core.resolve(coreValue(name)); auxiliary.resolve(runtime); await flush();
    mocks.token = "member-b"; core = deferred(); auxiliary = deferred(); page.retryRuntime(); await flush();
    expect(facts(name)).toBeNull(); closed(name); expect(page.data.coreReady).toBe(false);
    auxiliary.resolve(runtime); await flush(); closed(name);
  });
  it("does not let hidden reads publish on a later return to the same account", async () => {
    await loadPage(name); void page.load(); const oldCore = core, oldRuntime = auxiliary;
    page.onHide(); core = deferred(); auxiliary = deferred(); page.onShow();
    oldCore.resolve(coreValue(name)); oldRuntime.resolve(runtime); await flush();
    expect(facts(name)).toBeNull(); closed(name);
    core.resolve(coreValue(name)); auxiliary.resolve(runtime); await flush(); expect(page.data.coreReady).toBe(true);
  });
  it("does not make an extra core request when a runtime retry is cancelled", async () => {
    await loadPage(name); void page.load(); core.resolve(coreValue(name)); await flush();
    const firstAbort = aborts.get("/v1/commerce/orders/status")!; auxiliary = deferred(); page.retryRuntime(); await flush();
    expect(firstAbort).toHaveBeenCalledTimes(1);
    expect(mocks.request.mock.calls.filter(([o]) => o.path === corePath(name))).toHaveLength(1);
    page.onHide(); auxiliary.resolve(runtime); await flush(); closed(name);
  });
});
describe.each<Name>(["commission", "order-detail"])("read continuity: %s", name => {
  it("preserves already-read facts during refresh but closes actions until core and runtime are current", async () => {
    await loadPage(name); void page.load(); core.resolve(coreValue(name)); auxiliary.resolve(runtime); await flush();
    core = deferred(); auxiliary = deferred(); void page.load(); await flush();
    expect(page.data.loading).toBe(false); expect(facts(name)).toMatchObject(coreValue(name)); expect(page.data.coreReady).toBe(false); closed(name);
    auxiliary.resolve(runtime); await flush(); closed(name);
    core.reject(new Error("synthetic offline refresh")); await flush(); expect(facts(name)).toMatchObject(coreValue(name)); closed(name);
  });
  it.each([401, 403, 404])("scrubs cached private core data after an authoritative %s", async status => {
    await loadPage(name); void page.load(); core.resolve(coreValue(name)); auxiliary.resolve(runtime); await flush();
    core = deferred(); void page.load(); core.reject({ status, title: "synthetic denied" }); await flush();
    expect(facts(name)).toBeNull(); expect(page.data.coreReady).toBe(false); closed(name);
  });
});
it("retains a newer order display without authorizing an older business version", async () => {
  await loadPage("order-detail"); void page.load(); core.resolve(order); auxiliary.resolve(runtime); await flush();
  core = deferred(); void page.load(); core.resolve({ ...order, version: 1, totalCents: 1 }); await flush();
  expect(page.data.order).toMatchObject({ version: 2, totalYuan: "12.00" }); expect(page.data.coreReady).toBe(false); closed("order-detail");
});
it("revoked management authority closes financial and ordinary navigation despite a successful runtime", async () => {
  await loadPage("management"); void page.load(); core.resolve(authority); auxiliary.resolve(runtime); await flush();
  core = deferred(); void page.load(); core.resolve({ version: 1, managementAvailable: false, capabilities: [] }); await flush();
  expect(page.data).toMatchObject({ canFinance: false, canSupport: false, authority: null, coreReady: false });
  page.openSupport(); page.openFinance(); expect((globalThis as any).wx.navigateTo).not.toHaveBeenCalled();
});
describe.each<"commission" | "order-detail">(["commission", "order-detail"])("write ownership is not read ownership: %s", name => {
  async function prepare() {
    await loadPage(name); void page.load(); core.resolve(coreValue(name)); auxiliary.resolve(runtime); await flush();
    if (name === "commission") page.setData({ creditFormVisible: true, creditAmount: "2.00" });
    else page.setData({ refundFormVisible: true, refundAmount: "2.00", refundReason: "合成退款测试原因" });
  }
  const submit = () => name === "commission" ? page.submitCredit() : page.submitRefund();
  it("does not cancel an in-flight POST on hide and recovers busy state after returning", async () => {
    await prepare(); const write = deferred(), original = mocks.request.getMockImplementation()!;
    mocks.request.mockImplementation(o => o.method === "POST" ? write.promise : original(o));
    const promise = submit(); await flush();
    const options = mocks.request.mock.calls.find(([o]) => o.method === "POST")![0];
    expect(options.registerAbort).toBeUndefined(); expect(page.data.busy).toBe(true);
    page.onHide(); page.onShow(); expect(page.data.busy).toBe(true);
    write.reject({ code: "NETWORK_TIMEOUT" }); await promise; await flush();
    expect(page.data.busy).toBe(false);
    const key = name === "commission" ? page.data.creditRequestKey : page.data.refundKey;
    expect(key).toBe(options.idempotencyKey);
    const replay = submit(); await flush(); await replay;
    const writes = mocks.request.mock.calls.filter(([o]) => o.method === "POST").map(([o]) => o);
    expect(writes).toHaveLength(2); expect(writes[1].idempotencyKey).toBe(key); expect(writes[1].data).toEqual(writes[0].data);
  });
  it("ignores double taps during the confirmation dialog and performs only one write", async () => {
    await prepare(); const answer = deferred(); (globalThis as any).wx.showModal.mockReturnValue(answer.promise);
    const first = submit(), second = submit(); await flush();
    expect((globalThis as any).wx.showModal).toHaveBeenCalledTimes(1);
    answer.resolve({ confirm: true }); await Promise.all([first, second]); await flush();
    expect(mocks.request.mock.calls.filter(([o]) => o.method === "POST")).toHaveLength(1);
  });
  it("does not start a write from a confirmation that arrives after hiding", async () => {
    await prepare(); const answer = deferred(); (globalThis as any).wx.showModal.mockReturnValue(answer.promise);
    const first = submit(); page.onHide(); answer.resolve({ confirm: true }); await first;
    expect(mocks.request.mock.calls.filter(([o]) => o.method === "POST")).toHaveLength(0);
  });
});

it("management blocks all stale-account navigation before onShow runs", async () => {
  await loadPage("management"); void page.load();
  core.resolve({...authority,capabilities:["support.read","commerce.refund.approve","commerce.product.manage","commerce.order.read","member.profile.read"]});
  auxiliary.resolve(runtime); await flush(); mocks.token="member-b";
  page.openSupport();page.openCatalog();page.openOrders();page.openMembers();page.openFinance();
  expect((globalThis as any).wx.navigateTo).not.toHaveBeenCalled();
});
it("a verified payment refresh releases busy before reloading the authoritative order", async () => {
  await loadPage("order-detail");void page.load();core.resolve({...order,status:"pending_payment"});auxiliary.resolve(runtime);await flush();
  const original=mocks.request.getMockImplementation()!;
  core=deferred();mocks.request.mockImplementation(o=>o.path.endsWith("/payment-intent")?Promise.resolve({state:"paid"}):original(o));
  await page.recheckPayment();await flush();expect(page.data.busy).toBe(false);expect(page.data.coreReady).toBe(false);
  core.resolve({...order,version:3});await flush();expect(page.data.order.version).toBe(3);expect(page.data.coreReady).toBe(true);
});

describe.each<Name>(["commission","order-detail"])("historical facts without a money provider: %s",name=>{
  it.each(["pending","disabled","error"])("loads owner history while runtime is %s without opening actions",async state=>{
    await loadPage(name);void page.load();core.resolve(coreValue(name));
    if(state==="disabled")auxiliary.resolve({...runtime,scope:"disabled",isolatedMoneyOperationsAvailable:false,isolatedTransferAvailable:false,isolatedCreditCheckoutAvailable:false});
    if(state==="error")auxiliary.reject(new Error("synthetic unavailable provider"));
    await flush();closed(name);
    const paths=mocks.request.mock.calls.map(([o])=>o.path);
    if(name==="commission"){
      expect(paths).toContain("/v1/me/commission/settlement-requests?limit=10");
      expect(paths).toContain("/v1/me/commission/credit-conversions?limit=10");
      expect(page.data).toMatchObject({requestsLoading:false,creditLoading:false,totalCount:0,creditTotal:0});
    }else {expect(paths).toContain(`/v1/me/refund-requests?orderId=${id}&limit=10`);expect(page.data.refundLoading).toBe(false);}
  });
  it("retains core facts when a historical read fails, without displaying a successful empty history",async()=>{
    const original=mocks.request.getMockImplementation()!;
    mocks.request.mockImplementation(o=>o.path.includes("requests?")||o.path.includes("conversions?")?Promise.reject(new Error("synthetic history unavailable")):original(o));
    await loadPage(name);void page.load();core.resolve(coreValue(name));await flush();
    expect(facts(name)).toMatchObject(coreValue(name));expect(page.data.coreReady).toBe(true);
    if(name==="commission"){expect(page.data.listError).not.toBe("");expect(page.data.creditError).not.toBe("");}
    else expect(page.data.refundError).not.toBe("");closed(name);
  });
});
it("never launches native payment UI from a response received while hidden",async()=>{
  await loadPage("order-detail");void page.load();core.resolve({...order,status:"pending_payment"});auxiliary.resolve(runtime);await flush();
  const write=deferred(),original=mocks.request.getMockImplementation()!;
  mocks.request.mockImplementation(o=>o.method==="POST"?write.promise:original(o));
  (globalThis as any).wx.requestPayment=vi.fn().mockResolvedValue({});
  const pending=page.preparePayment();page.onHide();write.resolve({state:"prepared",simulation:false,requestPayment:{}});await pending;
  expect((globalThis as any).wx.requestPayment).not.toHaveBeenCalled();expect(page.data.busy).toBe(false);
});
it("never launches transfer confirmation UI from a response received while hidden",async()=>{
  await loadPage("commission");void page.load();core.resolve(membership);auxiliary.resolve(runtime);await flush();
  page.setData({requests:[{id,canConfirm:true}]});const confirmation=deferred(),original=mocks.request.getMockImplementation()!;
  mocks.request.mockImplementation(o=>o.path.endsWith("/confirmation")?confirmation.promise:original(o));
  Object.assign((globalThis as any).wx,{canIUse:()=>true,getAccountInfoSync:()=>({miniProgram:{appId:"synthetic-app"}}),requestMerchantTransfer:vi.fn()});
  const pending=page.confirmReceipt({currentTarget:{dataset:{id}}});page.onHide();
  confirmation.resolve({requestId:id,state:"WAIT_USER_CONFIRM",appId:"synthetic-app",mchId:"synthetic-merchant",package:"synthetic-package",simulation:true});await pending;
  expect((globalThis as any).wx.requestMerchantTransfer).not.toHaveBeenCalled();expect(page.data.busy).toBe(false);
});
it("order-detail renders an unknown refund count while history is pending, not a false zero",async()=>{
  const history=deferred(),fallback=mocks.request.getMockImplementation()!;
  mocks.request.mockImplementation((options:any)=>options.path.startsWith("/v1/me/refund-requests?")?history.promise:fallback(options));
  await loadPage("order-detail");void page.load();core.resolve(order);await flush();
  expect(page.data.refundCountLabel).toBe("正在核对记录数量");
  expect(readFileSync("apps/miniprogram/pages/order-detail/index.wxml","utf8")).toContain("{{refundCountLabel}}");
  history.resolve({items:[],totalCount:0,nextCursor:null});await flush();
  expect(page.data.refundCountLabel).toBe("本单申请 0 项");
});
it("order-detail does not present a failed refund-history read as zero requests",async()=>{
  const history=deferred(),fallback=mocks.request.getMockImplementation()!;
  mocks.request.mockImplementation((options:any)=>options.path.startsWith("/v1/me/refund-requests?")?history.promise:fallback(options));
  await loadPage("order-detail");void page.load();core.resolve(order);await flush();
  history.reject({status:503,title:"合成历史读取失败"});await flush();
  expect(page.data.refundCountLabel).toBe("记录数量暂未核实");expect(page.data.refundError).toBeTruthy();
});
