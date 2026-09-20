import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { careCommandConfirmed } from "../../apps/miniprogram/services/care-command-state";
const mocks = vi.hoisted(() => ({ token: "session-a", request: vi.fn() }));
vi.mock("../../apps/miniprogram/services/api", () => ({ request: mocks.request, requireMemberAccess: () => Boolean(mocks.token), retainMemberSnapshot: () => true }));
vi.mock("../../apps/miniprogram/services/member-identity", () => ({ memberIdentity: () => null }));
vi.mock("../../apps/miniprogram/services/layout", () => ({ currentChromeStyle: () => "", shouldReduceMotion: () => true }));
vi.mock("../../apps/miniprogram/services/share", () => ({ registerIncomingShare: vi.fn() }));
const deferred = <T = any>() => { let resolve!: (value:T)=>void, reject!:(value:unknown)=>void; const promise = new Promise<T>((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject}; };
const flush = async () => { for (let i=0;i<40;i++) await Promise.resolve(); };
const initial = () => ({ id: "cycle-a", phase: "active", version: 2, startedOn: "2026-09-20", timezone: "Asia/Shanghai", due: "D1", next: "D1", completed: [] as string[], records: [] as any[], scheduleOffsetDays: 0 });
let care: ReturnType<typeof initial>, page: any, wxMock: any, posts: any[], postResult: ReturnType<typeof deferred>, version: number;
async function mount() { await import("../../apps/miniprogram/pages/home/index"); await page.load(); }
function steps() { page.openCareSession(); for(let i=0;i<4;i++)page.advanceCareStep(); page.selectAssessment({currentTarget:{dataset:{value:"comfortable"}}}); }
function saved() { care = {...care,version:3,due:null as any,next:"D7",completed:["D1"],records:[{milestone:"D1",completedAt:"2026-09-20T22:00:00Z",stepCodes:["00","01","02","03"],selfAssessment:"comfortable"}]}; version++; }
beforeEach(()=>{
  vi.resetModules(); mocks.request.mockReset();mocks.token="session-a"; care=initial();version=100;posts=[];postResult=deferred();
  mocks.request.mockImplementation(async (options:any)=>{
    if(options.method==="POST"){posts.push(structuredClone(options));return postResult.promise;}
    if(options.path==="/v1/bootstrap/home")return {member:{id:mocks.token,display_name:"合成会员"},care:structuredClone(care),businessVersion:version};
    if(options.path==="/v1/me/support/summary")return {unreadCount:0};
    throw new Error("Unexpected synthetic route");
  });
  wxMock={showModal:vi.fn(async()=>({confirm:true})),showToast:vi.fn(),disableAlertBeforeUnload:vi.fn(),enableAlertBeforeUnload:vi.fn(),navigateTo:vi.fn(),nextTick:(f:()=>void)=>f()};
  (globalThis as any).wx=wxMock;(globalThis as any).getApp=()=>({globalData:{sessionToken:mocks.token}});
  (globalThis as any).Page=(definition:any)=>{page={...definition,data:structuredClone(definition.data),setData(patch:any,callback?:()=>void){Object.assign(this.data,patch);callback?.();}};};
});
afterEach(()=>page?.stopDaypartClock?.());
describe("CARE-01–04 native write recovery and late response ownership",()=>{
  it("keeps save frozen on double clicks and a mutable assessment until authority confirms",async()=>{
    await mount();steps();expect(page.data.sessionAssessment).toBe("comfortable");
    const first=page.submitCareSession();await flush();await page.submitCareSession();page.selectAssessment({currentTarget:{dataset:{value:"attention"}}});
    expect(posts).toHaveLength(1);expect(page.data).toMatchObject({working:true,mutationState:"sending",sessionAssessment:"comfortable"});expect(wxMock.showToast).not.toHaveBeenCalled();
    saved();postResult.resolve({});await first;expect(page.data).toMatchObject({working:false,mutationState:"confirmed",sessionMounted:false});expect(wxMock.showToast).toHaveBeenCalledWith(expect.objectContaining({icon:"success"}));
  });
  it("confirms lost-response facts by a fresh read without resubmitting or optimistic points",async()=>{
    await mount();steps();const saving=page.submitCareSession();await flush();saved();postResult.reject({code:"NETWORK_TIMEOUT"});await saving;
    expect(posts).toHaveLength(1);expect(page.data).toMatchObject({mutationState:"confirmed",working:false,sessionMounted:false});expect(page.data.care.records[0].completedAt).toBe("2026-09-20T22:00:00Z");expect(wxMock.showToast).not.toHaveBeenCalled();
  });
  it("holds unknown outcomes, fresh reads are read-only, explicit replay uses exactly the original intent",async()=>{
    await mount();steps();const saving=page.submitCareSession();await flush();postResult.reject({code:"NETWORK_TIMEOUT"});await saving;
    expect(page.data).toMatchObject({mutationState:"unknown",working:false,sessionMounted:true});expect(wxMock.showToast).not.toHaveBeenCalled();
    await page.load(true);await page.submitCareSession();expect(posts).toHaveLength(1);
    postResult=deferred();const retry=page.retryCareMutation();await flush();expect(posts).toHaveLength(2);expect(posts[1]).toEqual(posts[0]);
    saved();postResult.resolve({});await retry;expect(page.data).toMatchObject({mutationState:"confirmed",sessionMounted:false});
  });
  it.each(["success","failure"])("ignores an old %s after same-account hide/show without clearing a newer busy owner",async outcome=>{
    await mount();steps();const saving=page.submitCareSession();await flush();const old=postResult;
    page.onHide();page.onShow();await flush();expect(page.data.mutationState).toBe("unknown");
    postResult=deferred();const replay=page.retryCareMutation();await flush();expect(page.data.working).toBe(true);expect(posts).toHaveLength(2);
    outcome==="success"?old.resolve({}):old.reject({status:503});await saving;expect(page.data).toMatchObject({working:true,mutationState:"sending"});expect(wxMock.showToast).not.toHaveBeenCalled();
    saved();postResult.resolve({});await replay;expect(page.data).toMatchObject({working:false,mutationState:"confirmed"});
  });
  it("cannot publish an old account write result, carry its sheet or replay its key into a new account",async()=>{
    await mount();steps();const saving=page.submitCareSession();await flush();mocks.token="session-b";care={...initial(),id:"cycle-b"};version=1;
    page.onHide();page.onShow();await flush();postResult.resolve({});await saving;await page.retryCareMutation();
    expect(page.data).toMatchObject({care:{id:"cycle-b"},sessionMounted:false,working:false});expect(posts).toHaveLength(1);expect(wxMock.showToast).not.toHaveBeenCalled();
  });
  it("never writes completed steps onto a different target or version after refresh",async()=>{
    await mount();steps();care={...care,version:3,due:"D7",next:"D7"};version++;await page.load(true);await page.submitCareSession();
    expect(posts).toHaveLength(0);expect(page.data.error).toContain("不会把旧步骤写到新节点");
  });
  it("ignores activation confirmation returning after leaving the page",async()=>{
    care={...initial(),phase:"planned",startedOn:null as any,due:null as any};await mount();const modal=deferred();wxMock.showModal.mockReturnValueOnce(modal.promise);
    const activation=page.primaryAction();await flush();page.onHide();modal.resolve({confirm:true});await activation;expect(posts).toHaveLength(0);
  });
  it("does not classify old records lacking exact server facts as confirmed",()=>{
    const command={path:"/v1/care-cycles/cycle-a/milestones/D1/complete",key:"synthetic-key",token:"session-a",data:{expectedVersion:2,stepCodes:["00","01","02","03"],selfAssessment:"comfortable"}};
    for(const record of [{milestone:"D1"},{milestone:"D1",completedAt:"not-a-time",stepCodes:["00","01","02","03"],selfAssessment:"comfortable"},{milestone:"D1",completedAt:"2026-09-20T22:00:00Z",stepCodes:["00","01","02","03"],selfAssessment:"discomfort"}]) expect(careCommandConfirmed(command,{...care,records:[record]})).toBe(false);
    saved();expect(careCommandConfirmed(command,care)).toBe(true);expect(careCommandConfirmed(command,{...care,id:"other"})).toBe(false);
  });
});
