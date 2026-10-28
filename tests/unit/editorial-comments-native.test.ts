import {beforeEach,describe,expect,it,vi} from "vitest";

// Actual Page methods, typed editorial clients, thread grouping and read epochs
// run here. Requests and native dialogs are isolated synthetic boundaries.
const mocks=vi.hoisted(()=>({request:vi.fn(),resume:vi.fn(),renew:vi.fn(),token:"actor-a"}));
vi.mock("../../apps/miniprogram/services/api",()=>({request:mocks.request,resumeAuthentication:mocks.resume,beginLegalRenewal:mocks.renew,clearAuthenticationRedirectSuppression:vi.fn()}));
vi.mock("../../apps/miniprogram/services/page-requests",()=>({pageRead:(_page:unknown,options:unknown)=>mocks.request(options),cancelPageReads:vi.fn()}));
vi.mock("../../apps/miniprogram/services/layout",()=>({currentChromeStyle:()=>"",motionDuration:()=>0}));
vi.mock("../../apps/miniprogram/services/member-avatar",()=>({defaultMemberAvatar:"local-default",localMemberAvatar:async()=>"local-default",prepareFeedAuthors:async(rows:unknown)=>rows}));
vi.mock("../../apps/miniprogram/services/share",()=>({prepareShareLink:vi.fn(),registerIncomingShare:vi.fn()}));
const articleId="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",authorId="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const rootId="cccccccc-cccc-4ccc-8ccc-cccccccccccc",replyId="dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const base=`/v1/editorial/articles/${articleId}/comments`,returnUrl=`/pages/post/index?id=${articleId}&source=editorial`;
const stamp="2026-10-28T00:00:00.000Z";
const row=(id=rootId,patch:Record<string,unknown>={})=>({id,version:2,body:"已审核的评论",status:"published",parentId:null,replyToId:null,replyRootId:id,
 createdAt:stamp,authorId,authorName:"公开昵称",replyToName:null,isMine:false,likeCount:3,liked:false,...patch});
const article=()=>({id:articleId,title:"精选标题",excerpt:"摘要",authorId,author:"作者公开昵称",avatar:"",coverUrl:null,publishedAt:stamp,
 likeCount:17,saveCount:9,version:2,body:"第一段原文\n第二段原文",media:[],liked:false,saved:true,following:false,isMine:false,
 interactionsEnabled:true,sourceUrl:null,provenanceLabel:"",commentsEnabled:true,commentsPolicyVersion:0,commentCount:1,canModerate:false});
const deferred=()=>{let resolve!:(value:any)=>void,reject!:(value:unknown)=>void;const promise=new Promise<any>((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const event=(id=rootId)=>({currentTarget:{dataset:{id}}});
let page:any,rows:any[],enabled:boolean,moderator:boolean,policyVersion:number,nextCursor:string|null,patches:any[],blockReads:Promise<unknown>[];
function commentPage(){return {comments:structuredClone(rows),authors:{[authorId]:{name:"公开昵称",avatar:"",avatarRevision:null}},
 commentCount:rows.filter(item=>item.status==="published").length,commentsEnabled:enabled,commentsPolicyVersion:policyVersion,canModerate:moderator,
 loadedCount:rows.length,hasMore:nextCursor!==null,nextCursor,truncated:nextCursor!==null,preview:false,asOf:stamp};}
function calls(method?:string){return mocks.request.mock.calls.map(([input])=>input).filter(input=>!method||(input.method??"GET")===method);}
function patch(target:any,key:string,value:any){const parts=key.replace(/\[(\d+)\]/g,".$1").split(".");let node=target;for(const [i,name]of parts.entries())if(i===parts.length-1)node[name!]=structuredClone(value);else node=node[name!]??=(/^\d+$/.test(parts[i+1]!)?[]:{});}
async function mount(){await import("../../apps/miniprogram/pages/post/index");page.onLoad({id:articleId,source:"editorial"});await page.load();await vi.waitFor(()=>expect(page.data.commentsLoading).toBe(false));return page;}
beforeEach(()=>{
 vi.resetModules();mocks.request.mockReset();mocks.resume.mockReset();mocks.renew.mockReset();mocks.token="actor-a";
 rows=[row()];enabled=true;moderator=false;policyVersion=3;nextCursor=null;patches=[];blockReads=[];
 (globalThis as any).getApp=()=>({globalData:{sessionToken:mocks.token,apiBaseUrl:"https://synthetic.invalid"}});
 (globalThis as any).Page=(definition:any)=>{page={...definition,data:structuredClone(definition.data),loadEditorialBlocks(...args:any[]){const reading=definition.loadEditorialBlocks.apply(this,args);blockReads.push(Promise.resolve(reading));return reading;},setData(update:any,done?:()=>void){patches.push(structuredClone(update));for(const [key,value]of Object.entries(update))patch(this.data,key,value);done?.();}};};
 (globalThis as any).wx={hideShareMenu:vi.fn(),showShareMenu:vi.fn(),showToast:vi.fn(),hideKeyboard:vi.fn(),pageScrollTo:vi.fn(),
  navigateTo:vi.fn(),navigateBack:vi.fn(),switchTab:vi.fn(),getStorageSync:vi.fn(),nextTick:(callback:()=>void)=>callback(),
  getWindowInfo:()=>({windowWidth:390}),getAppBaseInfo:()=>({fontSizeSetting:16}),
  showModal:vi.fn().mockResolvedValue({confirm:true,content:"明确的处理说明"}),showActionSheet:vi.fn().mockResolvedValue({tapIndex:0})};
 mocks.request.mockImplementation(async(input:any)=>{
  if(input.path===`/v1/editorial/articles/${articleId}`)return article();
  if(input.path.startsWith(base+"?")&&(input.method??"GET")==="GET")return commentPage();
  if(input.path.startsWith("/v1/editorial/blocks?")&&(input.method??"GET")==="GET")return {items:[],loadedCount:0,hasMore:false,nextCursor:null};
  throw new Error(`Unexpected synthetic request ${input.method??"GET"} ${input.path}`);
 });
});

describe("published editorial comment Page reads",()=>{
 it("loads public comments independently without replacing real article reactions or its body",async()=>{
  mocks.token="";await mount();expect(page.data).toMatchObject({commentCount:1,commentsEnabled:true,commentsLoading:false,commentsError:"",commentAuthenticated:false});
  expect(page.data.threads[0]).toMatchObject({id:rootId,body:"已审核的评论",likeCount:3});
  expect(page.data.social).toMatchObject({liked:false,saved:true,likeCount:17,saveCount:9});
  const item=page.data.item,reading=page.readingRead;await page.loadEditorialComments();
  expect(page.data.item).toBe(item);expect(page.readingRead).toBe(reading);expect(calls().filter(input=>input.path===`/v1/editorial/articles/${articleId}`)).toHaveLength(1);
  expect(calls().find(input=>input.path.startsWith(base+"?"))).toMatchObject({authMode:"optional"});
 });
 it("navigates a guest composer or reply to this article and does not submit or require auth just to read",async()=>{
  mocks.token="";await mount();mocks.request.mockClear();page.showComments();
  expect((globalThis as any).wx.pageScrollTo).toHaveBeenCalledWith({selector:"#post-comments",duration:0});expect(mocks.resume).not.toHaveBeenCalled();
  page.startComment();page.replyComment(event());expect(mocks.resume.mock.calls).toEqual([[returnUrl],[returnUrl]]);expect(calls("POST")).toEqual([]);expect(page.data.draft).toBe("");
 });
 it("keeps published comments readable when policy is closed and rejects new send/like locally",async()=>{
  enabled=false;await mount();page.inputComment({detail:{value:"明确提交内容"}});await page.sendComment();await page.likeComment(event());
  expect(page.data.threads[0].body).toBe("已审核的评论");expect(calls("POST")).toEqual([]);expect(calls("PUT")).toEqual([]);
  expect(page.data.commentsError).not.toBe("");expect(page.data.social).toMatchObject({likeCount:17,saveCount:9});
 });
 it("merges actual cursor pages by comment ID without reloading the article",async()=>{
  nextCursor="next_page";await mount();const item=page.data.item;
  rows=[row(),row(replyId,{parentId:rootId,replyRootId:rootId,replyToId:rootId,replyToName:"公开昵称",body:"一条回复"})];nextCursor=null;
  await page.loadMoreEditorialComments();expect(page.data.editorialCommentItems.map((item:any)=>item.id)).toEqual([rootId,replyId]);
  expect(page.data.threads[0].replies[0]).toMatchObject({id:replyId,body:"一条回复"});expect(page.data.item).toBe(item);
  expect(calls().at(-1).path).toBe(base+"?limit=30&cursor=next_page");
 });
 it.each(["hide","unload","actor","version","newer-read"])("discards a late comments read after %s",async(change)=>{
  await mount();const pending=deferred();mocks.request.mockReturnValueOnce(pending.promise);const reading=page.loadEditorialComments();
  if(change==="hide")page.onHide();else if(change==="unload")page.onUnload();else if(change==="actor")mocks.token="actor-b";
  else if(change==="version")page.data.item.version+=1;else {rows=[];await page.loadEditorialComments();}
  const before=patches.length;pending.resolve({...commentPage(),comments:[row(replyId)],loadedCount:1});await reading;
  expect(patches.slice(before)).toEqual([]);expect(page.data.editorialCommentItems.some((item:any)=>item.id===replyId)).toBe(false);
 });
 it("keeps comment-load errors separate from the article and offers a real explicit retry",async()=>{
  await mount();const item=page.data.item;mocks.request.mockRejectedValueOnce({status:503,title:"评论暂时无法读取"});await page.loadEditorialComments();
  expect(page.data.commentsError).toBe("评论暂时无法读取");expect(page.data.commentsLoading).toBe(false);expect(page.data.item).toBe(item);expect(page.data.error).toBe("");
  await page.loadEditorialComments();expect(page.data.commentsError).toBe("");expect(page.data.threads).toHaveLength(1);
 });
 it("waits for the fresh comment section to settle before restoring a verified reading position",async()=>{
  await mount();page.onPageScroll({scrollTop:800});page.onHide();page.readVisible=true;
  const pending=deferred(),ticks:Array<()=>void>=[];(globalThis as any).wx.nextTick=(fn:()=>void)=>ticks.push(fn);
  mocks.request.mockResolvedValueOnce(article()).mockReturnValueOnce(pending.promise);await page.load(true);
  expect(page.data.commentsLoading).toBe(true);expect((globalThis as any).wx.pageScrollTo).not.toHaveBeenCalled();
  pending.resolve(commentPage());await vi.waitFor(()=>expect(ticks).toHaveLength(1));
  expect((globalThis as any).wx.pageScrollTo).not.toHaveBeenCalled();ticks.shift()!();
  expect((globalThis as any).wx.pageScrollTo).toHaveBeenCalledWith(expect.objectContaining({scrollTop:800,duration:0}));
 });
});

describe("published editorial comment Page commands",()=>{
 it.each(["🧴","字".repeat(181)])("rejects an out-of-range Unicode draft before transport %#",async(body)=>{
  await mount();page.inputComment({detail:{value:body}});await page.sendComment();expect(calls("POST")).toEqual([]);expect(page.data.commentsError).toContain("2 至 180");
 });
 it("accepts180 Unicode code points without truncating their360 UTF16 code units",async()=>{
  await mount();const body="🧴".repeat(180);page.inputComment({detail:{value:body}});expect(page.data.draftLength).toBe(180);
  mocks.request.mockResolvedValueOnce({id:replyId,status:"pending",version:1,replayed:false});await page.sendComment();
  expect(calls("POST")[0]).toMatchObject({path:base,data:{body}});expect(calls("POST")[0].data.body).toHaveLength(360);
 });
 it("serializes send taps and only clears the draft after a confirmed receipt",async()=>{
  await mount();page.inputComment({detail:{value:"确认发送的评论"}});const pending=deferred();mocks.request.mockReturnValueOnce(pending.promise);
  const first=page.sendComment();await page.sendComment();expect(calls("POST")).toHaveLength(1);expect(page.data.draft).toBe("确认发送的评论");
  const key=page.data.draftOperation;expect(key).not.toBe("");rows=[row(replyId,{status:"pending",isMine:true,version:1})];
  pending.resolve({id:replyId,status:"pending",version:1,replayed:false});await first;
  expect(page.data).toMatchObject({commentsBusy:false,draft:"",draftOperation:"",commentSendUnknown:false,composerOpen:false});
  expect(page.data.commentsNotice).toContain("审核");expect(page.data.editorialCommentItems[0]).toMatchObject({id:replyId,status:"pending"});
  expect(page.data.commentCount).toBe(0);expect(calls("POST")[0]).toMatchObject({path:base,idempotencyKey:key,data:{body:"确认发送的评论"}});
 });
 it("retains an unknown command's body, reply and key and uses that same command for explicit verification",async()=>{
  await mount();page.replyComment(event());page.inputComment({detail:{value:"尚待确认的回复"}});
  mocks.request.mockRejectedValueOnce({code:"NETWORK_TIMEOUT"});await page.sendComment();const key=page.data.draftOperation;
  expect(page.data).toMatchObject({commentsBusy:false,commentSendUnknown:true,draft:"尚待确认的回复",replyToId:rootId});
  page.inputComment({detail:{value:"不能替换未知正文"}});page.cancelReply();expect(page.data.draftOperation).toBe(key);expect(page.data.draft).toBe("尚待确认的回复");expect(page.data.replyToId).toBe(rootId);
  mocks.request.mockResolvedValueOnce({id:replyId,status:"deleted",version:3,replayed:true});await page.sendComment();
  expect(calls("POST").map(input=>[input.idempotencyKey,input.data])).toEqual([[key,{body:"尚待确认的回复",replyToId:rootId}],[key,{body:"尚待确认的回复",replyToId:rootId}]]);
  expect(page.data).toMatchObject({commentSendUnknown:false,draft:"",draftOperation:""});expect(page.data.commentsNotice).toContain("未再次发送");
 });
 it("preserves a legal-rejected draft/key across a same-actor return without replaying the write",async()=>{
  await mount();page.inputComment({detail:{value:"等待本人协议确认的评论"}});mocks.request.mockRejectedValueOnce({status:409,code:"CURRENT_LEGAL_CONSENT_REQUIRED"});await page.sendComment();
  const key=page.data.draftOperation;expect(mocks.renew).toHaveBeenCalledExactlyOnceWith(returnUrl);expect(page.data.commentSendUnknown).toBe(false);
  page.onHide();page.readVisible=true;await page.load(true);await vi.waitFor(()=>expect(page.data.commentsLoading).toBe(false));
  expect(page.data).toMatchObject({draft:"等待本人协议确认的评论",draftOperation:key});expect(calls("POST")).toHaveLength(1);
 });
 it("clears a draft and operation when a different actor returns",async()=>{
  await mount();page.inputComment({detail:{value:"只属于旧账号的草稿"}});page.data.draftOperation="old-operation-key";
  page.onHide();mocks.token="actor-b";page.readVisible=true;await page.load(true);await vi.waitFor(()=>expect(page.data.commentsLoading).toBe(false));
  expect(page.data).toMatchObject({draft:"",draftOperation:"",replyToId:"",commentSendUnknown:false});
 });
 it.each(["hide","actor","version"])("does not consume an old send receipt after %s",async(change)=>{
  await mount();page.inputComment({detail:{value:"旧请求的评论"}});const pending=deferred();mocks.request.mockReturnValueOnce(pending.promise);const sending=page.sendComment();
  if(change==="hide")page.onHide();else if(change==="actor")mocks.token="actor-b";else page.data.item.version+=1;
  const before=patches.length;pending.resolve({id:replyId,status:"pending",version:1,replayed:false});await sending;
  expect(patches.slice(before)).toEqual([]);expect(page.data.draft).toBe("旧请求的评论");expect(page.data.commentsNotice).toBe("");
 });
 it("adopts only confirmed comment-like counts and does not alter article counts",async()=>{
  await mount();const pending=deferred();mocks.request.mockReturnValueOnce(pending.promise);const liking=page.likeComment(event());
  expect(page.data.editorialCommentItems[0]).toMatchObject({liked:false,likeCount:3});pending.resolve({id:rootId,liked:true,likeCount:8});await liking;
  expect(page.data.editorialCommentItems[0]).toMatchObject({liked:true,likeCount:8});expect(page.data.social).toMatchObject({liked:false,likeCount:17,saved:true,saveCount:9});
 });
 it("does not issue a delete after its confirmation dialog belongs to a different actor",async()=>{
  rows=[row(rootId,{isMine:true})];await mount();const modal=deferred();(globalThis as any).wx.showModal.mockReturnValueOnce(modal.promise);
  const deleting=page.deleteComment(event());mocks.token="actor-b";modal.resolve({confirm:true});await deleting;expect(calls("DELETE")).toEqual([]);
 });
 it("permits own deletion while comments are closed and reloads actual rows instead of inventing a count",async()=>{
  rows=[row(rootId,{isMine:true})];enabled=false;await mount();mocks.request.mockImplementationOnce(async()=>{rows=[];return {id:rootId,status:"deleted"};});await page.deleteComment(event());
  expect(calls("DELETE")[0]).toMatchObject({path:`${base}/${rootId}`,method:"DELETE"});expect(page.data.editorialCommentItems).toEqual([]);expect(page.data.commentCount).toBe(0);
 });
 it("does not expose governance just because an article isMine, and uses true canModerate for its scoped entry",async()=>{
  await mount();page.data.item.isMine=true;page.openCommentReview();expect((globalThis as any).wx.navigateTo).not.toHaveBeenCalled();
  moderator=true;await page.loadEditorialComments();page.openCommentReview();expect((globalThis as any).wx.navigateTo).toHaveBeenCalledWith(expect.objectContaining({url:`/pages/community-review/index?source=editorial&articleId=${articleId}`}));
 });
 it("sends only the separate policy CAS and preserves existing comments on confirmed close",async()=>{
  moderator=true;await mount();mocks.request.mockImplementationOnce(async()=>{enabled=false;policyVersion=4;return {commentsEnabled:false,commentsPolicyVersion:4};});await page.toggleCommentsPolicy();
  expect(calls("PUT")[0]).toMatchObject({path:`/v1/management/editorial/articles/${articleId}/comments-policy`,data:{enabled:false,expectedVersion:3}});
  expect(page.data).toMatchObject({commentsEnabled:false,commentsPolicyVersion:4});expect(page.data.editorialCommentItems[0].id).toBe(rootId);expect(page.data.social.likeCount).toBe(17);
 });
 it("loads persistent blocks after closing and reentering the sheet instead of relying on the last block action",async()=>{
  await mount();const list={items:[{authorId,name:"已屏蔽的公开昵称",avatar:"",avatarRevision:null}],loadedCount:1,hasMore:false,nextCursor:null};
  mocks.request.mockResolvedValueOnce(list);page.openEditorialBlocks();await vi.waitFor(()=>expect(page.data.blocks).toHaveLength(1));
  expect(page.data.lastBlockedAuthor).toBe("");page.closeEditorialBlocks();expect(page.data.blocks).toEqual([]);
  mocks.request.mockResolvedValueOnce(list);page.openEditorialBlocks();await vi.waitFor(()=>expect(page.data.blocks).toHaveLength(1));
  expect(calls().filter(input=>input.path==="/v1/editorial/blocks?limit=30")).toHaveLength(2);
 });
 it("does not refill a closed block sheet from its late private read",async()=>{
  await mount();const pending=deferred();mocks.request.mockReturnValueOnce(pending.promise);page.openEditorialBlocks();const reading=blockReads.at(-1);page.closeEditorialBlocks();const before=patches.length;
  pending.resolve({items:[{authorId,name:"旧屏蔽列表",avatar:"",avatarRevision:null}],loadedCount:1,hasMore:false,nextCursor:null});
  await reading;expect(patches.slice(before)).toEqual([]);expect(page.data).toMatchObject({blocksOpen:false,blocks:[]});
 });
 it("keeps an unconfirmed unblock visible and removes it only after an explicit confirmed retry",async()=>{
  await mount();mocks.request.mockResolvedValueOnce({items:[{authorId,name:"公开昵称",avatar:"",avatarRevision:null}],loadedCount:1,hasMore:false,nextCursor:null});
  page.openEditorialBlocks();await vi.waitFor(()=>expect(page.data.blocks).toHaveLength(1));
  mocks.request.mockRejectedValueOnce({code:"NETWORK_TIMEOUT"});await page.unblockEditorialAuthor(event(authorId));
  expect(page.data.blocks).toHaveLength(1);expect(page.data.blocksBusy).toBe(false);expect(page.data.blocksError).toContain("尚未确认");
  mocks.request.mockResolvedValueOnce({authorId,blocked:false});await page.unblockEditorialAuthor(event(authorId));
  expect(page.data.blocks).toEqual([]);expect(calls("PUT").map(input=>[input.path,input.data])).toEqual([
   [`/v1/editorial/blocks/${authorId}`,{active:false}],[`/v1/editorial/blocks/${authorId}`,{active:false}]]);
 });
});
