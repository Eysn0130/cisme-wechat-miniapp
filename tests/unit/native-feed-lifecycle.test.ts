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
  it.each([403,503])("handles an unselected Featured source's HTTP%s without reviving denied snapshots",async status=>{
    let failed=false,featuredReads=0;
    mocks.request.mockImplementation(async({path}:any)=>{
      if(path==="/v1/capabilities")return {};
      if(path==="/v1/ugc/status")return {publicEnabled:true};
      if(path.startsWith("/v1/community/featured")){featuredReads++;if(failed)throw {status};return {items:[entry("featured")],nextCursor:"featured-next"};}
      return {items:[],nextCursor:null};
    });
    page.setData({mode:"featured"});await page.load();await page.selectMode({currentTarget:{dataset:{mode:"recommend"}}});failed=true;await page.load();
    const before=featuredReads;await page.selectMode({currentTarget:{dataset:{mode:"featured"}}});
    expect(page.data.displayFeedCount).toBe(status===403?0:1);expect(page.data.editorialNextCursor).toBe(status===403?null:"featured-next");
    expect(featuredReads).toBe(status===403?before+1:before);
  });
  it.each(["/v1/capabilities","/v1/ugc/status"])("clears a capability denial from %s before another capability or access read finishes",async deniedPath=>{
    let blocked=false;const other=delayed(),access=delayed();
    mocks.request.mockImplementation(async({path}:any)=>{
      if(path==="/v1/capabilities"||path==="/v1/ugc/status"){
        if(blocked){if(path===deniedPath)throw {status:403};return other.promise;}
        return path==="/v1/capabilities"?{communityPreviewEnabled:false}:{publicEnabled:true,draftsEnabled:true};
      }
      if(path==="/v1/me/community-access")return blocked?access.promise:{canReview:false};
      if(path.startsWith("/v1/feed/page?"))return {items:[],nextCursor:null};
      return {items:[entry(path.startsWith("/v1/community/featured")?"featured":"recommend")],nextCursor:"next"};
    });
    await page.load();blocked=true;const refresh=page.load();for(let i=0;i<30;i++)await Promise.resolve();
    expect(page.data).toMatchObject({displayFeedCount:0,loading:false,formalNextCursor:null,ugcFeedEnabled:false,ugcDraftsEnabled:false});
    const count=mocks.request.mock.calls.length;await page.onReachBottom();expect(mocks.request).toHaveBeenCalledTimes(count);
    other.resolve(deniedPath==="/v1/capabilities"?{publicEnabled:true}:{communityPreviewEnabled:true});for(let i=0;i<30;i++)await Promise.resolve();
    expect(page.data.mode).toBe("featured");expect(page.data.feedColumns.flat().map((item:any)=>item.id)).toEqual(["featured"]);
    access.resolve({canReview:false});await refresh;expect(page.data.feedColumns.flat().map((item:any)=>item.id)).toEqual(["featured"]);
  });
  it("does not overwrite an already appended Featured page when ancillary first-page reads finish",async()=>{
    const pending=delayed();
    mocks.request.mockImplementation(async({path}:any)=>{
      if(path==="/v1/capabilities")return {};
      if(path==="/v1/ugc/status")return {publicEnabled:true};
      if(path.startsWith("/v1/ugc/posts?"))return pending.promise;
      if(path.startsWith("/v1/community/featured"))return {items:[entry(path.includes("cursor=")?"second":"first")],nextCursor:path.includes("cursor=")?null:"next"};
      return {items:[],nextCursor:null};
    });
    page.setData({mode:"featured"});const reading=page.load();for(let i=0;i<30;i++)await Promise.resolve();
    expect(page.data.loading).toBe(false);await page.onReachBottom();expect(page.data.displayFeedCount).toBe(2);
    pending.resolve({items:[],nextCursor:null});await reading;
    expect(page.data.feedColumns.flat().map((item:any)=>item.id).sort()).toEqual(["first","second"]);expect(page.data.editorialNextCursor).toBeNull();
  });
  it.each(["formal","preview"])("removes a confirmed closed %s source while other status/list reads are unavailable",async closed=>{
    let closing=false;
    mocks.request.mockImplementation(async({path}:any)=>{
      if(path==="/v1/capabilities"){if(closing&&closed==="formal")throw {status:503};return {communityPreviewEnabled:!closing,ugcGoLiveGate:!closing};}
      if(path==="/v1/ugc/status"){if(closing&&closed==="preview")throw {status:503};return {publicEnabled:!closing};}
      if(path.startsWith("/v1/community/featured"))return {items:[],nextCursor:null};
      if(path.startsWith("/v1/ugc/posts?")){if(closing&&closed==="preview")throw {status:503};return {items:closing?[]:[entry("formal")],nextCursor:closing?null:"next"};}
      if(path.startsWith("/v1/feed/page?")){if(closing&&closed==="formal")throw {status:503};return {items:closing?[]:[entry("preview")],authors:{},nextCursor:null};}
      return {};
    });
    await page.load();expect(page.data.displayFeedCount).toBe(2);closing=true;await page.load();
    expect(page.data.feedColumns.flat().map((item:any)=>item.id)).toEqual([closed==="formal"?"preview":"formal"]);
    if(closed==="formal")expect(page.data.formalNextCursor).toBeNull();
    expect(page.data.capabilityError).toContain("重试");
  });
  it.each(["refresh","pagination"])("clears Featured cards and cursor on %s permission denial",async stage=>{
    let denied=false;
    mocks.request.mockImplementation(async({path}:any)=>{
      if(path==="/v1/capabilities"||path==="/v1/ugc/status")return {};
      if(path.startsWith("/v1/community/featured")){if(denied)throw {status:403};return {items:[entry("featured")],nextCursor:"next"};}
      return {items:[],nextCursor:null};
    });
    page.setData({mode:"featured"});await page.load();denied=true;
    if(stage==="refresh")await page.load();else await page.onReachBottom();
    expect(page.data).toMatchObject({displayFeedCount:0,editorialNextCursor:null,formalLoadingMore:false,loading:false});
  });
  it("keeps each retained channel cursor when a later first-page refresh fails",async()=>{
    let failed=false;
    mocks.request.mockImplementation(async({path}:any)=>{
      if(path==="/v1/capabilities")return {};
      if(path==="/v1/ugc/status")return {publicEnabled:true};
      if(failed)throw {status:503};
      if(path.startsWith("/v1/feed/page?"))return {items:[],nextCursor:null};
      return {items:[entry(path.startsWith("/v1/community/featured")?"featured":"recommend")],nextCursor:path.startsWith("/v1/community/featured")?"featured-next":"recommend-next"};
    });
    page.setData({mode:"featured"});await page.load();
    await page.selectMode({currentTarget:{dataset:{mode:"recommend"}}});
    failed=true;await page.load();
    expect(page.data).toMatchObject({editorialNextCursor:"featured-next",formalNextCursor:"recommend-next",displayFeedCount:1});
    await page.selectMode({currentTarget:{dataset:{mode:"featured"}}});expect(page.data.editorialNextCursor).toBe("featured-next");
  });
  it.each(["/v1/capabilities","/v1/ugc/status"])("retains the current channel when %s is temporarily unavailable",async missing=>{
    let failed=false;
    mocks.request.mockImplementation(async({path}:any)=>{
      if(failed&&path===missing)throw {status:503};
      if(path==="/v1/capabilities")return {communityPreviewEnabled:false};
      if(path==="/v1/ugc/status")return {publicEnabled:true,draftsEnabled:true};
      if(path.startsWith("/v1/feed/page?"))return {items:[],nextCursor:null};
      return {items:[entry("kept")],nextCursor:null};
    });
    await page.load();failed=true;await page.load();
    expect(page.data).toMatchObject({mode:"recommend",loading:false,ugcFeedEnabled:true,displayFeedCount:1,
      ugcDraftsEnabled:missing!=="/v1/ugc/status",capabilityError:expect.stringContaining("重试")});
    failed=false;await page.load();expect(page.data.capabilityError).toBe("");
  });
  it("clears a recommendation page on pagination permission denial but ignores a different account's old denial",async()=>{
    let failure:any=null;
    mocks.request.mockImplementation(async({path}:any)=>{
      if(path==="/v1/capabilities")return {};
      if(path==="/v1/ugc/status")return {publicEnabled:true};
      if(path.startsWith("/v1/feed/page?"))return {items:[],nextCursor:null};
      if(failure&&path.includes("cursor="))throw failure;
      return {items:[entry("kept")],nextCursor:"next"};
    });
    await page.load();failure={status:403};await page.onReachBottom();
    expect(page.data).toMatchObject({displayFeedCount:0,feedReady:false,formalNextCursor:null,formalLoadingMore:false,error:expect.stringContaining("无法加载")});
    failure=null;await page.load();const pending=delayed();mocks.request.mockReturnValueOnce(pending.promise);
    const reading=page.onReachBottom();mocks.token="member-b";const before=structuredClone(page.data);pending.reject({status:403});await reading;
    expect(page.data).toEqual(before);
  });
  it("does not carry old capability flags across an account change or pretend an unknown first read was a closure",async()=>{
    let failed=false;
    mocks.request.mockImplementation(async({path}:any)=>{
      if(path==="/v1/capabilities"||path==="/v1/ugc/status"){
        if(failed)throw {status:503};return {publicEnabled:true,draftsEnabled:true};
      }
      return {items:[entry("current")],nextCursor:null};
    });
    await page.load();mocks.token="member-b";failed=true;await page.load();
    expect(page.data).toMatchObject({mode:"recommend",ugcFeedEnabled:false,ugcDraftsEnabled:false,socialPreviewEnabled:false,
      capabilityError:expect.stringContaining("重试")});
    failed=false;mocks.request.mockImplementation(async({path}:any)=>path==="/v1/capabilities"||path==="/v1/ugc/status"?{}:{items:[],nextCursor:null});
    await page.load();expect(page.data.mode).toBe("featured");expect(page.data.capabilityError).toBe("");
  });
  it("clears a denied recommendation immediately while the other source is still pending",async()=>{
    const pending=delayed();let denied=false;
    mocks.request.mockImplementation(async({path}:any)=>{
      if(path==="/v1/capabilities")return {};
      if(path==="/v1/ugc/status")return {publicEnabled:true,draftsEnabled:true};
      if(path.startsWith("/v1/community/featured"))return {items:[entry("featured")],nextCursor:null};
      if(path.startsWith("/v1/feed/page?")){if(denied)throw {status:403};return {items:[],nextCursor:null};}
      if(path.startsWith("/v1/ugc/posts?"))return denied?pending.promise:{items:[entry("before-denial")],nextCursor:null};
      return {};
    });
    await page.load();expect(page.data.displayFeedCount).toBe(1);denied=true;
    const refresh=page.load();for(let i=0;i<30;i++)await Promise.resolve();
    expect(page.data).toMatchObject({displayFeedCount:0,feedReady:false,loading:false});expect(page.data.error).toContain("无法加载");
    pending.resolve({items:[entry("late-must-not-return")],nextCursor:null});await refresh;
    expect(page.data.displayFeedCount).toBe(0);expect(page.data.feedReady).toBe(false);
  });
  it("does not refill a denied recommendation cache from another source and preserves the independent Featured snapshot",async()=>{
    const pending=delayed();let held=false,featuredFailed=false,featuredReads=0;
    mocks.request.mockImplementation(async({path}:any)=>{
      if(path==="/v1/capabilities")return {};
      if(path==="/v1/ugc/status")return {publicEnabled:true,draftsEnabled:true};
      if(path.startsWith("/v1/community/featured")){featuredReads++;if(featuredFailed)throw {status:503};return {items:[entry("featured")],nextCursor:null};}
      if(path.startsWith("/v1/feed/page?"))throw {status:403};
      if(path.startsWith("/v1/ugc/posts?"))return held?pending.promise:{items:[entry("must-not-flash")],nextCursor:null};
      return {};
    });
    page.setData({mode:"featured"});await page.load();held=true;
    const selected=page.selectMode({currentTarget:{dataset:{mode:"recommend"}}});for(let i=0;i<30;i++)await Promise.resolve();
    expect(page.data).toMatchObject({loading:false,feedReady:false,displayFeedCount:0});expect(page.data.error).toContain("无法加载");
    pending.resolve({items:[],nextCursor:null});await selected;
    const before=featuredReads;featuredFailed=true;await page.selectMode({currentTarget:{dataset:{mode:"featured"}}});
    expect(page.data.feedColumns.flat().map((item:any)=>item.id)).toEqual(["featured"]);expect(featuredReads).toBe(before);expect(page.data.error).toBe("");
  });
  it("clears the recommendation projection on a permission rejection even if the other source returns cards",async()=>{
    mocks.request.mockImplementation(async({path}:any)=>{
      if(path==="/v1/capabilities")return {};
      if(path==="/v1/ugc/status")return {publicEnabled:true,draftsEnabled:true};
      if(path.startsWith("/v1/feed/page?"))throw {status:403};
      return {items:[entry("not-retained")],nextCursor:null};
    });
    await page.load();expect(page.data.displayFeedCount).toBe(0);expect(page.data.feedReady).toBe(false);expect(page.data.error).toContain("无法加载");
  });
  it.each(["legacy","formal"])("does not turn a failed %s source plus an empty other source into a confirmed empty list",async missing=>{
    mocks.request.mockImplementation(async({path}:any)=>{
      if(path==="/v1/capabilities")return {};
      if(path==="/v1/ugc/status")return {publicEnabled:true,draftsEnabled:true};
      if(path.startsWith("/v1/community/featured"))return {items:[entry("featured")],nextCursor:null};
      if(missing==="legacy"&&path.startsWith("/v1/feed/page?")||missing==="formal"&&path.startsWith("/v1/ugc/posts?"))throw {status:503};
      return {items:[],nextCursor:null};
    });
    await page.load();expect(page.data.displayFeedCount).toBe(0);expect(page.data.feedReady).toBe(false);expect(page.data.error).toContain("无法加载");
    await page.selectMode({currentTarget:{dataset:{mode:"featured"}}});
    await page.selectMode({currentTarget:{dataset:{mode:"recommend"}}});
    expect(page.data.feedReady).toBe(false);expect(page.data.error).toContain("无法加载");
  });
  it("shows a partial result with a recovery notice and keeps it if both sources later fail",async()=>{
    let allFailed=false;
    mocks.request.mockImplementation(async({path}:any)=>{
      if(path==="/v1/capabilities")return {};
      if(path==="/v1/ugc/status")return {publicEnabled:true,draftsEnabled:true};
      if(path.startsWith("/v1/community/featured"))return {items:[],nextCursor:null};
      if(path.startsWith("/v1/feed/page?")||allFailed&&path.startsWith("/v1/ugc/posts?"))throw {status:503};
      return {items:[entry("partial")],nextCursor:null};
    });
    await page.load();expect(page.data.feedColumns.flat().map((item:any)=>item.id)).toEqual(["partial"]);expect(page.data.error).toContain("部分");
    allFailed=true;await page.load();expect(page.data.feedColumns.flat().map((item:any)=>item.id)).toEqual(["partial"]);expect(page.data.error).toContain("无法加载");
  });
  it("retries an unconfirmed channel instead of treating its earlier failed read as an empty success",async()=>{
    let failed=true;const pending=delayed();
    mocks.request.mockImplementation(async({path}:any)=>{
      if(path==="/v1/capabilities")return {};
      if(path==="/v1/ugc/status")return {publicEnabled:true,draftsEnabled:true};
      if(path.startsWith("/v1/community/featured"))return {items:[entry("featured")],nextCursor:null};
      if(path.startsWith("/v1/feed/page?")){if(failed)throw {status:503};return {items:[],nextCursor:null};}
      if(path.startsWith("/v1/ugc/posts?")){if(failed)throw {status:503};return pending.promise;}
      return {};
    });
    page.setData({mode:"featured"});await page.load();failed=false;
    const selected=page.selectMode({currentTarget:{dataset:{mode:"recommend"}}});
    for(let i=0;i<30;i++)await Promise.resolve();
    expect(page.data).toMatchObject({mode:"recommend",feedReady:false,loading:true,displayFeedCount:0});
    pending.resolve({items:[entry("retried")],nextCursor:null});await selected;
    expect(page.data.feedColumns.flat().map((item:any)=>item.id)).toEqual(["retried"]);
  });
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
    mocks.request.mockImplementation(async({path}:any)=>path==="/v1/capabilities"?{}:path==="/v1/ugc/status"?{publicEnabled:true,draftsEnabled:true}:{items:[],nextCursor:"start"});
    await page.load();mocks.request.mockReset();
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
