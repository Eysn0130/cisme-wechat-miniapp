import { beforeEach, describe, expect, it, vi } from "vitest";
const m=vi.hoisted(()=>({token:"member-a",request:vi.fn()}));
vi.mock("../../apps/miniprogram/services/api",()=>({request:m.request,requireMemberAccess:()=>Boolean(m.token),retainMemberSnapshot:()=>true,clearAuthenticationRedirectSuppression:vi.fn(),resumeAuthentication:vi.fn()}));
vi.mock("../../apps/miniprogram/services/layout",()=>({currentChromeStyle:()=>"",motionDuration:()=>0,shouldReduceMotion:()=>false}));
const later=()=>{let resolve!:(x:any)=>void,reject!:(x:any)=>void;const promise=new Promise<any>((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const flush=async()=>{for(let i=0;i<30;i++)await Promise.resolve();};
const care={id:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",version:3,phase:"active",pausePolicy:{enabled:true},completed:["D1"],next:"D7",records:[{milestone:"D1",stepCodes:["00","01","02","03"],selfAssessment:"comfortable"}]};
let page:any,read:ReturnType<typeof later>,write:ReturnType<typeof later>,aborts:ReturnType<typeof vi.fn>[],nextTicks:Array<()=>void>;
const action=()=>page.changeCycle({currentTarget:{dataset:{action:"pause"}}});
beforeEach(async()=>{vi.resetModules();vi.clearAllMocks();m.token="member-a";read=later();write=later();aborts=[];nextTicks=[];
  m.request.mockImplementation((o:any)=>{if(o.method==="POST")return write.promise;const a=vi.fn();aborts.push(a);o.registerAbort?.(a);return read.promise;});
  (globalThis as any).getApp=()=>({globalData:{sessionToken:m.token}});
  (globalThis as any).wx={showModal:vi.fn().mockResolvedValue({confirm:true}),showToast:vi.fn(),pageScrollTo:vi.fn(),enableAlertBeforeUnload:vi.fn(),disableAlertBeforeUnload:vi.fn(),stopPullDownRefresh:vi.fn(),nextTick:(fn:()=>void)=>nextTicks.push(fn)};
  (globalThis as any).Page=(d:any)=>{page={...d,data:structuredClone(d.data),setData(p:any,fn?:()=>void){Object.assign(this.data,p);fn?.();}};};
  await import("../../apps/miniprogram/pages/records/index");
});
async function ready(){void page.onShow();read.resolve(care);await flush();}
describe("records read and mutation ownership",()=>{
  it("cancels a hidden GET and refuses background retries",async()=>{void page.onShow();await flush();page.onHide();const count=aborts[0]!.mock.calls.length;void page.load();read.resolve(care);await flush();expect(count).toBe(1);expect(m.request).toHaveBeenCalledTimes(1);expect(page.data.care).toBeNull();});
  it("discards a read from the previous account even before onShow",async()=>{void page.onShow();m.token="member-b";read.resolve(care);await flush();expect(page.data.care).toBeNull();});
  it("rejects A to B to A reads using the session revision",async()=>{void page.onShow();const {invalidateCommerceRecoveryContext}=await import("../../apps/miniprogram/services/commerce-command-store");invalidateCommerceRecoveryContext();invalidateCommerceRecoveryContext();read.resolve(care);await flush();expect(page.data.care).toBeNull();});
  it("retains a labeled snapshot while refresh is pending but refuses cycle writes",async()=>{await ready();read=later();void page.load(true);void action();await flush();expect(page.data.care?.id).toBe(care.id);expect(wx.showModal).not.toHaveBeenCalled();expect(m.request.mock.calls.some(([o])=>o.method==="POST")).toBe(false);read.reject(new Error("synthetic offline"));await flush();expect(page.data.care?.id).toBe(care.id);void action();await flush();expect(wx.showModal).not.toHaveBeenCalled();});
  it("clears sensitive records and write authority after a forbidden refresh",async()=>{await ready();read=later();void page.load(true);read.reject({status:403});await flush();expect(page.data.care).toBeNull();expect(page.data.records).toEqual([]);expect(page.data.authorityAvailable).toBe(false);});
  it("ignores confirmation after hide and return",async()=>{await ready();const modal=later();(wx.showModal as any).mockReturnValue(modal.promise);const pending=action();page.onHide();read=later();void page.onShow();read.resolve(care);await flush();modal.resolve({confirm:true});write.resolve({});read.resolve(care);await pending;expect(m.request.mock.calls.some(([o])=>o.method==="POST")).toBe(false);});
  it("ignores confirmation after changing accounts",async()=>{await ready();const modal=later();(wx.showModal as any).mockReturnValue(modal.promise);const pending=action();m.token="member-b";modal.resolve({confirm:true});write.resolve({});read.resolve(care);await pending;expect(m.request.mock.calls.some(([o])=>o.method==="POST")).toBe(false);});
  it("does not cancel the write or launch a hidden follow-up GET",async()=>{await ready();const pending=action();await flush();page.onHide();const before=m.request.mock.calls.length;write.resolve({});await pending;expect(m.request.mock.calls).toHaveLength(before);expect(page.data.operationStatus).not.toBe("护理周期已暂停");read=later();void page.onShow();read.resolve({...care,phase:"paused",version:4});await flush();expect(page.data.care.phase).toBe("paused");});
  it("keeps the write owner across onShow then reads fresh facts",async()=>{await ready();const pending=action();await flush();page.onHide();read=later();void page.onShow();await flush();expect(m.request.mock.calls.filter(([o])=>o.method!=="POST")).toHaveLength(1);write.resolve({});await flush();read.resolve({...care,phase:"paused",version:4});await pending;expect(page.data.care.phase).toBe("paused");expect(page.data.working).toBe(false);});
  it("cannot refill a different account with a completed old write",async()=>{await ready();const pending=action();await flush();m.token="member-b";read=later();void page.onShow();write.resolve({});await flush();expect(page.data.care).toBeNull();expect(page.data.operationStatus).toBe("");expect(m.request.mock.calls.filter(([o])=>o.method!=="POST")).toHaveLength(2);read.resolve(null);await pending;});
  it("does not call a write failed when the lost response is followed by the expected authoritative transition",async()=>{await ready();const pending=action();await flush();read=later();write.reject(new Error("synthetic response lost"));await flush();read.resolve({...care,phase:"paused",version:4});await pending;expect(page.data.operationStatus).toBe("护理周期已暂停");expect(page.data.error).toBe("");});
  it("cannot claim success when a successful envelope is followed by unchanged facts",async()=>{await ready();const pending=action();await flush();read=later();write.resolve({});await flush();read.resolve(care);await pending;expect(page.data.operationStatus).not.toBe("护理周期已暂停");expect(page.data.error).not.toBe("");});
  it("does not remount a detail sheet from a nextTick after hiding",async()=>{await ready();page.openRecordDetail({currentTarget:{dataset:{key:`${care.id}:D1`}}});page.onHide();for(const fn of nextTicks)fn();expect(page.data.recordDetailVisible).toBe(false);expect(page.data.selectedRecord).toBeNull();});
  it("rejects unknown cycle actions without a modal or request",async()=>{await ready();void page.changeCycle({currentTarget:{dataset:{action:"not-an-action"}}});await flush();expect(wx.showModal).not.toHaveBeenCalled();expect(m.request.mock.calls.some(([o])=>o.method==="POST")).toBe(false);});
});

it("does not clear another visible page's busy state after a hidden write settles",async()=>{
  await ready();const tab={setData:vi.fn(),setPresentation:vi.fn()};page.getTabBar=()=>tab;
  const pending=action();await flush();page.onHide();tab.setData.mockClear();write.resolve({});await pending;
  expect(tab.setData).not.toHaveBeenCalled();
});
it("invalidates an open confirmation when an explicit refresh replaces its facts",async()=>{
  await ready();const modal=later();(wx.showModal as any).mockReturnValue(modal.promise);const pending=action();
  read=later();void page.load(true);read.resolve(care);await flush();modal.resolve({confirm:true});await pending;
  expect(page.data.confirmingCycleAction).toBe(false);expect(m.request.mock.calls.some(([o])=>o.method==="POST")).toBe(false);
});
