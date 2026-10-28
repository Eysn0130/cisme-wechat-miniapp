import {beforeEach,describe,expect,it,vi} from "vitest";

const m=vi.hoisted(()=>({request:vi.fn(),token:"synthetic-reader",pause:vi.fn(),stop:vi.fn(),exit:vi.fn()}));
vi.mock("../../apps/miniprogram/services/api",()=>({request:m.request,resumeAuthentication:vi.fn(),beginLegalRenewal:vi.fn(),clearAuthenticationRedirectSuppression:vi.fn()}));
// Comment transport has its own actual-Page and real-HTTP suites. These
// media/article tests isolate that independent read with its valid empty DTO.
vi.mock("../../apps/miniprogram/services/page-requests",()=>({pageRead:(_page:unknown,options:{path:string})=>
 /\/editorial\/articles\/[^/]+\/comments\?/.test(options.path)?Promise.resolve({comments:[],authors:{},commentCount:0,commentsEnabled:true,commentsPolicyVersion:0,canModerate:false,loadedCount:0,hasMore:false,nextCursor:null,truncated:false,preview:false,asOf:"2026-10-28T00:00:00Z"}):m.request(options),cancelPageReads:vi.fn()}));
vi.mock("../../apps/miniprogram/services/layout",()=>({currentChromeStyle:()=>"",motionDuration:()=>0}));
vi.mock("../../apps/miniprogram/services/share",()=>({prepareShareLink:vi.fn(),registerIncomingShare:vi.fn()}));

const id="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",authorId="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",other="cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const media=(letter:string,articleId=id)=>({id:letter.repeat(64),url:`/v1/editorial/media/${articleId}/${letter.repeat(64)}`});
const article=()=>({id,version:3,authorId,author:"公开作者",title:"长篇护理内容",body:"原文首段\n\n中段内容\n\n原文末段 #护理",publishedAt:"2026-10-26T09:00:00Z",media:[media("d"),media("e")],interactionsEnabled:true,liked:false,saved:false,following:false,isMine:false,likeCount:0,saveCount:0});
const video=()=>({id:"c".repeat(64),url:media("c").url,type:"video",mimeType:"video/mp4",width:720,height:1280,durationMs:48300,posterUrl:media("d").url});
const delayed=()=>{let resolve!:(value:any)=>void,reject!:(error:any)=>void;const promise=new Promise<any>((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};};
let page:any,wxMock:any,windowInfo:any,baseInfo:any,nextTicks:Array<()=>void>,stack:any[],reads:Promise<unknown>[];
const restoredOffsets=()=>wxMock.pageScrollTo.mock.calls.map(([options]:any[])=>options.scrollTop);
const flushNextTicks=()=>{for(const callback of nextTicks.splice(0))callback();};
async function mount(value:any=article()){
  m.request.mockResolvedValue(value);await import("../../apps/miniprogram/pages/post/index");page.onLoad({id,source:"editorial"});await page.load();flushNextTicks();wxMock.pageScrollTo.mockClear();
}
async function returnFromHidden(value:any=article()){
  m.request.mockResolvedValue(value);page.onShow();await reads.at(-1);expect(page.data.loading).toBe(false);
  await vi.waitFor(()=>expect(page.data.commentsLoading).toBe(false));
  if(page.pendingReadingRestore)await vi.waitFor(()=>expect(nextTicks.length).toBeGreaterThan(0));
}
function leaveAt800(){page.onPageScroll({scrollTop:800});page.onHide();}

beforeEach(()=>{
  vi.resetModules();vi.clearAllMocks();m.request.mockReset();m.token="synthetic-reader";nextTicks=[];reads=[];
  windowInfo={windowWidth:390,windowHeight:844,screenHeight:844,statusBarHeight:47,safeArea:{bottom:810},fontSizeScaleFactor:1};
  baseInfo={fontSizeSetting:16,fontSizeScaleFactor:1};
  stack=[{route:"pages/community-author/index",options:{id:authorId,source:"editorial"}},{route:"pages/post/index",options:{id,source:"editorial"}}];
  (globalThis as any).getApp=()=>({globalData:{sessionToken:m.token,apiBaseUrl:"https://synthetic.invalid"}});
  (globalThis as any).getCurrentPages=()=>stack;
  (globalThis as any).Page=(definition:any)=>{page={...definition,data:structuredClone(definition.data),load(...args:any[]){const read=definition.load.apply(this,args);reads.push(Promise.resolve(read));return read;},setData(values:any,callback?:()=>void){Object.assign(this.data,structuredClone(values));callback?.();}};};
  wxMock={getWindowInfo:vi.fn(()=>windowInfo),getAppBaseInfo:vi.fn(()=>baseInfo),
    hideShareMenu:vi.fn(),showShareMenu:vi.fn(),showToast:vi.fn(),nextTick:vi.fn((callback:()=>void)=>nextTicks.push(callback)),
    pageScrollTo:vi.fn((options:any)=>{options.success?.();options.complete?.();}),
    navigateTo:vi.fn(),navigateBack:vi.fn((options:any)=>{stack.pop();options.success?.();}),
    switchTab:vi.fn((options:any)=>{stack=[{route:options.url.replace(/^\//,"")}];options.success?.();}),
    createVideoContext:vi.fn(()=>({pause:m.pause,stop:m.stop,exitFullScreen:m.exit}))};
  (globalThis as any).wx=wxMock;
});

describe("native editorial reading return revalidates before restoring a viewport",()=>{
  it("restores the actual recorded800 only after a fresh matching GET and the native nextTick",async()=>{
    await mount();page.onPageScroll({scrollTop:800});page.openAuthor();expect(wxMock.navigateTo).toHaveBeenCalledWith(expect.objectContaining({url:`/pages/community-author/index?id=${authorId}&source=editorial`}));page.onHide();
    const fresh=delayed();m.request.mockReturnValueOnce(fresh.promise);page.onShow();
    // Emptying/rebuilding the page can itself deliver an offset0. It must not
    // replace the saved reading position while the content read is in flight.
    page.onPageScroll({scrollTop:0});expect(restoredOffsets()).not.toContain(800);
    fresh.resolve(article());await reads.at(-1);expect(page.data.loading).toBe(false);
    await vi.waitFor(()=>expect(page.data.commentsLoading).toBe(false));await vi.waitFor(()=>expect(nextTicks.length).toBeGreaterThan(0));
    expect(m.request).toHaveBeenCalledTimes(2);expect(m.request.mock.calls.every(([options])=>options.path===`/v1/editorial/articles/${id}`&&options.authMode==="optional")).toBe(true);
    expect(nextTicks.length).toBeGreaterThan(0);page.onPageScroll({scrollTop:0});expect(restoredOffsets()).not.toContain(800);
    flushNextTicks();expect(wxMock.pageScrollTo).toHaveBeenCalledWith(expect.objectContaining({scrollTop:800,duration:0}));
    expect(page.data).toMatchObject({loading:false,item:{id,version:3},social:{liked:false,saved:false,likeCount:0,saveCount:0}});
  });

  it.each([undefined,{type:"tap",detail:{}}])("an explicit reload%j cannot reuse a prior reading position",async(event)=>{
    await mount();page.onPageScroll({scrollTop:800});await page.load(event);flushNextTicks();expect(restoredOffsets()).not.toContain(800);
    page.onHide();await returnFromHidden();flushNextTicks();expect(restoredOffsets()).not.toContain(800);
  });

  it.each(["synthetic-other-reader",""])("does not carry an offset across actor change to%j",async(token)=>{
    await mount();leaveAt800();m.token=token;await returnFromHidden();flushNextTicks();expect(restoredOffsets()).not.toContain(800);
  });

  it("does not carry an offset into a new article even when the version matches",async()=>{
    await mount();leaveAt800();page.setData({id:other});await returnFromHidden({...article(),id:other,media:[media("d",other),media("e",other)]});flushNextTicks();
    expect(page.data.item.id).toBe(other);expect(restoredOffsets()).not.toContain(800);
  });

  it("does not carry an offset into a revised publication with unchanged image URLs",async()=>{
    await mount();leaveAt800();await returnFromHidden({...article(),version:4});flushNextTicks();expect(page.data.item.version).toBe(4);expect(restoredOffsets()).not.toContain(800);
  });

  it.each(["reorder","replace","append","identity"])("does not inherit reading after ordered published media change:%s",async(mode)=>{
    await mount();leaveAt800();const value:any=article();
    value.media=mode==="reorder"?[...value.media].reverse():mode==="replace"?[media("d"),media("f")]:mode==="append"?[...value.media,media("f")]:[{...media("d"),id:"f".repeat(64)},media("e")];
    await returnFromHidden(value);flushNextTicks();expect(restoredOffsets()).not.toContain(800);
  });

  it("retains video reading offset and pause position without automatically playing",async()=>{
    const value={...article(),media:[video()]};await mount(value);
    page.videoTimeChanged({detail:{currentTime:12.5},currentTarget:{dataset:{videoIdentity:page.data.videoEventId}}});leaveAt800();await returnFromHidden(value);flushNextTicks();
    expect(restoredOffsets()).toContain(800);expect(page.data.videoInitialTime).toBe(12.5);expect(m.pause).toHaveBeenCalled();expect(m.exit).toHaveBeenCalled();
  });

  it.each(["url","poster","duration","dimensions"])("rejects video media identity changes:%s",async(kind)=>{
    const value={...article(),media:[video()]};await mount(value);leaveAt800();const changed=video();
    if(kind==="url"){changed.id="f".repeat(64);changed.url=media("f").url;}else if(kind==="poster")changed.posterUrl=media("e").url;else if(kind==="duration")changed.durationMs=40000;else changed.height=960;
    await returnFromHidden({...article(),media:[changed]});flushNextTicks();expect(restoredOffsets()).not.toContain(800);
  });

  it.each(["width","fontSizeSetting","fontSizeScaleFactor"])("does not restore against changed layout:%s",async(kind)=>{
    await mount();leaveAt800();if(kind==="width")windowInfo.windowWidth=375;else if(kind==="fontSizeSetting")baseInfo.fontSizeSetting=20;else{baseInfo.fontSizeScaleFactor=1.25;windowInfo.fontSizeScaleFactor=1.25;}
    await returnFromHidden();flushNextTicks();expect(restoredOffsets()).not.toContain(800);
  });

  it.each(["getWindowInfo","getAppBaseInfo"])("does not guess layout eligibility when%s is unavailable",async(api)=>{
    delete wxMock[api];await mount();leaveAt800();await returnFromHidden();flushNextTicks();expect(restoredOffsets()).not.toContain(800);
  });

  it("supports the actual setting-only font API without inventing a scale factor",async()=>{
    delete baseInfo.fontSizeScaleFactor;delete windowInfo.fontSizeScaleFactor;await mount();leaveAt800();await returnFromHidden();flushNextTicks();expect(restoredOffsets()).toContain(800);
  });

  it("does not guess a layout when neither supported font setting is known",async()=>{
    delete baseInfo.fontSizeSetting;delete baseInfo.fontSizeScaleFactor;await mount();leaveAt800();await returnFromHidden();flushNextTicks();expect(restoredOffsets()).not.toContain(800);
  });

  it.each(["onHide","onUnload"])("drops a matching response delivered after%s",async(lifecycle)=>{
    await mount();leaveAt800();const late=delayed();m.request.mockReturnValueOnce(late.promise);page.onShow();const read=reads.at(-1);page[lifecycle]();late.resolve(article());await read;flushNextTicks();expect(restoredOffsets()).not.toContain(800);
  });

  it.each(["hide","unload","actor","new-read","layout","touch"])("rechecks the queued restore before native nextTick after%s",async(change)=>{
    await mount();leaveAt800();await returnFromHidden();expect(nextTicks.length).toBeGreaterThan(0);
    if(change==="hide")page.onHide();else if(change==="unload")page.onUnload();else if(change==="actor")m.token="other-reader";else if(change==="new-read")await page.load();else if(change==="touch")page.interruptReadingRestore();else windowInfo.windowWidth=412;
    flushNextTicks();expect(restoredOffsets()).not.toContain(800);
  });

  it.each([new Error("offline"),{status:404}])("clears a failed or withdrawn read instead of reviving its offset:%j",async(error)=>{
    await mount();leaveAt800();m.request.mockRejectedValueOnce(error);page.onShow();await reads.at(-1);expect(page.data.loading).toBe(false);flushNextTicks();expect(page.data.item).toBeNull();expect(restoredOffsets()).not.toContain(800);
    m.request.mockResolvedValue(article());await page.load();flushNextTicks();expect(restoredOffsets()).not.toContain(800);
  });

  it("never lets an older response restore over a later explicit read",async()=>{
    await mount();leaveAt800();const old=delayed();m.request.mockReturnValueOnce(old.promise);page.onShow();const read=reads.at(-1);
    m.request.mockResolvedValueOnce({...article(),version:4});await page.load();old.resolve(article());await read;flushNextTicks();
    expect(page.data.item.version).toBe(4);expect(restoredOffsets()).not.toContain(800);
  });

  it("ignores hidden native scroll callbacks rather than replacing the stored reading position",async()=>{
    await mount();leaveAt800();page.onPageScroll({scrollTop:0});await returnFromHidden();flushNextTicks();expect(restoredOffsets()).toContain(800);
  });

  it("lets a new user scroll win over queued restore and retains the new reading position",async()=>{
    await mount();leaveAt800();await returnFromHidden();page.onPageScroll({scrollTop:400});flushNextTicks();expect(restoredOffsets()).not.toContain(800);
    page.onHide();await returnFromHidden();flushNextTicks();expect(restoredOffsets()).toContain(400);
  });

  it("keeps body text in the current rendering only, not in the private return snapshot",async()=>{
    const value=article();await mount(value);page.onPageScroll({scrollTop:800});expect(page.data.item.body).toBe(value.body);
    expect(page.readingRead).toBeDefined();expect(page.readingRead).not.toBeNull();expect(page.readingRead.scrollTop).toBe(800);
    expect(JSON.stringify(page.readingRead)).not.toContain("原文首段");expect(page.readingRead.body).toBeUndefined();expect(page.readingRead.item).toBeUndefined();
  });

  it("drops an offset that the native scroll API failed to restore instead of retrying a false position",async()=>{
    await mount();leaveAt800();await returnFromHidden();wxMock.pageScrollTo.mockImplementationOnce((options:any)=>options.fail({errMsg:"pageScrollTo:fail"}));flushNextTicks();
    expect(restoredOffsets()).toContain(800);expect(page.readingRead.scrollTop).toBe(0);wxMock.pageScrollTo.mockClear();
    page.onHide();await returnFromHidden();flushNextTicks();expect(restoredOffsets()).not.toContain(800);
  });
});

describe("unavailable post navigation distinguishes history from canonical community",()=>{
  it("returns its explicit community CTA to the community tab even with an author under the post",async()=>{
    await mount();m.request.mockRejectedValueOnce({status:404});await page.load();expect(page.data.errorKind).toBe("missing");
    page.backToCommunity();expect(wxMock.navigateBack).not.toHaveBeenCalled();expect(wxMock.switchTab).toHaveBeenCalledWith(expect.objectContaining({url:"/pages/community/index"}));expect(stack.at(-1).route).toBe("pages/community/index");
  });

  it("keeps header Back as real history navigation",async()=>{
    await mount();page.back();expect(wxMock.navigateBack).toHaveBeenCalledOnce();expect(wxMock.switchTab).not.toHaveBeenCalled();expect(stack.at(-1).route).toBe("pages/community-author/index");
  });

  it("serializes community navigation and unlocks an actual failed switch for retry",async()=>{
    await mount();wxMock.switchTab.mockImplementation(()=>{});page.backToCommunity();page.backToCommunity();expect(wxMock.switchTab).toHaveBeenCalledOnce();expect(page.data.leaving).toBe(true);
    wxMock.switchTab.mock.calls[0][0].fail({errMsg:"switchTab:fail"});expect(page.data.leaving).toBe(false);expect(wxMock.showToast).toHaveBeenCalled();
    page.backToCommunity();expect(wxMock.switchTab).toHaveBeenCalledTimes(2);
  });
});
