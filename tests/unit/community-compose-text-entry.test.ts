import {afterEach,beforeEach,expect,it,vi} from "vitest";
import {readFile} from "node:fs/promises";
const m=vi.hoisted(()=>({request:vi.fn(),upload:vi.fn(),token:"member-a",revision:1}));
vi.mock("../../apps/miniprogram/services/api",()=>({request:m.request,uploadAuthorized:m.upload,resumeAuthentication:vi.fn()}));
vi.mock("../../apps/miniprogram/services/layout",()=>({currentChromeStyle:()=>""}));
vi.mock("../../apps/miniprogram/services/commerce-command-store",()=>({commerceContextRevision:()=>m.revision}));
const owner="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",post="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",asset="cccccccc-cccc-4ccc-8ccc-cccccccccccc";
let definition:any,wxMock:any,fs:any,pages:any[],storage:Map<string,unknown>;
let backups:typeof import("../../apps/miniprogram/services/ugc-local-backup");
const flush=async()=>{for(let i=0;i<100;i++)await Promise.resolve();};
const deferred=()=>{let resolve!:(value:any)=>void,reject!:(error:any)=>void;return {promise:new Promise<any>((yes,no)=>{resolve=yes;reject=no;}),resolve,reject};};
const draft=(patch:Record<string,unknown>={})=>({id:post,ownerId:owner,state:"draft",version:1,title:"",body:"",media:[],publicVersionActive:false,...patch});
function defaultRequest(options:any):Promise<any>{
  if(options.path==="/v1/ugc/status")return Promise.resolve({publicEnabled:false,draftsEnabled:true});
  if(options.path==="/v1/me/ugc/posts"&&options.method==="POST")return Promise.resolve(draft());
  if(options.path.endsWith("/draft"))return Promise.resolve(draft({...options.data,version:options.data.expectedVersion+1}));
  if(options.path.endsWith("/authorize"))return Promise.resolve({mediaId:asset,url:"synthetic-upload",method:"PUT",fields:{}});
  if(options.path.endsWith("/complete"))return Promise.resolve({id:asset,state:"uploaded"});
  if(options.path.endsWith("/preview-url"))return Promise.resolve({url:"synthetic-preview"});
  return Promise.resolve({items:[],matchingTotal:0,nextCursor:null});
}
function instance(patch:Record<string,unknown>={}){const page={...definition,data:{...structuredClone(definition.data),...patch},readRevision:m.revision,lastSessionToken:m.token,
  setData(patch:Record<string,unknown>){Object.assign(this.data,patch);}};pages.push(page);return page;}
function editor(patch:Record<string,unknown>={}){const page=instance({postId:post,ownerId:owner,version:1,loading:false,draftsEnabled:true,...patch});page.mediaVisible=true;return page;}
async function entry(){const page=instance();page.onLoad({new:"1",entry:"text"});page.onShow();await flush();return page;}
const changed=(page:any,text="卡片里的可编辑文字",template="care")=>page.textCardChanged({detail:{contextKey:page.data.textCardContext,text,template}});
const confirmation=(page:any,patch:Record<string,unknown>={})=>({detail:{contextKey:page.data.textCardContext,text:page.data.textCardText,template:page.data.textCardTemplate,tempFilePath:"/synthetic/card.png",size:120,...patch}});
const creates=()=>m.request.mock.calls.filter(([o])=>o.path==="/v1/me/ugc/posts"&&o.method==="POST");
const writes=()=>m.request.mock.calls.filter(([o])=>o.method);
beforeEach(async()=>{
  vi.resetModules();m.token="member-a";m.revision=1;m.request.mockReset().mockImplementation(defaultRequest);m.upload.mockReset().mockResolvedValue(undefined);pages=[];storage=new Map();
  fs={readFile:vi.fn(({success}:any)=>success({data:new Uint8Array([137,80,78,71,13,10,26,10]).buffer})),getFileInfo:vi.fn(({success}:any)=>success({size:120}))};
  wxMock={getFileSystemManager:()=>fs,getStorageSync:(key:string)=>storage.get(key),setStorageSync:(key:string,value:unknown)=>storage.set(key,structuredClone(value)),removeStorageSync:(key:string)=>storage.delete(key),
    enableAlertBeforeUnload:vi.fn(),disableAlertBeforeUnload:vi.fn(),hideKeyboard:vi.fn(),showActionSheet:vi.fn(),showModal:vi.fn(),navigateBack:vi.fn(),switchTab:vi.fn(),nextTick:vi.fn()};
  Object.assign(globalThis,{wx:wxMock,getApp:()=>({globalData:{sessionToken:m.token}}),Page:(value:any)=>{definition=value;}});
  backups=await import("../../apps/miniprogram/services/ugc-local-backup");await import("../../apps/miniprogram/pages/community-compose/index");
});
afterEach(()=>{for(const page of pages){if(page.backupTimer)clearTimeout(page.backupTimer);}vi.unstubAllGlobals();});

it("keeps new input and all template changes local until a checked PNG is handed off once, with an empty publisher body",async()=>{
  const page=await entry();expect(page.data).toMatchObject({postId:"",ownerId:"",version:0,textCardVisible:true});
  expect(page.textCardOpenContext).toMatchObject({postId:"",ownerId:"",version:0,origin:"entry"});expect(page.textCardOpenContext.entryNonce).toBeTruthy();
  changed(page);changed(page,"卡片中的最终文字","border");page.flushLocalBackup();expect(writes()).toHaveLength(0);expect(storage.size).toBe(0);
  const event=confirmation(page),confirming=page.confirmTextCard(event);await page.confirmTextCard(event);await confirming;
  expect(creates()).toHaveLength(1);expect(creates()[0]![0].idempotencyKey).toBe(page.data.createKey);
  expect(fs.getFileInfo).toHaveBeenCalledWith(expect.objectContaining({filePath:"/synthetic/card.png"}));
  expect(page.data).toMatchObject({postId:post,ownerId:owner,version:1,body:"",title:"",textCardText:"卡片中的最终文字",textCardTemplate:"border",textCardVisible:false});
  expect(m.upload).toHaveBeenCalledOnce();expect(page.data.files).toEqual([expect.objectContaining({id:asset,state:"uploaded"})]);
  page.flushLocalBackup();expect(backups.readUgcBackup(owner,post,1)).toMatchObject({body:"",textCardText:"卡片中的最终文字",textCardTemplate:"border",mediaIds:[asset]});
});
it.each(["size","mime","missing","empty","over300"])("does not create or upload a card rejected for %s, and retains its input",async boundary=>{
  const page=await entry();changed(page,"需要保留的输入","memo");
  if(boundary==="size")fs.getFileInfo.mockImplementationOnce(({success}:any)=>success({size:121}));
  if(boundary==="mime")fs.readFile.mockImplementationOnce(({success}:any)=>success({data:new Uint8Array([255,216,255]).buffer}));
  if(boundary==="missing")fs.getFileInfo.mockImplementationOnce(({fail}:any)=>fail({errMsg:"not found"}));
  const event=confirmation(page,boundary==="empty"?{text:"\u200b   "}:boundary==="over300"?{text:"护".repeat(301)}:{});
  await page.confirmTextCard(event);expect(writes()).toHaveLength(0);expect(m.upload).not.toHaveBeenCalled();
  expect(page.data).toMatchObject({postId:"",ownerId:"",body:"",textCardText:"需要保留的输入",textCardTemplate:"memo",textCardVisible:true,busy:false,textCardHandoffPath:""});
  expect(page.data.error).toContain("输入仍保留");
});
it.each(["account","environment","version","epoch","unload"])("rejects a file-info result arriving after the %s scope changed",async boundary=>{
  const page=await entry();changed(page);let options:any;fs.getFileInfo.mockImplementationOnce((value:any)=>{options=value;});
  const confirming=page.confirmTextCard(confirmation(page));await flush();
  if(boundary==="account")m.token="member-b";else if(boundary==="environment")m.revision+=1;else if(boundary==="version")page.data.version=1;else if(boundary==="epoch")page.data.epoch+=1;else page.onUnload();
  options.success({size:120});await confirming;expect(creates()).toHaveLength(0);expect(m.upload).not.toHaveBeenCalled();
});
it("requires an explicit same-key retry after an unknown create and never uploads before its confirmed response",async()=>{
  const page=await entry();changed(page);let calls=0;
  m.request.mockImplementation((options:any)=>{if(options.path==="/v1/me/ugc/posts"&&options.method==="POST"){calls+=1;return calls===1?Promise.reject({status:503}):Promise.resolve(draft());}return defaultRequest(options);});
  await page.confirmTextCard(confirmation(page));const key=creates()[0]![0].idempotencyKey;
  expect(page.pendingLocalText).toMatchObject({text:"卡片里的可编辑文字",sent:true});expect(m.upload).not.toHaveBeenCalled();expect(page.data).toMatchObject({body:"",busy:false,operation:"idle",textCardHandoffPath:"/synthetic/card.png"});
  page.onHide();page.onShow();await flush();expect(creates()).toHaveLength(1);
  page.retryLoad();await flush();expect(creates()).toHaveLength(2);expect(creates()[1]![0].idempotencyKey).toBe(key);
  expect(m.upload).toHaveBeenCalledOnce();expect(page.pendingLocalText).toBeNull();expect(page.data).toMatchObject({body:"",textCardText:"卡片里的可编辑文字",ownerId:owner});
});
it.each(["account","environment","unload"])("does not adopt an old owner's create response or import its card after %s",async boundary=>{
  const creation=deferred(),page=await entry();changed(page);
  m.request.mockImplementation((options:any)=>options.path==="/v1/me/ugc/posts"&&options.method==="POST"?creation.promise:defaultRequest(options));
  const confirming=page.confirmTextCard(confirmation(page));await flush();expect(creates()).toHaveLength(1);
  if(boundary==="account"){m.token="member-b";page.onShow();}else if(boundary==="environment"){m.revision+=1;page.onShow();}else page.onUnload();
  creation.resolve(draft());await confirming;expect(page.data).toMatchObject({postId:"",textCardHandoffPath:""});expect(m.upload).not.toHaveBeenCalled();
});
it("adopts a known create success on return without retrying POST or uploading while hidden",async()=>{
  const creation=deferred(),page=await entry();changed(page);
  m.request.mockImplementation((options:any)=>options.path==="/v1/me/ugc/posts"&&options.method==="POST"?creation.promise:defaultRequest(options));
  const confirming=page.confirmTextCard(confirmation(page));await flush();page.onHide();creation.resolve(draft());await confirming;
  expect(page.pendingLocalText?.draft).toMatchObject({id:post});expect(page.data).toMatchObject({postId:"",textCardHandoffPath:"/synthetic/card.png"});expect(m.upload).not.toHaveBeenCalled();
  page.onShow();await flush();expect(creates()).toHaveLength(1);expect(m.upload).toHaveBeenCalledOnce();expect(page.data).toMatchObject({body:"",textCardHandoffPath:""});
});
it("refuses a newly closed private-draft capability before creating, while retaining the accepted card for explicit retry",async()=>{
  const page=await entry();changed(page);
  m.request.mockImplementation((options:any)=>options.path==="/v1/ugc/status"?Promise.resolve({draftsEnabled:false,publicEnabled:false}):defaultRequest(options));
  await page.confirmTextCard(confirmation(page));expect(creates()).toHaveLength(0);expect(m.upload).not.toHaveBeenCalled();expect(page.pendingLocalText?.text).toBe("卡片里的可编辑文字");
  expect(page.data.error).toContain("不能新建草稿");
});
it.each(["empty","discard"])("leaves an %s local entry without POST or DELETE",async mode=>{
  const page=await entry();if(mode==="discard"){changed(page);wxMock.showActionSheet.mockResolvedValue({tapIndex:2});}
  page.cancelTextCard({detail:{contextKey:page.data.textCardContext}});await flush();expect(writes()).toHaveLength(0);expect(m.upload).not.toHaveBeenCalled();expect(wxMock.navigateBack).toHaveBeenCalledOnce();
});
it("reopens local text and its selected template with a fresh key after Continue and after hide/show, rejecting the old key",async()=>{
  const page=await entry();changed(page,"护理输入不等于正文","minimal");const oldKey=page.data.textCardContext;wxMock.showActionSheet.mockResolvedValue({tapIndex:1});
  page.cancelTextCard({detail:{contextKey:oldKey}});await flush();expect(page.data.textCardContext).not.toBe(oldKey);
  const nextKey=page.data.textCardContext;page.onHide();page.onShow();await flush();expect(page.data.textCardContext).not.toBe(nextKey);
  page.textCardChanged({detail:{contextKey:oldKey,text:"过期内容",template:"plain"}});
  expect(page.data).toMatchObject({textCardText:"护理输入不等于正文",textCardTemplate:"minimal",body:"",postId:"",textCardVisible:true});
  expect(writes()).toHaveLength(0);expect(storage.size).toBe(0);
});
it("does not refill deliberately cleared card text from an existing body on background return",async()=>{
  const page=editor({body:"原有正文需要保留"});page.openTextCard();changed(page,"","memo");const oldKey=page.data.textCardContext;
  page.onHide();page.onShow();await flush();expect(page.data.textCardContext).not.toBe(oldKey);
  expect(page.data).toMatchObject({textCardText:"",textCardTemplate:"memo",body:"原有正文需要保留",textCardVisible:true});
});
it("creates and saves raw text only after an explicit Save on exit, without generating or uploading an image",async()=>{
  const page=await entry();changed(page,"用户明确选择保存的原始文字","memo");wxMock.showActionSheet.mockResolvedValue({tapIndex:0});
  page.cancelTextCard({detail:{contextKey:page.data.textCardContext}});await flush();
  expect(creates()).toHaveLength(1);expect(m.request).toHaveBeenCalledWith({path:`/v1/me/ugc/posts/${post}/draft`,method:"PUT",data:{expectedVersion:1,title:"",body:"用户明确选择保存的原始文字",mediaIds:[]}});
  expect(m.upload).not.toHaveBeenCalled();expect(fs.getFileInfo).not.toHaveBeenCalled();expect(wxMock.navigateBack).toHaveBeenCalledOnce();expect(page.data.body).toBe("用户明确选择保存的原始文字");
});
it("uses direct-body intent to transfer local text, while an old direct-body event neither creates nor focuses",async()=>{
  const page=await entry();changed(page,"直接作为可编辑正文","care");const oldKey=page.data.textCardContext;page.onHide();page.onShow();await flush();
  page.cancelTextCard({detail:{contextKey:oldKey,mode:"body"}});await flush();expect(creates()).toHaveLength(0);
  page.cancelTextCard({detail:{contextKey:page.data.textCardContext,mode:"body"}});await flush();
  expect(creates()).toHaveLength(1);expect(page.data).toMatchObject({body:"直接作为可编辑正文",bodyFocused:true,postId:post,ownerId:owner});expect(m.upload).not.toHaveBeenCalled();
});
it.each(["plain","lilac","memo","minimal","care","border"])("restores %s and independent card text only for its exact authenticated post version",template=>{
  backups.writeUgcBackup({ownerId:owner,postId:post,baseVersion:2,title:"原标题",body:"已有正文",textCardText:"独立制卡文字",textCardTemplate:template as any,mediaIds:[],savedAt:Date.now()});
  const page=editor();page.applyDraft(draft({version:2}));expect(page.data).toMatchObject({body:"已有正文",textCardText:"独立制卡文字",textCardTemplate:template,dirty:true});
  page.openTextCard();expect(page.data.textCardText).toBe("独立制卡文字");
  const other=editor();other.applyDraft(draft({version:3,body:"服务端当前正文"}));expect(other.data).toMatchObject({body:"服务端当前正文",textCardText:"",textCardTemplate:"plain",dirty:false});
  const anotherOwner=editor();anotherOwner.applyDraft(draft({version:2,ownerId:asset}));expect(anotherOwner.data.textCardText).toBe("");
});
it("restores a legacy backup without inventing card text and normalizes an unknown stored template",()=>{
  backups.writeUgcBackup({ownerId:owner,postId:post,baseVersion:1,title:"",body:"旧稿原始正文",textCardTemplate:"unrecognized" as any,mediaIds:[],savedAt:Date.now()});
  const page=editor();page.applyDraft(draft());expect(page.data).toMatchObject({body:"旧稿原始正文",textCardText:"",textCardTemplate:"plain"});
  page.openTextCard();expect(page.data.textCardText).toBe("旧稿原始正文");expect(page.data.body).toBe("旧稿原始正文");
});
it("preserves a long existing body and all nine assets instead of shortening text or evicting an image",()=>{
  const body="护".repeat(301),page=editor({body});page.openTextCard();expect(page.data.textCardVisible).toBe(false);expect(page.data.body).toBe(body);
  const files=Array.from({length:9},(_,i)=>({id:`asset-${i}`,state:"uploaded"}));page.setData({body:"保留正文",files});page.openTextCard();expect(page.data.files).toBe(files);expect(page.data.textCardVisible).toBe(false);expect(writes()).toHaveLength(0);
});
it("keeps existing body and eight ordered assets when a current card becomes the ninth image",async()=>{
  const files=Array.from({length:8},(_,i)=>({id:`asset-${i}`,state:"uploaded",size:120,localPath:"",previewUrl:"",progress:100,error:""})),page=editor({body:"保留既有正文",files});
  page.openTextCard();changed(page,"只出现在配图里的文字","border");await page.confirmTextCard(confirmation(page));
  expect(creates()).toHaveLength(0);expect(page.data.body).toBe("保留既有正文");expect(page.data.files.map((f:any)=>f.id)).toEqual([...files.map(f=>f.id),asset]);
});
it("rejects existing-card change/confirm after a version advance, and retains its body and assets",async()=>{
  const page=editor({body:"已经存在的正文"});page.openTextCard();const event=confirmation(page,{text:"旧版本卡片"}),oldKey=page.data.textCardContext;
  page.data.version=2;page.textCardChanged({detail:{contextKey:oldKey,text:"过期文字",template:"border"}});await page.confirmTextCard(event);
  expect(page.data.body).toBe("已经存在的正文");expect(page.data.files).toEqual([]);expect(writes()).toHaveLength(0);expect(m.upload).not.toHaveBeenCalled();
});
it("preserves the canonical text and ordered media of a nonpristine create replay instead of uploading or overwriting them",async()=>{
  const page=await entry();changed(page,"只保留在本机的待核对卡片文字","lilac");
  m.request.mockImplementation((options:any)=>options.path==="/v1/me/ugc/posts"&&options.method==="POST"?Promise.resolve(draft({version:2,title:"并发保存的标题",body:"服务端已有并发正文",media:[{id:asset,state:"uploaded"}]})):defaultRequest(options));
  await page.confirmTextCard(confirmation(page));expect(page.data).toMatchObject({title:"并发保存的标题",body:"服务端已有并发正文",version:2,textCardText:"只保留在本机的待核对卡片文字",textCardTemplate:"lilac",dirty:true,writeRecovery:"conflict"});
  expect(page.data.files.map((file:any)=>file.id)).toEqual([asset]);expect(m.upload).not.toHaveBeenCalled();
  expect(m.request.mock.calls.some(([options])=>options.path.endsWith("/authorize"))).toBe(false);
});
it("keeps existing body unless its author explicitly confirms replacement, retaining card input on cancellation",async()=>{
  const page=editor({body:"不应默默消失的已有正文"});page.openTextCard();changed(page,"想转为正文的卡片文字","memo");
  const oldKey=page.data.textCardContext;wxMock.showModal.mockResolvedValueOnce({confirm:false});
  page.cancelTextCard({detail:{contextKey:oldKey,mode:"body"}});await flush();
  expect(page.data).toMatchObject({body:"不应默默消失的已有正文",textCardText:"想转为正文的卡片文字",textCardTemplate:"memo",textCardVisible:true,bodyFocused:false});expect(page.data.textCardContext).not.toBe(oldKey);
  wxMock.showModal.mockResolvedValueOnce({confirm:true});page.cancelTextCard({detail:{contextKey:page.data.textCardContext,mode:"body"}});await flush();
  expect(page.data.body).toBe("想转为正文的卡片文字");expect(wxMock.nextTick).toHaveBeenCalledOnce();expect(writes()).toHaveLength(0);
});
it.each(["version","account"])("rejects a late replace-body confirmation after %s changes",async boundary=>{
  const answer=deferred(),page=editor({body:"继续保留的服务端正文"});page.openTextCard();changed(page,"旧scope的替换文字");wxMock.showModal.mockReturnValue(answer.promise);
  page.cancelTextCard({detail:{contextKey:page.data.textCardContext,mode:"body"}});await flush();
  if(boundary==="version")page.data.version+=1;else m.token="member-b";
  answer.resolve({confirm:true});await flush();expect(page.data.body).toBe("继续保留的服务端正文");expect(wxMock.nextTick).not.toHaveBeenCalled();expect(writes()).toHaveLength(0);
});
it("does not turn an unknown create into a false discard or delete it on exit",async()=>{
  const page=await entry();changed(page);m.request.mockImplementation((options:any)=>options.path==="/v1/me/ugc/posts"&&options.method==="POST"?Promise.reject({status:503}):defaultRequest(options));
  await page.confirmTextCard(confirmation(page));wxMock.showModal.mockResolvedValueOnce({confirm:false});
  expect(await page.confirmLeave()).toBe(false);expect(wxMock.showModal).toHaveBeenCalledWith(expect.objectContaining({title:"新建结果仍待核对",content:expect.stringContaining("离开不会撤销")}));
  expect(creates()).toHaveLength(1);expect(m.request.mock.calls.some(([options])=>options.method==="DELETE")).toBe(false);expect(m.upload).not.toHaveBeenCalled();
});
it("retains the text entry mode on guest authentication and still makes no draft POST before confirmation",async()=>{
  m.token="";const page=instance();page.onLoad({new:"1",entry:"text"});page.onShow();await flush();expect(creates()).toHaveLength(0);
  m.token="authenticated-member";page.onShow();await flush();
  expect(page.data).toMatchObject({postId:"",ownerId:"",version:0,textCardVisible:true});expect(page.localTextEntry.token).toBe(m.token);expect(creates()).toHaveLength(0);
});
it.each(["closed","unknown"])("keeps local input on background return when draft capability becomes %s",async mode=>{
  const page=await entry();changed(page,"后台回来仍需保留的卡片文字","care");page.onHide();
  m.request.mockImplementation((options:any)=>options.path==="/v1/ugc/status"?mode==="closed"?Promise.resolve({draftsEnabled:false,publicEnabled:false}):Promise.reject({status:503}):defaultRequest(options));
  page.onShow();await flush();expect(page.data).toMatchObject({listMode:false,textCardVisible:true,textCardText:"后台回来仍需保留的卡片文字",textCardTemplate:"care",postId:""});
  expect(writes()).toHaveLength(0);expect(page.data.error).toContain("输入仍保留");
});
it("returns to editing after a known creation denial without creating, deleting or discarding its local text",async()=>{
  const page=await entry();changed(page,"权限暂时不可用也不丢文字","border");
  m.request.mockImplementation((options:any)=>options.path==="/v1/me/ugc/posts"&&options.method==="POST"?Promise.reject({status:403,title:"暂不能新建"}):defaultRequest(options));
  await page.confirmTextCard(confirmation(page));expect(page.pendingLocalText?.sent).toBe(false);wxMock.showActionSheet.mockResolvedValue({tapIndex:1});
  expect(await page.confirmLeave()).toBe(false);expect(page.data).toMatchObject({postId:"",textCardVisible:true,textCardText:"权限暂时不可用也不丢文字",textCardTemplate:"border"});
  expect(creates()).toHaveLength(1);expect(m.request.mock.calls.some(([o])=>o.method==="DELETE")).toBe(false);expect(m.upload).not.toHaveBeenCalled();
});
it("expires independent card text with the same seven-day unsaved backup instead of restoring stale content",()=>{
  backups.writeUgcBackup({ownerId:owner,postId:post,baseVersion:1,title:"",body:"原有正文",textCardText:"已过期卡片文字",textCardTemplate:"care",mediaIds:[],savedAt:Date.now()});
  const now=vi.spyOn(Date,"now").mockReturnValue(Date.now()+7*24*60*60_000+1);
  try{const page=editor();page.applyDraft(draft({body:"最新服务端正文"}));expect(page.data).toMatchObject({body:"最新服务端正文",textCardText:"",textCardTemplate:"plain",dirty:false});expect(backups.readUgcBackup(owner,post,1)).toBeNull();}
  finally{now.mockRestore();}
});
it("reopens an independently edited short card while preserving a later long publisher body",()=>{
  const page=editor({body:"最初的短正文"});page.openTextCard();changed(page,"独立保存的短卡文字","care");
  page.cancelTextCard({detail:{contextKey:page.data.textCardContext}});const body="护".repeat(1000);page.editBody({detail:{value:body}});page.openTextCard();
  expect(page.data).toMatchObject({body,textCardText:"独立保存的短卡文字",textCardTemplate:"care",textCardVisible:true});expect(writes()).toHaveLength(0);
});
it("keeps the verified card visible with real creating feedback until its canonical draft response arrives",async()=>{
  const page=await entry(),creation=deferred();changed(page,"服务器响应前仍能看到这张卡","memo");
  m.request.mockImplementation((options:any)=>options.path==="/v1/me/ugc/posts"&&options.method==="POST"?creation.promise:defaultRequest(options));
  const confirming=page.confirmTextCard(confirmation(page));await flush();
  expect(page.data).toMatchObject({textCardVisible:false,textCardHandoffPath:"/synthetic/card.png",busy:true,operation:"creating",loading:false,postId:"",ownerId:""});expect(m.upload).not.toHaveBeenCalled();
  const markup=await readFile("apps/miniprogram/pages/community-compose/index.wxml","utf8");
  expect(markup).toContain("!postId && !loading && !listMode && (textCardHandoffPath || (busy && operation === 'creating'))");
  expect(markup).toMatch(/<image\b[^>]*src="\{\{textCardHandoffPath\}\}"[^>]*mode="aspectFit"/);expect(markup).toContain("正在准备…");
  creation.resolve(draft());await confirming;
  expect(page.data).toMatchObject({postId:post,ownerId:owner,textCardHandoffPath:"",busy:false,operation:"idle",body:""});expect(m.upload).toHaveBeenCalledOnce();
});
it("shows an explicit same-candidate continuation after backgrounding interrupts the pre-create status read",async()=>{
  const page=await entry(),status=deferred();changed(page);const key=page.data.createKey;
  m.request.mockImplementation((options:any)=>options.path==="/v1/ugc/status"?status.promise:defaultRequest(options));
  const confirming=page.confirmTextCard(confirmation(page));await flush();expect(page.pendingLocalText?.sent).toBe(false);expect(page.data).toMatchObject({busy:true,operation:"creating",loading:false,textCardHandoffPath:"/synthetic/card.png"});
  page.onHide();status.resolve({draftsEnabled:true,publicEnabled:false});await confirming;
  expect(creates()).toHaveLength(0);expect(page.data).toMatchObject({busy:false,operation:"idle",loading:false,textCardHandoffPath:"/synthetic/card.png"});
  page.onShow();await flush();expect(creates()).toHaveLength(0);expect(page.data.error).toContain("重试继续");expect(page.data.textCardHandoffPath).toBe("/synthetic/card.png");
  m.request.mockImplementation(defaultRequest);page.retryLoad();await flush();expect(creates()).toHaveLength(1);expect(creates()[0]![0].idempotencyKey).toBe(key);expect(m.upload).toHaveBeenCalledOnce();expect(page.data.textCardHandoffPath).toBe("");
});
it.each(["body","save"])("shows real creating feedback for a no-image %s handoff and clears it after the response",async kind=>{
  const page=await entry(),creation=deferred();changed(page,"没有生成PNG的原始文字");
  m.request.mockImplementation((options:any)=>options.path==="/v1/me/ugc/posts"&&options.method==="POST"?creation.promise:defaultRequest(options));
  if(kind==="save")wxMock.showActionSheet.mockResolvedValue({tapIndex:0});
  page.cancelTextCard({detail:{contextKey:page.data.textCardContext,...(kind==="body"?{mode:"body"}:{})}});await flush();
  expect(page.data).toMatchObject({postId:"",textCardVisible:false,busy:true,operation:"creating",loading:false,textCardHandoffPath:""});expect(m.upload).not.toHaveBeenCalled();
  creation.resolve(draft());await flush();expect(page.data).toMatchObject({postId:post,busy:false,operation:"idle",textCardHandoffPath:"",body:"没有生成PNG的原始文字"});
});
it("clears an unknown local create command after explicitly leaving for My posts, so an existing draft can make a card",async()=>{
  const other="dddddddd-dddd-4ddd-8ddd-dddddddddddd",page=await entry();changed(page,"已经确认离开的旧本机卡片");const oldEvent=confirmation(page);
  m.request.mockImplementation((options:any)=>options.path==="/v1/me/ugc/posts"&&options.method==="POST"?Promise.reject({status:503}):options.path===`/v1/me/ugc/posts/${other}`?Promise.resolve(draft({id:other,version:4,body:"本人已有稿正文"})):defaultRequest(options));
  await page.confirmTextCard(oldEvent);expect(page.pendingLocalText?.sent).toBe(true);
  wxMock.showModal.mockResolvedValue({confirm:true});await page.showMyPosts();await flush();
  expect(page.localTextEntry).toBeNull();expect(page.pendingLocalText).toBeNull();expect(page.pendingTextImport).toBeNull();expect(page.resumeTextCard).toBeNull();expect(page.textCardOpenContext).toBeNull();
  expect(page.data).toMatchObject({listMode:true,textCardVisible:false,textCardHandoffPath:""});
  await page.loadDraft(other);page.openTextCard();expect(page.data).toMatchObject({postId:other,ownerId:owner,version:4,textCardVisible:true,textCardText:"本人已有稿正文"});
  await page.confirmTextCard(oldEvent);expect(m.upload).not.toHaveBeenCalled();expect(creates()).toHaveLength(1);
  page.retryLoad();await flush();expect(m.request).toHaveBeenCalledWith(expect.objectContaining({path:`/v1/me/ugc/posts/${other}`}));expect(creates()).toHaveLength(1);expect(m.request.mock.calls.some(([options])=>options.method==="DELETE")).toBe(false);
});
it("invalidates an in-flight text-entry create when explicitly loading another draft, without adopting or uploading its late response",async()=>{
  const other="dddddddd-dddd-4ddd-8ddd-dddddddddddd",creation=deferred(),page=await entry();changed(page,"旧创作输入");
  m.request.mockImplementation((options:any)=>options.path==="/v1/me/ugc/posts"&&options.method==="POST"?creation.promise:options.path===`/v1/me/ugc/posts/${other}`?Promise.resolve(draft({id:other,version:7,title:"另一篇本人草稿",body:"另一篇真实正文"})):defaultRequest(options));
  const confirming=page.confirmTextCard(confirmation(page));await flush();expect(page.data.busy).toBe(true);
  await page.loadDraft(other);expect(page.pendingLocalText).toBeNull();expect(page.localTextEntry).toBeNull();expect(page.pendingTextImport).toBeNull();expect(page.resumeTextCard).toBeNull();
  expect(page.data).toMatchObject({postId:other,version:7,title:"另一篇本人草稿",body:"另一篇真实正文",busy:false,operation:"idle",textCardVisible:false,textCardHandoffPath:""});
  page.openTextCard();expect(page.data.textCardVisible).toBe(true);const currentKey=page.data.textCardContext;
  creation.resolve(draft());await confirming;expect(page.data).toMatchObject({postId:other,version:7,body:"另一篇真实正文",textCardVisible:true,textCardContext:currentKey});
  expect(m.upload).not.toHaveBeenCalled();expect(m.request.mock.calls.some(([options])=>options.path.endsWith("/authorize")||options.method==="DELETE")).toBe(false);
});
it("clears an explicitly abandoned local entry command before a distinct new creation intent",async()=>{
  const page=await entry();changed(page);m.request.mockImplementation((options:any)=>options.path==="/v1/me/ugc/posts"&&options.method==="POST"?Promise.reject({status:503}):defaultRequest(options));
  await page.confirmTextCard(confirmation(page));const key=page.data.createKey;wxMock.showModal.mockResolvedValue({confirm:true});expect(await page.confirmLeave()).toBe(true);
  page.openNewIfAvailable=vi.fn().mockResolvedValue(undefined);page.startNew();
  expect(page.pendingLocalText).toBeNull();expect(page.localTextEntry).toBeNull();expect(page.pendingTextImport).toBeNull();expect(page.resumeTextCard).toBeNull();expect(page.textCardOpenContext).toBeNull();
  expect(page.data).toMatchObject({textCardVisible:false,textCardContext:"",textCardText:"",textCardHandoffPath:"",requestedNew:true});expect(page.data.createKey).not.toBe(key);expect(page.openNewIfAvailable).toHaveBeenCalledOnce();
  expect(creates()).toHaveLength(1);expect(m.upload).not.toHaveBeenCalled();expect(m.request.mock.calls.some(([options])=>options.method==="DELETE")).toBe(false);
});
