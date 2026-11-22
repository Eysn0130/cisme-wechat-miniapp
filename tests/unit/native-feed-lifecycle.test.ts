import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks=vi.hoisted(()=>({request:vi.fn(),token:"session-a"}));
vi.mock("../../apps/miniprogram/services/api",()=>({request:mocks.request,resumeAuthentication:vi.fn()}));
vi.mock("../../apps/miniprogram/services/page-requests",()=>({pageRead:(_page:unknown,options:unknown)=>mocks.request(options),cancelPageReads:vi.fn()}));
vi.mock("../../apps/miniprogram/services/layout",()=>({shouldReduceMotion:()=>false,currentChromeStyle:()=>""}));
let page:any;
const delayed=()=>{let resolve!:(value:any)=>void,reject!:(value:any)=>void;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const entry=(id:string)=>({id,title:id,authorId:"synthetic",likeCount:0});
function patch(target:any,key:string,value:any){const parts=key.replace(/\[(\d+)\]/g,".$1").split(".");let current=target;for(const [i,name] of parts.entries()){if(i===parts.length-1)current[name]=structuredClone(value);else current=current[name!]??=(/^\d+$/.test(parts[i+1]!)?[]:{});}}
beforeEach(async()=>{vi.resetModules();mocks.request.mockReset();mocks.token="session-a";(globalThis as any).getApp=()=>({globalData:{sessionToken:mocks.token,apiBaseUrl:"https://synthetic.invalid"}});(globalThis as any).wx={};(globalThis as any).Page=(definition:any)=>{page={...definition,data:structuredClone(definition.data),setData(updates:any,callback?:()=>void){for(const [key,value]of Object.entries(updates))patch(this.data,key,value);callback?.();}};};await import("../../apps/miniprogram/pages/community/index");Object.assign(page.data,{loading:false,mode:"recommend",ugcFeedEnabled:true,formalNextCursor:"start",feedColumns:[[],[]],displayFeedCount:0});});
describe("native community pagination response ownership",()=>{
  it("keeps the same owner's previously read recommendations if a switch during Featured refresh fails",async()=>{
    let stage="ready";const held=delayed();
    mocks.request.mockImplementation(async({path}:any)=>{
      if(path==="/v1/capabilities")return {};
      if(path==="/v1/ugc/status")return {publicEnabled:true,draftsEnabled:true};
      if(path.startsWith("/v1/community/featured"))return {items:[entry("featured")],nextCursor:null};
      if(path.startsWith("/v1/ugc/posts?")||path.startsWith("/v1/feed/page?")){
        if(stage==="hold")return held.promise;
        if(stage==="fail")throw {status:503};
        return {items:path.startsWith("/v1/ugc/posts?")?[entry("kept")]:[],nextCursor:null};
      }
      return {};
    });
    await page.load();expect(page.data.feedColumns.flat().map((item:any)=>item.id)).toEqual(["kept"]);
    await page.selectMode({currentTarget:{dataset:{mode:"featured"}}});stage="hold";
    const refresh=page.load();for(let i=0;i<30;i++)await Promise.resolve();
    stage="fail";await page.selectMode({currentTarget:{dataset:{mode:"recommend"}}});
    expect(page.data.feedColumns.flat().map((item:any)=>item.id)).toEqual(["kept"]);expect(page.data.error).toContain("无法加载");
    held.resolve({items:[],nextCursor:null});await refresh;
    expect(page.data.feedColumns.flat().map((item:any)=>item.id)).toEqual(["kept"]);
  });
  it("reads the selected recommendation channel when Featured painted before recommendation results",async()=>{
    const old=delayed(),fresh=delayed();let recommendationReads=0;
    mocks.request.mockImplementation(async({path}:any)=>path==="/v1/capabilities"?{}:path==="/v1/ugc/status"?{publicEnabled:true,draftsEnabled:true}:
      path.startsWith("/v1/community/featured")?{items:[entry("featured")],nextCursor:null}:
      path.startsWith("/v1/ugc/posts?")?(++recommendationReads===1?old.promise:fresh.promise):{items:[],nextCursor:null});
    page.setData({mode:"featured",loading:true,feedReady:false});
    const initial=page.load();for(let i=0;i<30;i++)await Promise.resolve();
    expect(page.data).toMatchObject({loading:false,displayFeedCount:1,ugcFeedEnabled:true});
    const selected=page.selectMode({currentTarget:{dataset:{mode:"recommend"}}});
    for(let i=0;i<30;i++)await Promise.resolve();
    expect(page.data).toMatchObject({mode:"recommend",loading:true,feedReady:false,displayFeedCount:0});
    expect(recommendationReads).toBe(2);
    old.resolve({items:[entry("stale")],nextCursor:null});await initial;
    expect(page.data.loading).toBe(true);expect(page.data.displayFeedCount).toBe(0);
    fresh.resolve({items:[entry("current")],nextCursor:null});await selected;
    expect(page.data.loading).toBe(false);expect(page.data.feedColumns.flat().map((item:any)=>item.id)).toEqual(["current"]);
  });
  it("reveals only the current cover after load and remounts only its image on retry",async()=>{
    mocks.request.mockImplementation(async({path}:any)=>path==="/v1/capabilities"?{}:path==="/v1/ugc/status"?{publicEnabled:false,draftsEnabled:false}:
      path.startsWith("/v1/community/featured")?{items:[{...entry("a"),coverUrl:`/v1/editorial/media/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/${"a".repeat(64)}`}],nextCursor:null}:{items:[],nextCursor:null});
    page.setData({mode:"featured"});await page.load();
    const first=structuredClone(page.data.feedColumns[0][0]),event=(key:string)=>({currentTarget:{dataset:{imageKey:key}}});
    expect(first.imagePhase).toBe("loading");page.feedImageLoaded({...event(first.imageKey),detail:{width:400,height:600}});expect(page.data.feedColumns[0][0].imagePhase).toBe("arriving");
    expect(page.data.feedColumns[0][0].imageRatio).toBe(150);
    page.feedImageSettled(event(first.imageKey));expect(page.data.feedColumns[0][0].imagePhase).toBe("ready");
    await page.load();expect(page.data.feedColumns[0][0]).toMatchObject({imageKey:first.imageKey,imagePhase:"ready"});
    page.feedImageFailed(event(first.imageKey));page.retryFeedImage(event(first.imageKey));
    const retry=page.data.feedColumns[0][0];expect(retry.imageKey).not.toBe(first.imageKey);expect(retry.imagePhase).toBe("loading");
    expect(retry.imageRatio).toBe(150);
    page.feedImageLoaded(event(first.imageKey));expect(page.data.feedColumns[0][0].imagePhase).toBe("loading");
    mocks.token="different-actor";page.feedImageLoaded(event(retry.imageKey));expect(page.data.feedColumns[0][0].imagePhase).toBe("loading");
  });
  it("clears the retained public projection on an explicit permission rejection",async()=>{
    mocks.request.mockImplementation(async({path}:any)=>path==="/v1/capabilities"?{}:path==="/v1/ugc/status"?{publicEnabled:false,draftsEnabled:false}:
      path.startsWith("/v1/community/featured")?{items:[entry("a")],nextCursor:null}:{items:[],nextCursor:null});
    page.setData({mode:"featured"});await page.load();expect(page.data.displayFeedCount).toBe(1);
    mocks.request.mockImplementation(async({path}:any)=>{if(path.startsWith("/v1/community/featured"))throw {status:403};return {items:[],nextCursor:null};});
    await page.load();expect(page.data.displayFeedCount).toBe(0);expect(page.data.feedReady).toBe(false);expect(page.data.error).toContain("无法加载");
  });

  it("does not revive A's response after A→B→A or clear the new request's busy state",async()=>{
    const old=delayed();mocks.request.mockReturnValueOnce(old.promise);const first=page.onReachBottom();
    await page.selectMode({currentTarget:{dataset:{mode:"featured"}}});await page.selectMode({currentTarget:{dataset:{mode:"recommend"}}});
    const newer=delayed();mocks.request.mockReturnValueOnce(newer.promise);const second=page.onReachBottom();
    old.resolve({items:[entry("old")],nextCursor:null});await first;expect(page.data.formalLoadingMore).toBe(true);expect(page.data.displayFeedCount).toBe(0);
    newer.resolve({items:[entry("new")],nextCursor:null});await second;expect(page.data.feedColumns.flat().map((row:any)=>row.id)).toEqual(["new"]);
  });
  it("retains cards on a pagination failure and deduplicates both within and across pages",async()=>{
    mocks.request.mockResolvedValueOnce({items:[entry("a"),entry("a")],nextCursor:"second"});await page.onReachBottom();expect(page.data.displayFeedCount).toBe(1);
    mocks.request.mockRejectedValueOnce({code:"NETWORK_TIMEOUT"});await page.onReachBottom();expect(page.data.displayFeedCount).toBe(1);expect(page.data.moreError).toContain("已显示的故事保留");
    mocks.request.mockResolvedValueOnce({items:[entry("a"),entry("b")],nextCursor:null});await page.onReachBottom();expect(page.data.feedColumns.flat().map((row:any)=>row.id).sort()).toEqual(["a","b"]);
  });
  it("suppresses a pagination result and error after account change",async()=>{
    const old=delayed();mocks.request.mockReturnValueOnce(old.promise);const first=page.onReachBottom();mocks.token="session-b";page.onHide();old.reject({code:"NETWORK_TIMEOUT"});await first;
    expect(page.data.feedColumns).toEqual([[],[]]);expect(page.data.moreError).toBe("");
  });
});
