import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ token: "member-a", request: vi.fn(), bootstrap: vi.fn(), resume:vi.fn(),navigate:vi.fn(),gift:vi.fn(),invitation:vi.fn() }));
vi.mock("../../apps/miniprogram/services/api", () => ({
  resumeAuthentication:mocks.resume, navigateAfterAuthentication:mocks.navigate, request: mocks.request, requireMemberAccess: () => Boolean(mocks.token), retainMemberSnapshot: () => false
}));
vi.mock('../../apps/miniprogram/services/rewards',()=>({acceptRewardInvitation:mocks.gift,rewardInvitation:mocks.invitation,rewardCopy:(e:any)=>e.title||'请重试',rewardExpiry:()=> '2026.12.16 08:00'}));
vi.mock("../../apps/miniprogram/services/layout", () => ({ currentChromeStyle: () => "", shouldReduceMotion: () => true }));
vi.mock("../../apps/miniprogram/services/share", () => ({ prepareShareDetails:async()=>null,registerIncomingShare: vi.fn() }));

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
  mocks.gift.mockResolvedValue({memberId:'11111111-1111-4111-8111-111111111111',voucher:{id:'22222222-2222-4222-8222-222222222222',state:'unused',expiresAt:'2026-12-16T00:00:00Z'}});
  mocks.request.mockImplementation(async ({ path }: { path: string }) => {
    if (path === "/v1/bootstrap/home") return mocks.bootstrap();
    if (path === "/v1/me/points/club") return {serverDay:"2026-10-30",today:null,enabled:true,streak:0};
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
  it('waits for the full real credit presentation before opening the gift on care, once',async()=>{
    const owner='11111111-1111-4111-8111-111111111111',destination='/pages/rewards/index?invite='+'a'.repeat(64);
    const app={globalData:{sessionToken:'member-a',apiBaseUrl:'https://staging-api.cisme.cn',onboardingReturnUrl:destination,onboardingReturnToken:'member-a'}};
    (globalThis as any).getApp=()=>app;page.setData({memberId:owner,pageAlive:true,pageVisible:true,lifecycleEpoch:0,onboardingOpen:false,onboardingRequired:false,accountOpening:false});
    let finish!:()=>void;const animation=new Promise<void>(resolve=>{finish=resolve;});page.selectComponent=()=>({present:()=>animation});mocks.navigate.mockResolvedValue('target');
    const first=page.resumeOnboardingDestination(),second=page.resumeOnboardingDestination();await flush();expect(mocks.navigate).not.toHaveBeenCalled();
    finish();await Promise.all([first,second]);expect(mocks.gift).toHaveBeenCalledTimes(1);expect(mocks.gift).toHaveBeenCalledWith('a'.repeat(64),expect.any(String));expect(page.data.giftOpen).toBe(true);expect(mocks.navigate).not.toHaveBeenCalled();
  });
  it('keeps an invitation pending when the first questionnaire credit has not been confirmed',async()=>{
    const owner='11111111-1111-4111-8111-111111111111',destination='/pages/rewards/index?invite='+'b'.repeat(64);
    const app={globalData:{sessionToken:'member-a',apiBaseUrl:'https://staging-api.cisme.cn',onboardingReturnUrl:destination,onboardingReturnToken:'member-a'}};
    (globalThis as any).getApp=()=>app;page.setData({memberId:owner,pageAlive:true,pageVisible:true,lifecycleEpoch:0,onboardingOpen:false,onboardingRequired:false,accountOpening:false});
    page.selectComponent=()=>({present:async()=>{}});const feedback=await import('../../apps/miniprogram/services/points-feedback');feedback.queueOnboardingFeedback(owner,'first-questionnaire');
    await page.resumeOnboardingDestination();expect(mocks.navigate).not.toHaveBeenCalled();expect(app.globalData.onboardingReturnUrl).toBe(destination);
    feedback.consumeOnboardingFeedback(owner,'33333333-3333-4333-8333-333333333333');mocks.navigate.mockResolvedValue('target');await page.resumeOnboardingDestination();expect(mocks.gift).toHaveBeenCalledTimes(1);expect(page.data.giftOpen).toBe(true);expect(mocks.navigate).not.toHaveBeenCalled();
  });
  it('does not open a previous member reward after identity changes during the points animation',async()=>{
    const app={globalData:{sessionToken:'member-a',onboardingReturnUrl:'/pages/rewards/index?invite='+'a'.repeat(64),onboardingReturnToken:'member-a'}};
    (globalThis as any).getApp=()=>app;page.setData({memberId:'11111111-1111-4111-8111-111111111111',pageAlive:true,pageVisible:true,lifecycleEpoch:0,onboardingOpen:false,onboardingRequired:false,accountOpening:false});
    let finish!:()=>void;page.selectComponent=()=>({present:()=>new Promise<void>(resolve=>{finish=resolve;})});
    const pending=page.resumeOnboardingDestination();app.globalData.sessionToken='member-b';finish();await pending;expect(mocks.navigate).not.toHaveBeenCalled();
  });
  it('remembers a cold care gift link and opens it only after onboarding is complete',async()=>{
    const app={globalData:{sessionToken:'member-a',apiBaseUrl:'https://staging-api.cisme.cn'}};(globalThis as any).getApp=()=>app;page.onLoad({gift:'c'.repeat(64)});
    const intent=await import('../../apps/miniprogram/services/reward-invitation');expect(intent.pendingRewardInvitationPath()).toBe('/pages/home/index?gift='+'c'.repeat(64));
    page.setData({memberId:'11111111-1111-4111-8111-111111111111',onboardingRequired:true,onboardingOpen:true});await page.resumeOnboardingDestination();expect(mocks.gift).not.toHaveBeenCalled();
    page.setData({onboardingRequired:false,onboardingOpen:false});page.selectComponent=()=>({present:async()=>{}});await page.resumeOnboardingDestination();expect(page.data.giftOpen).toBe(true);expect(mocks.navigate).not.toHaveBeenCalled();
  });
  it('resumes an existing members pending gift after a successful home retry without onboarding again',async()=>{
    const owner='11111111-1111-4111-8111-111111111111',app={globalData:{sessionToken:'member-a',apiBaseUrl:'https://staging-api.cisme.cn'}};(globalThis as any).getApp=()=>app;
    page.setData({memberId:owner,pageAlive:true,pageVisible:true,lifecycleEpoch:0,onboardingOpen:false,onboardingRequired:false});page.selectComponent=()=>({present:async()=>{}});
    const invite=await import('../../apps/miniprogram/services/reward-invitation');invite.rememberRewardInvitation('d'.repeat(64));page.load=vi.fn().mockResolvedValue(true);page.retryLoad();await flush();
    expect(mocks.gift).toHaveBeenCalledTimes(1);expect(page.data.giftOpen).toBe(true);expect(page.data.onboardingOpen).toBe(false);expect(mocks.resume).not.toHaveBeenCalled();
  });
  it('keeps the voucher after later and sends an explicit claim to its dedicated flow, not the wallet',async()=>{
    const owner='11111111-1111-4111-8111-111111111111',voucher='22222222-2222-4222-8222-222222222222';
    const app={globalData:{sessionToken:'member-a',apiBaseUrl:'https://staging-api.cisme.cn'}};(globalThis as any).getApp=()=>app;
    page.setData({memberId:owner,pageAlive:true,pageVisible:true,lifecycleEpoch:0,onboardingOpen:false,onboardingRequired:false});page.selectComponent=()=>({present:async()=>{}});
    const invite=await import('../../apps/miniprogram/services/reward-invitation');invite.rememberRewardInvitation('a'.repeat(64));await page.resumeOnboardingDestination();
    expect(page.data.giftOpen).toBe(true);expect(invite.pendingRewardInvitationToken()).toBe('');
    const event={detail:{owner,reference:voucher}};page.deferGift(event);expect(page.data.giftOpen).toBe(false);expect(page.data.giftVoucher.id).toBe(voucher);expect(wx.navigateTo).not.toHaveBeenCalled();
    invite.rememberRewardInvitation('a'.repeat(64));await page.resumeOnboardingDestination();page.chooseGift(event);
    expect(wx.navigateTo).toHaveBeenCalledWith(expect.objectContaining({url:`/pages/checkout/index?rewardVoucher=${voucher}&from=care`}));expect(mocks.navigate).not.toHaveBeenCalled();
  });
  it('preserves the opened link when a receive response arrives after leaving care',async()=>{
    const app={globalData:{sessionToken:'member-a',apiBaseUrl:'https://staging-api.cisme.cn'}};(globalThis as any).getApp=()=>app;
    page.setData({memberId:'11111111-1111-4111-8111-111111111111',pageAlive:true,pageVisible:true,lifecycleEpoch:0,onboardingOpen:false,onboardingRequired:false});page.selectComponent=()=>({present:async()=>{}});
    const invite=await import('../../apps/miniprogram/services/reward-invitation');invite.rememberRewardInvitation('a'.repeat(64));
    let received!:(value:any)=>void;mocks.gift.mockImplementationOnce(()=>new Promise(resolve=>{received=resolve;}));const opening=page.resumeOnboardingDestination();await flush();page.onHide();
    received({memberId:page.data.memberId,voucher:{id:'22222222-2222-4222-8222-222222222222',state:'unused',expiresAt:'2026-12-16T00:00:00Z'}});await opening;
    expect(page.data.giftOpen).toBe(false);expect(page.data.giftLoading).toBe(false);expect(invite.pendingRewardInvitationToken()).toBe('a'.repeat(64));page.setData({pageVisible:true});await page.resumeOnboardingDestination();expect(page.data.giftOpen).toBe(true);
  });
  it('does not force registration for a care gift link whose two sets are sold out',async()=>{
    const app={globalData:{sessionToken:'',apiBaseUrl:'https://staging-api.cisme.cn'}};(globalThis as any).getApp=()=>app;page.setData({pageAlive:true,pageVisible:true,lifecycleEpoch:0});
    const invite=await import('../../apps/miniprogram/services/reward-invitation');invite.rememberRewardInvitation('a'.repeat(64));mocks.invitation.mockResolvedValueOnce({bundles:[{stockConfirmed:true,availableQuantity:0},{stockConfirmed:true,availableQuantity:0}]});
    await page.resumeOnboardingDestination();expect(mocks.resume).not.toHaveBeenCalled();expect(mocks.gift).not.toHaveBeenCalled();expect(page.data.giftError).toContain('已领完');expect(invite.pendingRewardInvitationToken()).toBe('');
  });
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

it('returns an authenticated but unfinished identity to Account before opening the questionnaire',async()=>{
 mocks.bootstrap.mockResolvedValue({member:{id:'a',display_name:'CISME 会员',profile_revision:0,completed_at:null,avatar_data_url:null},care:null,businessVersion:1,onboardingRequired:true});
 await page.load();expect(mocks.resume).toHaveBeenCalledWith('/pages/home/index');expect(page.data.onboardingOpen).toBe(false);expect(page.data.authorityAvailable).toBe(false);
});
