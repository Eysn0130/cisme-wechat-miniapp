import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks=vi.hoisted(()=>({request:vi.fn(),resume:vi.fn(),renew:vi.fn(),token:"",share:vi.fn(),incoming:vi.fn()}));
vi.mock("../../apps/miniprogram/services/api",()=>({request:mocks.request,resumeAuthentication:mocks.resume,beginLegalRenewal:mocks.renew,clearAuthenticationRedirectSuppression:vi.fn()}));
vi.mock("../../apps/miniprogram/services/page-requests",()=>({pageRead:(_page:unknown,options:unknown)=>mocks.request(options),cancelPageReads:vi.fn()}));
vi.mock("../../apps/miniprogram/services/layout",()=>({currentChromeStyle:()=>"",motionDuration:()=>0}));
vi.mock("../../apps/miniprogram/services/share",()=>({prepareShareLink:mocks.share,registerIncomingShare:mocks.incoming}));
const articleId="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",authorId="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",secondId="cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const mediaPath=`/v1/editorial/media/${articleId}/${"d".repeat(64)}`;
const card=(id=articleId)=>({id,title:"经授权的精选标题",excerpt:"来源清楚的摘要",authorId,author:"公开作者名",avatar:"",coverUrl:mediaPath,publishedAt:"2026-10-26T09:00:00Z",likeCount:0,saveCount:0});
const article=()=>({...card(),version:1,body:"第一段正文\n第二段正文",media:[{id:"d".repeat(64),url:mediaPath}],liked:false,saved:false,following:false,isMine:false,interactionsEnabled:true,sourceUrl:"https://example.org/original",provenanceLabel:"作者授权发布"});
const authorPage=()=>({author:{id:authorId,name:"公开作者名",avatar:"",postCount:1,following:false,isMine:false},items:[card()],nextCursor:null});
const delayed=()=>{let resolve!:(value:any)=>void,reject!:(value:any)=>void;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
let page:any;
function patch(target:any,key:string,value:any){const parts=key.replace(/\[(\d+)\]/g,".$1").split(".");let current=target;for(const [i,name] of parts.entries()){if(i===parts.length-1)current[name]=structuredClone(value);else current=current[name!]??=(/^\d+$/.test(parts[i+1]!)?[]:{});}}
async function mount(name:"post"|"community"|"community-author",query:Record<string,string>={}){
 if(name==="post")await import("../../apps/miniprogram/pages/post/index");
 else if(name==="community")await import("../../apps/miniprogram/pages/community/index");
 else await import("../../apps/miniprogram/pages/community-author/index");
 if(page.onLoad)page.onLoad(query);
 return page;
}
beforeEach(()=>{
 vi.resetModules();mocks.request.mockReset();mocks.resume.mockReset();mocks.renew.mockReset();mocks.share.mockReset();mocks.incoming.mockReset();mocks.token="";
 (globalThis as any).getApp=()=>({globalData:{sessionToken:mocks.token,apiBaseUrl:"https://synthetic.invalid"}});
 (globalThis as any).Page=(definition:any)=>{page={...definition,data:structuredClone(definition.data),setData(updates:any,callback?:()=>void){for(const [key,value]of Object.entries(updates))patch(this.data,key,value);callback?.();}};};
 (globalThis as any).wx={hideShareMenu:vi.fn(),showShareMenu:vi.fn(),showToast:vi.fn(),navigateTo:vi.fn(),navigateBack:vi.fn(),switchTab:vi.fn(),setClipboardData:vi.fn(),getStorageSync:vi.fn(),pageScrollTo:vi.fn()};
});

describe("published editorial native contracts",()=>{
 it("uses optional public reads and required authenticated writes on the independent API",async()=>{
  const api=await import("../../apps/miniprogram/services/editorial");mocks.request.mockResolvedValue({items:[],nextCursor:null});
  await api.publishedEditorialArticles(undefined,"opaque cursor");await api.publishedEditorialArticle(articleId);await api.publishedEditorialAuthor(authorId);
  expect(mocks.request.mock.calls.slice(0,3).map(([x])=>[x.path,x.authMode])).toEqual([["/v1/editorial/articles?limit=20&cursor=opaque%20cursor","optional"],[`/v1/editorial/articles/${articleId}`,"optional"],[`/v1/editorial/authors/${authorId}?limit=20`,"optional"]]);
  mocks.request.mockResolvedValueOnce({kind:"like",active:true,count:1,liked:true,saved:false,likeCount:1,saveCount:0}).mockResolvedValueOnce({authorId,following:true});
  await api.reactToEditorialArticle(articleId,"like",true);await api.followEditorialArticle(articleId,true);
  expect(mocks.request).toHaveBeenNthCalledWith(4,{path:`/v1/editorial/articles/${articleId}/reaction`,method:"PUT",data:{kind:"like",active:true}});
  expect(mocks.request).toHaveBeenNthCalledWith(5,{path:`/v1/editorial/articles/${articleId}/follow`,method:"PUT",data:{active:true}});
 });
 it("only resolves licensed same-origin media paths and never returns a bundled demo",async()=>{
  const api=await import("../../apps/miniprogram/services/editorial");
  expect(api.editorialMediaSrc(mediaPath)).toBe("https://synthetic.invalid"+mediaPath);
  for(const value of ["object/key","https://foreign.invalid/image.jpg","//foreign.invalid/image.jpg",mediaPath+"?token=unexpected","/v1/ugc/media/other"]){expect(api.editorialMediaSrc(value)).toBe("");}
  expect(api.editorialStoriesForRuntime()).toEqual([]);expect(api.editorialStory("brand-scalp-ritual")).toBeNull();
 });
 it("rejects malformed counts and foreign follow identities instead of reporting a saved interaction",async()=>{
  const api=await import("../../apps/miniprogram/services/editorial");
  mocks.request.mockResolvedValueOnce({kind:"like",active:true,count:1,liked:true,saved:false,likeCount:-1,saveCount:0});
  await expect(api.reactToEditorialArticle(articleId,"like",true)).rejects.toThrow("EDITORIAL_REACTION_RESPONSE_INVALID");
  mocks.request.mockResolvedValueOnce({authorId:"brand:cisme",following:true});
  await expect(api.followEditorialArticle(articleId,true)).rejects.toThrow("EDITORIAL_FOLLOW_RESPONSE_INVALID");
 });
 it.each(["brand-scalp-ritual","brand-night-routine","brand-care-journal","brand-roots-check","brand-product-ritual"])("keeps retired %s unavailable even with the new source query",async(id)=>{
  await mount("post",{id,source:"editorial"});await page.load();expect(page.data.item).toBeNull();expect(page.data.errorKind).toBe("missing");expect(mocks.request).not.toHaveBeenCalled();expect(mocks.incoming).not.toHaveBeenCalled();
 });
 it("loads real article fields while keeping comments and legacy source attribution separate",async()=>{
  mocks.request.mockResolvedValueOnce(article());await mount("post",{id:articleId,source:"editorial"});await page.load();
  expect(mocks.request).toHaveBeenCalledOnce();expect(mocks.request).toHaveBeenCalledWith({path:`/v1/editorial/articles/${articleId}`,authMode:"optional"});
  expect(page.data).toMatchObject({loading:false,editorialSource:true,authorId,socialEnabled:true,media:["https://synthetic.invalid"+mediaPath],item:{kind:"editorial",author:"公开作者名",body:"第一段正文\n第二段正文"},social:{likeCount:0,saveCount:0,liked:false,saved:false,comments:[]}});
  expect(mocks.incoming).not.toHaveBeenCalled();expect(mocks.share).not.toHaveBeenCalled();expect(page.onShareAppMessage().path).toBe(`/pages/post/index?id=${articleId}&source=editorial`);
 });
 it("returns guests to the same editorial article before like, save, or follow",async()=>{
  mocks.request.mockResolvedValueOnce(article());await mount("post",{id:articleId,source:"editorial"});await page.load();mocks.request.mockClear();
  await page.toggleLike();await page.toggleSave();await page.toggleFollow();
  expect(mocks.request).not.toHaveBeenCalled();expect(mocks.resume.mock.calls).toEqual(Array.from({length:3},()=>[`/pages/post/index?id=${articleId}&source=editorial`]));
 });
 it("only adopts a confirmed reaction, serializes taps, and keeps failed saves unchanged",async()=>{
  mocks.token="member-a";mocks.request.mockResolvedValueOnce(article());await mount("post",{id:articleId,source:"editorial"});await page.load();
  const pending=delayed();mocks.request.mockReturnValueOnce(pending.promise);const first=page.toggleLike();await page.toggleLike();
  expect(page.data.social.liked).toBe(false);expect(page.data.social.likeCount).toBe(0);expect(mocks.request).toHaveBeenCalledTimes(2);
  pending.resolve({kind:"like",active:true,count:1,liked:true,saved:false,likeCount:1,saveCount:0});await first;
  expect(page.data.social).toMatchObject({liked:true,likeCount:1,saved:false,saveCount:0});
  mocks.request.mockRejectedValueOnce(new Error("offline"));await page.toggleSave();expect(page.data.social.saved).toBe(false);expect(page.data.social.saveCount).toBe(0);expect(page.data.socialBusy).toBe(false);expect(page.data.socialError).toContain("尚未确认");
 });
 it("does not revive an old operator's reaction or follow result after leaving",async()=>{
  mocks.token="member-a";mocks.request.mockResolvedValueOnce(article());await mount("post",{id:articleId,source:"editorial"});await page.load();
  const reaction=delayed(),follow=delayed();mocks.request.mockReturnValueOnce(reaction.promise).mockReturnValueOnce(follow.promise);
  const one=page.toggleLike(),two=page.toggleFollow();page.onHide();mocks.token="member-b";
  reaction.resolve({kind:"like",active:true,count:99,liked:true,saved:true,likeCount:99,saveCount:99});follow.resolve({authorId,following:true});await Promise.all([one,two]);
  expect(page.data.social).toMatchObject({liked:false,saved:false,likeCount:0,saveCount:0});expect(page.data.following).toBe(false);
 });
 it("routes only the current editorial legal 409 to renewal and leaves reactions unchanged",async()=>{
  mocks.token="member-a";mocks.request.mockResolvedValueOnce(article());await mount("post",{id:articleId,source:"editorial"});await page.load();
  mocks.request.mockRejectedValueOnce({status:409,code:"CURRENT_LEGAL_CONSENT_REQUIRED"});await page.toggleLike();
  expect(mocks.renew).toHaveBeenCalledExactlyOnceWith(`/pages/post/index?id=${articleId}&source=editorial`);expect(page.data.social).toMatchObject({liked:false,likeCount:0});
  mocks.renew.mockClear();mocks.request.mockRejectedValueOnce({status:409,code:"CONCURRENT_OPERATION_RETRY"});await page.toggleSave();expect(mocks.renew).not.toHaveBeenCalled();
  const pending=delayed();mocks.request.mockReturnValueOnce(pending.promise);const following=page.toggleFollow();page.onHide();pending.reject({status:409,code:"CURRENT_LEGAL_CONSENT_REQUIRED"});await following;expect(mocks.renew).not.toHaveBeenCalled();
 });
 it("distinguishes a withdrawn article from transport failure and lets the same route retry",async()=>{
  mocks.request.mockRejectedValueOnce({status:404});await mount("post",{id:articleId,source:"editorial"});await page.load();expect(page.data).toMatchObject({loading:false,item:null,errorKind:"missing"});
  mocks.request.mockRejectedValueOnce(new Error("offline"));await page.load();expect(page.data).toMatchObject({loading:false,item:null,errorKind:"load"});
  mocks.request.mockResolvedValueOnce(article());await page.load();expect(page.data.item.id).toBe(articleId);expect(page.data.error).toBe("");
 });
 it("keeps a failed licensed image honest and clears the warning only on a fresh content read",async()=>{
  mocks.request.mockResolvedValueOnce(article());await mount("post",{id:articleId,source:"editorial"});await page.load();
  page.mediaFailed({currentTarget:{dataset:{src:"https://foreign.invalid/old.jpg"}}});expect(page.data.mediaError).toBe("");
  page.mediaFailed({currentTarget:{dataset:{src:"https://synthetic.invalid"+mediaPath}}});expect(page.data.mediaError).toBe("图片加载失败，请重新加载。");expect(page.data.item.id).toBe(articleId);
  mocks.request.mockResolvedValueOnce(article());await page.load();expect(page.data.mediaError).toBe("");
 });
 it("shows published featured content while ordinary UGC and preview remain closed",async()=>{
  mocks.request.mockImplementation(({path}:any)=>{
   if(path==="/v1/editorial/articles?limit=20")return Promise.resolve({items:[card()],nextCursor:null});
   if(path==="/v1/capabilities")return Promise.resolve({communityPreviewEnabled:false});if(path==="/v1/ugc/status")return Promise.resolve({publicEnabled:false});
   return Promise.reject({status:403});
  });
  await mount("community");await page.load();expect(page.data).toMatchObject({mode:"featured",ugcFeedEnabled:false,socialPreviewEnabled:false,loading:false,error:"",displayFeedCount:1});
  expect(page.data.feedColumns.flat()).toEqual([expect.objectContaining({id:articleId,kind:"editorial",author:"公开作者名",engagementLabel:"0 赞",image:"https://synthetic.invalid"+mediaPath})]);
  page.openPost({currentTarget:{dataset:{id:articleId}}});expect((globalThis as any).wx.navigateTo).toHaveBeenCalledWith(expect.objectContaining({url:`/pages/post/index?id=${articleId}&source=editorial`}));
 });
 it("keeps featured empty and error separate and deduplicates real pagination",async()=>{
  mocks.request.mockImplementation(({path}:any)=>Promise.resolve(path==="/v1/editorial/articles?limit=20"?{items:[],nextCursor:null}:{}));
  await mount("community");await page.load();expect(page.data).toMatchObject({loading:false,error:"",displayFeedCount:0});
  mocks.request.mockImplementation(({path}:any)=>path.startsWith("/v1/editorial/")?Promise.reject(new Error("offline")):Promise.resolve({}));await page.load();expect(page.data.error).toContain("暂时无法加载");
  mocks.request.mockImplementation(({path}:any)=>Promise.resolve(path==="/v1/editorial/articles?limit=20"?{items:[card()],nextCursor:"next"}:{}));await page.load();
  mocks.request.mockResolvedValueOnce({items:[card(),card(secondId),card(secondId)],nextCursor:null});await page.onReachBottom();
  expect(page.data.feedColumns.flat().map((item:any)=>item.id).sort()).toEqual([articleId,secondId].sort());expect(page.data.editorialNextCursor).toBeNull();
 });
 it("drops a late featured response after the visible session changes",async()=>{
  const pending=delayed();mocks.request.mockImplementation(({path}:any)=>path.startsWith("/v1/editorial/")?pending.promise:Promise.resolve({}));await mount("community");const load=page.load();page.onHide();mocks.token="new-member";pending.resolve({items:[card()],nextCursor:null});await load;
  expect(page.data.feedColumns.flat()).toEqual([]);
 });
 it("loads the independent author page and uses a published article to confirm following",async()=>{
  mocks.token="member-a";mocks.request.mockResolvedValueOnce(authorPage());await mount("community-author",{id:authorId,source:"editorial"});await page.load();
  expect(page.data).toMatchObject({loading:false,editorialSource:true,articleContextId:articleId,author:{id:authorId,name:"公开作者名",following:false}});
  const pending=delayed();mocks.request.mockReturnValueOnce(pending.promise);const follow=page.toggleFollow();expect(page.data.author.following).toBe(false);
  pending.resolve({authorId,following:true});await follow;expect(page.data.author.following).toBe(true);
  page.openPost({currentTarget:{dataset:{id:articleId}}});expect((globalThis as any).wx.navigateTo).toHaveBeenCalledWith(expect.objectContaining({url:`/pages/post/index?id=${articleId}&source=editorial`}));
 });
 it("retains the editorial author return path for a guest and ignores late author data after hide",async()=>{
  mocks.request.mockResolvedValueOnce(authorPage());await mount("community-author",{id:authorId,source:"editorial"});await page.load();
  await page.toggleFollow();expect(mocks.resume).toHaveBeenCalledWith(`/pages/community-author/index?id=${authorId}&source=editorial`);expect(mocks.request).toHaveBeenCalledOnce();
  const pending=delayed();mocks.request.mockReturnValueOnce(pending.promise);const next=page.load();page.onHide();mocks.token="other-member";
  pending.resolve({...authorPage(),author:{...authorPage().author,following:true}});await next;
  expect(page.data.author).toBeNull();
 });
 it("keeps an author's exact source when a live following action requires current legal consent",async()=>{
  mocks.token="member-a";mocks.request.mockResolvedValueOnce(authorPage());await mount("community-author",{id:authorId,source:"editorial"});await page.load();
  mocks.request.mockRejectedValueOnce({status:409,code:"CURRENT_LEGAL_CONSENT_REQUIRED"});await page.toggleFollow();expect(mocks.renew).toHaveBeenCalledExactlyOnceWith(`/pages/community-author/index?id=${authorId}&source=editorial`);expect(page.data.author.following).toBe(false);
 });
});
