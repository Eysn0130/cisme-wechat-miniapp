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
const serverDay = "2026-10-29";
const record = (n = 1, patch: Record<string, unknown> = {}) => ({ id: `11111111-1111-4111-8111-${String(n).padStart(12, "0")}`, source: "daily", operationId: `daily-operation-${n}`, careDay: `2026-10-${String(30 - n).padStart(2, "0")}`, version: 1, deleted: false, updatedAt: "2026-10-29T10:00:00.000Z", completedAt: "2026-10-29T10:00:00.000Z", timezone: "Asia/Shanghai", protocolVersion: "daily-care-v1", stepCodes: [...steps], selfAssessment: "comfortable", ...patch });
const pageOf = (items: any[] = [], nextCursor: string | null = null) => ({ items, loadedCount: items.length, hasMore: nextCursor !== null, nextCursor, serverDay, today: items.find(item => item.careDay === serverDay) ?? null, totalCount: items.length });
let page: any, care: any, posts: any[], gets: string[], dailyRead: (options: any) => any, write: (options: any) => any, homeFails: boolean, cycleRead: () => any;
beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks(); m.token = "member-a"; care = null; homeFails = false; posts = []; gets = [];
  dailyRead = () => pageOf(); cycleRead = () => care;
  write = options => ({ record: record(1, { operationId: options.idempotencyKey, ...options.data }), replayed: false, current: true });
  m.request.mockImplementation(async (options: any) => {
    if (options.method && options.method !== "GET") { posts.push(structuredClone(options)); return write(options); }
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
async function home() { await import("../../apps/miniprogram/pages/home/index"); await page.load(); await flush(); }
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
    expect(Object.keys(posts[0].data).sort()).toEqual(["careDay", "selfAssessment", "stepCodes"]);
    expect(posts[0].data.careDay).toBe(serverDay);
    expect(page.data).toMatchObject({ care: null, mutationState: "confirmed", sessionMounted: false });
    expect(page.data.view.steps.every((step: any) => !step.done)).toBe(true);
    expect(gets).toContain(path + "?limit=20");
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
    held.resolve({ record: record(1, { operationId: posts[0].idempotencyKey }), replayed: false, current: true }); await saving;
  });
  it("keeps an acknowledged save successful even when bootstrap refresh fails", async () => {
    await home(); complete(); write = options => { homeFails = true; return { record: record(1, { operationId: options.idempotencyKey }), replayed: false, current: true }; };
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
    write = options => ({ record: record(1, { operationId: options.idempotencyKey }), replayed: true, current: true });
    await page.retryCareMutation(); expect(posts).toHaveLength(2); expect(posts[1]).toEqual(posts[0]); expect(page.data.sessionMounted).toBe(false);
  });
  it("can explicitly retry an unknown daily operation while bootstrap is unavailable", async () => {
    await home(); complete(); write = () => { throw { status: 503 }; }; await page.submitCareSession(); homeFails = true;
    write = options => ({ record: record(1, { operationId: options.idempotencyKey }), replayed: true, current: true });
    await page.retryCareMutation(); expect(posts).toHaveLength(2); expect(posts[1]).toEqual(posts[0]); expect(page.data.sessionMounted).toBe(false);
  });
  it("does not accept a successful envelope bound to another operation", async () => {
    write = () => ({ record: record(), replayed: false, current: true }); await home(); complete(); await page.submitCareSession();
    expect(page.data.mutationState).toBe("unknown"); expect(page.data.sessionMounted).toBe(true); expect(wx.showToast).not.toHaveBeenCalled();
  });
  it("cannot apply an old account save or replay its key after switching users", async () => {
    const held = deferred(); write = () => held.promise; await home(); complete(); const saving = page.submitCareSession(); await flush();
    page.onHide(); m.token = "member-b"; page.onShow(); await flush(); held.resolve({ record: record(1, { operationId: posts[0].idempotencyKey }), replayed: false, current: true }); await saving; await page.retryCareMutation();
    expect(posts).toHaveLength(1); expect(page.data).toMatchObject({ care: null, sessionMounted: false, mutationState: "idle" }); expect(wx.showToast).not.toHaveBeenCalled();
  });
  it("retains the original command across hide/show and ignores its late acknowledgement", async () => {
    const held = deferred(); write = () => held.promise; await home(); complete(); const saving = page.submitCareSession(); await flush(); page.onHide(); page.onShow(); await flush();
    held.resolve({ record: record(1, { operationId: posts[0].idempotencyKey }), replayed: false, current: true }); await saving; expect(page.data.mutationState).toBe("unknown");
    write = options => ({ record: record(1, { operationId: options.idempotencyKey }), replayed: true, current: true }); await page.retryCareMutation(); expect(posts[1]).toEqual(posts[0]);
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

describe("Home server-day create and explicit same-day adjustment", () => {
  it("reads the server's day before opening an unrecorded daily session", async () => {
    const held = deferred(); dailyRead = () => held.promise; await home();
    page.openCareSession(); expect(page.data.sessionMounted).toBe(false); await page.primaryAction();
    expect(posts).toEqual([]); held.resolve(pageOf()); await flush();
    page.openCareSession(); expect(page.data.sessionMounted).toBe(true);
  });
  it("updates the same live id and version after repeating all four steps", async () => {
    dailyRead = () => pageOf([record()]); await home(); expect(page.data.view.action).toBe("调整今日记录");
    complete(); write = options => {
      const updated = record(1, { version: 2, operationId: options.idempotencyKey, selfAssessment: options.data.selfAssessment });
      dailyRead = () => pageOf([updated]); return { record: updated, replayed: false, current: true };
    };
    await page.submitCareSession(); await flush();
    expect(posts).toHaveLength(1); expect(posts[0]).toMatchObject({ path: `${path}/${record().id}`, method: "PUT", data: { careDay: serverDay, expectedVersion: 1, stepCodes: steps, selfAssessment: "comfortable" } });
    expect(page.data.dailyToday).toMatchObject({ id: record().id, version: 2 }); expect(page.data.view.action).toBe("调整今日记录");
  });
  it("retains an unknown PUT's exact method, key and original version for explicit retry", async () => {
    dailyRead = () => pageOf([record()]); await home(); complete(); write = () => { throw { status: 503 }; };
    await page.submitCareSession(); expect(page.data.mutationState).toBe("unknown");
    write = options => ({ record: record(1, { version: 2, operationId: options.idempotencyKey }), replayed: true, current: false });
    await page.retryCareMutation(); expect(posts).toHaveLength(2); expect(posts[1]).toEqual(posts[0]); expect(page.data.sessionMounted).toBe(false);
  });
  it("keeps a historical successful reply from replacing a newer daily snapshot", async () => {
    dailyRead = () => pageOf([record()]); await home(); complete();
    write = options => { dailyRead = () => pageOf([record(1, { version: 3, operationId: "another-later-operation", selfAssessment: "attention" })]); return { record: record(1, { version: 2, operationId: options.idempotencyKey }), replayed: true, current: false }; };
    await page.submitCareSession(); await flush(); expect(page.data.dailyToday).toMatchObject({ version: 3, selfAssessment: "attention" }); expect(posts).toHaveLength(1);
  });
  it("refreshes a rollover409 without changing the submitted day or automatically replaying", async () => {
    await home(); complete(); write = () => { dailyRead = () => ({ ...pageOf(), serverDay: "2026-10-30" }); throw { status: 409, code: "DAILY_CARE_DAY_CHANGED" }; };
    await page.submitCareSession(); await flush(); expect(posts).toHaveLength(1); expect(posts[0].data.careDay).toBe(serverDay);
    expect(page.data.serverDay).toBe("2026-10-30"); expect(page.data.error).toContain("日期已更新");
    await page.retryCareMutation(); expect(posts).toHaveLength(1);
  });
  it("cannot let an older read restore another session's daily state after an A-B-A revision", async () => {
    const held = deferred(); dailyRead = () => held.promise; await home();
    const { invalidateCommerceRecoveryContext } = await import("../../apps/miniprogram/services/commerce-command-store"); invalidateCommerceRecoveryContext(); invalidateCommerceRecoveryContext();
    held.resolve(pageOf([record()])); await flush(); expect(page.data.dailyReady).toBe(false);
  });
});

function rowEvent(n = 1, x = 200, y = 300): any { return { currentTarget: { dataset: { key: `daily:${record(n).id}` } }, touches: [{ clientX: x, clientY: y }] }; }
function rowEnd(n = 1, x = 200, y = 300): any { return { currentTarget: { dataset: { key: `daily:${record(n).id}` } }, touches: [], changedTouches: [{ clientX: x, clientY: y }] }; }
function installDeleteWrite() {
  write = options => {
    const deleted = options.method === "DELETE";
    const result = record(1, { version: options.data.expectedVersion + 1, operationId: options.idempotencyKey, deleted });
    dailyRead = () => pageOf(deleted ? [] : [result]); return { record: result, replayed: false, current: true };
  };
}
describe("Records swipe, accessible confirmed deletion and reversible writes", () => {
  beforeEach(() => { dailyRead = () => pageOf([record()]); });
  it("opens only one left action, closes on a right swipe, and does not open detail on swipe release", async () => {
    dailyRead = () => pageOf([record(1), record(2)]); await records();
    page.dailyTouchStart(rowEvent()); page.dailyTouchMove(rowEvent(1, 120, 301)); page.dailyTouchEnd();
    expect(page.data.openDailyKey).toBe(`daily:${record().id}`); expect(page.data.dailyRecords[0].swipeStyle).toContain("-72px");
    page.openRecordDetail(rowEvent()); expect(page.data.recordDetailMounted).toBe(false);
    page.dailyTouchStart(rowEvent(2)); page.dailyTouchMove(rowEvent(2, 120, 301)); page.dailyTouchEnd();
    expect(page.data.openDailyKey).toBe(`daily:${record(2).id}`); expect(page.data.dailyRecords[0].swipeStyle).toContain("0px");
    page.dailyTouchStart(rowEvent(2)); page.dailyTouchMove(rowEvent(2, 280, 301)); page.dailyTouchEnd(); expect(page.data.openDailyKey).toBe("");
    page.dailyTouchStart(rowEvent(2)); page.dailyTouchEnd(); page.openRecordDetail(rowEvent(2)); expect(page.data.selectedRecord.recordKey).toBe(`daily:${record(2).id}`);
  });
  it("lets vertical intent stay vertical and cancels half-open drags on cancel, scroll and hide", async () => {
    await records(); page.dailyTouchStart(rowEvent()); page.dailyTouchMove(rowEvent(1, 196, 340)); page.dailyTouchEnd(); expect(page.data.openDailyKey).toBe("");
    for (const stop of [() => page.dailyTouchCancel(), () => page.onPageScroll({ scrollTop: 20 }), () => page.onHide()]) {
      page.data.visible = true; page.dailyTouchStart(rowEvent()); page.dailyTouchMove(rowEvent(1, 120, 300)); stop(); expect(page.data.openDailyKey).toBe("");
    }
    expect(posts).toEqual([]);
  });
  it("does not delete on a canceled or failed confirmation and keeps the row", async () => {
    await records(); (wx.showModal as any).mockResolvedValueOnce({ confirm: false }); await page.deleteDailyRecord(rowEvent());
    (wx.showModal as any).mockRejectedValueOnce(new Error("synthetic modal unavailable")); await page.deleteDailyRecord(rowEvent());
    expect(posts).toEqual([]); expect(page.data.dailyRecords).toHaveLength(1); expect(page.data.confirmingDailyDelete).toBe(false);
  });
  it("supports detail-button deletion without any swipe, then restores the same id by version", async () => {
    await records(); page.openRecordDetail(rowEvent()); installDeleteWrite(); await page.deleteDailyRecord(); await flush();
    expect(posts[0]).toMatchObject({ method: "DELETE", path: `${path}/${record().id}`, data: { expectedVersion: 1 } });
    expect(page.data).toMatchObject({ loadedRecordCount: 0, recordDetailMounted: false, undoAvailable: true }); expect(page.data.dailyRecords).toEqual([]);
    await page.undoDailyDelete(); await flush(); expect(posts[1]).toMatchObject({ method: "POST", path: `${path}/${record().id}/restore`, data: { expectedVersion: 2 } });
    expect(page.data).toMatchObject({ loadedRecordCount: 1, undoAvailable: false }); expect(page.data.dailyRecords[0].dailyRecord.version).toBe(3);
  });
  it("refuses a stale confirmation after the row is updated while the modal is open", async () => {
    await records(); const held = deferred(); (wx.showModal as any).mockReturnValueOnce(held.promise); const confirming = page.deleteDailyRecord(rowEvent());
    dailyRead = () => pageOf([record(1, { version: 2 })]); await page.loadDailyRecords(); held.resolve({ confirm: true }); await confirming;
    expect(posts).toEqual([]); expect(page.data.dailyMutationError).toContain("记录已更新");
  });
  it("keeps an unknown DELETE visible and retries exactly the same key without a new confirmation", async () => {
    await records(); write = () => { throw { status: 503 }; }; await page.deleteDailyRecord(rowEvent());
    expect(page.data).toMatchObject({ dailyMutationState: "unknown", loadedRecordCount: 1 });
    await page.deleteDailyRecord(rowEvent()); expect(posts).toHaveLength(1); installDeleteWrite(); await page.retryDailyMutation(); await flush();
    expect(posts).toHaveLength(2); expect(posts[1]).toEqual(posts[0]); expect(wx.showModal).toHaveBeenCalledTimes(1); expect(page.data.loadedRecordCount).toBe(0);
  });
  it("does not call a historical delete snapshot the current deletion or hide a subsequently restored row", async () => {
    await records(); write = options => ({ record: record(1, { version: 2, operationId: options.idempotencyKey, deleted: true }), replayed: true, current: false });
    await page.deleteDailyRecord(rowEvent()); await flush(); expect(page.data.loadedRecordCount).toBe(1); expect(page.data.undoAvailable).toBe(false);
    expect(wx.showToast).toHaveBeenCalledWith({ title: "操作已核对", icon: "success" });
  });
  it("does not let an older in-flight GET resurrect an acknowledged deletion", async () => {
    await records(); const held = deferred(); dailyRead = () => held.promise; const oldRead = page.loadDailyRecords(); installDeleteWrite();
    await page.deleteDailyRecord(rowEvent()); await flush(); held.resolve(pageOf([record()])); await oldRead;
    expect(page.data.dailyRecords).toEqual([]); expect(page.data.loadedRecordCount).toBe(0);
  });
  it("does not mutate hidden UI on a late ack and applies the known result on return", async () => {
    await records(); const held = deferred(); write = () => held.promise; const saving = page.deleteDailyRecord(rowEvent()); await flush(); page.onHide();
    dailyRead = () => pageOf(); held.resolve({ record: record(1, { version: 2, operationId: posts[0].idempotencyKey, deleted: true }), replayed: false, current: true }); await saving;
    expect(page.data.loadedRecordCount).toBe(1); page.onShow(); await flush(); expect(page.data).toMatchObject({ loadedRecordCount: 0, undoAvailable: true });
  });
  it("does not let an old actor's acknowledgement remove another actor's row", async () => {
    await records(); const held = deferred(); write = () => held.promise; const saving = page.deleteDailyRecord(rowEvent()); await flush();
    m.token = "member-b"; dailyRead = () => pageOf([record(2)]); page.onShow(); await flush();
    held.resolve({ record: record(1, { version: 2, operationId: posts[0].idempotencyKey, deleted: true }), replayed: false, current: true }); await saving;
    expect(page.data.dailyRecords.map((row: any) => row.recordKey)).toEqual([`daily:${record(2).id}`]); expect(page.data.undoAvailable).toBe(false);
  });
  it("keeps an unknown restore bound to its original key and does not overwrite a newly created day's record", async () => {
    await records(); installDeleteWrite(); await page.deleteDailyRecord(rowEvent()); await flush(); write = () => { throw { status: 503 }; };
    await page.undoDailyDelete(); expect(page.data.dailyMutationState).toBe("unknown"); const restore = posts[1];
    dailyRead = () => pageOf([record(2, { careDay: serverDay })]); write = () => { throw { status: 409, code: "DAILY_CARE_DAY_EXISTS" }; };
    await page.retryDailyMutation(); await flush(); expect(posts[2]).toEqual(restore); expect(page.data.undoAvailable).toBe(false);
    expect(page.data.dailyRecords[0].recordKey).toBe(`daily:${record(2).id}`);
  });
});

describe("Records swipe terminal samples and read reconciliation", () => {
  beforeEach(() => { dailyRead = () => pageOf([record()]); });
  it("uses the real end point even when native dispatches no touchmove and suppresses its tap", async () => {
    await records(); page.dailyTouchStart(rowEvent(1, 300, 300)); page.dailyTouchEnd(rowEnd(1, 40, 305));
    expect(page.data.openDailyKey).toBe(`daily:${record().id}`);
    expect(page.data.dailyRecords[0].swipeStyle).toBe("transform:translateX(-72px);");
    page.openRecordDetail(rowEnd(1, 40, 305)); expect(page.data.recordDetailMounted).toBe(false);
    expect(page.data.openDailyKey).toBe(`daily:${record().id}`); expect(posts).toEqual([]);
  });
  it("uses a farther final sample rather than snapping a30px cached move shut", async () => {
    await records(); page.dailyTouchStart(rowEvent(1, 300, 300)); page.dailyTouchMove(rowEvent(1, 270, 301));
    page.dailyTouchEnd(rowEnd(1, 100, 303));
    expect(page.data.openDailyKey).toBe(`daily:${record().id}`); expect(page.data.dailyRecords[0].swipeStyle).toContain("-72px");
  });
  it("does not let a queued move or duplicate end change an already settled swipe", async () => {
    await records(); page.dailyTouchStart(rowEvent(1, 300, 300)); page.dailyTouchEnd(rowEnd(1, 100, 301));
    page.dailyTouchMove(rowEvent(1, 285, 301)); page.dailyTouchEnd(rowEnd(1, 300, 300));
    expect(page.data.openDailyKey).toBe(`daily:${record().id}`);
    expect(page.data.dailyRecords[0].swipeStyle).toBe("transform:translateX(-72px);"); expect(page.data.draggingDailyKey).toBe("");
    expect(posts).toEqual([]);
  });
  it("keeps a short horizontal end closed but does not mistake it for a row tap", async () => {
    await records(); page.dailyTouchStart(rowEvent(1, 300, 300)); page.dailyTouchEnd(rowEnd(1, 280, 301));
    expect(page.data.openDailyKey).toBe(""); page.openRecordDetail(rowEnd(1, 280, 301));
    expect(page.data.recordDetailMounted).toBe(false); expect(posts).toEqual([]);
  });
  it("honors end-only vertical intent and a later deliberate right swipe", async () => {
    await records(); page.dailyTouchStart(rowEvent(1, 300, 300)); page.dailyTouchEnd(rowEnd(1, 296, 360));
    page.openRecordDetail(rowEnd(1, 296, 360)); expect(page.data.recordDetailMounted).toBe(false);
    page.dailyTouchStart(rowEvent(1, 300, 300)); page.dailyTouchEnd(rowEnd(1, 100, 301));
    expect(page.data.openDailyKey).toBe(`daily:${record().id}`);
    page.dailyTouchStart(rowEvent(1, 100, 300)); page.dailyTouchEnd(rowEnd(1, 220, 301));
    expect(page.data.openDailyKey).toBe("");
  });
  it.each(["cancel", "multiple-touches"])("a %s terminates the gesture so its late end cannot reopen", async stop => {
    await records(); page.dailyTouchStart(rowEvent(1, 300, 300)); page.dailyTouchMove(rowEvent(1, 100, 301));
    if (stop === "cancel") page.dailyTouchCancel();
    else { const multiple = rowEvent(1, 100, 301); multiple.touches.push({ clientX: 110, clientY: 301 }); page.dailyTouchMove(multiple); }
    expect(page.data.openDailyKey).toBe(""); page.dailyTouchEnd(rowEnd(1, 80, 301));
    expect(page.data.openDailyKey).toBe(""); page.openRecordDetail(rowEnd(1, 80, 301)); expect(page.data.recordDetailMounted).toBe(false);
    expect(posts).toEqual([]);
  });
  it("does not complete the old gesture using a different finger identifier", async () => {
    await records(); const start = rowEvent(1, 300, 300); start.touches[0].identifier = 7; page.dailyTouchStart(start);
    const moved = rowEvent(1, 100, 301); moved.touches[0].identifier = 7; page.dailyTouchMove(moved);
    const end = rowEnd(1, 80, 301); end.changedTouches[0].identifier = 8; page.dailyTouchEnd(end);
    expect(page.data.openDailyKey).toBe("");
  });
  it.each([false, true])("same-version read preserves the current %s drag/open state", async dragging => {
    await records(); const held = deferred(); dailyRead = () => held.promise; const reading = page.loadDailyRecords();
    page.dailyTouchStart(rowEvent(1, 300, 300)); page.dailyTouchMove(rowEvent(1, dragging ? 270 : 100, 301));
    if (!dragging) page.dailyTouchEnd(rowEnd(1, 100, 301));
    const expectedStyle = page.data.dailyRecords[0].swipeStyle;
    held.resolve(pageOf([record()])); await reading;
    expect(page.data.openDailyKey).toBe(`daily:${record().id}`); expect(page.data.dailyRecords[0].swipeStyle).toBe(expectedStyle);
    expect(page.data.draggingDailyKey).toBe(dragging ? `daily:${record().id}` : "");
    page.dailyTouchEnd(rowEnd(1, 80, 301)); expect(page.data.openDailyKey).toBe(`daily:${record().id}`); expect(posts).toEqual([]);
  });
  it.each(["changed", "removed"])("a %s row closes and invalidates the old gesture after refresh", async change => {
    await records(); const held = deferred(); dailyRead = () => held.promise; const reading = page.loadDailyRecords();
    page.dailyTouchStart(rowEvent(1, 300, 300)); page.dailyTouchMove(rowEvent(1, 100, 301));
    held.resolve(pageOf(change === "changed" ? [record(1, { version: 2 })] : [])); await reading;
    expect(page.data.openDailyKey).toBe(""); expect(page.data.draggingDailyKey).toBe("");
    page.dailyTouchEnd(rowEnd(1, 80, 301)); expect(page.data.openDailyKey).toBe("");
    page.openRecordDetail(rowEnd(1, 80, 301)); expect(page.data.recordDetailMounted).toBe(false); expect(posts).toEqual([]);
  });
  it("ignores equal-offset and tiny horizontal-tail scroll callbacks but closes for real vertical movement", async () => {
    await records(); page.dailyTouchStart(rowEvent(1, 300, 300)); page.dailyTouchMove(rowEvent(1, 100, 301));
    page.dailyTouchEnd(rowEnd(1, 100, 301)); page.onPageScroll(); page.onPageScroll({}); page.onPageScroll({ scrollTop: 0 });
    expect(page.data.openDailyKey).toBe(`daily:${record().id}`); page.onPageScroll({ scrollTop: 2 });
    expect(page.data.openDailyKey).toBe(`daily:${record().id}`); page.onPageScroll({ scrollTop: 30 });
    expect(page.data.openDailyKey).toBe(""); page.dailyTouchEnd(rowEnd(1, 80, 301)); expect(page.data.openDailyKey).toBe("");
    expect(posts).toEqual([]);
  });
  it("suppresses a delayed tap from the completed drag but permits the next actual touch", async () => {
    await records(); const clock = vi.spyOn(Date, "now").mockReturnValue(1000);
    try {
      page.dailyTouchStart(rowEvent(1, 300, 300)); page.dailyTouchMove(rowEvent(1, 100, 301)); page.dailyTouchEnd(rowEnd(1, 100, 301));
      clock.mockReturnValue(1600); page.openRecordDetail(rowEnd(1, 100, 301));
      expect(page.data.openDailyKey).toBe(`daily:${record().id}`); expect(page.data.recordDetailMounted).toBe(false);
      page.dailyTouchStart(rowEvent(1, 200, 300)); page.dailyTouchEnd(rowEnd(1, 200, 300)); page.openRecordDetail(rowEnd(1, 200, 300));
      expect(page.data.openDailyKey).toBe("");
      page.dailyTouchStart(rowEvent(1, 200, 300)); page.dailyTouchEnd(rowEnd(1, 200, 300)); page.openRecordDetail(rowEnd(1, 200, 300));
      expect(page.data.recordDetailMounted).toBe(true);
    } finally { clock.mockRestore(); }
  });
});

describe("Daily new DTO and mutation/read ordering", () => {
 it.each([{serverDay:"2026-02-30"},{serverDay:null},{totalCount:-1},{totalCount:0},{today:record(2)},{today:null},{items:[record(1,{version:0})],today:record(1,{version:0})},{items:[record(1,{deleted:true})],today:record(1,{deleted:true})}])("rejects inconsistent server day or canonical day metadata %j",async(patch)=>{
  dailyRead=()=>({...pageOf([record()]),...patch});const {readDailyCareRecords}=await import("../../apps/miniprogram/services/daily-care");await expect(readDailyCareRecords({})).rejects.toThrow("INVALID_DAILY_CARE_RESPONSE");
 });
 it("invalidates a read begun during the DELETE before settling its acknowledgement",async()=>{
  dailyRead=()=>pageOf([record()]);await records();const writing=deferred();write=()=>writing.promise;const deletion=page.deleteDailyRecord(rowEvent());await flush();
  const stale=deferred();dailyRead=()=>stale.promise;const reading=page.loadDailyRecords();dailyRead=()=>pageOf();
  writing.resolve({record:record(1,{version:2,operationId:posts[0].idempotencyKey,deleted:true}),replayed:false,current:true});await deletion;await flush();stale.resolve(pageOf([record()]));await reading;
  expect(page.data.dailyRecords).toEqual([]);expect(page.data.loadedRecordCount).toBe(0);
 });
 it("does not hide a newer locally read version when an earlier delete acknowledgement arrives late",async()=>{
  dailyRead=()=>pageOf([record()]);await records();const writing=deferred();write=()=>writing.promise;const deletion=page.deleteDailyRecord(rowEvent());await flush();
  dailyRead=()=>pageOf([record(1,{version:3,operationId:"later-restored-operation"})]);await page.loadDailyRecords();
  writing.resolve({record:record(1,{version:2,operationId:posts[0].idempotencyKey,deleted:true}),replayed:false,current:true});await deletion;await flush();
  expect(page.data.dailyRecords[0].dailyRecord.version).toBe(3);expect(page.data.undoAvailable).toBe(false);expect(wx.showToast).toHaveBeenCalledWith({title:"操作已核对",icon:"success"});
 });
 it("clears private rows after an actual lost-session delete response and never offers the old undo",async()=>{
  dailyRead=()=>pageOf([record()]);await records();write=()=>{m.token="";throw {status:401};};await page.deleteDailyRecord(rowEvent());expect(page.data).toMatchObject({accessRequired:true,dailyRecords:[],loadedRecordCount:0,undoAvailable:false});
 });
 it("does not reopen a swipe from late gesture events after hide or account change",async()=>{
  dailyRead=()=>pageOf([record()]);await records();page.dailyTouchStart(rowEvent());page.dailyTouchMove(rowEvent(1,120,300));page.onHide();page.dailyTouchEnd(rowEnd());expect(page.data.openDailyKey).toBe("");
  page.data.visible=true;page.dailyTouchStart(rowEvent());m.token="member-b";page.dailyTouchMove(rowEvent(1,120,300));page.dailyTouchEnd(rowEnd());expect(page.data.openDailyKey).toBe("");
 });
});

describe("Records delete confirmation lifecycle owner", () => {
 beforeEach(() => { dailyRead=()=>pageOf([record()]); });
 it("ignores an old delete confirmation after hide and same-actor fresh return", async () => {
  await records();const modal=deferred();(wx.showModal as any).mockReturnValueOnce(modal.promise);
  const old=page.deleteDailyRecord(rowEvent());expect(page.data.confirmingDailyDelete).toBe(true);
  page.onHide();page.onShow();await flush();modal.resolve({confirm:true});await old;
  expect(posts).toEqual([]);expect(page.data.dailyRecords).toHaveLength(1);expect(page.data.confirmingDailyDelete).toBe(false);
 });
 it("does not let the old modal finally release a newer confirmation's owner", async () => {
  await records();const oldModal=deferred(),newModal=deferred();(wx.showModal as any).mockReturnValueOnce(oldModal.promise).mockReturnValueOnce(newModal.promise);
  const old=page.deleteDailyRecord(rowEvent());page.onHide();page.onShow();await flush();
  const newer=page.deleteDailyRecord(rowEvent());expect(page.data.confirmingDailyDelete).toBe(true);
  oldModal.resolve({confirm:true});await old;expect(posts).toEqual([]);expect(page.data.confirmingDailyDelete).toBe(true);
  await page.deleteDailyRecord(rowEvent());expect(wx.showModal).toHaveBeenCalledTimes(2);
  newModal.resolve({confirm:false});await newer;expect(posts).toEqual([]);expect(page.data.confirmingDailyDelete).toBe(false);
 });
 it("cancels a confirmation on explicit refresh and still permits a new confirmation", async () => {
  await records();const modal=deferred();(wx.showModal as any).mockReturnValueOnce(modal.promise);
  const old=page.deleteDailyRecord(rowEvent());await page.load(true);await flush();expect(page.data.confirmingDailyDelete).toBe(false);
  modal.resolve({confirm:true});await old;expect(posts).toEqual([]);
  (wx.showModal as any).mockResolvedValueOnce({confirm:false});await page.deleteDailyRecord(rowEvent());expect(wx.showModal).toHaveBeenCalledTimes(2);expect(page.data.confirmingDailyDelete).toBe(false);
 });
});

describe("Records swipe reveals a deletion choice without committing it", () => {
 it("clamps a full swipe to the action area, waits for a button tap and confirmation, and preserves cancel", async () => {
  dailyRead=()=>pageOf([record()]);await records();
  page.dailyTouchStart(rowEvent(1,300,300));page.dailyTouchMove(rowEvent(1,-900,301));page.dailyTouchEnd(rowEnd(1,-900,301));
  expect(page.data.openDailyKey).toBe(`daily:${record().id}`);expect(page.data.dailyRecords[0].swipeStyle).toBe("transform:translateX(-72px);");
  expect(wx.showModal).not.toHaveBeenCalled();expect(posts).toEqual([]);
  const modal=deferred();(wx.showModal as any).mockReturnValueOnce(modal.promise);const choosing=page.deleteDailyRecord(rowEvent());
  expect(wx.showModal).toHaveBeenCalledTimes(1);expect(posts).toEqual([]);expect(page.data.openDailyKey).toBe("");
  modal.resolve({confirm:false});await choosing;expect(posts).toEqual([]);expect(page.data.dailyRecords).toHaveLength(1);
  installDeleteWrite();await page.deleteDailyRecord(rowEvent());await flush();expect(posts).toHaveLength(1);expect(posts[0].method).toBe("DELETE");expect(page.data.dailyRecords).toEqual([]);
 });
});
