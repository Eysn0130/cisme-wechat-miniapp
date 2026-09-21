import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
const mocks = vi.hoisted(() => ({ token: "member-a", request: vi.fn() }));
const storage = new Map<string,unknown>();
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
  vi.resetModules(); vi.clearAllMocks(); mocks.token = "member-a"; storage.clear(); core = deferred(); auxiliary = deferred(); aborts = new Map();
  mocks.request.mockImplementation((options: any) => {
    if(options.path === "/v1/me/profile") return Promise.resolve({id});
    if(options.path.startsWith("/v1/me/commerce/command-receipts/")) return Promise.resolve({version:1, memberId:id, kind:options.path.split("/").pop()?.split("?")[0], status:"not_observed", record:null});
    const abort = vi.fn(); aborts.set(options.path, abort); options.registerAbort?.(abort);
    if (options.path === "/v1/commerce/orders/status") return auxiliary.promise;
    if (["/v1/me/authority", "/v1/me/commercial-membership", `/v1/me/orders/${id}`].includes(options.path)) return core.promise;
    if (options.path.includes("refund-requests")) return Promise.resolve({ items: [], totalCount: 0, nextCursor: null });
    if (options.path.includes("settlement-requests")) return Promise.resolve({ items: [], totalCount: 0, nextCursor: null });
    if (options.path.includes("credit-conversions")) return Promise.resolve({ items: [], totalCount: 0, availableCents: 0, nextCursor: null });
    throw new Error(`Unexpected synthetic request: ${options.path}`);
  });
  (globalThis as any).getApp = () => ({ globalData: { sessionToken: mocks.token,apiBaseUrl:"https://synthetic.invalid",cloudFunction:null } });
  (globalThis as any).wx = { navigateTo: vi.fn(), navigateBack: vi.fn(), switchTab: vi.fn(), showToast: vi.fn(), getStorageSync:(key:string)=>storage.get(key),setStorageSync:(key:string,value:unknown)=>storage.set(key,structuredClone(value)),removeStorageSync:(key:string)=>storage.delete(key),showModal: vi.fn().mockResolvedValue({ confirm: true }) };
  (globalThis as any).Page = (definition: any) => { page = { ...definition, data: structuredClone(definition.data), setData(patch: any, callback?: () => void) { Object.assign(this.data, patch); callback?.(); } }; };
});

async function ready(name:Name){ await loadPage(name);void page.load();core.resolve(coreValue(name));auxiliary.resolve(runtime);await flush(); }
const forms=(kind:string)=>kind==="refund"?{refundFormVisible:true,refundAmount:"1.00",refundReason:"合成退款原因"}:kind==="settlement"?{formVisible:true,amount:"1.00",reason:"合成结算依据"}:{creditFormVisible:true,creditAmount:"1.00"};
const submit=(kind:string)=>kind==="refund"?page.submitRefund():kind==="settlement"?page.submit():page.submitCredit();
describe("MONEY-RECOVERY-01: existing Page reproduction",()=>{
  it.each(["refund","settlement","credit"])("does not issue a new %s command after a lost response and edited amount",async kind=>{
    await ready(kind==="refund"?"order-detail":"commission");
    const original=mocks.request.getMockImplementation()!;
    mocks.request.mockImplementation(o=>o.method==="POST"?Promise.reject({code:"REQUEST_DEADLINE",title:"合成丢响应"}):original(o));
    page.setData(forms(kind));await submit(kind);await flush();
    if(kind==="refund")page.editRefundAmount({detail:{value:"2.00"}});
    else if(kind==="settlement")page.editAmount({detail:{value:"2.00"}});
    else page.editCreditAmount({detail:{value:"2.00"}});
    await submit(kind);await flush();
    const writes=mocks.request.mock.calls.map(([o])=>o).filter(o=>o.method==="POST");
    expect(writes.length).toBeGreaterThan(0);
    expect(new Set(writes.map(o=>o.idempotencyKey)).size).toBe(1);
    expect(writes.every(o=>o.data.amountCents===100)).toBe(true);
  });
  it.each(["refund","settlement","credit"])("preserves the original %s key across page unload and module restart",async kind=>{
    const name=kind==="refund"?"order-detail":"commission";
    await ready(name);const original=mocks.request.getMockImplementation()!;
    mocks.request.mockImplementation(o=>o.method==="POST"?Promise.reject({code:"REQUEST_DEADLINE"}):original(o));
    page.setData(forms(kind));await submit(kind);await flush();page.onUnload();
    vi.resetModules();await ready(name);page.setData(forms(kind));await submit(kind);await flush();
    const writes=mocks.request.mock.calls.map(([o])=>o).filter(o=>o.method==="POST");
    expect(writes.length).toBeGreaterThan(0);expect(new Set(writes.map(o=>o.idempotencyKey)).size).toBe(1);
  });
});
