import { beforeEach, expect, it, vi } from "vitest";

const requestMock=vi.hoisted(()=>vi.fn());
vi.mock("../../apps/miniprogram/services/api",()=>({request:requestMock,requireMemberAccess:vi.fn(()=>true)}));
vi.mock("../../apps/miniprogram/services/layout",()=>({currentChromeStyle:()=>""}));

type Definition=Record<string,any>&{data:Record<string,any>};
let definition:Definition;
let session="reviewer-a";
let modal=vi.fn();
function mounted(){
  const page:Record<string,any>={data:{...definition.data},setData(patch:Record<string,unknown>){Object.assign(this.data,patch);}};
  for(const [name,value] of Object.entries(definition))if(typeof value==="function")page[name]=value;
  page.data.postId="00000000-0000-4000-8000-000000000001";
  return page;
}
const candidate=(moderationState="pending")=>({id:"00000000-0000-4000-8000-000000000001",authorId:"owner",state:"pending_review",
  revision:2,publishedRevision:null,version:3,title:"待审核标题",body:"仅供审核",aiUsage:"none",
  rightsConfirmed:true,publicConsentConfirmed:true,moderationState,media:[],lastAction:null});
beforeEach(async()=>{
  vi.resetModules();requestMock.mockReset();session="reviewer-a";modal=vi.fn();
  (globalThis as any).getApp=()=>({globalData:{sessionToken:session}});
  (globalThis as any).wx={showModal:(...args:unknown[])=>modal(...args),previewImage:vi.fn(),navigateBack:vi.fn()};
  (globalThis as any).Page=(value:Definition)=>{definition=value;};
  await import("../../apps/miniprogram/pages/community-review/index");
});

it("clears a private candidate on a failed reload and ignores an old-account modal",async()=>{
  const page=mounted();requestMock.mockResolvedValueOnce(candidate());await page.load();
  expect(page.data.candidate?.body).toBe("仅供审核");
  let closeModal!:(value:{confirm:boolean;content:string})=>void;
  modal.mockReturnValueOnce(new Promise(resolve=>{closeModal=resolve;}));
  const pending=page.reviewPost({currentTarget:{dataset:{decision:"reject"}}});
  session="reviewer-b";
  requestMock.mockRejectedValueOnce({status:403,title:"无审核权限"});
  await page.load();
  expect(page.data.candidate).toBeNull();expect(page.data.media).toEqual([]);
  closeModal({confirm:true,content:"足够长的审核依据"});await pending;
  expect(requestMock.mock.calls.filter(([input])=>input.method==="POST")).toHaveLength(0);
  expect(page.data.error).toBe("无审核权限");
});

it("keeps successful rejection and publication as terminal results without re-reading the removed candidate",async()=>{
  const rejectPage=mounted();requestMock.mockResolvedValueOnce(candidate());await rejectPage.load();
  modal.mockResolvedValueOnce({confirm:true,content:"已核对，需要作者修改"});
  requestMock.mockResolvedValueOnce({decision:"reject",version:4});
  await rejectPage.reviewPost({currentTarget:{dataset:{decision:"reject"}}});
  expect(rejectPage.data).toMatchObject({candidate:null,media:[],handled:true,error:"",notice:"已退回作者修改。"});
  expect(requestMock).toHaveBeenCalledTimes(2);

  const publishPage=mounted();requestMock.mockResolvedValueOnce(candidate("approved"));await publishPage.load();
  modal.mockResolvedValueOnce({confirm:true});requestMock.mockResolvedValueOnce({state:"published",version:4});
  await publishPage.publish();
  expect(publishPage.data).toMatchObject({candidate:null,media:[],handled:true,error:"",notice:"已公开这篇护理故事。"});
  expect(requestMock).toHaveBeenCalledTimes(4);
});

it("removes old actions when another reviewer handles the candidate",async()=>{
  const page=mounted();requestMock.mockResolvedValueOnce(candidate());await page.load();
  modal.mockResolvedValueOnce({confirm:true,content:"足够长的审核依据"});requestMock.mockRejectedValueOnce({status:409});
  await page.reviewPost({currentTarget:{dataset:{decision:"approve"}}});
  expect(page.data.candidate).toBeNull();expect(page.data.handled).toBe(true);
  expect(page.data.notice).toContain("已被他人处理");
});

for(const action of ['load','reviewPost','reviewMedia','publish'])it(`clears the private candidate after revoked capability at ${action}`,async()=>{
  const page=mounted();const item=candidate(action==='publish'?'approved':'pending');
  item.media=[{id:'media-one',state:'uploaded',scanVerdict:'safe',scanProvider:'synthetic',position:0}] as any;
  requestMock.mockResolvedValueOnce(item).mockResolvedValueOnce({url:'https://example.invalid/private'});await page.load();
  modal.mockResolvedValueOnce({confirm:true,content:'隔离审核充分依据'});
  requestMock.mockRejectedValueOnce({status:403,code:'CAPABILITY_REQUIRED',title:'Required capability: community.moderate'});
  if(action==='reviewPost'||action==='reviewMedia')await page[action]({currentTarget:{dataset:{decision:'approve',id:'media-one'}}});else await page[action]();
  expect(page.data).toMatchObject({candidate:null,media:[],busy:false,permissionDenied:true,handled:false});
  expect(page.data.error).toBe('当前账号没有内容审核权限，请返回社区。');
  const before=requestMock.mock.calls.length;
  await page.reviewPost({currentTarget:{dataset:{decision:'approve'}}});
  expect(requestMock.mock.calls).toHaveLength(before);
});

it("does not retain candidate text when private media lookup reports revoked capability",async()=>{
  const page=mounted();const item=candidate();item.media=[{id:'media-one'}] as any;
  requestMock.mockResolvedValueOnce(item).mockRejectedValueOnce({status:403,code:'CAPABILITY_REQUIRED',title:'Required capability: community.moderate'});
  await page.load();expect(page.data).toMatchObject({candidate:null,media:[],permissionDenied:true,loading:false,busy:false});
});
