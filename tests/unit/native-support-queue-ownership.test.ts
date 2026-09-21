import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ token: "operator-a", request: vi.fn() }));
vi.mock("../../apps/miniprogram/services/api", () => ({ request: m.request }));
vi.mock("../../apps/miniprogram/services/layout", () => ({ currentChromeStyle: () => "" }));
const deferred = () => {
  let resolve!: (value: any) => void, reject!: (reason: any) => void;
  const promise = new Promise<any>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
const grant = { version: 1, managementAvailable: true, capabilities: ["support.read"] };
const row = { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", memberDisplayName: "合成会员", lastMessage: "合成咨询", status: "waiting_human", updatedAt: "2026-09-21T00:00:00Z" };
let definition: any, page: any, read: ReturnType<typeof deferred>, authority: ReturnType<typeof deferred>;
let aborts: Map<string, ReturnType<typeof vi.fn>>;
const instantiate = () => ({ ...definition, data: structuredClone(definition.data), setData(patch: any) { Object.assign(this.data, patch); } });
beforeEach(async () => {
  vi.resetModules(); vi.clearAllMocks(); vi.useFakeTimers(); m.token = "operator-a";
  read = deferred(); authority = deferred(); aborts = new Map();
  (globalThis as any).getApp = () => ({ globalData: { sessionToken: m.token } });
  (globalThis as any).wx = { showToast: vi.fn(), navigateBack: vi.fn(), navigateTo: vi.fn(), switchTab: vi.fn(), redirectTo: vi.fn() };
  (globalThis as any).Page = (value: any) => { definition = value; };
  m.request.mockImplementation((options: any) => {
    const abort = vi.fn(); aborts.set(options.path, abort); options.registerAbort?.(abort);
    return options.path === "/v1/me/authority" ? authority.promise : read.promise;
  });
  await import("../../apps/miniprogram/pages/management-support/index"); page = instantiate();
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });
const start = async () => { void page.onShow(); authority.resolve(grant); await flush(); };
const ready = async () => { await start(); read.resolve({ items: [row], nextCursor: "older" }); await flush(); };

describe("support queue read ownership", () => {
  it("cancels its pending GET on hide without accepting its late response", async () => {
    await start(); page.onHide(); expect(aborts.get("/v1/management/support/conversations?limit=30")).toHaveBeenCalledOnce();
    read.resolve({ items: [row], nextCursor: null }); await flush(); expect(page.data.items).toEqual([]);
  });
  it("does not navigate another page on a hidden authority denial", async () => {
    void page.onShow(); page.onHide(); authority.reject({ status: 403 }); await flush();
    expect(wx.navigateBack).not.toHaveBeenCalled(); expect(wx.showToast).not.toHaveBeenCalled();
  });
  it("rejects an account change before a pending list response", async () => {
    await start(); m.token = "operator-b"; read.resolve({ items: [row], nextCursor: null }); await flush();
    expect(page.data.items).toEqual([]);
  });
  it("blocks old navigation immediately after account change", async () => {
    await ready(); m.token = "operator-b"; page.open({ currentTarget: { dataset: { id: row.id } } });
    expect(wx.navigateTo).not.toHaveBeenCalled();
  });
  it("does not start manual reads or pagination while hidden", async () => {
    await ready(); page.onHide(); m.request.mockClear(); await page.load(); await page.loadMore();
    expect(m.request).not.toHaveBeenCalled();
  });
  it.each([401, 403, 404])("clears sensitive rows on polling denial %s", async status => {
    await ready(); read = deferred(); void page.load(true); read.reject({ status }); await flush();
    expect(page.data.items).toEqual([]); expect(page.data.nextCursor).toBeNull();
    expect(page.data.error).not.toBe("");
  });
  it("clears retained rows when the API invalidates the session before rejecting 401", async () => {
    await ready(); read = deferred(); void page.load(true);
    const { invalidateCommerceRecoveryContext } = await import("../../apps/miniprogram/services/commerce-command-store");
    m.token = ""; invalidateCommerceRecoveryContext(); read.reject({ status: 401 }); await flush();
    expect(page.data.items).toEqual([]); expect(page.data.nextCursor).toBeNull();
    expect(page.readPending).toBe(false); expect(page.timer).toBeNull();
  });
  it("clears the retained snapshot when account ownership changes during pagination", async () => {
    await ready(); read = deferred(); void page.loadMore(); m.token = "operator-b";
    read.resolve({ items: [{ ...row, id: "second" }], nextCursor: null }); await flush();
    expect(page.data.items).toEqual([]); expect(page.data.nextCursor).toBeNull();
    expect(page.data.loadingMore).toBe(false); expect(page.timer).toBeNull();
  });
  it("keeps a failed refresh snapshot read-only until an explicit retry succeeds", async () => {
    await ready(); read = deferred(); void page.load(true); read.reject({ status: 503 }); await flush();
    expect(page.data.items[0].id).toBe(row.id); expect(page.data.error).not.toBe("");
    page.open({ currentTarget: { dataset: { id: row.id } } }); expect(wx.navigateTo).not.toHaveBeenCalled();
    read = deferred(); void page.load(); await flush(); read.resolve({ items: [row], nextCursor: null }); await flush();
    page.open({ currentTarget: { dataset: { id: row.id } } }); expect(wx.navigateTo).toHaveBeenCalledOnce();
  });
  it("does not overlap slow polling reads", async () => {
    await ready(); read = deferred(); m.request.mockClear(); await vi.advanceTimersByTimeAsync(18_000);
    expect(m.request.mock.calls.filter(([o]) => o.path.includes("/conversations"))).toHaveLength(1);
  });
  it("isolates timers and pending responses between page instances", async () => {
    await ready(); const old = page; page = instantiate(); await ready();
    old.onUnload(); read = deferred(); m.request.mockClear(); await vi.advanceTimersByTimeAsync(6000);
    expect(m.request.mock.calls.filter(([o]) => o.path.includes("/conversations"))).toHaveLength(1);
  });
  it("rejects A to B to A session revisions", async () => {
    await start(); const { invalidateCommerceRecoveryContext } = await import("../../apps/miniprogram/services/commerce-command-store");
    m.token = "operator-b"; invalidateCommerceRecoveryContext(); m.token = "operator-a"; invalidateCommerceRecoveryContext();
    read.resolve({ items: [row], nextCursor: null }); await flush(); expect(page.data.items).toEqual([]);
  });
  it("retains pagination cursor on temporary failure and removes duplicate rows on retry", async () => {
    await ready(); read = deferred(); void page.loadMore(); read.reject({ status: 503 }); await flush();
    expect(page.data.nextCursor).toBe("older"); expect(page.data.items).toHaveLength(1);
    read = deferred(); void page.loadMore(); read.resolve({ items: [row, { ...row, id: "second" }], nextCursor: null }); await flush();
    expect(page.data.items.map((item: any) => item.id)).toEqual([row.id, "second"]);
  });
});
