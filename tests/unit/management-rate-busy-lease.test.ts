import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ token: "synthetic-session-a", revision: 1, request: vi.fn(), read: vi.fn() }));
vi.mock("../../apps/miniprogram/services/api", () => ({ request: state.request }));
vi.mock("../../apps/miniprogram/services/page-requests", () => ({ pageRead: state.read, cancelPageReads: vi.fn() }));
vi.mock("../../apps/miniprogram/services/commerce-command-store", () => ({ commerceContextRevision: () => state.revision }));
vi.mock("../../apps/miniprogram/services/authority", () => ({ authorityProjection: vi.fn(), hasCapability: vi.fn(), requireCapability: vi.fn() }));
vi.mock("../../apps/miniprogram/services/layout", () => ({ currentChromeStyle: () => "" }));

let page: any;
const deferred = () => {
  let resolve!: (value: unknown) => void, reject!: (error: unknown) => void;
  return { promise: new Promise((yes, no) => { resolve = yes; reject = no; }), resolve, reject };
};
const variants = [
  { name: "member", command: "rateCommand", busy: "busy", send: "sendRateCommand", visible: "rateFormVisible", error: "actionError", open: "openRateForm" },
  { name: "global", command: "globalRateCommand", busy: "globalRateBusy", send: "sendGlobalRateCommand", visible: "globalRateFormVisible", error: "globalRateError", open: "openGlobalRateForm" }
] as const;
beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks(); state.token = "synthetic-session-a"; state.revision = 1;
  state.request.mockResolvedValue({ id: "synthetic-rate-proposal" }); state.read.mockResolvedValue({ id: "synthetic-rate-proposal" });
  (globalThis as any).getApp = () => ({ globalData: { sessionToken: state.token } });
  (globalThis as any).wx = { showToast: vi.fn(), showModal:vi.fn().mockResolvedValue({confirm:true}) };
  (globalThis as any).Page = (definition: any) => {
    page = { ...definition, data: structuredClone(definition.data), patches: [] as any[], setData(patch: any) { this.patches.push(patch); Object.assign(this.data, patch); } };
  };
});

for (const variant of variants) describe(`${variant.name} rate command busy lease`, () => {
  async function load() {
    if (variant.name === "member") await import("../../apps/miniprogram/pages/management-member/index");
    else await import("../../apps/miniprogram/pages/management-members/index");
    Object.assign(page.data, { alive: true, attempt: 1, canManageRate: true, [variant.visible]: true,
      detail: { member: { id: "synthetic-member", version: 1 }, membershipPolicy: { kind: "operator_explicit", rateProposalSuggestedAt: "2026-11-01T00:00:00Z" }, rate: { basisPoints: 100 } },
      globalRate: { policyKind: "approved_rule", suggestedEffectiveAt: "2026-11-01T00:00:00Z", basisPoints: 100 } });
    page.lastRevision = state.revision;
    page[variant.command] = { key: "synthetic-original-key", memberId: "synthetic-member", action: "inherit", basisPoints: 100, effectiveAt: "2026-11-01T00:00:00Z", reason: "合成复核依据" };
    return page[variant.command];
  }
  it('submits the operator-entered business time as Beijing time, including on a western device',async()=>{
    await load();page[variant.command]=null;page[variant.send]=vi.fn();
    const form={mode:'override',percent:'25.00',date:'2026-11-12',time:'00:30',reason:'合成另一人复核依据'};
    const global=variant.name==='global';page.data[global?'globalRateForm':'rateForm']=form;
    await page[global?'submitGlobalRateForm':'submitRateForm']();
    expect(page[variant.command]).toMatchObject({effectiveAt:'2026-11-11T16:30:00.000Z',basisPoints:2500});
    expect((wx.showModal as any).mock.calls[0][0].content).toContain('北京时间');
  });
  it('rejects a calendar-normalized invalid date before confirmation or transmission',async()=>{
    await load();page[variant.command]=null;page[variant.send]=vi.fn();
    const global=variant.name==='global';page.data[global?'globalRateForm':'rateForm']={mode:'override',percent:'25.00',date:'2026-02-29',time:'00:30',reason:'合成日期校验依据'};
    await page[global?'submitGlobalRateForm':'submitRateForm']();expect(wx.showModal).not.toHaveBeenCalled();expect(page[variant.command]).toBeNull();
  });
  it("releases busy in the acknowledged commit and permits another form", async () => {
    await load(); await page[variant.send]();
    expect(page[variant.command]).toBeNull(); expect(page.data[variant.busy]).toBe(false);
    expect(page.patches).toContainEqual(expect.objectContaining({ [variant.busy]: false, [variant.visible]: false }));
    page[variant.open](); expect(page.data[variant.visible]).toBe(true);
    expect(state.request).toHaveBeenCalledTimes(1);
  });
  it("also releases busy when by-request lookup confirms the original write", async () => {
    await load(); state.request.mockImplementation(async (options: { method?: string }) => {
      if (options.method === "POST") throw new Error("synthetic transport interrupted");
      return { id: "synthetic-rate-proposal" };
    });
    await page[variant.send]();
    expect(page[variant.command]).toBeNull(); expect(page.data[variant.busy]).toBe(false); expect(page.data[variant.visible]).toBe(false);
    const posts = state.request.mock.calls.filter(([options]) => options.method === "POST");
    expect(posts).toHaveLength(1); expect(posts[0]![0].idempotencyKey).toBe("synthetic-original-key");
  });
  it("keeps the exact command on unknown outcome and retries the same key", async () => {
    const command = await load(); state.request.mockRejectedValue(new Error("synthetic unavailable")); state.read.mockRejectedValue(new Error("synthetic unavailable"));
    await page[variant.send](); expect(page[variant.command]).toBe(command); expect(page.data[variant.busy]).toBe(false); expect(page.data[variant.error]).toBeTruthy();
    state.request.mockResolvedValue({ id: "synthetic-rate-proposal" }); await page[variant.send]();
    const posts = state.request.mock.calls.filter(([options]) => options.method === "POST");
    expect(posts).toHaveLength(2); expect(posts.map(([options]) => options.idempotencyKey)).toEqual([command.key, command.key]);
    expect(page[variant.command]).toBeNull(); expect(page.data[variant.busy]).toBe(false);
  });
  it.each(["resolve", "reject"] as const)("does not let an old %s or finally release a newer command", async outcome => {
    await load(); const pending = deferred(); state.request.mockReturnValue(pending.promise);
    const sending = page[variant.send](); const newer = { ...page[variant.command], key: "synthetic-newer-key" };
    page[variant.command] = newer; page.data[variant.busy] = true;
    if (outcome === "resolve") pending.resolve({ id: "synthetic-old-proposal" }); else pending.reject(new Error("synthetic late failure"));
    await sending; expect(page[variant.command]).toBe(newer); expect(page.data[variant.busy]).toBe(true);
    expect(state.request).toHaveBeenCalledTimes(1); expect(state.read).not.toHaveBeenCalled();
  });
  it("does not apply an old actor result or unlock their successor", async () => {
    await load(); const pending = deferred(); state.request.mockReturnValue(pending.promise); const sending = page[variant.send]();
    state.token = "synthetic-session-b"; page.data.attempt += 1;
    const newer = { ...page[variant.command], key: "synthetic-actor-b-key" }; page[variant.command] = newer; page.data[variant.busy] = true;
    pending.resolve({ id: "synthetic-actor-a-proposal" }); await sending;
    expect(page[variant.command]).toBe(newer); expect(page.data[variant.busy]).toBe(true); expect(page.data[variant.visible]).toBe(true);
  });
  it("does not commit after its page lifetime ends", async () => {
    await load(); const pending = deferred(); state.request.mockReturnValue(pending.promise); const sending = page[variant.send]();
    page.onUnload(); const patchCount = page.patches.length; pending.resolve({ id: "synthetic-ended-proposal" }); await sending;
    expect(page.patches).toHaveLength(patchCount); expect(page[variant.command]).toBeNull();
  });
});
