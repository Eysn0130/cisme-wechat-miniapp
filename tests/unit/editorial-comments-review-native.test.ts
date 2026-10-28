import {beforeEach,describe,expect,it,vi} from "vitest";

const m=vi.hoisted(()=>({request:vi.fn(),require:vi.fn(),token:"synthetic-moderator"}));
vi.mock("../../apps/miniprogram/services/api",()=>({request:m.request,requireMemberAccess:m.require}));
vi.mock("../../apps/miniprogram/services/page-requests",()=>({pageRead:(_page:unknown,options:unknown)=>m.request(options),cancelPageReads:vi.fn()}));
vi.mock("../../apps/miniprogram/services/layout",()=>({currentChromeStyle:()=>""}));
const articleId="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",commentId="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",authorId="cccccccc-cccc-4ccc-8ccc-cccccccccccc",secondId="dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const queuePath="/v1/management/editorial/comments",reviewPath=`${queuePath}/${commentId}/review`;
const row=(patch:Record<string,unknown>={})=>({id:commentId,version:3,body:"实际待审正文",status:"pending",parentId:null,replyToId:null,replyRootId:commentId,
 createdAt:"2026-10-28T00:00:00.000Z",articleId,articleTitle:"实际精选标题",authorId,authorName:"公开昵称",safetyState:"safe",reportCount:0,...patch});
const deferred=()=>{let resolve!:(value:any)=>void,reject!:(value:unknown)=>void;const promise=new Promise<any>((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const event=(decision="approve")=>({currentTarget:{dataset:{id:commentId,decision}}});
let page:any,items:any[],cursor:string|null,patches:any[];
function queue(){return {items:structuredClone(items),authors:{[authorId]:{name:"公开昵称",avatar:"",avatarRevision:null}},loadedCount:items.length,hasMore:cursor!==null,nextCursor:cursor};}
const writes=()=>m.request.mock.calls.map(([input])=>input).filter(input=>input.method==="POST");
async function mount(){await import("../../apps/miniprogram/pages/community-review/index");page.onLoad({source:"editorial",articleId});await vi.waitFor(()=>expect(page.data.loading).toBe(false));return page;}
beforeEach(()=>{
 vi.resetModules();vi.clearAllMocks();m.request.mockReset();m.require.mockReset();m.token="synthetic-moderator";items=[row()];cursor=null;patches=[];
 m.require.mockImplementation(()=>Boolean(m.token));
 (globalThis as any).getApp=()=>({globalData:{sessionToken:m.token,apiBaseUrl:"https://synthetic.invalid"}});
 (globalThis as any).Page=(definition:any)=>{page={...definition,data:structuredClone(definition.data),setData(update:any){patches.push(structuredClone(update));Object.assign(this.data,structuredClone(update));}};};
 (globalThis as any).wx={showModal:vi.fn().mockResolvedValue({confirm:true,content:"已核对正文与安全检查结果"}),showToast:vi.fn(),navigateTo:vi.fn(),navigateBack:vi.fn(),switchTab:vi.fn()};
 m.request.mockImplementation(async(input:any)=>{if(input.path.startsWith(queuePath+"?")&&!input.method)return queue();throw new Error(`Unexpected synthetic request ${input.method} ${input.path}`);});
});

describe("independent editorial moderation Page",()=>{
 it("reads only the scoped editorial queue and does not invent public-reader fields or ordinary UGC permission",async()=>{
  await mount();expect(m.require).toHaveBeenCalledWith(`/pages/community-review/index?source=editorial&articleId=${articleId}`);
  expect(m.request).toHaveBeenCalledWith({path:`${queuePath}?state=pending&limit=30&articleId=${articleId}`,authMode:"required"});
  expect(page.data.queueItems[0]).toMatchObject({articleId,articleTitle:"实际精选标题",body:"实际待审正文",version:3,safetyState:"safe"});
  expect(page.data.queueItems[0]).not.toHaveProperty("isMine");expect(page.data.queueItems[0]).not.toHaveProperty("likeCount");
  expect(m.request.mock.calls.some(([input])=>input.path.includes("/ugc/"))).toBe(false);
 });
 it("does not locally forbid an authorized review based on a nonexistent separate-reviewer flag",async()=>{
  await mount();m.request.mockImplementationOnce(async()=>{items=[];return {id:commentId,status:"published",version:4};});await page.reviewEditorial(event());
  expect(writes()).toEqual([{path:reviewPath,method:"POST",data:{decision:"approve",reason:"已核对正文与安全检查结果",expectedVersion:3}}]);
  expect(page.data.queueItems).toEqual([]);expect(page.data.notice).toContain("通过审核");
 });
 it.each(["pending","review","risky","error"])("does not request approval when the actual safety state is %s",async(safetyState)=>{
  items=[row({safetyState})];await mount();await page.reviewEditorial(event());
  expect((globalThis as any).wx.showModal).not.toHaveBeenCalled();expect(writes()).toEqual([]);expect(page.data.error).toContain("安全检查");
 });
 it("serializes the pending native decision and never optimistically publishes the queue row",async()=>{
  await mount();const pending=deferred();m.request.mockReturnValueOnce(pending.promise);const first=page.reviewEditorial(event());
  await vi.waitFor(()=>expect(writes()).toHaveLength(1));await page.reviewEditorial(event());
  expect(writes()).toHaveLength(1);expect(page.data.queueItems[0]).toMatchObject({status:"pending",version:3});
  pending.reject({status:503,title:"处理结果尚未确认，请刷新核对"});await first;
  expect(page.data.busy).toBe(false);expect(page.data.queueItems[0].status).toBe("pending");expect(page.data.error).toContain("尚未确认");
 });
 it.each(["hide","unload","actor","row-version","tab"])("does not submit a modal confirmation after %s changed its context",async(change)=>{
  await mount();const answer=deferred();(globalThis as any).wx.showModal.mockReturnValueOnce(answer.promise);const reviewing=page.reviewEditorial(event());
  if(change==="hide")page.onHide();else if(change==="unload")page.onUnload();else if(change==="actor")m.token="synthetic-other-moderator";
  else if(change==="row-version")page.setData({queueItems:[{...page.data.queueItems[0],version:4}]});
  else {page.selectEditorialQueue({currentTarget:{dataset:{state:"published"}}});await vi.waitFor(()=>expect(page.data.loading).toBe(false));}
  answer.resolve({confirm:true,content:"旧弹窗不能提交新上下文"});await reviewing;expect(writes()).toEqual([]);
 });
 it.each(["hide","actor","new-queue"])("does not adopt an old review result after %s",async(change)=>{
  await mount();const pending=deferred();m.request.mockReturnValueOnce(pending.promise);const reviewing=page.reviewEditorial(event());await vi.waitFor(()=>expect(writes()).toHaveLength(1));
  if(change==="hide")page.onHide();else if(change==="actor")m.token="synthetic-other-moderator";else await page.loadEditorialQueue();
  const before=patches.length;pending.resolve({id:commentId,status:"published",version:4});await reviewing;
  expect(patches.slice(before)).toEqual([]);expect(page.data.notice).toBe("");
 });
 it("preserves the actual row on CAS409 and accepts a later explicit refreshed version",async()=>{
  await mount();m.request.mockRejectedValueOnce({status:409,code:"COMMENT_REVIEW_CONFLICT",title:"评论状态已变化，请刷新"});await page.reviewEditorial(event());
  expect(page.data.queueItems[0]).toMatchObject({id:commentId,version:3});expect(page.data.busy).toBe(false);expect(page.data.error).toContain("刷新");
  items=[row({version:4,status:"published"})];await page.loadEditorialQueue();expect(page.data.queueItems[0]).toMatchObject({version:4,status:"published"});
 });
 it("removes private queue data and actions after a real permission rejection",async()=>{
  await mount();m.request.mockRejectedValueOnce({status:403,code:"CAPABILITY_REQUIRED"});await page.reviewEditorial(event());
  expect(page.data).toMatchObject({queueItems:[],queueCursor:null,queueHasMore:false,busy:false,permissionDenied:true});
  expect(page.data.error).toContain("权限");const count=writes().length;await page.reviewEditorial(event());expect(writes()).toHaveLength(count);
 });
 it("deduplicates paged items and keeps the selected state/article in every query",async()=>{
  cursor="next_page";await mount();items=[row(),row({id:secondId,replyRootId:secondId})];cursor=null;await page.loadMoreEditorialQueue();
  expect(page.data.queueItems.map((item:any)=>item.id)).toEqual([commentId,secondId]);
  expect(m.request.mock.calls.at(-1)?.[0]).toMatchObject({path:`${queuePath}?state=pending&limit=30&cursor=next_page&articleId=${articleId}`});
 });
 it("discards an older queue read after the selected state changes",async()=>{
  await mount();const pending=deferred();m.request.mockReturnValueOnce(pending.promise);const old=page.loadEditorialQueue();
  items=[];page.selectEditorialQueue({currentTarget:{dataset:{state:"hidden"}}});await vi.waitFor(()=>expect(page.data.loading).toBe(false));
  pending.resolve(queue());await old;expect(page.data).toMatchObject({queueState:"hidden",queueItems:[]});
 });
 it("opens the real article route without minting content or requesting a public UGC preview",async()=>{
  await mount();page.openEditorialArticle({currentTarget:{dataset:{articleId}}});
  expect((globalThis as any).wx.navigateTo).toHaveBeenCalledWith(expect.objectContaining({url:`/pages/post/index?id=${articleId}&source=editorial`}));expect(writes()).toEqual([]);
 });
});
