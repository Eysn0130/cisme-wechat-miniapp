import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ token: "member-a", request: vi.fn(), bootstrap: vi.fn() }));
vi.mock("../../apps/miniprogram/services/api", () => ({
  request: mocks.request, requireMemberAccess: () => Boolean(mocks.token), retainMemberSnapshot: () => false
}));
vi.mock("../../apps/miniprogram/services/layout", () => ({ currentChromeStyle: () => "", shouldReduceMotion: () => true }));
vi.mock("../../apps/miniprogram/services/share", () => ({ registerIncomingShare: vi.fn() }));

let page: any;
let identity: typeof import("../../apps/miniprogram/services/member-identity");
const snapshot = (name = "合成昵称甲", revision = 2, id = "a") => ({
  member: { id, display_name: name, profile_revision: revision }, care: null, businessVersion: 1
});
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
function publish(name: string, revision: number, id = "a") {
  identity.publishMemberIdentity({ id, display_name: name, profile_revision: revision, avatarUrl: "local-avatar" });
}
const step = (index: number) => ({ currentTarget: { dataset: { index } } });

beforeEach(async () => {
  vi.resetModules(); vi.clearAllMocks(); vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-30T12:00:00Z"));
  mocks.token = "member-a"; mocks.bootstrap.mockResolvedValue(snapshot());
  mocks.request.mockImplementation(async ({ path }: { path: string }) => {
    if (path === "/v1/bootstrap/home") return mocks.bootstrap();
    if (path === "/v1/me/support/summary") return { unreadCount: 0 };
    if (path.startsWith("/v1/me/daily-care-records")) return {
      items: [], loadedCount: 0, hasMore: false, nextCursor: null,
      serverDay: "2026-10-30", today: null, totalCount: 0
    };
    throw new Error("Unexpected synthetic request");
  });
  (globalThis as any).getApp = () => ({ globalData: { sessionToken: mocks.token } });
  (globalThis as any).wx = {
    disableAlertBeforeUnload: vi.fn(), enableAlertBeforeUnload: vi.fn(),
    showToast: vi.fn(), navigateTo: vi.fn(), nextTick: (callback: () => void) => callback()
  };
  (globalThis as any).Page = (definition: any) => {
    page = { ...definition, data: structuredClone(definition.data),
      setData(patch: any, callback?: () => void) { Object.assign(this.data, patch); callback?.(); } };
  };
  identity = await import("../../apps/miniprogram/services/member-identity");
  await import("../../apps/miniprogram/pages/home/index");
});
afterEach(() => { page?.onUnload(); vi.useRealTimers(); });

describe("Home canonical nickname continuity", () => {
  it("keeps a cold-bootstrap nickname through the real minute-clock callback without a shared identity cache", async () => {
    expect(identity.memberIdentity()).toBeNull(); await page.load();
    expect(page.data.view.greeting).toBe("晚上好，合成昵称甲");
    page.startDaypartClock(); await vi.advanceTimersByTimeAsync(60_000);
    expect(page.data.view.greeting).toBe("晚上好，合成昵称甲");
    expect(mocks.bootstrap).toHaveBeenCalledTimes(1);
  });

  it("keeps that canonical nickname when selecting a protocol step", async () => {
    await page.load(); page.selectProtocolStep(step(2));
    expect(page.data.view).toMatchObject({ greeting: "晚上好，合成昵称甲", protocolCode: "02" });
    expect(mocks.request.mock.calls.every(([options]) => !options.method || options.method === "GET")).toBe(true);
  });

  it("keeps the nickname through opening, advancing and closing the local care sheet without a write", async () => {
    await page.load(); await flush(); page.openCareSession();
    expect(page.data.sessionOpen).toBe(true); expect(page.data.view.greeting).toBe("晚上好，合成昵称甲");
    for (let i = 0; i < 4; i++) { page.advanceCareStep(); expect(page.data.view.greeting).toBe("晚上好，合成昵称甲"); }
    page.resetCareSession(); expect(page.data.sessionMounted).toBe(false);
    expect(page.data.view.greeting).toBe("晚上好，合成昵称甲");
    expect(mocks.request.mock.calls.every(([options]) => !options.method || options.method === "GET")).toBe(true);
  });

  it("prefers a Settings identity with a newer revision over a late older bootstrap and later redraws", async () => {
    await page.load(); publish("设置新昵称", 4); page.refreshDaypart();
    expect(page.data.view.greeting).toBe("晚上好，设置新昵称");
    mocks.bootstrap.mockResolvedValue(snapshot("旧昵称", 3)); await page.load(true);
    identity.clearMemberIdentity(); page.selectProtocolStep(step(1));
    expect(page.data.view.greeting).toBe("晚上好，设置新昵称");
  });

  it("does not replace a newer bootstrap nickname with a stale shared identity revision", async () => {
    publish("旧缓存昵称", 1); await page.load(); page.refreshDaypart();
    expect(page.data.view.greeting).toBe("晚上好，合成昵称甲");
    page.selectProtocolStep(step(3)); expect(page.data.view.greeting).toBe("晚上好，合成昵称甲");
  });

  it("keeps the last confirmed nickname when a same-actor refresh is offline", async () => {
    await page.load(); mocks.bootstrap.mockRejectedValue({ status: 503 }); await page.load(true);
    expect(page.data.authorityAvailable).toBe(false); expect(page.data.error).not.toBe("");
    expect(page.data.view.greeting).toBe("晚上好，合成昵称甲");
    page.refreshDaypart(); expect(page.data.view.greeting).toBe("晚上好，合成昵称甲");
  });

  it("drops the previous actor's nickname while the next actor bootstrap is pending", async () => {
    await page.load(); publish("甲的较新昵称", 5); page.refreshDaypart();
    mocks.token = "member-b";
    let resolve!: (value: ReturnType<typeof snapshot>) => void;
    mocks.bootstrap.mockReturnValue(new Promise(resolveValue => { resolve = resolveValue; }));
    const pending = page.load(); expect(page.data.view.greeting).toBe("晚上好，CISME");
    page.selectProtocolStep(step(2)); expect(page.data.view.greeting).not.toContain("甲");
    resolve(snapshot("合成昵称乙", 1, "b")); await pending;
    page.refreshDaypart(); expect(page.data.view.greeting).toBe("晚上好，合成昵称乙");
  });

  it("never adopts a previous actor's late bootstrap after a session switch", async () => {
    let resolve!: (value: ReturnType<typeof snapshot>) => void;
    mocks.bootstrap.mockReturnValue(new Promise(resolveValue => { resolve = resolveValue; }));
    const oldRead = page.load(); mocks.token = "member-b";
    mocks.bootstrap.mockResolvedValue(snapshot("合成昵称乙", 1, "b")); await page.load();
    resolve(snapshot("迟到的甲", 9)); await oldRead; page.selectProtocolStep(step(0));
    expect(page.data.view.greeting).toBe("晚上好，合成昵称乙");
  });

  it("clears the nickname on an expired session and keeps the guest Home available", async () => {
    await page.load(); mocks.bootstrap.mockImplementation(async () => { mocks.token = ""; throw { status: 401 }; });
    await page.load(true); page.refreshDaypart(); page.selectProtocolStep(step(1));
    expect(page.data.view).toMatchObject({ greeting: "欢迎来到 CISME", action: "授权身份并开始", protocolCode: "01" });
    expect(page.data.needsAuthentication).toBe(true); expect(wx.navigateTo).not.toHaveBeenCalled();
  });

  it("does not reuse a nickname after the existing identity context is invalidated", async () => {
    await page.load();
    const { invalidateCommerceRecoveryContext } = await import("../../apps/miniprogram/services/commerce-command-store");
    invalidateCommerceRecoveryContext(); page.refreshDaypart();
    expect(page.data.view.greeting).toBe("晚上好，CISME");
  });
});
