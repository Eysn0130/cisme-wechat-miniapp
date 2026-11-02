import {beforeEach,describe,expect,it,vi} from "vitest";
const m=vi.hoisted(()=>({request:vi.fn(),resume:vi.fn(),token:"member-a",revision:1}));
vi.mock("../../apps/miniprogram/services/api",()=>({request:m.request,resumeAuthentication:m.resume}));
vi.mock("../../apps/miniprogram/services/layout",()=>({currentChromeStyle:()=>""}));
vi.mock("../../apps/miniprogram/services/commerce-command-store",()=>({commerceContextRevision:()=>m.revision}));
vi.mock("../../apps/miniprogram/services/performance-metrics",()=>({measurementClock:()=>0,recordClientMetric:vi.fn()}));
vi.mock("../../apps/miniprogram/services/editorial",()=>({editorialStoriesForRuntime:()=>[],editorialMediaSrc:()=>"",publishedEditorialArticles:vi.fn(async()=>({items:[],nextCursor:null})),expiredEditorialRead:()=>false}));
let definition:any,page:any,wxMock:any,route:string,nonce:number,api:typeof import("../../apps/miniprogram/services/community-compose-intent");
const deferred=()=>{let resolve!:(value:any)=>void,reject!:(value:any)=>void;return{promise:new Promise<any>((yes,no)=>{resolve=yes;reject=no;}),resolve,reject};};
const event=(source:string)=>({currentTarget:{dataset:{source}}});
const file={tempFilePath:"/synthetic/selected.jpg",size:100};
const flush=async()=>{for(let i=0;i<40;i++)await Promise.resolve();};
function navigationIntent(){return new URLSearchParams(wxMock.navigateTo.mock.calls.at(-1)[0].url.split("?")[1]).get("intent")!;}
beforeEach(async()=>{
  vi.resetModules();m.request.mockReset().mockResolvedValue({draftsEnabled:true,publicEnabled:false});m.resume.mockReset();m.token="member-a";m.revision=1;nonce=0;route="pages/community/index";
  wxMock={navigateTo:vi.fn(),showToast:vi.fn(),requirePrivacyAuthorize:vi.fn(({success}:any)=>success()),chooseMedia:vi.fn().mockResolvedValue({tempFiles:[file]}),
    openSetting:vi.fn(({success}:any)=>success()),getRandomValues:vi.fn(({length,success}:any)=>success({randomValues:new Uint8Array(length).fill(++nonce).buffer})),
    getStorageSync:vi.fn(),setStorageSync:vi.fn(),removeStorageSync:vi.fn(),getFileSystemManager:()=>({readFile:({success}:any)=>success({data:new Uint8Array([255,216,255]).buffer})})};
  Object.assign(globalThis,{wx:wxMock,getApp:()=>({globalData:{sessionToken:m.token,apiBaseUrl:"https://synthetic.invalid"}}),getCurrentPages:()=>[{route}],Page:(value:any)=>{definition=value;}});
  await import("../../apps/miniprogram/pages/community/index");api=await import("../../apps/miniprogram/services/community-compose-intent");
  const tab={setData:vi.fn(),syncActive:vi.fn(),setPresentation:vi.fn(),setCommunityPublisherAvailable:vi.fn()};
  page={...definition,data:{...structuredClone(definition.data),signedIn:true,ugcDraftsEnabled:true,loading:false},load:vi.fn(),getTabBar:()=>tab,
    setData(patch:any,callback?:()=>void){Object.assign(this.data,patch);callback?.();}};
});
describe("community native creation entry",()=>{
  it("opens and cancels the three-way chooser without creating a draft or opening native media",()=>{
    page.openPublisher();expect(page.data.publishEntryOpen).toBe(true);expect(m.request).not.toHaveBeenCalled();expect(wxMock.navigateTo).not.toHaveBeenCalled();expect(wxMock.chooseMedia).not.toHaveBeenCalled();
    page.closePublisherEntry();expect(page.data).toMatchObject({publishEntryOpen:false,publishEntryBusy:false});expect(page.publisherOwner).toBeNull();
  });
  it("routes text after a fresh capability read without privacy or media calls",async()=>{
    page.openPublisher();await page.choosePublisherSource(event("text"));
    expect(wxMock.navigateTo).toHaveBeenCalledWith(expect.objectContaining({url:"/pages/community-compose/index?new=1&entry=text"}));
    expect(wxMock.requirePrivacyAuthorize).not.toHaveBeenCalled();expect(wxMock.chooseMedia).not.toHaveBeenCalled();expect(m.request.mock.calls.every(([value])=>!value.method)).toBe(true);
  });
  it.each([["album",9],["camera",1]] as const)("uses only %s and hands off validated local media with count %i",async(source,count)=>{
    page.openPublisher();await page.choosePublisherSource(event(source));
    expect(wxMock.chooseMedia).toHaveBeenCalledWith(expect.objectContaining({sourceType:[source],count,mediaType:["image"]}));
    const id=navigationIntent(),url=wxMock.navigateTo.mock.calls[0][0].url;expect(url).not.toContain(file.tempFilePath);expect(url).not.toContain(m.token);
    expect(api.consumeComposeMediaIntent(id,{sessionToken:m.token,revision:m.revision})).toEqual({source,files:[{path:file.tempFilePath,size:file.size}]});
    expect(m.request).toHaveBeenCalledTimes(2);expect(m.request.mock.calls.every(([value])=>!value.method)).toBe(true);expect(wxMock.setStorageSync).not.toHaveBeenCalled();
  });
  it("preserves the intent across its own successful navigation hide until the composer consumes it",async()=>{
    page.openPublisher();await page.choosePublisherSource(event("album"));const id=navigationIntent();wxMock.navigateTo.mock.calls[0][0].success();route="pages/community-compose/index";page.onHide();
    expect(api.consumeComposeMediaIntent(id,{sessionToken:m.token,revision:m.revision})).not.toBeNull();
  });
  it.each(["cancel","empty"])("leaves native %s selection with zero draft writes and no error",async kind=>{
    wxMock.chooseMedia.mockImplementation(()=>kind==="cancel"?Promise.reject({errMsg:"chooseMedia:fail cancel"}):Promise.resolve({tempFiles:[]}));
    page.openPublisher();await page.choosePublisherSource(event("album"));
    expect(page.data).toMatchObject({publishEntryOpen:true,publishEntryBusy:false,publishEntryError:""});expect(wxMock.navigateTo).not.toHaveBeenCalled();expect(wxMock.getRandomValues).not.toHaveBeenCalled();expect(m.request.mock.calls.every(([value])=>!value.method)).toBe(true);
  });
  it("offers source-specific settings only after a camera refusal and never automatically relaunches the camera",async()=>{
    wxMock.chooseMedia.mockRejectedValue({errMsg:"chooseMedia:fail auth deny"});page.openPublisher();await page.choosePublisherSource(event("camera"));
    expect(page.data).toMatchObject({publishEntryRecovery:"settings",publishEntrySource:"camera"});expect(page.data.publishEntryError).toContain("相机权限");expect(wxMock.openSetting).not.toHaveBeenCalled();
    await page.openPublisherMediaSettings();expect(wxMock.openSetting).toHaveBeenCalledOnce();expect(wxMock.chooseMedia).toHaveBeenCalledOnce();expect(page.data.publishEntryError).toContain("再次选择相机");
  });
  it("requires an explicit privacy retry before opening the selected media source",async()=>{
    wxMock.requirePrivacyAuthorize.mockImplementationOnce(({fail}:any)=>fail({errMsg:"privacy deny"}));page.openPublisher();await page.choosePublisherSource(event("album"));
    expect(page.data).toMatchObject({publishEntryRecovery:"privacy",publishEntryBusy:false});expect(wxMock.chooseMedia).not.toHaveBeenCalled();expect(wxMock.openSetting).not.toHaveBeenCalled();
    await page.retryPublisherMedia();expect(wxMock.requirePrivacyAuthorize).toHaveBeenCalledTimes(2);expect(wxMock.chooseMedia).toHaveBeenCalledWith(expect.objectContaining({sourceType:["album"]}));
  });
  it("retains a valid selection over native hide/show but waits for visibility and a fresh gate",async()=>{
    const chosen=deferred();wxMock.chooseMedia.mockReturnValue(chosen.promise);page.openPublisher();const selecting=page.choosePublisherSource(event("album"));await flush();
    page.onHide();chosen.resolve({tempFiles:[file]});await flush();expect(wxMock.navigateTo).not.toHaveBeenCalled();expect(wxMock.getRandomValues).not.toHaveBeenCalled();
    page.onShow();await selecting;expect(wxMock.navigateTo).toHaveBeenCalledOnce();expect(m.request).toHaveBeenCalledTimes(2);
  });
  it("keeps the FAB mounted on native return while resetting and freshly confirming capability under the sheet",async()=>{
    m.request.mockImplementation(async({path}:any)=>path==="/v1/ugc/status"?{draftsEnabled:true,publicEnabled:false}:path==="/v1/capabilities"?{communityPreviewEnabled:false}:path==="/v1/me/tasks"?[]:{items:[],authors:{},nextCursor:null,canReview:false});
    page.openPublisher();page.publisherNative="picker";const tab=page.getTabBar(),render=vi.spyOn(page,"setData");page.load=definition.load.bind(page);
    page.onHide();page.onShow();await vi.waitFor(()=>expect(page.data.loading).toBe(false));
    expect(tab.setCommunityPublisherAvailable.mock.calls.some(([available]:any[])=>available===false)).toBe(false);
    expect(tab.setCommunityPublisherAvailable).toHaveBeenLastCalledWith(true,"写仅自己可见的草稿");
    expect(render.mock.calls.some(([patch]:any[])=>patch.ugcDraftsEnabled===false)).toBe(true);
    expect(m.request.mock.calls.some(([value])=>value.path==="/v1/ugc/status")).toBe(true);expect(page.data.publishEntryOpen).toBe(true);
  });
  it("unmounts an old FAB if the sheet closes before capability is known",()=>{
    page.openPublisher();page.data.ugcDraftsEnabled=false;page.closePublisherEntry();expect(page.getTabBar().setCommunityPublisherAvailable).toHaveBeenLastCalledWith(false);
    page.openPublisher();expect(page.data.publishEntryOpen).toBe(false);expect(wxMock.navigateTo).not.toHaveBeenCalled();
  });
  it("drops a late picker result after genuinely leaving the community",async()=>{
    const chosen=deferred();wxMock.chooseMedia.mockReturnValue(chosen.promise);page.openPublisher();const selecting=page.choosePublisherSource(event("camera"));await flush();
    route="pages/profile/index";page.onHide();chosen.resolve({tempFiles:[file]});await selecting;expect(page.data.publishEntryOpen).toBe(false);expect(wxMock.navigateTo).not.toHaveBeenCalled();expect(wxMock.getRandomValues).not.toHaveBeenCalled();
  });
  it("drops a late native selection after the account or environment changes",async()=>{
    const chosen=deferred();wxMock.chooseMedia.mockReturnValue(chosen.promise);page.openPublisher();const selecting=page.choosePublisherSource(event("album"));await flush();
    page.onHide();m.token="member-b";m.revision=2;page.onShow();chosen.resolve({tempFiles:[file]});await selecting;expect(wxMock.navigateTo).not.toHaveBeenCalled();expect(page.publisherOwner).toBeNull();
  });
  it("clears the chooser when its visible session changes before a native result returns",async()=>{
    const chosen=deferred();wxMock.chooseMedia.mockReturnValue(chosen.promise);page.openPublisher();const selecting=page.choosePublisherSource(event("album"));await flush();
    m.token="member-b";chosen.resolve({tempFiles:[file]});await selecting;
    expect(page.data).toMatchObject({publishEntryOpen:false,publishEntryBusy:false});expect(page.publisherOwner).toBeNull();expect(wxMock.navigateTo).not.toHaveBeenCalled();
  });
  it("rechecks a gate that closed while the picker was open and does not hand off",async()=>{
    m.request.mockResolvedValueOnce({draftsEnabled:true}).mockResolvedValueOnce({draftsEnabled:false});page.openPublisher();await page.choosePublisherSource(event("album"));
    expect(page.data.ugcDraftsEnabled).toBe(false);expect(page.data.publishEntryError).toContain("暂不能新建草稿");expect(wxMock.navigateTo).not.toHaveBeenCalled();expect(wxMock.getRandomValues).not.toHaveBeenCalled();
  });
  it("revokes a selected handoff when navigation fails and leaves a usable chooser",async()=>{
    page.openPublisher();await page.choosePublisherSource(event("album"));const id=navigationIntent();wxMock.navigateTo.mock.calls[0][0].fail();
    expect(api.consumeComposeMediaIntent(id,{sessionToken:m.token,revision:m.revision})).toBeNull();expect(page.data).toMatchObject({publishEntryOpen:true,publishEntryBusy:false,navigating:false});expect(page.data.publishEntryError).toContain("创作页暂时无法打开");
  });
  it("does not hand off an invalid image or a cancelled secure-random operation",async()=>{
    wxMock.chooseMedia.mockResolvedValueOnce({tempFiles:[{...file,size:10*1024*1024+1}]});page.openPublisher();await page.choosePublisherSource(event("album"));
    expect(page.data.publishEntryError).toContain("10MB");expect(wxMock.getRandomValues).not.toHaveBeenCalled();expect(wxMock.navigateTo).not.toHaveBeenCalled();
    let complete!:(value:any)=>void;wxMock.getRandomValues.mockImplementation(({success}:any)=>{complete=success;});
    const selecting=page.choosePublisherSource(event("album"));await flush();page.closePublisherEntry();complete({randomValues:new Uint8Array(24).fill(9).buffer});await selecting;
    expect(page.data).toMatchObject({publishEntryOpen:false,publishEntryError:""});expect(wxMock.navigateTo).not.toHaveBeenCalled();expect(api.consumeComposeMediaIntent("mi_"+"09".repeat(24),{sessionToken:m.token,revision:m.revision})).toBeNull();
  });
  it("keeps a separate draft-management route without requesting media or creating a new draft",()=>{
    page.openPublisher();page.openMyPosts();expect(page.data.publishEntryOpen).toBe(false);expect(wxMock.navigateTo).toHaveBeenCalledWith(expect.objectContaining({url:"/pages/community-compose/index"}));expect(m.request).not.toHaveBeenCalled();expect(wxMock.requirePrivacyAuthorize).not.toHaveBeenCalled();
  });
});
