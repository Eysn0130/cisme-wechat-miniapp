import {beforeEach,afterEach,describe,expect,it,vi} from "vitest";
const m=vi.hoisted(()=>({request:vi.fn(),upload:vi.fn(),token:"member-a"}));
vi.mock("../../apps/miniprogram/services/api",()=>({request:m.request,uploadAuthorized:m.upload,resumeAuthentication:vi.fn()}));
vi.mock("../../apps/miniprogram/services/layout",()=>({currentChromeStyle:()=>""}));
vi.mock("../../apps/miniprogram/services/commerce-command-store",()=>({commerceContextRevision:()=>1}));
const owner="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",post="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",image="cccccccc-cccc-4ccc-8ccc-cccccccccccc";
let definition:any,wxMock:any,storage:Map<string,unknown>,pages:any[];
const deferred=()=>{let resolve!:(value:any)=>void,reject!:(error:any)=>void;return{promise:new Promise<any>((yes,no)=>{resolve=yes;reject=no;}),resolve,reject};};
const flush=async()=>{for(let i=0;i<30;i++)await Promise.resolve();};
const draft=(patch:Record<string,unknown>={})=>({id:post,ownerId:owner,state:"draft",version:1,revision:1,title:"",body:"",aiUsage:"unknown",rightsConfirmed:false,publicConsentConfirmed:false,publicVersionActive:false,media:[],...patch});
function instance(patch:Record<string,unknown>={}){const page={...definition,data:{...structuredClone(definition.data),...patch},readRevision:1,lastSessionToken:m.token,
  setData(value:Record<string,unknown>,callback?:()=>void){Object.assign(this.data,value);callback?.();}};pages.push(page);return page;}
function editor(patch:Record<string,unknown>={}){return instance({postId:post,ownerId:owner,version:1,loading:false,body:"本次真实感受",dirty:true,publicGateEnabled:true,draftsEnabled:true,
  rightsConfirmed:true,publicConsentConfirmed:true,...patch});}
beforeEach(async()=>{
  vi.resetModules();m.request.mockReset();m.upload.mockReset().mockResolvedValue(undefined);m.token="member-a";storage=new Map();pages=[];
  wxMock={getStorageSync:(key:string)=>storage.get(key),setStorageSync:(key:string,value:unknown)=>storage.set(key,structuredClone(value)),removeStorageSync:(key:string)=>storage.delete(key),
    enableAlertBeforeUnload:vi.fn(),disableAlertBeforeUnload:vi.fn(),showActionSheet:vi.fn(),showModal:vi.fn(),navigateBack:vi.fn(),switchTab:vi.fn(),navigateTo:vi.fn(),hideKeyboard:vi.fn(),
    requirePrivacyAuthorize:({success}:any)=>success(),chooseMedia:vi.fn(),previewImage:vi.fn(),getFileSystemManager:()=>({readFile:({success}:any)=>success({data:new Uint8Array([255,216,255]).buffer})})};
  Object.assign(globalThis,{wx:wxMock,getApp:()=>({globalData:{sessionToken:m.token}}),Page:(value:any)=>{definition=value;}});
  await import("../../apps/miniprogram/pages/community-compose/index");
});
afterEach(()=>{for(const page of pages)if(page.backupTimer)clearTimeout(page.backupTimer);});
describe("community composer command ownership",()=>{
  it("uses a distinct creation key per new page and creates only once across onLoad/onShow",async()=>{
    m.request.mockImplementation(async({path,method}:any)=>path==="/v1/ugc/status"?{publicEnabled:false,draftsEnabled:true}:method==="POST"?draft():{items:[],matchingTotal:0,nextCursor:null});
    const first=instance();first.onLoad({new:"1"});first.onShow();await flush();
    const second=instance();second.onLoad({new:"1"});second.onShow();await flush();
    const writes=m.request.mock.calls.map(([value])=>value).filter(value=>value.method==="POST");
    expect(writes).toHaveLength(2);expect(writes[0].idempotencyKey).not.toBe(writes[1].idempotencyKey);
    expect(first.data).toMatchObject({postId:post,requestedNew:false,publicGateEnabled:false,draftsEnabled:true});
  });
  it("retries an unknown create with the same intent key",async()=>{
    let creates=0;m.request.mockImplementation(async({path,method}:any)=>{if(path==="/v1/ugc/status")return {publicEnabled:false,draftsEnabled:true};if(method==="POST"){if(++creates===1)throw {code:"NETWORK_TIMEOUT"};return draft();}return {items:[]};});
    const page=instance();page.onLoad({new:"1"});page.onShow();await flush();expect(page.data.requestedNew).toBe(true);
    page.retryLoad();await flush();const writes=m.request.mock.calls.map(([value])=>value).filter(value=>value.method==="POST");
    expect(writes).toHaveLength(2);expect(writes[1].idempotencyKey).toBe(writes[0].idempotencyKey);expect(page.data.postId).toBe(post);
  });
  it("keeps unknown draft capability from creating private data",async()=>{
    m.request.mockImplementation(async({path}:any)=>{if(path==="/v1/ugc/status")throw {code:"NETWORK_ERROR"};return {items:[],matchingTotal:0,nextCursor:null};});
    const page=instance();page.onLoad({new:"1"});page.onShow();await flush();
    expect(page.data.draftsEnabled).toBe(false);expect(m.request.mock.calls.some(([value])=>value.method==="POST")).toBe(false);
  });
  it("confirms a committed save after a lost response without repeating the PUT",async()=>{
    const page=editor();page.mediaVisible=true;
    m.request.mockImplementation(async({method}:any)=>{if(method==="PUT")throw {code:"NETWORK_TIMEOUT"};return draft({version:2,body:page.data.body,aiUsage:"generated",rightsConfirmed:true,publicConsentConfirmed:true});});
    const saved=await page.saveDraft();expect(saved?.version).toBe(2);expect(page.data).toMatchObject({version:2,dirty:false,writeRecovery:"",busy:false});
    expect(m.request.mock.calls.filter(([value])=>value.method==="PUT")).toHaveLength(1);
  });
  it("confirms an unknown submission from the server state without resubmitting",async()=>{
    const page=editor();page.mediaVisible=true;const content={body:page.data.body,rightsConfirmed:true,publicConsentConfirmed:true};
    m.request.mockImplementation(async({path,method}:any)=>{if(method==="PUT")return draft({...content,version:2});if(method==="POST")throw {code:"NETWORK_TIMEOUT"};return draft({...content,state:"pending_review",version:3});});
    await page.submit();expect(page.data).toMatchObject({state:"pending_review",version:3,writeRecovery:"",busy:false});
    const submit=m.request.mock.calls.map(([value])=>value).filter(value=>value.path.endsWith("/submit"));expect(submit).toHaveLength(1);expect(submit[0].data).not.toHaveProperty("aiDeclarationChosen");
  });
  it("preserves local text on a version conflict until explicit reload",async()=>{
    const page=editor();page.mediaVisible=true;m.request.mockImplementation(async({method}:any)=>{if(method==="PUT")throw {status:409,code:"UGC_VERSION_CONFLICT"};return draft({body:"另一处更新",version:2});});
    await page.saveDraft();expect(page.data).toMatchObject({body:"本次真实感受",dirty:true,writeRecovery:"conflict"});
    await page.submit();expect(m.request.mock.calls.filter(([value])=>value.method==="POST")).toHaveLength(0);
  });
  it("does not chain a submit after its save completes on an unloaded page",async()=>{
    const save=deferred(),page=editor();page.mediaVisible=true;m.request.mockImplementation(()=>save.promise);
    const pending=page.submit();page.onUnload();save.resolve(draft({version:2}));await pending;
    expect(m.request.mock.calls.map(([value])=>value.method)).toEqual(["PUT"]);
  });
  it("saves and submits without sending AI inputs while preserving explicit rights and public-consent checks",async()=>{
    const page=editor({rightsConfirmed:false,publicConsentConfirmed:false});page.mediaVisible=true;let version=1;
    m.request.mockImplementation(async({method,data}:any)=>method==="PUT"?draft({...data,version:++version}):draft({state:"pending_review",version:++version}));
    await page.saveDraft();expect(m.request).toHaveBeenCalledOnce();
    await page.submit();expect(m.request).toHaveBeenCalledOnce();expect(page.data.error).toContain("内容权利和公开展示范围");expect(page.data.settingsExpanded).toBe(true);
    page.changeRights({detail:{value:true}});page.changeConsent({detail:{value:true}});await page.submit();
    expect(page.data).toMatchObject({state:"pending_review",settingsExpanded:false});
    for(const [request] of m.request.mock.calls){expect(request.data).not.toHaveProperty("aiUsage");expect(request.data).not.toHaveProperty("aiDeclarationChosen");}
    expect(page.data).not.toHaveProperty("aiOptions");expect(page.data).not.toHaveProperty("aiDeclarationChosen");expect(page.changeAi).toBeUndefined();
  });
  it("only toggles publish settings while editing is available and folds them for a loaded draft",()=>{
    const page=editor({keyboardVisible:true});page.mediaVisible=true;page.togglePublishSettings();expect(page.data).toMatchObject({settingsExpanded:true,keyboardVisible:false});expect(wxMock.hideKeyboard).toHaveBeenCalledOnce();
    page.data.uploadBusy=true;page.togglePublishSettings();expect(page.data.settingsExpanded).toBe(true);
    page.data.uploadBusy=false;page.data.writeRecovery="save";page.togglePublishSettings();expect(page.data.settingsExpanded).toBe(true);
    page.data.writeRecovery="";page.togglePublishSettings();expect(page.data.settingsExpanded).toBe(false);expect(wxMock.hideKeyboard).toHaveBeenCalledOnce();
    page.data.settingsExpanded=true;page.applyDraft(draft());expect(page.data.settingsExpanded).toBe(false);
    page.data.settingsExpanded=true;page.onHide();expect(page.data.settingsExpanded).toBe(false);
  });
  it("clears only the exact consent error once both confirmations are present",()=>{
    const consentError="请先确认内容权利和公开展示范围。",page=editor({rightsConfirmed:false,publicConsentConfirmed:false,error:consentError});
    page.changeRights({detail:{value:true}});expect(page.data.error).toBe(consentError);
    page.changeConsent({detail:{value:true}});expect(page.data.error).toBe("");
    page.data.error="提交结果暂未确认，请稍后核对。";page.data.writeRecovery="submit";
    page.changeRights({detail:{value:false}});page.changeRights({detail:{value:true}});page.changeConsent({detail:{value:true}});
    expect(page.data).toMatchObject({error:"提交结果暂未确认，请稍后核对。",writeRecovery:"submit"});
  });
  it("retains a genuine chooser result across native hide/show without uploading in the background",async()=>{
    const chosen=deferred(),page=editor({files:[]});page.mediaVisible=true;wxMock.chooseMedia.mockReturnValue(chosen.promise);
    m.request.mockImplementation(async({path}:any)=>path==="/v1/ugc/status"?{draftsEnabled:true,publicEnabled:true}:path.endsWith("/authorize")?{mediaId:image,url:"synthetic",method:"PUT",fields:{}}:path.endsWith("preview-url")?{url:"synthetic-preview"}:{});
    const choosing=page.chooseImages();await flush();page.onHide();chosen.resolve({tempFiles:[{tempFilePath:"/synthetic/picture.jpg",size:100}]});await flush();
    expect(m.upload).not.toHaveBeenCalled();page.onShow();await choosing;
    expect(m.upload).not.toHaveBeenCalled();expect(page.data).toMatchObject({photoEditorVisible:true,photoEditorFiles:[{path:"/synthetic/picture.jpg",size:100}]});
    await page.photoEditorConfirmed({detail:{contextKey:page.data.photoEditorContext,files:page.data.photoEditorFiles}});
    expect(page.data.files).toEqual([expect.objectContaining({id:image,state:"uploaded"})]);expect(page.data).toMatchObject({uploadBusy:false,dirty:true});
  });
  it("drops a chooser result after unload or account change",async()=>{
    const chosen=deferred(),page=editor();page.mediaVisible=true;wxMock.chooseMedia.mockReturnValue(chosen.promise);
    const choosing=page.chooseImages();await flush();page.onUnload();chosen.resolve({tempFiles:[{tempFilePath:"/synthetic/private.jpg",size:100}]});await choosing;
    expect(m.upload).not.toHaveBeenCalled();expect(page.data.files).toEqual([]);
  });
  it("restores failed local image choices honestly with their owning text backup",async()=>{
    const page=editor({files:[{id:"local-image",localPath:"/synthetic/picture.jpg",previewUrl:"",size:100,state:"failed",progress:0,error:"上传失败"}]});page.mediaVisible=true;page.flushLocalBackup();
    const restored=instance();restored.mediaVisible=true;restored.applyDraft(draft());
    expect(restored.data).toMatchObject({body:"本次真实感受",dirty:true});
    expect(restored.data.files).toEqual([expect.objectContaining({state:"failed",localPath:"/synthetic/picture.jpg"})]);
    await restored.saveDraft();expect(m.request).not.toHaveBeenCalled();
  });
  it("ignores retired AI values in old backups and omits them from every new backup",()=>{
    const page=editor();page.mediaVisible=true;page.flushLocalBackup();
    const key=[...storage.keys()].find(value=>value.startsWith("cisme.ugcDraftBackup.v2."))!;
    storage.set(key,{...(storage.get(key) as Record<string,unknown>),aiUsage:"generated",aiDeclarationChosen:true});
    const restored=instance();restored.mediaVisible=true;restored.applyDraft(draft({aiUsage:"assisted"}));
    expect(restored.data).toMatchObject({body:"本次真实感受",dirty:true});
    expect(restored.data).not.toHaveProperty("aiUsage");expect(restored.data).not.toHaveProperty("aiIndex");expect(restored.data).not.toHaveProperty("aiDeclarationChosen");
    restored.flushLocalBackup();const rewritten=storage.get(key);expect(rewritten).not.toHaveProperty("aiUsage");expect(rewritten).not.toHaveProperty("aiDeclarationChosen");
  });
  it("does not navigate away when an asynchronous exit save returns after unload",async()=>{
    const save=deferred(),page=editor();page.mediaVisible=true;wxMock.showActionSheet.mockResolvedValue({tapIndex:0});m.request.mockReturnValue(save.promise);
    const leaving=page.back();await flush();page.onUnload();save.resolve(draft({version:2}));await leaving;expect(wxMock.navigateBack).not.toHaveBeenCalled();
  });
  it("requests state filtering from the server and drops the old filter page",async()=>{
    const old=deferred(),page=instance();page.mediaVisible=true;
    m.request.mockImplementation(({path}:any)=>path.includes("state=all")?old.promise:Promise.resolve({items:[{id:post,title:"审核稿",state:"pending_review",version:3,imageCount:0}],matchingTotal:1,nextCursor:null}));
    const first=page.loadList();page.selectDraftFilter({currentTarget:{dataset:{state:"pending_review"}}});await flush();old.resolve({items:[{id:"old",title:"旧草稿",state:"draft"}],matchingTotal:8,nextCursor:"old"});await first;
    expect(page.data).toMatchObject({draftFilter:"pending_review",listTotal:1,listCursor:null});expect(page.data.drafts.map((item:any)=>item.id)).toEqual([post]);
    expect(m.request.mock.calls.some(([value])=>value.path.includes("state=pending_review"))).toBe(true);
  });
  it("restores the editor after native preview without losing dirty text",async()=>{
    const page=editor({files:[{id:image,localPath:"/synthetic/image.jpg",previewUrl:"",size:100,state:"uploaded",progress:100,error:""}]});page.mediaVisible=true;
    m.request.mockResolvedValue({draftsEnabled:true,publicEnabled:false});page.previewImage({currentTarget:{dataset:{id:image}}});page.onHide();
    expect(page.nativeMedia).toBe("preview");page.onShow();await flush();expect(page.data).toMatchObject({body:"本次真实感受",dirty:true,uploadBusy:false});expect(page.data.files[0].id).toBe(image);
  });
  it("keeps another account's late creation response out of the editor",async()=>{
    const created=deferred(),page=instance();page.mediaVisible=true;
    m.request.mockImplementation(({method}:any)=>method==="POST"?created.promise:Promise.resolve({publicEnabled:false,draftsEnabled:true,items:[],matchingTotal:0,nextCursor:null}));
    page.onLoad({new:"1"});page.onShow();await flush();m.token="member-b";page.onShow();created.resolve(draft({body:"member-a private"}));await flush();
    expect(page.data.postId).toBe("");expect(page.data.body).toBe("");expect(page.data.listMode).toBe(true);
  });
  it("clears only the confirmed deleted post backup after an unknown delete result",async()=>{
    const page=editor();page.mediaVisible=true;page.flushLocalBackup();
    const other=editor({postId:"dddddddd-dddd-4ddd-8ddd-dddddddddddd",body:"另一篇仍需保留"});other.flushLocalBackup();
    page.data.listMode=true;page.data.drafts=[{id:post,title:"我的草稿",state:"draft",version:1,imageCount:0}];wxMock.showModal.mockResolvedValue({confirm:true});
    let ownReads=0;m.request.mockImplementation(async({path,method}:any)=>{if(method==="DELETE")throw {code:"NETWORK_TIMEOUT"};if(path===`/v1/me/ugc/posts/${post}`)return draft({state:++ownReads===1?"draft":"deleted",version:ownReads});return {items:[],matchingTotal:0,nextCursor:null};});
    await page.deleteListDraft({currentTarget:{dataset:{id:post}}});await flush();
    expect([...storage.keys()].some(key=>key.includes(post))).toBe(false);expect([...storage.keys()].some(key=>key.includes(other.data.postId))).toBe(true);
    expect(m.request.mock.calls.filter(([value])=>value.method==="DELETE")).toHaveLength(1);
  });
  it("never deletes an existing public version through a draft deletion, including a stale list row",async()=>{
    const page=instance({listMode:true,loading:false,drafts:[{id:post,title:"新版草稿",state:"draft",version:3,imageCount:0,publicVersionActive:true}]});page.mediaVisible=true;
    await page.deleteListDraft({currentTarget:{dataset:{id:post}}});expect(wxMock.showModal).not.toHaveBeenCalled();expect(m.request).not.toHaveBeenCalled();
    page.data.drafts[0].publicVersionActive=undefined;wxMock.showModal.mockResolvedValue({confirm:true});m.request.mockResolvedValue(draft({version:3,publicVersionActive:true}));
    await page.deleteListDraft({currentTarget:{dataset:{id:post}}});expect(page.data.error).toContain("仍有已发布版本");
    expect(m.request.mock.calls.filter(([value])=>value.method==="DELETE")).toHaveLength(0);expect(page.data.busy).toBe(false);
  });
  it("uses the same dirty guard for the list and community exits",async()=>{
    const page=editor();page.mediaVisible=true;wxMock.showActionSheet.mockResolvedValue({tapIndex:1});
    await page.showMyPosts();await page.returnToCommunity();expect(wxMock.showActionSheet).toHaveBeenCalledTimes(2);expect(wxMock.switchTab).not.toHaveBeenCalled();expect(page.data.postId).toBe(post);
    wxMock.showActionSheet.mockResolvedValue({tapIndex:2});await page.returnToCommunity();expect(wxMock.switchTab).toHaveBeenCalledWith(expect.objectContaining({url:"/pages/community/index"}));
  });
  it("allows an informed exit from an unresolved write without claiming to discard an already sent operation",async()=>{
    const page=editor();page.mediaVisible=true;m.request.mockRejectedValue({code:"NETWORK_TIMEOUT"});await page.saveDraft();
    wxMock.showModal.mockResolvedValue({confirm:true});await page.showMyPosts();
    expect(wxMock.showActionSheet).not.toHaveBeenCalled();expect(wxMock.showModal).toHaveBeenCalledWith(expect.objectContaining({content:expect.stringContaining("离开不会撤销"),cancelText:"继续核对"}));
    expect(page.data.listMode).toBe(true);expect(page.pendingWrite).toBeNull();expect([...storage.keys()].some(key=>key.includes(post))).toBe(true);
  });
  it("ignores a delayed image error from an older preview URL or page epoch",()=>{
    const page=editor({epoch:3,files:[{id:image,localPath:"",previewUrl:"new-preview",size:100,state:"uploaded",progress:100,error:""}]});page.mediaVisible=true;
    page.previewFailed({currentTarget:{dataset:{id:image,epoch:2,preview:"new-preview"}}});
    page.previewFailed({currentTarget:{dataset:{id:image,epoch:3,preview:"old-preview"}}});expect(page.data.files[0].previewUrl).toBe("new-preview");
    page.previewFailed({currentTarget:{dataset:{id:image,epoch:3,preview:"new-preview"}}});expect(page.data.files[0].previewUrl).toBe("");
  });
  it("releases the chooser busy state when a native chooser is cancelled while hidden",async()=>{
    const chosen=deferred(),page=editor();page.mediaVisible=true;wxMock.chooseMedia.mockReturnValue(chosen.promise);m.request.mockResolvedValue({draftsEnabled:true,publicEnabled:false});
    const choosing=page.chooseImages();await flush();page.onHide();chosen.reject({errMsg:"chooseMedia:fail cancel"});await flush();page.onShow();await choosing;
    expect(page.data).toMatchObject({uploadBusy:false,body:"本次真实感受"});
  });
  it("releases recovery controls when a delayed known rejection settles during a return-state check",async()=>{
    const saving=deferred(),checking=deferred(),page=editor();page.mediaVisible=true;
    m.request.mockImplementation(({method,path}:any)=>method==="PUT"?saving.promise:path==="/v1/ugc/status"?Promise.resolve({draftsEnabled:true,publicEnabled:true}):checking.promise);
    const pending=page.saveDraft();page.onHide();page.onShow();await flush();expect(page.data.recoveryBusy).toBe(true);
    saving.reject({status:422,title:"请修正内容"});await pending;expect(page.data).toMatchObject({busy:false,recoveryBusy:false,writeRecovery:"",dirty:true});
    checking.resolve(draft());await flush();expect(page.data.error).toBe("请修正内容");
  });
  it("keeps an unchanged server version unresolved and allows a retained-input exit",async()=>{
    const page=editor();page.mediaVisible=true;m.request.mockImplementation(async({method}:any)=>{if(method==="PUT")throw {code:"NETWORK_TIMEOUT"};return draft();});
    await page.saveDraft();expect(page.data).toMatchObject({writeRecovery:"save",recoveryBusy:false,dirty:true});expect(page.pendingWrite).not.toBeNull();
    wxMock.showModal.mockResolvedValue({confirm:true});expect(await page.confirmLeave()).toBe(true);expect(wxMock.showActionSheet).not.toHaveBeenCalled();
    expect(m.request.mock.calls.filter(([value])=>value.method==="PUT")).toHaveLength(1);
  });
  it("resumes a readonly preview cancelled by hide even when a valid local image still exists",async()=>{
    const first=deferred(),page=editor({state:"pending_review",dirty:false,files:[{id:image,localPath:"/synthetic/image.jpg",previewUrl:"",size:100,state:"uploaded",progress:100,error:""}]});page.mediaVisible=true;
    let previews=0;m.request.mockImplementation(({path,registerAbort}:any)=>{
      if(path.endsWith("preview-url")){if(++previews===1){registerAbort?.(()=>first.reject({code:"REQUEST_ABORTED"}));return first.promise;}return Promise.resolve({url:"fresh-preview"});}
      return Promise.resolve({draftsEnabled:true,publicEnabled:false});});
    const loading=page.loadMediaPreviews([image],page.data.epoch,m.token,post);page.onHide();await loading;
    expect(page.data.files[0]).toMatchObject({localPath:"/synthetic/image.jpg",previewUrl:"",error:""});
    page.onShow();await flush();expect(previews).toBe(2);expect(page.data.files[0]).toMatchObject({localPath:"/synthetic/image.jpg",previewUrl:"fresh-preview",error:""});
  });
  it("compares readonly image errors against their actual remote-first source and preserves a local fallback",()=>{
    const page=editor({state:"pending_review",epoch:4,files:[{id:image,localPath:"/synthetic/image.jpg",previewUrl:"fresh-preview",size:100,state:"uploaded",progress:100,error:""}]});page.mediaVisible=true;
    page.previewFailed({currentTarget:{dataset:{id:image,epoch:4,preview:"/synthetic/image.jpg"}}});expect(page.data.files[0].previewUrl).toBe("fresh-preview");
    page.previewFailed({currentTarget:{dataset:{id:image,epoch:4,preview:"fresh-preview"}}});expect(page.data.files[0]).toMatchObject({previewUrl:"",localPath:"/synthetic/image.jpg"});
  });
  it.each(["pending_review","awaiting_publication"])("opens %s images using the rendered remote-first source and a local fallback when needed",state=>{
    const second="dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    const page=editor({state,files:[{id:image,localPath:"/synthetic/expired.jpg",previewUrl:"fresh-preview",size:100,state:"uploaded",progress:100,error:""},
      {id:second,localPath:"/synthetic/local-fallback.jpg",previewUrl:"",size:100,state:"uploaded",progress:100,error:""}]});page.mediaVisible=true;
    page.previewImage({currentTarget:{dataset:{id:image}}});
    expect(wxMock.previewImage).toHaveBeenLastCalledWith(expect.objectContaining({current:"fresh-preview",urls:["fresh-preview","/synthetic/local-fallback.jpg"]}));
    page.previewImage({currentTarget:{dataset:{id:second}}});
    expect(wxMock.previewImage).toHaveBeenLastCalledWith(expect.objectContaining({current:"/synthetic/local-fallback.jpg",urls:["fresh-preview","/synthetic/local-fallback.jpg"]}));
  });
  it("reloads the exact post after its public detail returns and reflects a confirmed deletion",async()=>{
    const page=editor({state:"published",publicVersionActive:true,dirty:false});page.mediaVisible=true;
    m.request.mockImplementation(async({path}:any)=>path==="/v1/ugc/status"?{draftsEnabled:true,publicEnabled:true}:draft({state:"deleted",version:5,publicVersionActive:false}));
    page.openPublishedPost();page.onHide();page.onShow();await flush();
    expect(page.data).toMatchObject({state:"deleted",publicVersionActive:false,version:5,dirty:false,recoveryBusy:false});
    expect(m.request.mock.calls.some(([value])=>value.path===`/v1/me/ugc/posts/${post}`)).toBe(true);expect(m.request.mock.calls.some(([value])=>value.method)).toBe(false);
  });
  it("keeps dirty text and images when public-detail deletion returns, and exits without offering an impossible save",async()=>{
    const files=[{id:image,localPath:"/synthetic/image.jpg",previewUrl:"known-preview",size:100,state:"uploaded",progress:100,error:""}];
    const page=editor({state:"published",publicVersionActive:true,title:"未保存标题",files});page.mediaVisible=true;
    m.request.mockImplementation(async({path}:any)=>path==="/v1/ugc/status"?{draftsEnabled:true,publicEnabled:true}:path===`/v1/me/ugc/posts/${post}`?draft({state:"deleted",version:5,body:"旧服务端正文",publicVersionActive:false}):{items:[],matchingTotal:0,nextCursor:null});
    page.openPublishedPost();page.onHide();page.onShow();await flush();
    expect(page.data).toMatchObject({state:"deleted",publicVersionActive:false,version:1,dirty:true,title:"未保存标题",body:"本次真实感受",files});
    await page.saveDraft();expect(m.request.mock.calls.some(([value])=>value.method)).toBe(false);
    wxMock.showModal.mockResolvedValue({confirm:true});await page.showMyPosts();await flush();
    expect(wxMock.showActionSheet).not.toHaveBeenCalled();expect(wxMock.showModal).toHaveBeenCalledWith(expect.objectContaining({title:"这篇内容已删除",content:expect.stringContaining("离开后无法从投稿列表找回")}));
    expect([...storage.keys()].some(key=>key.includes(post))).toBe(true);expect(page.data.listMode).toBe(true);
  });
  it("drops a public-detail return read after its account changes",async()=>{
    const latest=deferred(),page=editor({state:"published",publicVersionActive:true,dirty:false});page.mediaVisible=true;
    m.request.mockImplementation(({path}:any)=>path===`/v1/me/ugc/posts/${post}`?latest.promise:Promise.resolve({draftsEnabled:true,publicEnabled:true,items:[],matchingTotal:0,nextCursor:null}));
    page.openPublishedPost();page.onHide();page.onShow();await flush();m.token="member-b";page.onShow();
    latest.resolve(draft({state:"deleted",version:5}));await flush();expect(page.data).toMatchObject({postId:"",ownerId:"",body:"",listMode:true});
  });
  it("preserves hidden dirty input across hide/show and refuses a stale-version appeal without discarding it",async()=>{
    const files=[{id:image,localPath:"/synthetic/image.jpg",previewUrl:"known-preview",size:100,state:"uploaded",progress:100,error:""}];
    const page=editor({state:"hidden",title:"未保存修改",files});page.mediaVisible=true;page.shown=true;
    m.request.mockResolvedValue({draftsEnabled:true,publicEnabled:false});page.onHide();page.onShow();await flush();
    expect(page.data).toMatchObject({state:"hidden",dirty:true,title:"未保存修改",body:"本次真实感受",files,version:1});
    expect(m.request.mock.calls.some(([value])=>value.path===`/v1/me/ugc/posts/${post}`)).toBe(false);
    await page.submitAppeal();expect(m.request.mock.calls.some(([value])=>value.method==="POST")).toBe(false);expect(wxMock.showModal).not.toHaveBeenCalled();
    expect(page.data.error).toContain("重新打开后再申请申诉");
    page.syncUnloadWarning();expect(wxMock.enableAlertBeforeUnload).toHaveBeenLastCalledWith({message:"修改尚未保存，请先保留需要的内容。"});
  });
  it.each(["hidden","deleted"])("preserves dirty local input when an unknown save reads a different %s snapshot and blocks reloading it away",async state=>{
    const files=[{id:image,localPath:"/synthetic/local.jpg",previewUrl:"known-preview",size:100,state:"uploaded",progress:100,error:""}];
    const page=editor({title:"本机未保存标题",files,publicVersionActive:true});page.mediaVisible=true;
    m.request.mockImplementation(async({method}:any)=>{if(method==="PUT")throw {status:409,code:"UGC_VERSION_CONFLICT"};return draft({state,version:4,title:"服务端旧标题",body:"服务端已有正文",hiddenReason:"处理记录",publicVersionActive:false});});
    expect(await page.saveDraft()).toBeNull();expect(page.data).toMatchObject({state,publicVersionActive:false,version:1,dirty:true,title:"本机未保存标题",body:"本次真实感受",files,writeRecovery:"",recoveryBusy:false,hiddenReason:"处理记录"});
    expect(page.pendingWrite).toBeNull();expect(page.data.notice).toContain("离开后无法从投稿列表找回");
    const reads=m.request.mock.calls.length;await page.reloadRemoteDraft();await page.submit();await page.submitAppeal();
    expect(page.data).toMatchObject({dirty:true,title:"本机未保存标题",body:"本次真实感受",files,version:1});expect(m.request.mock.calls).toHaveLength(reads);
    expect(m.request.mock.calls.some(([value])=>value.method==="POST")).toBe(false);
  });
  it.each(["hidden","deleted"])("prioritizes a matching %s terminal fact over marking an uncertain save successful",async state=>{
    const page=editor();page.mediaVisible=true;
    m.request.mockImplementation(async({method}:any)=>{if(method==="PUT")throw {code:"NETWORK_TIMEOUT"};return draft({state,version:4,body:page.data.body,rightsConfirmed:true,publicConsentConfirmed:true});});
    expect(await page.saveDraft()).toBeNull();expect(page.data).toMatchObject({state,version:1,dirty:true,writeRecovery:"",busy:false});
    expect([...storage.keys()].some(key=>key.includes(post))).toBe(true);expect(page.data.notice).not.toBe("草稿已保存。");
  });
  it.each(["hidden","deleted"])("keeps local input when %s is first discovered inside reload's asynchronous exit check",async state=>{
    const files=[{id:image,localPath:"/synthetic/local.jpg",previewUrl:"known-preview",size:100,state:"uploaded",progress:100,error:""}];
    const page=editor({title:"本机未保存标题",files});page.mediaVisible=true;let reads=0;
    m.request.mockImplementation(async({method}:any)=>{if(method==="PUT")throw {code:"NETWORK_TIMEOUT"};if(++reads===1)throw {code:"NETWORK_ERROR"};return draft({state,version:5,title:"服务端标题",body:"服务端正文"});});
    await page.saveDraft();expect(page.data).toMatchObject({state:"draft",writeRecovery:"save",dirty:true});expect(page.pendingWrite).not.toBeNull();
    const load=vi.spyOn(page,"loadDraft");wxMock.showModal.mockResolvedValue({confirm:true});await page.reloadRemoteDraft();
    expect(load).not.toHaveBeenCalled();expect(page.data).toMatchObject({state,dirty:true,title:"本机未保存标题",body:"本次真实感受",files,version:1,writeRecovery:""});
    expect(wxMock.showModal).toHaveBeenCalledOnce();expect(wxMock.showModal).toHaveBeenCalledWith(expect.objectContaining({title:state==="deleted"?"这篇内容已删除":"这篇内容已下架",content:expect.stringContaining("离开后无法从投稿列表找回")}));
    expect(reads).toBe(2);expect(m.request.mock.calls.some(([value])=>value.method==="POST")).toBe(false);
  });
});
