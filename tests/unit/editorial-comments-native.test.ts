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
async function mountWithDelayedBridge(){
 await import("../../apps/miniprogram/pages/post/index");page.onLoad({id:articleId,source:"editorial"});
 const apply=page.setData.bind(page);
 page.setData=(update:any,done?:()=>void)=>{apply(update);if(done)setTimeout(done,20);};
 await page.load();
}
function input(value:string){if(!page.data.composerOpen)page.startComment();page.inputComment({detail:{value},currentTarget:{dataset:{composerId:page.data.composerEventId}}});}
beforeEach(()=>{
 vi.resetModules();mocks.request.mockReset();mocks.resume.mockReset();mocks.renew.mockReset();mocks.token="actor-a";
 rows=[row()];enabled=true;moderator=false;policyVersion=3;nextCursor=null;patches=[];blockReads=[];
 (globalThis as any).getApp=()=>({globalData:{sessionToken:mocks.token,apiBaseUrl:"https://synthetic.invalid"}});
 (globalThis as any).Page=(definition:any)=>{page={...definition,data:structuredClone(definition.data),loadEditorialBlocks(...args:any[]){const reading=definition.loadEditorialBlocks.apply(this,args);blockReads.push(Promise.resolve(reading));return reading;},setData(update:any,done?:()=>void){patches.push(structuredClone(update));for(const [key,value]of Object.entries(update))patch(this.data,key,value);done?.();}};};
 (globalThis as any).wx={hideShareMenu:vi.fn(),showShareMenu:vi.fn(),showToast:vi.fn(),hideKeyboard:vi.fn(),stopPullDownRefresh:vi.fn(),pageScrollTo:vi.fn(),
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
 it.each(["success","failure"] as const)("keeps the article/count bridge window loading until comments settle with %s",async(outcome)=>{
  vi.useFakeTimers();
  try{
   rows=[row(),row(replyId)];const pending=deferred();
   mocks.request.mockResolvedValueOnce({...article(),commentCount:2}).mockReturnValueOnce(pending.promise);
   await mountWithDelayedBridge();
   expect(page.data).toMatchObject({loading:false,item:{id:articleId},commentCount:2,commentsLoading:true,commentsError:"",threads:[]});
   const articlePatch=patches.find(value=>value.item?.id===articleId);
   expect(articlePatch).toMatchObject({commentCount:2,commentsLoading:true});
   expect(calls().filter(input=>input.path.startsWith(base+"?"))).toHaveLength(0);
   await vi.advanceTimersByTimeAsync(19);expect(calls().filter(input=>input.path.startsWith(base+"?"))).toHaveLength(0);expect(page.data.commentsLoading).toBe(true);
   await vi.advanceTimersByTimeAsync(1);expect(calls().filter(input=>input.path.startsWith(base+"?"))).toHaveLength(1);expect(page.data.commentsLoading).toBe(true);
   if(outcome==="success")pending.resolve(commentPage());else pending.reject({status:503,title:"评论暂时无法读取"});
   await vi.waitFor(()=>expect(page.data.commentsLoading).toBe(false));
   expect(page.data.item.id).toBe(articleId);expect(page.data.commentCount).toBe(2);
   if(outcome==="success"){expect(page.data.threads).toHaveLength(2);expect(page.data.commentsError).toBe("");}
   else {expect(page.data.threads).toEqual([]);expect(page.data.commentsError).toBe("评论暂时无法读取");}
   expect(calls("POST")).toEqual([]);
  }finally{vi.useRealTimers();}
 });
 it.each(["success","failure"] as const)("does not apply a late comments %s after the delayed bridge has started a read and the page hides",async(outcome)=>{
  vi.useFakeTimers();
  try{
   const pending=deferred();mocks.request.mockResolvedValueOnce({...article(),commentCount:2}).mockReturnValueOnce(pending.promise);
   await mountWithDelayedBridge();await vi.advanceTimersByTimeAsync(20);
   expect(calls().filter(input=>input.path.startsWith(base+"?"))).toHaveLength(1);
   page.onHide();const before=patches.length;
   if(outcome==="success")pending.resolve(commentPage());else pending.reject({status:503});
   await vi.advanceTimersByTimeAsync(0);
   expect(patches.slice(before)).toEqual([]);expect(page.data.commentsLoading).toBe(false);expect(page.data.threads).toEqual([]);
  }finally{vi.useRealTimers();}
 });
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
  enabled=false;await mount();input("明确提交内容");await page.sendComment();await page.likeComment(event());
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
  await mount();input(body);await page.sendComment();expect(calls("POST")).toEqual([]);expect(page.data.commentsError).toContain("2 至 180");
 });
 it("accepts180 Unicode code points without truncating their360 UTF16 code units",async()=>{
  await mount();const body="🧴".repeat(180);input(body);expect(page.data.draftLength).toBe(180);
  mocks.request.mockResolvedValueOnce({id:replyId,status:"pending",version:1,replayed:false});await page.sendComment();
  expect(calls("POST")[0]).toMatchObject({path:base,data:{body}});expect(calls("POST")[0].data.body).toHaveLength(360);
 });
 it("serializes send taps and only clears the draft after a confirmed receipt",async()=>{
  await mount();input("确认发送的评论");const pending=deferred();mocks.request.mockReturnValueOnce(pending.promise);
  const first=page.sendComment();await page.sendComment();expect(calls("POST")).toHaveLength(1);expect(page.data.draft).toBe("确认发送的评论");
  const key=page.data.draftOperation;expect(key).not.toBe("");rows=[row(replyId,{status:"published",isMine:true,version:1})];
  pending.resolve({id:replyId,status:"published",version:1,replayed:false});await first;
  expect(page.data).toMatchObject({commentsBusy:false,draft:"",draftOperation:"",commentSendUnknown:false,composerOpen:false});
  expect(page.data.commentsNotice).toBe("评论已发布。");expect(page.data.editorialCommentItems[0]).toMatchObject({id:replyId,status:"published"});
  expect(page.data.commentCount).toBe(1);expect(calls("POST")[0]).toMatchObject({path:base,idempotencyKey:key,data:{body:"确认发送的评论"}});
 });
 it("retains an unknown command's body, reply and key and uses that same command for explicit verification",async()=>{
  await mount();page.replyComment(event());input("尚待确认的回复");
  mocks.request.mockRejectedValueOnce({code:"NETWORK_TIMEOUT"});await page.sendComment();const key=page.data.draftOperation;
  expect(page.data).toMatchObject({commentsBusy:false,commentSendUnknown:true,draft:"尚待确认的回复",replyToId:rootId});
  input("不能替换未知正文");page.cancelReply();expect(page.data.draftOperation).toBe(key);expect(page.data.draft).toBe("尚待确认的回复");expect(page.data.replyToId).toBe(rootId);
  mocks.request.mockResolvedValueOnce({id:replyId,status:"deleted",version:3,replayed:true});await page.sendComment();
  expect(calls("POST").map(input=>[input.idempotencyKey,input.data])).toEqual([[key,{body:"尚待确认的回复",replyToId:rootId}],[key,{body:"尚待确认的回复",replyToId:rootId}]]);
  expect(page.data).toMatchObject({commentSendUnknown:false,draft:"",draftOperation:""});expect(page.data.commentsNotice).toContain("未再次发送");
 });
 it("preserves a legal-rejected draft/key across a same-actor return without replaying the write",async()=>{
  await mount();input("等待本人协议确认的评论");mocks.request.mockRejectedValueOnce({status:409,code:"CURRENT_LEGAL_CONSENT_REQUIRED"});await page.sendComment();
  const key=page.data.draftOperation;expect(mocks.renew).toHaveBeenCalledExactlyOnceWith(returnUrl);expect(page.data.commentSendUnknown).toBe(false);
  page.onHide();page.readVisible=true;await page.load(true);await vi.waitFor(()=>expect(page.data.commentsLoading).toBe(false));
  expect(page.data).toMatchObject({draft:"等待本人协议确认的评论",draftOperation:key});expect(calls("POST")).toHaveLength(1);
 });
 it("clears a draft and operation when a different actor returns",async()=>{
  await mount();input("只属于旧账号的草稿");page.data.draftOperation="old-operation-key";
  page.onHide();mocks.token="actor-b";page.readVisible=true;await page.load(true);await vi.waitFor(()=>expect(page.data.commentsLoading).toBe(false));
  expect(page.data).toMatchObject({draft:"",draftOperation:"",replyToId:"",commentSendUnknown:false});
 });
 it.each(["hide","actor","version"])("does not consume an old send receipt after %s",async(change)=>{
  await mount();input("旧请求的评论");const pending=deferred();mocks.request.mockReturnValueOnce(pending.promise);const sending=page.sendComment();
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
  rows=[row(rootId,{isMine:false})];moderator=true;await mount();const modal=deferred();(globalThis as any).wx.showModal.mockReturnValueOnce(modal.promise);
  const deleting=page.deleteComment(event());mocks.token="actor-b";modal.resolve({confirm:true});await deleting;expect(calls("DELETE")).toEqual([]);
 });
 it("refuses a normal author's delete even when the row isMine",async()=>{
  rows=[row(rootId,{isMine:true})];await mount();await page.deleteComment(event());
  expect((globalThis as any).wx.showModal).not.toHaveBeenCalled();expect(calls("DELETE")).toEqual([]);
 });
 it("permits administrator deletion while comments are closed and reloads actual rows instead of inventing a count",async()=>{
  rows=[row(rootId,{isMine:false})];moderator=true;enabled=false;await mount();mocks.request.mockImplementationOnce(async()=>{rows=[];return {id:rootId,status:"deleted"};});await page.deleteComment(event());
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


describe("editorial reading controls without permanent refresh buttons",()=>{
 it("automatically appends one cursor read at the end and preserves the article and draft",async()=>{
  nextCursor="next_page";await mount();const item=page.data.item,reading=page.readingRead;
  input("尚未发送的真实输入");page.closeComposer();page.data.draftOperation="kept-operation";
  const pending=deferred();mocks.request.mockReturnValueOnce(pending.promise);const before=calls().length;
  page.onReachBottom();page.onReachBottom();expect(calls().slice(before).map(input=>input.path)).toEqual([base+"?limit=30&cursor=next_page"]);
  rows=[row(replyId,{body:"后一页评论"})];nextCursor=null;pending.resolve(commentPage());
  await vi.waitFor(()=>expect(page.data.commentsLoading).toBe(false));
  expect(page.data.editorialCommentItems.map((item:any)=>item.id)).toEqual([rootId,replyId]);
  expect(page.data.item).toBe(item);expect(page.readingRead).toBe(reading);
  expect(page.data).toMatchObject({draft:"尚未发送的真实输入",draftOperation:"kept-operation",commentHasMore:false});
  expect(calls("POST")).toEqual([]);
 });
 it("keeps a failed next-page cursor for explicit retry without resetting the list",async()=>{
  nextCursor="next_page";await mount();input("保留输入");page.closeComposer();
  mocks.request.mockRejectedValueOnce({status:503,title:"暂时无法读取"});await page.loadMoreEditorialComments();
  expect(page.data).toMatchObject({commentRetryAppend:true,commentCursor:"next_page",draft:"保留输入"});
  const before=calls().length;page.onReachBottom();expect(calls()).toHaveLength(before);
  rows=[row(replyId,{body:"后一页评论"})];nextCursor=null;await page.retryEditorialComments();
  expect(calls().at(-1).path).toBe(base+"?limit=30&cursor=next_page");
  expect(page.data.editorialCommentItems.map((item:any)=>item.id)).toEqual([rootId,replyId]);
  expect(page.data.commentsError).toBe("");expect(page.data.draft).toBe("保留输入");
 });
 it.each(["success","failure","busy"])("settles native pull-down with %s without reloading the article",async(state)=>{
  await mount();const item=page.data.item,before=calls().length;
  if(state==="failure")mocks.request.mockRejectedValueOnce({status:503,title:"读取失败"});
  if(state==="busy")page.data.commentsBusy=true;
  await page.onPullDownRefresh();expect((globalThis as any).wx.stopPullDownRefresh).toHaveBeenCalledOnce();
  expect(page.data.item).toBe(item);expect(calls().slice(before).every(input=>input.path.startsWith(base+"?"))).toBe(true);
  if(state==="busy")expect(calls()).toHaveLength(before);
  expect(calls("POST")).toEqual([]);
 });
 it("keeps keyboard height until dismissal and rejects events from a closed or replaced editor",async()=>{
  await mount();page.startComment();const first=page.data.composerEventId;
  const key=(id:number,height:number)=>({detail:{height},currentTarget:{dataset:{composerId:id}}});
  const focus=(id:number)=>({currentTarget:{dataset:{composerId:id}}});
  page.keyboardChanged(key(first,280));page.blurComment(focus(first));expect(page.data.keyboardHeight).toBe(280);
  page.keyboardChanged(key(first,0));expect(page.data.keyboardHeight).toBe(0);
  input("保留这一段输入");page.data.draftOperation="known-operation";page.data.commentSendUnknown=true;
  page.closeComposer();page.keyboardChanged(key(first,310));expect(page.data.keyboardHeight).toBe(0);
  page.startComment();const second=page.data.composerEventId;expect(second).not.toBe(first);
  page.keyboardChanged(key(second,300));page.blurComment(focus(first));page.keyboardChanged(key(first,0));
  expect(page.data).toMatchObject({keyboardHeight:300,composerFocused:true,draft:"保留这一段输入",draftOperation:"known-operation",commentSendUnknown:true});
  page.onHide();const patchesBefore=patches.length;page.keyboardChanged(key(second,300));page.focusComment(focus(second));
  expect(patches).toHaveLength(patchesBefore);expect(page.data.keyboardHeight).toBe(0);expect(calls("POST")).toEqual([]);
 });
 it("applies only the current editor's measured height",async()=>{
  await mount();const boxes:Array<(box:any)=>void>=[];
  (globalThis as any).wx.createSelectorQuery=()=>({in(){return this;},select(){return this;},boundingClientRect(fn:(box:any)=>void){boxes.push(fn);return this;},exec(){}});
  page.startComment();page.closeComposer();page.startComment();expect(boxes).toHaveLength(2);
  boxes[0]!({height:400});expect(page.data.composerHeight).toBe(144);
  boxes[1]!({height:182.4});expect(page.data.composerHeight).toBe(183);
  page.measureComposer();page.onHide();boxes[2]!({height:220});expect(page.data.composerHeight).toBe(183);
 });
 it("keeps moderation actions role-scoped and routes review explicitly",async()=>{
  await mount();await page.openCommentManagement();expect((globalThis as any).wx.showActionSheet).not.toHaveBeenCalled();
  moderator=true;await page.loadEditorialComments();await page.openCommentManagement();
  expect((globalThis as any).wx.showActionSheet).toHaveBeenCalledWith({itemList:["审核评论","关闭这篇评论"]});
  expect((globalThis as any).wx.navigateTo).toHaveBeenCalledWith(expect.objectContaining({url:`/pages/community-review/index?source=editorial&articleId=${articleId}`}));
  expect(calls("PUT")).toEqual([]);
 });
 it("does not apply a moderation-menu selection after identity changes",async()=>{
  moderator=true;await mount();const menu=deferred();(globalThis as any).wx.showActionSheet.mockReturnValueOnce(menu.promise);
  const opening=page.openCommentManagement();mocks.token="actor-b";menu.resolve({tapIndex:1});await opening;
  expect((globalThis as any).wx.showModal).not.toHaveBeenCalled();expect(calls("PUT")).toEqual([]);
 });
});


describe("editorial input and explicit interaction recovery ownership",()=>{
 it("ignores old input events after closing and reopening the editor",async()=>{
  await mount();page.startComment();const oldId=page.data.composerEventId;page.closeComposer();page.startComment();
  input("只属于当前编辑器的内容");page.data.draftOperation="keep-current-operation";
  page.inputComment({detail:{value:"迟到的旧输入"},currentTarget:{dataset:{composerId:oldId}}});
  expect(page.data).toMatchObject({draft:"只属于当前编辑器的内容",draftOperation:"keep-current-operation"});
  page.closeComposer();page.inputComment({detail:{value:"关闭后迟到的输入"},currentTarget:{dataset:{composerId:page.data.composerEventId}}});
  expect(page.data.draft).toBe("只属于当前编辑器的内容");expect(calls("POST")).toEqual([]);
 });
 it("explicitly rechecks article reactions without resending a write or losing the pending comment",async()=>{
  await mount();input("尚待核对的评论");page.data.draftOperation="same-operation";page.data.commentSendUnknown=true;page.closeComposer();
  page.onPageScroll({scrollTop:800});page.data.socialError="互动结果尚未确认";
  mocks.request.mockResolvedValueOnce({...article(),liked:true,saved:false,likeCount:18,saveCount:8,following:true});
  await page.loadSocial();await vi.waitFor(()=>expect(page.data.commentsLoading).toBe(false));
  expect(page.data.social).toMatchObject({liked:true,saved:false,likeCount:18,saveCount:8});expect(page.data.following).toBe(true);
  expect(page.data).toMatchObject({draft:"尚待核对的评论",draftOperation:"same-operation",commentSendUnknown:true,socialError:"互动结果尚未确认"});
  expect((globalThis as any).wx.pageScrollTo).toHaveBeenCalledWith(expect.objectContaining({scrollTop:800,duration:0}));
  expect(calls("POST")).toEqual([]);expect(calls("PUT")).toEqual([]);
 });
 it.each(["socialBusy","followBusy"])("does not start a recheck during %s",async(flag)=>{
  await mount();page.data[flag]=true;const before=calls().length;await page.loadSocial();expect(calls()).toHaveLength(before);
 });
 it("routes a consent refusal back to renewal instead of treating a public GET as agreement",async()=>{
  await mount();page.editorialSocialRefusal="需确认当前协议";const before=calls().length;await page.loadSocial();
  expect(mocks.renew).toHaveBeenCalledExactlyOnceWith(returnUrl);expect(calls()).toHaveLength(before);
 });
});
