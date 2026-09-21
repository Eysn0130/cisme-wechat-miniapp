import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ token: "member-a", request: vi.fn(), authority: vi.fn(), avatar: vi.fn(), publish: vi.fn(), identity: vi.fn() }));
vi.mock("../../apps/miniprogram/services/api", () => ({ request: mocks.request, requireMemberAccess: () => Boolean(mocks.token), retainMemberSnapshot: () => false, clearAuthenticationRedirectSuppression: vi.fn() }));
vi.mock("../../apps/miniprogram/services/member-identity", () => ({ memberIdentity: mocks.identity, publishMemberIdentity: mocks.publish }));
vi.mock("../../apps/miniprogram/services/member-avatar", () => ({ defaultMemberAvatar: "neutral", localMemberAvatar: mocks.avatar }));
vi.mock("../../apps/miniprogram/services/authority", () => ({ authorityProjection: mocks.authority }));
vi.mock("../../apps/miniprogram/services/layout", () => ({ currentChromeStyle: () => "", shouldReduceMotion: () => true }));
vi.mock("../../apps/miniprogram/services/share", () => ({ registerIncomingShare: vi.fn() }));
vi.mock("../../apps/miniprogram/services/task-entry", () => ({ consumerTaskEntries: (items: unknown) => items }));

const deferred = <T = any>() => {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
let page: any;
const member = { id: "a", display_name: "合成会员", profile_revision: 1, avatar_data_url: "synthetic-avatar", avatar_revision: "synthetic-revision" };
const care = { id: "cycle-a", version: 1, phase: "planned", startedOn: null, timezone: "Asia/Shanghai", completed: [], records: [], due: null, next: "D1", scheduleOffsetDays: 0 };
const snapshot = { member, care, points: { projection: { available: 12 } }, businessVersion: 100 };
let support: ReturnType<typeof deferred>, commercial: ReturnType<typeof deferred>, authority: ReturnType<typeof deferred>, avatar: ReturnType<typeof deferred>;
async function loadPage(name: "home" | "profile") {
  if (name === "home") await import("../../apps/miniprogram/pages/home/index");
  else await import("../../apps/miniprogram/pages/profile/index");
  return page;
}
beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks(); mocks.token = "member-a";
  support = deferred(); commercial = deferred(); authority = deferred(); avatar = deferred();
  mocks.identity.mockReturnValue(null); mocks.avatar.mockReturnValue(avatar.promise); mocks.authority.mockReturnValue(authority.promise);
  mocks.request.mockImplementation(async ({ path }: { path: string }) => {
    if (path.startsWith("/v1/bootstrap/")) return snapshot;
    if (path === "/v1/me/support/summary") return support.promise;
    if (path === "/v1/me/commercial-membership") return commercial.promise;
    if (path === "/v1/me/tasks") return [];
    throw new Error(`Unexpected synthetic request: ${path}`);
  });
  (globalThis as any).getApp = () => ({ globalData: { sessionToken: mocks.token } });
  (globalThis as any).wx = { navigateTo: vi.fn(), showToast: vi.fn(), disableAlertBeforeUnload: vi.fn() };
  (globalThis as any).Page = (definition: any) => {
    page = { ...definition, data: structuredClone(definition.data), setData(patch: any, callback?: () => void) { Object.assign(this.data, patch); callback?.(); } };
  };
});

describe("PERF-01/03: native Home progressive, session-bound facts", () => {
  it("makes the care action usable while support never responds", async () => {
    await loadPage("home"); void page.load(); await flush();
    expect(page.data).toMatchObject({ loading: false, authorityAvailable: true, care, supportState: "loading", supportUnread: null });
    support.resolve({ unreadCount: 4 }); await flush();
    expect(page.data).toMatchObject({ supportState: "ready", supportUnread: 4, care });
  });
  it("does not translate failed unread into zero or erase core facts", async () => {
    await loadPage("home"); void page.load(); support.reject(new Error("synthetic offline")); await flush();
    expect(page.data).toMatchObject({ loading: false, authorityAvailable: true, care, supportState: "error", supportUnread: null });
  });
  it("keeps core writes closed after bootstrap fails even if support succeeds", async () => {
    mocks.request.mockImplementation(async ({ path }) => path.includes("bootstrap") ? Promise.reject(new Error("synthetic offline")) : { unreadCount: 4 });
    await loadPage("home"); await page.load(); await flush(); await page.primaryAction();
    expect(page.data).toMatchObject({ loading: false, authorityAvailable: false, care: null });
    expect((globalThis as any).wx.navigateTo).not.toHaveBeenCalled();
  });
  it("preserves guest step and CTA through selection, minute tick, refresh and explicit navigation", async () => {
    mocks.token = ""; await loadPage("home"); await page.load();
    page.selectProtocolStep({ currentTarget: { dataset: { index: 2 } } });
    for (const refresh of [() => page.refreshDaypart(), () => page.load()]) {
      expect(page.data.view).toMatchObject({ action: "授权身份并开始", protocolCode: "02" });
      await refresh();
    }
    expect(page.data.view).toMatchObject({ action: "授权身份并开始", protocolCode: "02" });
    expect(mocks.request).not.toHaveBeenCalled(); expect((globalThis as any).wx.navigateTo).not.toHaveBeenCalled();
    await page.primaryAction(); expect((globalThis as any).wx.navigateTo).toHaveBeenCalledWith(expect.objectContaining({ url: "/pages/account/index" }));
  });
  it("ignores both core and auxiliary late responses after session switch", async () => {
    const core = deferred(); mocks.request.mockImplementation(({ path }) => path.includes("bootstrap") ? core.promise : support.promise);
    await loadPage("home"); void page.load(); mocks.token = "member-b";
    core.resolve(snapshot); support.resolve({ unreadCount: 7 }); await flush();
    expect(page.data.care).toBeNull(); expect(page.data.authorityAvailable).toBe(false); expect(page.data.supportUnread).toBeNull();
  });
  it("suppresses late support after hide and does not replace a newer business version", async () => {
    await loadPage("home"); await page.load(); page.onHide(); support.resolve({ unreadCount: 7 }); await flush();
    expect(page.data.supportUnread).toBeNull();
    page.data.snapshotVersion = 101; const newerCare = { ...care, version: 2 }; page.data.care = newerCare;
    await page.load(true); expect(page.data.care).toEqual(newerCare);
  });
  it("restores guest semantics after an expired session without automatic navigation", async () => {
    mocks.request.mockImplementation(async ({ path, authMode }) => {
      expect(authMode).toBe("optional");
      if (path.includes("bootstrap")) { mocks.token = ""; throw { status: 401 }; }
      return support.promise;
    });
    await loadPage("home"); await page.load();
    expect(page.data).toMatchObject({ needsAuthentication: true, authorityAvailable: false, loading: false });
    expect(page.data.view.action).toBe("授权身份并开始"); expect((globalThis as any).wx.navigateTo).not.toHaveBeenCalled();
  });
});

describe("PERF-02/09: native Profile consistent core, independent auxiliary states", () => {
  it.each([
    ["planned", "护理周期待开始", "待用户确认开始", "下一节点 D1"],
    ["active", "护理周期进行中", "护理进行中", "下一节点 D1"],
    ["paused", "护理周期已暂停", "护理已暂停", "恢复后继续 D1"],
    ["terminated", "护理周期已终止", "周期已终止", "历史护理事实已归档"],
    ["completed", "护理周期已完成", "周期已完成", "护理事实已归档"],
    ["waiting", "护理周期待确认", "待资格确认", "下一节点 D1"],
    [null, "护理周期待确认", "待资格确认", "下一节点 待安排"]
  ])("populates the WXML care card for %s while auxiliary requests remain pending", async (phase, title, status, copy) => {
    const originalRequest = mocks.request.getMockImplementation()!;
    mocks.request.mockImplementation((options) => options.path === "/v1/bootstrap/profile"
      ? Promise.resolve({ ...snapshot, care: phase === null ? null : { ...care, phase } })
      : originalRequest(options));
    await loadPage("profile"); void page.load(); await flush();
    expect(page.data).toMatchObject({ loading: false, careTitle: title, careStatus: status, authorityState: "loading", commercialState: "loading", supportState: "loading", avatarState: "loading" });
    expect(page.data.careCopy).toContain(copy);
  });
  it("displays member/points/care before permissions, commercial, support and avatar", async () => {
    await loadPage("profile"); void page.load(); await flush();
    expect(page.data).toMatchObject({ loading: false, member: { id: "a" }, points: snapshot.points, care, memberAvatar: "neutral", authorityState: "loading", commercialState: "loading", supportState: "loading", avatarState: "loading" });
    expect(page.data.member).not.toHaveProperty("avatar_data_url");
    expect(page.data.authority).toBeNull(); expect(page.data.commercialAccessible).toBe(false);
  });
  it("distinguishes genuine absence from failure and does not erase the core on auxiliary failure", async () => {
    await loadPage("profile"); void page.load(); await flush();
    authority.reject(new Error("synthetic offline")); commercial.reject(new Error("synthetic offline")); support.reject(new Error("synthetic offline")); avatar.reject(new Error("synthetic fs")); await flush();
    expect(page.data).toMatchObject({ loading: false, member: { id: "a" }, authority: null, commercialAccessible: false, supportUnread: null, authorityState: "error", commercialState: "error", supportState: "error", avatarState: "error" });
    expect(mocks.publish).not.toHaveBeenCalled();
  });
  it("publishes separately arriving successful auxiliary results without changing the core version", async () => {
    await loadPage("profile"); void page.load(); await flush();
    authority.resolve({ version: 1, managementAvailable: false, capabilities: [] }); commercial.resolve({ eligible: false, membershipState: "none", verifiedOrderCount: 0, commission: { netEarnedCents: 0 } }); support.resolve({ unreadCount: 0 }); avatar.resolve("wxfile://synthetic-avatar"); await flush();
    expect(page.data).toMatchObject({ snapshotVersion: 100, authorityState: "ready", commercialState: "ready", supportState: "ready", supportUnread: 0, avatarState: "ready", memberAvatar: "wxfile://synthetic-avatar", commercialAccessible: false });
    expect(mocks.publish).toHaveBeenCalledWith(expect.objectContaining({ id: "a", avatarUrl: "wxfile://synthetic-avatar" }));
  });
  it.each(["hide", "session"])("rejects late avatar and auxiliary publication after %s", async (kind) => {
    await loadPage("profile"); void page.load(); await flush();
    if (kind === "hide") page.onHide(); else mocks.token = "member-b";
    authority.resolve({ version: 1, managementAvailable: true, capabilities: ["support.read"] }); commercial.resolve({ eligible: true, membershipState: "active", verifiedOrderCount: 1, commission: { netEarnedCents: 0 } }); support.resolve({ unreadCount: 4 }); avatar.resolve("wxfile://old-session"); await flush();
    expect(page.data.authority).toBeNull(); expect(page.data.commercialAccessible).toBe(false); expect(page.data.supportUnread).toBeNull(); expect(mocks.publish).not.toHaveBeenCalled();
  });
  it.each([
    { eligible: false, membershipState: "suspended", verifiedOrderCount: 0, commission: { netEarnedCents: 0 } },
    { eligible: false, membershipState: "none", verifiedOrderCount: 1, commission: { netEarnedCents: 0 } },
    { eligible: false, membershipState: "none", verifiedOrderCount: 0, commission: { netEarnedCents: 80 } }
  ])("preserves historical commercial access for the real status contract: %j", async (status) => {
    await loadPage("profile"); void page.load(); await flush(); commercial.resolve(status); await flush();
    expect(page.data).toMatchObject({ commercialState: "ready", commercialAccessible: true, commercialEligible: false });
  });
  it("does not turn a malformed commercial projection into eligibility", async () => {
    await loadPage("profile"); void page.load(); await flush(); commercial.resolve({ eligible: true, state: "active" }); await flush();
    expect(page.data).toMatchObject({ commercialState: "error", commercialAccessible: false, commercialEligible: false });
  });
  it("does not carry an older member's higher businessVersion into a new session", async () => {
    await loadPage("profile"); void page.load(); await flush();
    mocks.token = "member-b"; mocks.request.mockImplementation(async ({ path }) => path.includes("bootstrap") ? { ...snapshot, member: { ...member, id: "b" }, businessVersion: 2 } : []);
    await page.load(undefined, false); expect(page.data.member.id).toBe("b"); expect(page.data.snapshotVersion).toBe(2);
  });
});
