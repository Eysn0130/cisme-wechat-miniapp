import {beforeEach,describe,expect,it,vi} from "vitest";

// Keep the real API/coordinator/HTTP/page-read layers: synthetic native HTTP
// callbacks below must actually revoke the captured token on a 401.
vi.mock("../../apps/miniprogram/services/layout",()=>({currentChromeStyle:()=>"",motionDuration:()=>0}));
vi.mock("../../apps/miniprogram/services/member-avatar",()=>({defaultMemberAvatar:"local-default",clearMemberAvatarCache:vi.fn(),localMemberAvatar:async()=>"local-default",prepareFeedAuthors:async(items:unknown)=>items,prepareFeedPage:async()=>[]}));
vi.mock("../../apps/miniprogram/services/share",()=>({prepareShareLink:vi.fn(),registerIncomingShare:vi.fn()}));
const articleId="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",authorId="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const card={id:articleId,title:"公开精选",excerpt:"公开摘要",authorId,author:"公开作者",avatar:"",coverUrl:null,publishedAt:"2026-10-26T00:00:00Z",likeCount:0,saveCount:0};
const article={...card,version:1,body:"公开正文",media:[],liked:false,saved:false,following:false,isMine:false,interactionsEnabled:true,sourceUrl:null,provenanceLabel:"AI辅助配图"};
const author={author:{id:authorId,name:"公开作者",avatar:"",postCount:1,following:false,isMine:false},items:[card],nextCursor:"next"};
let page:any,runtime:any,requests:any[],storage:Map<string,unknown>,expirePath:string|null,holdPath:string|null,held:any[],patches:any[];
function payload(path:string):unknown {
 if(path===`/v1/editorial/articles/${articleId}`)return article;
 if(path.startsWith("/v1/editorial/authors/"))return author;
 if(path.startsWith("/v1/editorial/articles?"))return {items:[card],nextCursor:"next"};
 if(path==="/v1/capabilities")return {communityPreviewEnabled:false};
 if(path==="/v1/ugc/status")return {publicEnabled:false};
 if(path==="/v1/me/community-access")return {canReview:false};
 if(path==="/v1/me/tasks")return [];
 return {items:[],nextCursor:null};
}
function pathOf(options:any){return options.url.replace("https://synthetic.invalid","");}
function deliver(options:any){const path=pathOf(options);options.success({statusCode:expirePath&&path.startsWith(expirePath)?401:200,data:expirePath&&path.startsWith(expirePath)?{code:"AUTH_EXPIRED"}:payload(path)});}
function releaseHeld(){for(const options of held.splice(0))deliver(options);}
async function mount(route:"post"|"community"|"community-author"){
 (globalThis as any).getCurrentPages=()=>[{route:`pages/${route}/index`,options:{id:route==="community-author"?authorId:articleId,source:"editorial"}}];
 if(route==="post")await import("../../apps/miniprogram/pages/post/index");
 else if(route==="community-author")await import("../../apps/miniprogram/pages/community-author/index");
 else await import("../../apps/miniprogram/pages/community/index");
 page.onLoad?.({id:route==="community-author"?authorId:articleId,source:"editorial"});return page;
}
beforeEach(()=>{
 vi.resetModules();vi.clearAllMocks();requests=[];held=[];patches=[];storage=new Map();expirePath=null;holdPath=null;
 runtime={globalData:{sessionToken:"synthetic-expired-session",privacyRightsToken:"",apiBaseUrl:"https://synthetic.invalid",sessionStorageKey:"synthetic.session"}};
 (globalThis as any).getApp=()=>runtime;
 (globalThis as any).Page=(definition:any)=>{page={...definition,data:structuredClone(definition.data),setData(update:any,callback?:()=>void){patches.push(structuredClone(update));for(const [name,value]of Object.entries(update)){if(name.includes("["))continue;this.data[name]=structuredClone(value);}callback?.();}};};
 (globalThis as any).wx={getStorageSync:(key:string)=>storage.get(key)||"",setStorageSync:vi.fn((key:string,value:unknown)=>storage.set(key,value)),removeStorageSync:vi.fn((key:string)=>storage.delete(key)),getStorageInfoSync:()=>({keys:[...storage.keys()]}),hideShareMenu:vi.fn(),showShareMenu:vi.fn(),navigateTo:vi.fn(),reLaunch:vi.fn(),showToast:vi.fn(),
  request:vi.fn((options:any)=>{requests.push(options);if(holdPath&&pathOf(options).startsWith(holdPath))held.push(options);else queueMicrotask(()=>deliver(options));return {abort:vi.fn(()=>options.fail({code:"REQUEST_ABORTED"}))};})};
});

describe("editorial reads after a real transport session revocation",()=>{
 it.each(["post","community-author"] as const)("clears %s private state and offers a fresh anonymous retry after actual HTTP401",async(route)=>{
  await mount(route);expirePath=route==="post"?`/v1/editorial/articles/${articleId}`:`/v1/editorial/authors/${authorId}`;
  Object.assign(page.data,route==="post"?{following:true,social:{liked:true,saved:true},draft:"old private draft"}:{author:{following:true,isMine:true},articleContextId:articleId,busy:true});
  await page.load();
  expect(requests[0].header.Authorization).toBe("Bearer synthetic-expired-session");expect(runtime.globalData.sessionToken).toBe("");expect(storage.get("synthetic.session")).toBe("");
  expect(page.data).toMatchObject({loading:false,error:expect.stringContaining("重新加载公开")});
  if(route==="post")expect(page.data).toMatchObject({errorTitle:"登录状态已失效",item:null,following:false,socialEnabled:false,draft:"",social:{liked:false,saved:false}});
  else expect(page.data).toMatchObject({author:null,items:[],articleContextId:"",busy:false,loadingMore:false});
  expect((globalThis as any).wx.navigateTo).not.toHaveBeenCalled();
  expirePath=null;await page.load();expect(requests.at(-1).header.Authorization).toBe("");expect(page.data.loading).toBe(false);expect(page.data.error).toBe("");
  if(route==="post")expect(page.data.item.id).toBe(articleId);else expect(page.data.author.id).toBe(authorId);
 });
 it.each(["tasks-before-capabilities","editorial-before-capabilities","access-after-capabilities","editorial-at-aggregate"])("settles Community when expiry occurs at %s",async(stage)=>{
  await mount("community");Object.assign(page.data,{signedIn:true,follows:["old-private-follow"],reviewQueue:[{private:true}],tasks:[{private:true}],displayFeedCount:1});
  expirePath=stage.startsWith("tasks")?"/v1/me/tasks":stage.startsWith("access")?"/v1/me/community-access":"/v1/editorial/articles?";
  if(stage.includes("before-capabilities"))holdPath="/v1/capabilities";else if(stage==="editorial-at-aggregate")holdPath="/v1/editorial/articles?";
  const reading=page.load();
  if(holdPath==="/v1/capabilities"){await vi.waitFor(()=>expect(runtime.globalData.sessionToken).toBe(""));releaseHeld();}
  else if(holdPath){await vi.waitFor(()=>expect(requests.some(r=>pathOf(r)==="/v1/me/community-access")).toBe(true));releaseHeld();}
  await reading;expect(runtime.globalData.sessionToken).toBe("");expect(page.data).toMatchObject({loading:false,signedIn:false,mode:"featured",canReview:false,follows:[],reviewQueue:[],tasks:[],tasksLoading:false,formalLoadingMore:false,displayFeedCount:0,error:expect.stringContaining("登录状态已失效")});
  expirePath=null;holdPath=null;await page.load();expect(page.data).toMatchObject({loading:false,error:"",displayFeedCount:1});expect(requests.filter(r=>pathOf(r).startsWith("/v1/editorial/")).at(-1).header.Authorization).toBe("");
 });
 it.each(["community","community-author"] as const)("clears %s pagination busy and actor-specific projection on HTTP401",async(route)=>{
  await mount(route);await page.load();expirePath=route==="community"?"/v1/editorial/articles?":"/v1/editorial/authors/";
  await page.onReachBottom();expect(runtime.globalData.sessionToken).toBe("");expect(page.data.loading).toBe(false);expect(page.data.error).toContain("登录状态已失效");
  if(route==="community")expect(page.data).toMatchObject({formalLoadingMore:false,displayFeedCount:0});else expect(page.data).toMatchObject({loadingMore:false,author:null,items:[]});
 });
 it.each(["post","community-author","community"] as const)("does not recover a hidden %s view when an old transport subsequently expires",async(route)=>{
  await mount(route);holdPath=route==="post"?`/v1/editorial/articles/${articleId}`:route==="community-author"?"/v1/editorial/authors/":"/v1/me/tasks";
  const reading=page.load();page.onHide();const before=patches.length;expirePath=holdPath;releaseHeld();await reading;
  expect(patches.slice(before)).toEqual([]);expect(page.data.error).not.toContain("登录状态已失效");
 });
 it.each(["post","community-author","community"] as const)("does not let %s old HTTP401 overwrite a different nonempty session",async(route)=>{
  await mount(route);holdPath=route==="post"?`/v1/editorial/articles/${articleId}`:route==="community-author"?"/v1/editorial/authors/":"/v1/me/tasks";
  const reading=page.load();const api=await import("../../apps/miniprogram/services/api");api.setSessionToken("synthetic-different-session");const before=patches.length;
  expirePath=holdPath;releaseHeld();await reading;expect(runtime.globalData.sessionToken).toBe("synthetic-different-session");expect(patches.slice(before)).toEqual([]);expect(page.data.error).not.toContain("登录状态已失效");
 });
 it("requires the narrow failure code plus a nonempty-to-empty transition",async()=>{
  const {expiredEditorialRead}=await import("../../apps/miniprogram/services/editorial");
  runtime.globalData.sessionToken="";expect(expiredEditorialRead({code:"REQUEST_SESSION_CHANGED"},"old")).toBe(true);expect(expiredEditorialRead({status:401},"old")).toBe(true);
  expect(expiredEditorialRead({status:503},"old")).toBe(false);expect(expiredEditorialRead({status:401},"")).toBe(false);
  runtime.globalData.sessionToken="new";expect(expiredEditorialRead({status:401},"old")).toBe(false);
 });
});
