import {readFileSync} from "node:fs";
import {afterEach,beforeEach,describe,expect,it,vi} from "vitest";

const m=vi.hoisted(()=>({request:vi.fn(),token:"synthetic-gallery-reader"}));
vi.mock("../../apps/miniprogram/services/api",()=>({request:m.request,resumeAuthentication:vi.fn(),beginLegalRenewal:vi.fn(),clearAuthenticationRedirectSuppression:vi.fn()}));
// Comment transport has its own actual-Page and real-HTTP suites. These
// media/article tests isolate that independent read with its valid empty DTO.
vi.mock("../../apps/miniprogram/services/page-requests",()=>({pageRead:(_page:unknown,options:{path:string})=>
 /\/editorial\/articles\/[^/]+\/comments\?/.test(options.path)?Promise.resolve({comments:[],authors:{},commentCount:0,commentsEnabled:true,commentsPolicyVersion:0,canModerate:false,loadedCount:0,hasMore:false,nextCursor:null,truncated:false,preview:false,asOf:"2026-10-28T00:00:00Z"}):m.request(options),cancelPageReads:vi.fn()}));
vi.mock("../../apps/miniprogram/services/layout",()=>({currentChromeStyle:()=>"",motionDuration:()=>0}));
vi.mock("../../apps/miniprogram/services/share",()=>({prepareShareLink:vi.fn(),registerIncomingShare:vi.fn()}));
const id="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",authorId="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const media=(letter:string)=>({id:letter.repeat(64),url:`/v1/editorial/media/${id}/${letter.repeat(64)}`});
const article=()=>({id,version:3,authorId,author:"公开作者",title:"真实比例图片",body:"首段\n\n末段 #护理",publishedAt:"2026-10-26T00:00:00Z",media:[media("d"),media("e")],interactionsEnabled:true,liked:false,saved:false,following:false,isMine:false,likeCount:0,saveCount:0});
let page:any,wxMock:any,windowInfo:any,baseInfo:any,reads:Promise<unknown>[],ticks:Array<()=>void>;
async function createPage(){await import("../../apps/miniprogram/pages/post/index");page.onLoad({id,source:"editorial"});}
async function mount(){await createPage();await page.load();flushTicks();}
const flushTicks=()=>{for(const fn of ticks.splice(0))fn();};
const tap=(index=0,identity=page.data.imageEventId)=>({currentTarget:{dataset:{src:page.data.media[index],index,imageIdentity:identity}}});
const swipe=(current:number,identity=page.data.imageEventId)=>({detail:{current,source:"touch"},currentTarget:{dataset:{imageIdentity:identity}}});
const imageLoad=(index:number,width:number,height:number)=>({...tap(index),detail:{width,height}});
async function show(){page.onShow();await reads.at(-1);}
beforeEach(()=>{
  vi.resetModules();vi.clearAllMocks();m.request.mockReset();m.request.mockResolvedValue(article());m.token="synthetic-gallery-reader";reads=[];ticks=[];
  windowInfo={windowWidth:390,windowHeight:844,screenHeight:844,statusBarHeight:47,safeArea:{bottom:810}};baseInfo={fontSizeSetting:16};
  (globalThis as any).getApp=()=>({globalData:{sessionToken:m.token,apiBaseUrl:"https://synthetic.invalid"}});
  (globalThis as any).Page=(definition:any)=>{page={...definition,data:structuredClone(definition.data),load(...args:any[]){const read=definition.load.apply(this,args);reads.push(Promise.resolve(read));return read;},setData:vi.fn(function(this:any,values:any,callback?:()=>void){Object.assign(this.data,structuredClone(values));callback?.();})};};
  wxMock={getWindowInfo:vi.fn(()=>windowInfo),getAppBaseInfo:vi.fn(()=>baseInfo),
    getImageInfo:vi.fn((options:any)=>options.success({width:1080,height:1440,orientation:"up"})),
    hideShareMenu:vi.fn(),showShareMenu:vi.fn(),showToast:vi.fn(),nextTick:vi.fn((fn:()=>void)=>ticks.push(fn)),
    pageScrollTo:vi.fn(),navigateTo:vi.fn(),navigateBack:vi.fn(),switchTab:vi.fn(),
    previewImage:vi.fn((options:any)=>{options.success?.();options.complete?.();})};
  (globalThis as any).wx=wxMock;
});
afterEach(()=>{vi.useRealTimers();});

describe("published gallery locks one bounded first-image canvas",()=>{
  it.each([[1080,1440,1000],[1000,1000,750],[1500,1000,500],[2000,500,375],[500,2000,1000]])("uses decoded%ix%i metadata, bounded to%irpx",async(width,height,expected)=>{
    wxMock.getImageInfo.mockImplementation((options:any)=>options.success({width,height,orientation:"up"}));await mount();
    expect(wxMock.getImageInfo).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({src:page.data.media[0]}));
    expect(page.data).toMatchObject({galleryHeight:expected,loading:false,item:{id},error:""});
  });
  it.each(["left","right","left-mirrored","right-mirrored"])("respects decoded orientation%s instead of using an unswapped ratio",async(orientation)=>{
    wxMock.getImageInfo.mockImplementation((options:any)=>options.success({width:1600,height:900,orientation}));await mount();expect(page.data.galleryHeight).toBe(1000);
  });
  it.each(["missing","throw","failure","zero"])("renders body with the3:4 fallback when metadata is%s",async(kind)=>{
    if(kind==="missing")delete wxMock.getImageInfo;
    else wxMock.getImageInfo.mockImplementation((options:any)=>{if(kind==="throw")throw new Error("metadata unavailable");if(kind==="failure")options.fail({errMsg:"getImageInfo:fail"});else options.success({width:0,height:0});});
    await mount();expect(page.data).toMatchObject({galleryHeight:1000,loading:false,item:{id},mediaError:"",error:""});
  });
  it("bounds the metadata wait at2500ms and ignores success delivered after the fallback is locked",async()=>{
    vi.useFakeTimers();let metadata:any;wxMock.getImageInfo.mockImplementation((options:any)=>{metadata=options;});await createPage();const load=page.load();await vi.advanceTimersByTimeAsync(0);
    expect(page.data.loading).toBe(true);await vi.advanceTimersByTimeAsync(2499);expect(page.data.loading).toBe(true);
    await vi.advanceTimersByTimeAsync(1);await load;expect(page.data).toMatchObject({galleryHeight:1000,loading:false,item:{id}});
    metadata.success({width:1500,height:1000,orientation:"up"});metadata.fail?.({errMsg:"late failure"});await vi.advanceTimersByTimeAsync(0);expect(page.data.galleryHeight).toBe(1000);expect(vi.getTimerCount()).toBe(0);
    wxMock.getImageInfo.mockImplementation((options:any)=>options.success({width:1080,height:1440,orientation:"up"}));await page.load();expect(wxMock.getImageInfo).toHaveBeenCalledTimes(2);expect(page.data.galleryHeight).toBe(1000);
  });
  it.each(["onHide","onUnload","onResize"])("settles and clears the old metadata timer on%s without waiting2500ms",async(lifecycle)=>{
    vi.useFakeTimers();let metadata:any;wxMock.getImageInfo.mockImplementation((options:any)=>{metadata=options;});await createPage();const complete=vi.fn();const load=page.load().then(complete);await vi.advanceTimersByTimeAsync(0);
    page[lifecycle]();await vi.advanceTimersByTimeAsync(0);expect(complete).toHaveBeenCalledOnce();expect(vi.getTimerCount()).toBe(0);await load;
    const before=structuredClone(page.data);metadata.success({width:1500,height:1000,orientation:"up"});await vi.advanceTimersByTimeAsync(0);expect(page.data).toEqual(before);
  });
  it("does not let an older sizing completion overwrite a newer read or cancel its own sizing intent",async()=>{
    let old:any;wxMock.getImageInfo.mockImplementationOnce((options:any)=>{old=options;}).mockImplementationOnce((options:any)=>options.success({width:1000,height:1000,orientation:"up"}));await createPage();const first=page.load();
    await vi.waitFor(()=>expect(wxMock.getImageInfo).toHaveBeenCalledOnce());await page.load();await first;expect(page.data.galleryHeight).toBe(750);
    old.success({width:1080,height:1440,orientation:"up"});expect(page.data.galleryHeight).toBe(750);
    page.onHide();await show();expect(page.data.galleryHeight).toBe(750);expect(wxMock.getImageInfo).toHaveBeenCalledTimes(2);
  });
  it("reuses verified dimensions for an identical context but still requires a fresh article GET",async()=>{
    await mount();page.onHide();await show();flushTicks();expect(m.request).toHaveBeenCalledTimes(2);expect(wxMock.getImageInfo).toHaveBeenCalledOnce();expect(page.data.galleryHeight).toBe(1000);
  });
  it.each(["actor","version","order","width","font"])("does not reuse a sizing cache across%s changes",async(kind)=>{
    await mount();page.onHide();const next=article();if(kind==="actor")m.token="different-reader";else if(kind==="version")next.version=4;else if(kind==="order")next.media.reverse();else if(kind==="width")windowInfo.windowWidth=375;else baseInfo.fontSizeSetting=20;
    m.request.mockResolvedValue(next);wxMock.getImageInfo.mockImplementation((options:any)=>options.success({width:1000,height:1000,orientation:"up"}));await show();expect(wxMock.getImageInfo).toHaveBeenCalledTimes(2);expect(page.data.galleryHeight).toBe(750);
  });
  it("keeps one group canvas when neighbor images load or the selected image changes",async()=>{
    await mount();page.mediaLoaded(imageLoad(1,2000,500));expect(page.data.galleryHeight).toBe(1000);page.onMediaChange(swipe(1));expect(page.data.mediaIndex).toBe(1);
    page.mediaLoaded(imageLoad(1,500,2000));page.mediaLoaded(imageLoad(0,1500,1000));expect(page.data.galleryHeight).toBe(1000);
  });
  it("always rechecks images[0] after an uncached failure even when returning from image two",async()=>{
    wxMock.getImageInfo.mockImplementationOnce((options:any)=>options.fail({errMsg:"temporary failure"}));await mount();const firstSrc=page.data.media[0];page.onMediaChange(swipe(1));page.onHide();await show();
    expect(wxMock.getImageInfo).toHaveBeenNthCalledWith(2,expect.objectContaining({src:firstSrc}));expect(page.data.mediaIndex).toBe(1);
  });
  it("waits for matching final canvas geometry before restoring a reading offset",async()=>{
    wxMock.getImageInfo.mockImplementationOnce((options:any)=>options.fail({errMsg:"temporary failure"}));await mount();page.onPageScroll({scrollTop:800});page.onHide();
    let metadata:any;wxMock.getImageInfo.mockImplementationOnce((options:any)=>{metadata=options;});page.onShow();await vi.waitFor(()=>expect(wxMock.getImageInfo).toHaveBeenCalledTimes(2));
    expect(wxMock.pageScrollTo).not.toHaveBeenCalled();metadata.success({width:1000,height:1000,orientation:"up"});await reads.at(-1);flushTicks();
    expect(page.data.galleryHeight).toBe(750);expect(wxMock.pageScrollTo.mock.calls.map(([options]:any[])=>options.scrollTop)).not.toContain(800);
  });
});

describe("native gallery events and preview intents remain current",()=>{
  it("serializes rapid preview taps while native preview presentation is pending",async()=>{
    await mount();let native:any;wxMock.previewImage.mockImplementation((options:any)=>{native=options;});const first=page.previewMedia(tap());const second=page.previewMedia(tap());
    await vi.waitFor(()=>expect(wxMock.previewImage).toHaveBeenCalledOnce());await page.previewMedia(tap());expect(wxMock.previewImage).toHaveBeenCalledOnce();native.success?.();native.complete?.();await Promise.all([first,second]);
  });
  it("releases its preparation lock on native success even on clients that never hide the page",async()=>{
    await mount();let native:any;wxMock.previewImage.mockImplementationOnce((options:any)=>{native=options;});const first=page.previewMedia(tap());await vi.waitFor(()=>expect(wxMock.previewImage).toHaveBeenCalledOnce());
    native.success();await first;expect(page.readVisible).toBe(true);await page.previewMedia(tap());expect(wxMock.previewImage).toHaveBeenCalledTimes(2);
  });
  it.each(["author","actor","new-read","hide","unload"])("does not open a pending preview after%s changes",async(kind)=>{
    await mount();const opening=page.previewMedia(tap());if(kind==="author")page.openAuthor();else if(kind==="actor")m.token="different-reader";else if(kind==="new-read")await page.load();else if(kind==="hide")page.onHide();else page.onUnload();
    await opening;expect(wxMock.previewImage).not.toHaveBeenCalled();expect(wxMock.showToast).not.toHaveBeenCalled();
  });
  it("ignores an old read's tap at the same URL while allowing the current image",async()=>{
    await mount();const old=tap();await page.load();await page.previewMedia(old);expect(wxMock.previewImage).not.toHaveBeenCalled();await page.previewMedia(tap());expect(wxMock.previewImage).toHaveBeenCalledOnce();
  });
  it("does not let an old preview completion or failure unlock a different opening intent",async()=>{
    await mount();const native:any[]=[];wxMock.previewImage.mockImplementation((options:any)=>native.push(options));const old=page.previewMedia(tap());await vi.waitFor(()=>expect(native).toHaveLength(1));
    page.onHide();await show();flushTicks();const current=page.previewMedia(tap());await vi.waitFor(()=>expect(native).toHaveLength(2));native[0].success?.();native[0].fail?.({errMsg:"old failure"});native[0].complete?.();
    await page.previewMedia(tap());expect(native).toHaveLength(2);expect(wxMock.showToast).not.toHaveBeenCalled();native[1].success?.();native[1].complete?.();await Promise.all([old,current]);
  });
  it("allows retry after the current native preview fails",async()=>{
    await mount();wxMock.previewImage.mockImplementationOnce((options:any)=>{options.fail?.({errMsg:"previewImage:fail"});options.complete?.();});await page.previewMedia(tap());expect(wxMock.showToast).toHaveBeenCalledOnce();
    await page.previewMedia(tap());expect(wxMock.previewImage).toHaveBeenCalledTimes(2);
  });
  it("rejects stale, hidden and out-of-range swiper callbacks without moving the current image",async()=>{
    await mount();const stale=swipe(1);await page.load();page.onMediaChange(stale);expect(page.data.mediaIndex).toBe(0);
    for(const index of [-1,2,1.5,NaN,Infinity])page.onMediaChange(swipe(index));page.onMediaChange({detail:{current:1},currentTarget:{dataset:{}}});expect(page.data.mediaIndex).toBe(0);
    page.onMediaChange(swipe(1));expect(page.data.mediaIndex).toBe(1);page.setData.mockClear();page.onMediaChange(swipe(1));expect(page.setData).not.toHaveBeenCalled();
    const visible=swipe(0);page.onHide();page.onMediaChange(visible);expect(page.data.mediaIndex).toBe(1);
  });
  it("lets the native swipe scroll freely and suppresses only the moved gesture's accidental tap",async()=>{
    await mount();const markup=readFileSync(new URL("../../apps/miniprogram/pages/post/index.wxml",import.meta.url),"utf8");const surface=markup.match(/<swiper\b[^>]*class="post-swiper"[^>]*>/)?.[0];expect(surface).toBeDefined();
    const start=surface!.match(/bindtouchstart="([^"]+)"/)?.[1],move=surface!.match(/bindtouchmove="([^"]+)"/)?.[1];expect(start).toBeTruthy();expect(move).toBeTruthy();expect(surface).not.toMatch(/catchtouch(?:start|move)/);
    const touch=(x:number,y:number)=>({currentTarget:{dataset:{imageIdentity:page.data.imageEventId}},touches:[{identifier:1,clientX:x,clientY:y,pageX:x,pageY:y}],changedTouches:[{identifier:1,clientX:x,clientY:y,pageX:x,pageY:y}]});
    page.setData.mockClear();page[start!](touch(10,10));page[move!](touch(30,10));expect(page.setData).not.toHaveBeenCalled();await page.previewMedia(tap());expect(wxMock.previewImage).not.toHaveBeenCalled();
    page[start!](touch(30,10));await page.previewMedia(tap());expect(wxMock.previewImage).toHaveBeenCalledOnce();
  });
});
