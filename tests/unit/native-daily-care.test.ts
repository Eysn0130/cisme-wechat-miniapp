import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { careCommandConfirmed } from "../../apps/miniprogram/services/care-command-state";
const m = vi.hoisted(() => ({ token: "member-a", request: vi.fn(), authenticate: vi.fn() }));
vi.mock("../../apps/miniprogram/services/api", () => ({ request: m.request, requireMemberAccess: () => Boolean(m.token), retainMemberSnapshot: () => true, clearAuthenticationRedirectSuppression: vi.fn(), resumeAuthentication: m.authenticate }));
vi.mock("../../apps/miniprogram/services/layout", () => ({ currentChromeStyle: () => "", shouldReduceMotion: () => true, motionDuration: () => 0 }));
vi.mock("../../apps/miniprogram/services/member-identity", () => ({ memberIdentity: () => null }));
vi.mock("../../apps/miniprogram/services/share", () => ({ registerIncomingShare: vi.fn() }));
const path = "/v1/me/daily-care-records";
const steps = ["00", "01", "02", "03"];
const deferred = () => { let resolve!: (value: any) => void, reject!: (error: any) => void; const promise = new Promise<any>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const flush = async () => { for (let i = 0; i < 45; i++) await Promise.resolve(); };
const record = (n = 1, patch: Record<string, unknown> = {}) => ({ id: `11111111-1111-4111-8111-${String(n).padStart(12, "0")}`, source: "daily", operationId: `daily-operation-${n}`, completedAt: "2026-10-29T10:00:00.000Z", timezone: "Asia/Shanghai", protocolVersion: "daily-care-v1", stepCodes: [...steps], selfAssessment: "comfortable", ...patch });
const pageOf = (items: any[] = [], nextCursor: string | null = null) => ({ items, loadedCount: items.length, hasMore: nextCursor !== null, nextCursor });
let page: any, care: any, posts: any[], gets: string[], dailyRead: (options: any) => any, write: (options: any) => any, homeFails: boolean, cycleRead: () => any;
beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks(); m.token = "member-a"; care = null; homeFails = false; posts = []; gets = [];
  dailyRead = () => pageOf(); cycleRead = () => care;
  write = options => ({ record: record(1, { operationId: options.idempotencyKey, ...options.data }), replayed: false });
  m.request.mockImplementation(async (options: any) => {
    if (options.method === "POST") { posts.push(structuredClone(options)); return write(options); }
    gets.push(options.path);
    if (options.path.startsWith(path)) return dailyRead(options);
    if (options.path === "/v1/bootstrap/home") { if (homeFails) throw { status: 503 }; return { member: { id: m.token, display_name: "合成会员" }, care, businessVersion: care?.version ?? 0 }; }
    if (options.path === "/v1/me/care") return cycleRead();
    if (options.path === "/v1/me/support/summary") return { unreadCount: 0 };
    throw new Error("Unexpected synthetic route");
  });
  (globalThis as any).getApp = () => ({ globalData: { sessionToken: m.token } });
  (globalThis as any).wx = { showModal: vi.fn(async () => ({ confirm: true })), showToast: vi.fn(), navigateTo: vi.fn(), switchTab: vi.fn(), enableAlertBeforeUnload: vi.fn(), disableAlertBeforeUnload: vi.fn(), stopPullDownRefresh: vi.fn(), pageScrollTo: vi.fn(), nextTick: (fn: () => void) => fn() };
  (globalThis as any).Page = (definition: any) => { page = { ...definition, data: structuredClone(definition.data), setData(patch: any, callback?: () => void) { Object.assign(this.data, patch); callback?.(); } }; };
});
afterEach(() => page?.stopDaypartClock?.());
async function home() { await import("../../apps/miniprogram/pages/home/index"); await page.load(); }
async function records() { await import("../../apps/miniprogram/pages/records/index"); await page.load(); await flush(); }
function complete() { page.openCareSession(); for (let i = 0; i < 4; i++) page.advanceCareStep(); page.selectAssessment({ currentTarget: { dataset: { value: "comfortable" } } }); }
function emptyCardVisible(): boolean {
  const markup = readFileSync("apps/miniprogram/pages/records/index.wxml", "utf8");
  const expression = markup.match(/<view wx:elif="\{\{([^"}]+)\}\}" class="glass records-empty"/)?.[1];
  if (!expression) throw new Error("Records empty-state condition missing");
  return new Function(...Object.keys(page.data), `return Boolean(${expression});`)(...Object.values(page.data));
}

describe("daily care exact DTO and read-only confirmation", () => {
  it.each([
    { id: [record().id] }, { source: "cycle" }, { operationId: "" }, { completedAt: "not-a-time" },
    { timezone: "UTC" }, { protocolVersion: "other" }, { stepCodes: ["00", "02", "01", "03"] }, { stepCodes: ["00", "01", "02"] }, { selfAssessment: "fine" }
  ])("rejects a malformed daily fact %j", async patch => {
    const { validateDailyCareRecord } = await import("../../apps/miniprogram/services/daily-care");
    expect(() => validateDailyCareRecord(record(1, patch))).toThrow("INVALID_DAILY_CARE_RESPONSE");
  });
  it.each([
    { loadedCount: 99 }, { hasMore: true }, { nextCursor: "unused" }, { items: [record(), record()], loadedCount: 2 },
    { items: [], loadedCount: 0, hasMore: true, nextCursor: "next" }
  ])("rejects ambiguous pagination %j", async patch => {
    dailyRead = () => ({ ...pageOf([record()]), ...patch });
    const { readDailyCareRecords } = await import("../../apps/miniprogram/services/daily-care");
    await expect(readDailyCareRecords({})).rejects.toThrow("INVALID_DAILY_CARE_RESPONSE");
  });
  it("rejects a repeating cursor instead of offering endless empty progress", async () => {
    dailyRead = () => pageOf([record()], "same-cursor");
    const { readDailyCareRecords } = await import("../../apps/miniprogram/services/daily-care");
    await expect(readDailyCareRecords({}, "same-cursor")).rejects.toThrow();
  });
  it("requires this command key and full persisted details before confirming a lost response", () => {
    const command = { path, key: "daily-operation-1", token: m.token, data: { stepCodes: steps, selfAssessment: "comfortable" } };
    expect(careCommandConfirmed(command, null, [record() as any])).toBe(true);
    for (const patch of [{ operationId: "other-operation" }, { selfAssessment: "attention" }, { protocolVersion: "care-v1" }, { stepCodes: [["00"], ["01"], ["02"], ["03"]] }]) expect(careCommandConfirmed(command, null, [record(1, patch) as any])).toBe(false);
    expect(careCommandConfirmed(command, null)).toBe(false);
  });
});

describe("Home actual daily write and unknown-result ownership", () => {
  it("persists the four steps and assessment once, then closes and clears transient green steps", async () => {
    await home(); complete(); await page.submitCareSession();
    expect(posts).toHaveLength(1); expect(posts[0]).toMatchObject({ path, method: "POST", idempotencyKey: expect.stringMatching(/^daily-care-/), data: { stepCodes: steps, selfAssessment: "comfortable" } });
    expect(Object.keys(posts[0].data).sort()).toEqual(["selfAssessment", "stepCodes"]);
    expect(page.data).toMatchObject({ care: null, mutationState: "confirmed", sessionMounted: false });
    expect(page.data.view.steps.every((step: any) => !step.done)).toBe(true);
    expect(gets.some(url => url.startsWith(path))).toBe(false);
    expect(wx.showToast).toHaveBeenCalledWith({ title: "护理已保存", icon: "success" });
  });
  it("does not submit incomplete steps or an absent assessment", async () => {
    await home(); page.openCareSession(); page.advanceCareStep(); await page.submitCareSession();
    for (let i = 0; i < 3; i++) page.advanceCareStep(); await page.submitCareSession(); expect(posts).toEqual([]);
  });
  it("freezes duplicate taps and the chosen assessment while sending", async () => {
    const held = deferred(); write = () => held.promise; await home(); complete();
    const saving = page.submitCareSession(); await flush(); await page.submitCareSession();
    page.selectAssessment({ currentTarget: { dataset: { value: "attention" } } }); expect(posts).toHaveLength(1); expect(page.data.sessionAssessment).toBe("comfortable");
    held.resolve({ record: record(1, { operationId: posts[0].idempotencyKey }), replayed: false }); await saving;
  });
  it("keeps an acknowledged save successful even when bootstrap refresh fails", async () => {
    await home(); complete(); write = options => { homeFails = true; return { record: record(1, { operationId: options.idempotencyKey }), replayed: false }; };
    await page.submitCareSession(); expect(posts).toHaveLength(1); expect(page.data).toMatchObject({ mutationState: "confirmed", sessionMounted: false, working: false });
    expect(page.data.error).toContain("护理已保存"); await page.submitCareSession(); await page.primaryAction(); expect(posts).toHaveLength(1);
    homeFails = false; await page.load(); complete(); await page.submitCareSession(); expect(posts).toHaveLength(2); expect(posts[1].idempotencyKey).not.toBe(posts[0].idempotencyKey);
  });
  it("confirms a lost POST response only from this persisted operation without resubmitting", async () => {
    write = options => { dailyRead = () => pageOf([record(1, { operationId: options.idempotencyKey })]); throw { status: 503 }; };
    await home(); complete(); await page.submitCareSession();
    expect(posts).toHaveLength(1); expect(page.data).toMatchObject({ mutationState: "confirmed", sessionMounted: false });
    expect(gets).toContain(path + "?limit=20");
  });
  it("retains an absent/older-than-first-page operation as unknown and only explicitly retries the same payload and key", async () => {
    write = () => { throw { status: 503 }; }; dailyRead = () => pageOf([record(20)], "older-page");
    await home(); complete(); await page.submitCareSession(); expect(page.data.mutationState).toBe("unknown");
    await page.load(true); await page.submitCareSession(); page.selectAssessment({ currentTarget: { dataset: { value: "attention" } } });
    expect(posts).toHaveLength(1); expect(page.data.sessionAssessment).toBe("comfortable"); expect(gets.filter(url => url.startsWith(path)).every(url => url === path + "?limit=20")).toBe(true);
    write = options => ({ record: record(1, { operationId: options.idempotencyKey }), replayed: true });
    await page.retryCareMutation(); expect(posts).toHaveLength(2); expect(posts[1]).toEqual(posts[0]); expect(page.data.sessionMounted).toBe(false);
  });
  it("can explicitly retry an unknown daily operation while bootstrap is unavailable", async () => {
    await home(); complete(); write = () => { throw { status: 503 }; }; await page.submitCareSession(); homeFails = true;
    write = options => ({ record: record(1, { operationId: options.idempotencyKey }), replayed: true });
    await page.retryCareMutation(); expect(posts).toHaveLength(2); expect(posts[1]).toEqual(posts[0]); expect(page.data.sessionMounted).toBe(false);
  });
  it("does not accept a successful envelope bound to another operation", async () => {
    write = () => ({ record: record(), replayed: false }); await home(); complete(); await page.submitCareSession();
    expect(page.data.mutationState).toBe("unknown"); expect(page.data.sessionMounted).toBe(true); expect(wx.showToast).not.toHaveBeenCalled();
  });
  it("cannot apply an old account save or replay its key after switching users", async () => {
    const held = deferred(); write = () => held.promise; await home(); complete(); const saving = page.submitCareSession(); await flush();
    page.onHide(); m.token = "member-b"; page.onShow(); await flush(); held.resolve({ record: record(1, { operationId: posts[0].idempotencyKey }), replayed: false }); await saving; await page.retryCareMutation();
    expect(posts).toHaveLength(1); expect(page.data).toMatchObject({ care: null, sessionMounted: false, mutationState: "idle" }); expect(wx.showToast).not.toHaveBeenCalled();
  });
  it("retains the original command across hide/show and ignores its late acknowledgement", async () => {
    const held = deferred(); write = () => held.promise; await home(); complete(); const saving = page.submitCareSession(); await flush(); page.onHide(); page.onShow(); await flush();
    held.resolve({ record: record(1, { operationId: posts[0].idempotencyKey }), replayed: false }); await saving; expect(page.data.mutationState).toBe("unknown");
    write = options => ({ record: record(1, { operationId: options.idempotencyKey }), replayed: true }); await page.retryCareMutation(); expect(posts[1]).toEqual(posts[0]);
  });
  it("clears all transient step checks after explicitly abandoning an unsaved daily session", async () => {
    await home(); complete(); await page.closeCareSession(); expect(page.data.view.steps.every((step: any) => !step.done)).toBe(true); expect(posts).toEqual([]);
  });
});

describe("Records progressive daily group, paging and identity", () => {
  it("does not render an empty archive while the independent daily request is still pending", async () => {
    const held = deferred(); dailyRead = () => held.promise; await records();
    expect(page.data).toMatchObject({ authorityAvailable: true, care: null, dailyLoading: true }); expect(emptyCardVisible()).toBe(false);
    held.resolve(pageOf()); await flush(); expect(page.data.dailyReady).toBe(true); expect(emptyCardVisible()).toBe(true);
  });
  it("does not render an unknown failed daily archive as empty and recovers after a confirmed empty retry", async () => {
    dailyRead = () => { throw { status: 503 }; }; await records(); expect(page.data.dailyError).toBeTruthy(); expect(emptyCardVisible()).toBe(false);
    dailyRead = () => pageOf(); await page.loadDailyRecords(); expect(page.data.dailyError).toBe(""); expect(emptyCardVisible()).toBe(true);
  });
  it("renders real daily details without a cycle and reuses the record detail sheet", async () => {
    dailyRead = () => pageOf([record()]); await records();
    expect(page.data).toMatchObject({ care: null, dailyReady: true, loadedRecordCount: 1, records: [] });
    page.openRecordDetail({ currentTarget: { dataset: { key: `daily:${record().id}` } } });
    expect(page.data.selectedRecord).toMatchObject({ milestone: "日常", cycleLabel: "日常护理", protocolVersion: "daily-care-v1", assessmentLabel: "舒适轻盈", completedTime: "18:00" });
    expect(page.data.selectedRecord.steps.map((step: any) => step.code)).toEqual(steps);
  });
  it("does not let a failed daily read erase or block the independent cycle", async () => {
    care = { id: "cycle-a", phase: "active", completed: [], records: [] }; dailyRead = () => { throw { status: 503 }; }; await records();
    expect(page.data.care).toEqual(care); expect(page.data).toMatchObject({ authorityAvailable: true, dailyReady: false, accessRequired: false }); expect(page.data.dailyError).toBeTruthy();
  });
  it("merges page overlaps once, prevents duplicate clicks and labels only the loaded record count", async () => {
    dailyRead = () => pageOf([record(1), record(2)], "next-page"); await records(); const held = deferred(); dailyRead = () => held.promise;
    const loading = page.loadDailyRecords(true); void page.loadDailyRecords(true); expect(gets.filter(url => url.includes("cursor="))).toHaveLength(1);
    held.resolve(pageOf([record(2), record(3)])); await loading; expect(page.data.dailyRecords).toHaveLength(3); expect(page.data.loadedRecordCount).toBe(3); expect(page.data.dailyHasMore).toBe(false);
  });
  it("retains loaded pages after a failed append and retries that cursor without a write", async () => {
    dailyRead = () => pageOf([record(1)], "next-page"); await records(); dailyRead = () => { throw { status: 503 }; };
    await page.loadDailyRecords(true); expect(page.data.dailyRecords).toHaveLength(1); expect(page.data.dailyRetryAppend).toBe(true);
    dailyRead = () => pageOf([record(2)]); page.retryDailyRecords(); await flush();
    expect(gets.filter(url => url.includes("cursor="))).toEqual([path + "?limit=20&cursor=next-page", path + "?limit=20&cursor=next-page"]);
    expect(page.data.dailyRecords).toHaveLength(2); expect(posts).toEqual([]);
  });
  it("shows independently loaded daily records even when the cycle service fails", async () => {
    dailyRead = () => pageOf([record()]); cycleRead = () => { throw { status: 503 }; }; await records();
    expect(page.data).toMatchObject({ authorityAvailable: false, dailyReady: true, loadedRecordCount: 1 }); expect(page.data.dailyRecords).toHaveLength(1);
  });
  it("refreshes latest records on pull-down and onShow without merging stale pages", async () => {
    dailyRead = () => pageOf([record(1)], "next-page"); await records(); dailyRead = () => pageOf([record(4)]);
    await page.onPullDownRefresh(); await flush(); expect(page.data.dailyRecords.map((row: any) => row.recordKey)).toEqual([`daily:${record(4).id}`]); expect(wx.stopPullDownRefresh).toHaveBeenCalledOnce();
    page.onHide(); dailyRead = () => pageOf([record(5)]); page.onShow(); await flush(); expect(page.data.dailyRecords[0].recordKey).toBe(`daily:${record(5).id}`);
  });
  it.each(["hidden", "account-changed"])("ignores a late daily page after %s", async state => {
    const held = deferred(); dailyRead = () => held.promise; await records(); if (state === "hidden") page.onHide(); else m.token = "member-b";
    held.resolve(pageOf([record()])); await flush(); expect(page.data.dailyRecords).toEqual([]); expect(page.data.loadedRecordCount).toBe(0);
  });
  it("rejects a daily page from an earlier A to B to A context", async () => {
    const held = deferred(); dailyRead = () => held.promise; await records(); const { invalidateCommerceRecoveryContext } = await import("../../apps/miniprogram/services/commerce-command-store");
    invalidateCommerceRecoveryContext(); invalidateCommerceRecoveryContext(); held.resolve(pageOf([record()])); await flush(); expect(page.data.dailyRecords).toEqual([]);
  });
  it.each(["daily", "cycle"])("does not treat a %s permission403 as a lost session", async kind => {
    if (kind === "daily") dailyRead = () => { throw { status: 403 }; }; else cycleRead = () => { throw { status: 403 }; };
    await records(); expect(page.data.accessRequired).toBe(false); expect(m.authenticate).not.toHaveBeenCalled(); expect(kind === "daily" ? page.data.dailyError : page.data.error).toBeTruthy();
  });
  it("clears both groups after a genuine401 and offers the real return-to-records login path", async () => {
    dailyRead = () => pageOf([record()]); await records(); dailyRead = () => { m.token = ""; throw { status: 401 }; };
    await page.loadDailyRecords(); expect(page.data).toMatchObject({ accessRequired: true, dailyRecords: [], records: [], care: null, loadedRecordCount: 0 });
    page.authenticate(); expect(m.authenticate).toHaveBeenCalledWith("/pages/records/index");
  });
});
