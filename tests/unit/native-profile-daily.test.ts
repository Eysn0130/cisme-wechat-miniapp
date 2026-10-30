import { beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ token: "actor-a", request: vi.fn(), avatar: vi.fn() }));
vi.mock("../../apps/miniprogram/services/api", () => ({ request: m.request, requireMemberAccess: () => Boolean(m.token), retainMemberSnapshot: () => true, clearAuthenticationRedirectSuppression: vi.fn() }));
vi.mock("../../apps/miniprogram/services/member-avatar", () => ({ defaultMemberAvatar: "neutral-avatar", localMemberAvatar: m.avatar }));
vi.mock("../../apps/miniprogram/services/layout", () => ({ currentChromeStyle: () => "" }));
vi.mock("../../apps/miniprogram/services/authority", () => ({ authorityProjection: async () => ({ managementAvailable: false, capabilities: [] }), hasNativeManagementEntry: () => false }));
const later = () => { let resolve!: (x: any) => void, reject!: (x: any) => void; const promise = new Promise<any>((a,b) => { resolve=a; reject=b; }); return {promise,resolve,reject}; };
const flush = async () => { for(let i=0;i<45;i++) await Promise.resolve(); };
const daily = {id:"11111111-1111-4111-8111-111111111111",source:"daily",careDay:"2026-10-29",version:1,deleted:false,operationId:"synthetic-operation",completedAt:"2026-10-29T10:00:00Z",updatedAt:"2026-10-29T10:00:00Z",timezone:"Asia/Shanghai",protocolVersion:"daily-care-v1",stepCodes:["00","01","02","03"],selfAssessment:"neutral"};
const dailyPage = (items: any[] = [daily]) => ({items,loadedCount:items.length,hasMore:false,nextCursor:null,serverDay:"2026-10-29",today:items.find(x=>x.careDay==="2026-10-29")??null,totalCount:items.length});
let page:any, identity:typeof import("../../apps/miniprogram/services/member-identity"), avatar:ReturnType<typeof later>, care:any, readDaily:()=>any, member:any;
beforeEach(async()=>{
 vi.resetModules();vi.clearAllMocks();m.token="actor-a";care=null;member={id:"actor-a",display_name:"规范昵称",profile_revision:2,avatar_data_url:"synthetic",avatar_revision:"avatar-2"};avatar=later();m.avatar.mockReturnValue(avatar.promise);readDaily=()=>dailyPage();
 m.request.mockImplementation(async(o:any)=>{
  if(o.path==="/v1/bootstrap/profile")return {member,points:{projection:{available:0}},care,businessVersion:2};
  if(o.path.startsWith("/v1/me/daily-care-records"))return readDaily();
  if(o.path==="/v1/me/commercial-membership")return {eligible:false,membershipState:"none",verifiedOrderCount:0,commission:{netEarnedCents:0}};
  if(o.path==="/v1/me/support/summary")return {unreadCount:0};
  throw Error("unexpected synthetic route");
 });
 (globalThis as any).getApp=()=>({globalData:{sessionToken:m.token}});
 (globalThis as any).wx={disableAlertBeforeUnload:vi.fn(),switchTab:vi.fn(),navigateTo:vi.fn(),showToast:vi.fn()};
 (globalThis as any).Page=(definition:any)=>{page={...definition,data:structuredClone(definition.data),setData(patch:any,cb?:()=>void){Object.assign(this.data,patch);cb?.();}};};
 identity=await import("../../apps/miniprogram/services/member-identity");await import("../../apps/miniprogram/pages/profile/index");
});
describe("Profile canonical name independent of avatar and real daily status",()=>{
 it("publishes canonical nickname and revision immediately while the avatar is still pending",async()=>{
  await page.load();await flush();expect(identity.memberIdentity()).toMatchObject({display_name:"规范昵称",profile_revision:2,avatarUrl:"neutral-avatar"});expect(page.data.member.display_name).toBe("规范昵称");expect(page.data.avatarState).toBe("loading");
 });
 it("retains the confirmed nickname if the optional avatar fails",async()=>{
  await page.load();avatar.reject(Error("synthetic image failure"));await flush();expect(identity.memberIdentity()?.display_name).toBe("规范昵称");expect(page.data.member.display_name).toBe("规范昵称");expect(page.data.avatarState).toBe("error");
 });
 it("does not let an older avatar completion overwrite a newer Settings name or avatar",async()=>{
  await page.load();identity.publishMemberIdentity({id:member.id,display_name:"设置中新昵称",profile_revision:3,avatarUrl:"new-avatar"});avatar.resolve("old-avatar");await flush();
  expect(identity.memberIdentity()).toMatchObject({display_name:"设置中新昵称",profile_revision:3,avatarUrl:"new-avatar"});expect(page.data.member.display_name).toBe("设置中新昵称");expect(page.data.memberAvatar).toBe("new-avatar");
 });
 it("prefers the same actor's newer identity to an older bootstrap nickname",async()=>{
  identity.publishMemberIdentity({id:member.id,display_name:"较新昵称",profile_revision:3,avatarUrl:"new-avatar"});await page.load();expect(page.data.member.display_name).toBe("较新昵称");expect(identity.memberIdentity()?.profile_revision).toBe(3);
 });
 it("shows a real today record without inventing cycle progress or qualification",async()=>{
  await page.load();await flush();expect(page.data).toMatchObject({care:null,hasCareCycle:false,progressPercent:0,careTitle:"今日日常护理已记录",careStatus:"今日已记录"});expect(page.data.careCopy).not.toMatch(/资格|周期已|下一次/);
 });
 it("shows a confirmed empty day and a real previous care day without claiming a new completion",async()=>{
  readDaily=()=>dailyPage([{...daily,careDay:"2026-10-28"}]);await page.load();await flush();expect(page.data.careTitle).toBe("今天还未记录");expect(page.data.careCopy).toContain("10月28日");
 });
 it("does not block member/points on daily loading or call the unconfirmed archive empty",async()=>{
  const held=later();readDaily=()=>held.promise;await page.load();expect(page.data.member).toMatchObject({id:member.id});expect(page.data.loading).toBe(false);expect(page.data.careTitle).toContain("正在读取");expect(page.data.careTitle).not.toContain("未记录");held.resolve(dailyPage([]));await flush();expect(page.data.careTitle).toBe("今天还未记录");
 });
 it("preserves a real cycle if daily loading fails",async()=>{
  care={id:"cycle-a",phase:"active",completed:["D1"],due:"D7",next:"D7"};readDaily=()=>{throw {status:503};};await page.load();await flush();expect(page.data).toMatchObject({hasCareCycle:true,careTitle:"护理周期进行中",progressPercent:25});expect(page.data.care).toEqual(care);
 });
 it("keeps daily failure distinct from absence or a lost session",async()=>{
  readDaily=()=>{throw {status:403};};await page.load();await flush();expect(page.data.careTitle).toBe("日常护理记录暂未更新");expect(page.data.dailyStatusError).toBeTruthy();expect(m.token).toBe("actor-a");
 });
 it.each(["hide","actor"])("ignores an old daily result after %s",async(kind)=>{
  const held=later();readDaily=()=>held.promise;await page.load();if(kind==="hide")page.onHide();else m.token="actor-b";held.resolve(dailyPage());await flush();expect(page.dailySnapshot).toBeNull();
 });
 it("does not let an older retry replace a newer result",async()=>{
  await page.load();const old=later();readDaily=()=>old.promise;const reading=page.loadDailyStatus(page.data.loadAttempt,m.token);readDaily=()=>dailyPage([]);await page.loadDailyStatus(page.data.loadAttempt,m.token);old.resolve(dailyPage());await reading;expect(page.data.careTitle).toBe("今天还未记录");
 });
});
