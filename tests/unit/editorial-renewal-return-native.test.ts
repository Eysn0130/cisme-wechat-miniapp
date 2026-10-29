import {beforeEach,describe,expect,it,vi} from "vitest";

// Exercise the real Page, typed clients, API coordinator and native HTTP adapter.
// Only native responses are synthetic; no real identity or consent is created.
vi.mock("../../apps/miniprogram/services/layout",()=>({currentChromeStyle:()=>"",motionDuration:()=>0}));
vi.mock("../../apps/miniprogram/services/member-avatar",()=>({defaultMemberAvatar:"local-default",clearMemberAvatarCache:vi.fn(),localMemberAvatar:async()=>"local-default",prepareFeedAuthors:async(items:unknown)=>items}));
vi.mock("../../apps/miniprogram/services/share",()=>({prepareShareLink:vi.fn(),registerIncomingShare:vi.fn()}));
const id="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",authorId="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const articlePath=`/v1/editorial/articles/${id}`,commentsPath=`${articlePath}/comments`;
const legalTitle="请阅读并同意当前用户协议和隐私指引后再互动";
const documents=[{documentType:"terms" as const,version:"2026-10-28-v4"},{documentType:"privacy" as const,version:"2026-10-28-v4"}];
let page:any,runtime:any,requests:any[],storage:Map<string,unknown>;
let reactionMode:"legal"|"unknown",articleMode:"ready"|"fail"|"hold",held:any[],commentMode:"unknown"|"confirmed";
const article=()=>({id,title:"护理故事",excerpt:"公开摘要",authorId,author:"公开昵称",avatar:"",coverUrl:null,publishedAt:"2026-10-28T00:00:00Z",version:2,body:"真实读取的正文",media:[],liked:false,saved:false,following:false,isMine:false,interactionsEnabled:true,sourceUrl:null,provenanceLabel:"",commentsEnabled:true,commentsPolicyVersion:1,commentCount:0,canModerate:false,likeCount:7,saveCount:3});
function pathOf(options:any){return options.url.replace("https://synthetic.invalid","");}
function calls(method:string,path?:string){return requests.filter(options=>options.method===method&&(!path||pathOf(options)===path));}
function respond(options:any){
 const path=pathOf(options);
 if(path===articlePath){
  if(articleMode==="hold"){held.push(options);return;}
  if(articleMode==="fail"){options.fail({errMsg:"request:fail timeout"});return;}
  options.success({statusCode:200,data:article()});return;
 }
 if(path.startsWith(commentsPath+"?")){options.success({statusCode:200,data:{comments:[],authors:{},commentCount:0,commentsEnabled:true,commentsPolicyVersion:1,canModerate:false,loadedCount:0,hasMore:false,nextCursor:null,truncated:false,preview:false,asOf:"2026-10-28T00:00:00Z"}});return;}
 if(path===`${articlePath}/reaction`){
  if(reactionMode==="legal")options.success({statusCode:409,data:{code:"CURRENT_LEGAL_CONSENT_REQUIRED",title:legalTitle}});
  else options.fail({errMsg:"request:fail timeout"});return;
 }
 if(path==="/v1/me/legal-acceptances"){options.success({statusCode:200,data:{accepted:true,documents}});return;}
 if(path===commentsPath&&options.method==="POST"){
  if(commentMode==="unknown")options.fail({errMsg:"request:fail timeout"});
  else options.success({statusCode:200,data:{id:"cccccccc-cccc-4ccc-8ccc-cccccccccccc",status:"pending",version:1,replayed:true}});return;
 }
 throw new Error("Unexpected synthetic native request");
}
async function settled(){await vi.waitFor(()=>expect(page.data.loading||page.data.commentsLoading).toBe(false));}
async function mount(){await import("../../apps/miniprogram/pages/post/index");page.onLoad({id,source:"editorial"});await page.load();await settled();}
function input(value:string){if(!page.data.composerOpen)page.startComment();page.inputComment({detail:{value},currentTarget:{dataset:{composerId:page.data.composerEventId}}});}
beforeEach(()=>{
 vi.resetModules();vi.clearAllMocks();requests=[];held=[];storage=new Map();reactionMode="legal";articleMode="ready";commentMode="unknown";
 runtime={globalData:{sessionToken:"synthetic-member-session",privacyRightsToken:"",sessionStorageKey:"synthetic.session",apiBaseUrl:"https://synthetic.invalid"}};
 (globalThis as any).getApp=()=>runtime;
 (globalThis as any).getCurrentPages=()=>[{route:"pages/post/index",options:{id,source:"editorial"}}];
 (globalThis as any).Page=(definition:any)=>{page={...definition,data:structuredClone(definition.data),setData(update:any,callback?:()=>void){Object.assign(this.data,structuredClone(update));callback?.();}};};
 (globalThis as any).wx={getStorageSync:(key:string)=>storage.get(key)||"",setStorageSync:vi.fn((key:string,value:unknown)=>storage.set(key,value)),removeStorageSync:vi.fn((key:string)=>storage.delete(key)),getStorageInfoSync:()=>({keys:[...storage.keys()]}),hideShareMenu:vi.fn(),showShareMenu:vi.fn(),hideKeyboard:vi.fn(),navigateTo:vi.fn(),reLaunch:vi.fn(),showToast:vi.fn(),pageScrollTo:vi.fn(),nextTick:(callback:()=>void)=>callback(),getWindowInfo:()=>({windowWidth:390}),getAppBaseInfo:()=>({fontSizeSetting:16}),
  request:vi.fn((options:any)=>{requests.push(options);queueMicrotask(()=>respond(options));return {abort:vi.fn(()=>options.fail({code:"REQUEST_ABORTED"}))};})};
});

describe("editorial legal refusal recovery on a fresh native Page read",()=>{
 it("removes only the old legal refusal after explicit renewal and a current successful reentry read, without replaying the reaction",async()=>{
  await mount();await page.toggleLike();expect(page.data.socialError).toBe(legalTitle);
  expect((globalThis as any).wx.navigateTo).toHaveBeenCalledWith(expect.objectContaining({url:expect.stringContaining("intent=renew")}));
  page.onHide();const api=await import("../../apps/miniprogram/services/api");await api.acceptCurrentLegalDocuments(documents);
  const token=runtime.globalData.sessionToken;page.onShow();await settled();
  expect(page.data.socialError).toBe("");expect(page.data.social).toMatchObject({liked:false,likeCount:7,saveCount:3});
  expect(runtime.globalData.sessionToken).toBe(token);expect(calls("PUT",`${articlePath}/reaction`)).toHaveLength(1);
  expect(calls("POST","/v1/me/legal-acceptances")).toHaveLength(1);expect(calls("GET",articlePath)).toHaveLength(2);
 });
 it("does not clear the legal refusal merely because a fresh read starts, fails or finishes after hiding",async()=>{
  await mount();await page.toggleSave();page.onHide();articleMode="fail";page.onShow();await settled();expect(page.data.socialError).toBe(legalTitle);
  articleMode="hold";page.onShow();await vi.waitFor(()=>expect(held).toHaveLength(1));expect(page.data.socialError).toBe(legalTitle);
  page.onHide();held.shift().success({statusCode:200,data:article()});await Promise.resolve();expect(page.data.socialError).toBe(legalTitle);
  articleMode="ready";page.onShow();await settled();expect(page.data.socialError).toBe("");expect(calls("PUT",`${articlePath}/reaction`)).toHaveLength(1);
 });
 it("keeps an unknown reaction result visible after a successful fresh read",async()=>{
  await mount();reactionMode="unknown";await page.toggleLike();const warning=page.data.socialError;expect(warning).not.toBe("");
  page.onHide();page.onShow();await settled();expect(page.data.socialError).toBe(warning);expect(calls("PUT",`${articlePath}/reaction`)).toHaveLength(1);
 });
 it("does not let an earlier refusal marker dismiss a later interaction whose result is unknown",async()=>{
  await mount();await page.toggleLike();expect(page.data.socialError).toBe(legalTitle);
  reactionMode="unknown";await page.toggleSave();const warning=page.data.socialError;expect(warning).not.toBe(legalTitle);
  page.onHide();page.onShow();await settled();expect(page.data.socialError).toBe(warning);expect(calls("PUT",`${articlePath}/reaction`)).toHaveLength(2);
 });
 it("preserves an unknown comment body and submission key across renewal-style reentry and verifies only on the next explicit send",async()=>{
  await mount();input("需要核对发送结果的评论");await page.sendComment();
  const key=page.data.draftOperation;expect(key).not.toBe("");expect(page.data.commentSendUnknown).toBe(true);
  page.onHide();page.onShow();await settled();expect(page.data).toMatchObject({draft:"需要核对发送结果的评论",draftOperation:key,commentSendUnknown:true});
  input("不能覆盖未知提交");expect(page.data.draft).toBe("需要核对发送结果的评论");expect(calls("POST",commentsPath)).toHaveLength(1);
  commentMode="confirmed";await page.sendComment();
  const sends=calls("POST",commentsPath);expect(sends).toHaveLength(2);expect(sends.map(options=>[options.header["Idempotency-Key"],options.data])).toEqual([[key,{body:"需要核对发送结果的评论"}],[key,{body:"需要核对发送结果的评论"}]]);
  expect(page.data.commentSendUnknown).toBe(false);expect(page.data.draftOperation).toBe("");
 });
});
