import {beforeEach,describe,expect,it,vi} from "vitest";

// These tests retain the real request/coordinator/HTTP layers. Only native
// wx.request callbacks are synthetic; no member, consent, or network is created.
const articleId="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const commentId="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const authorId="cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const otherId="dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const origin="https://synthetic.invalid";
const commentBase=`/v1/editorial/articles/${articleId}/comments`;
const operation="synthetic-comment-operation-1";
const stamp="2026-10-28T00:00:00.000Z";
const publicComment=()=>({id:commentId,version:1,body:"一条公开评论",status:"published",parentId:null,replyToId:null,
 replyRootId:commentId,createdAt:stamp,authorId,authorName:"公开昵称",replyToName:null,isMine:false,likeCount:0,liked:false});
const authors=()=>({[authorId]:{name:"公开昵称",avatar:"",avatarRevision:null}});
const commentsPage=()=>({comments:[publicComment()],authors:authors(),commentCount:1,commentsEnabled:true,commentsPolicyVersion:0,
 canModerate:false,loadedCount:1,hasMore:false,nextCursor:null,truncated:false,preview:false,asOf:stamp});
const reviewPage=()=>({items:[{id:commentId,version:1,body:"待审核内容",status:"pending",parentId:null,replyToId:null,
 replyRootId:commentId,createdAt:stamp,articleId,articleTitle:"精选标题",authorId,authorName:"公开昵称",safetyState:"safe",reportCount:0}],
 authors:authors(),loadedCount:1,hasMore:false,nextCursor:null});
type NativeRequest={url:string;method:string;data:unknown;header:Record<string,string>;success:(value:unknown)=>void;fail:(value:unknown)=>void;abort?:ReturnType<typeof vi.fn>};
let runtime:any,requests:NativeRequest[],storage:Map<string,unknown>,response:unknown,status:number,hold:boolean,networkFailure:unknown;
const pathOf=(request:NativeRequest)=>request.url.slice(origin.length);
function deliver(request:NativeRequest){if(networkFailure)request.fail(networkFailure);else request.success({statusCode:status,data:structuredClone(response)});}
async function client(){return import("../../apps/miniprogram/services/editorial-comments");}
beforeEach(()=>{
 vi.resetModules();vi.clearAllMocks();requests=[];storage=new Map();response=commentsPage();status=200;hold=false;networkFailure=null;
 runtime={globalData:{sessionToken:"synthetic-member-session",privacyRightsToken:"",apiBaseUrl:origin,sessionStorageKey:"synthetic.session"}};
 (globalThis as any).getApp=()=>runtime;
 (globalThis as any).getCurrentPages=()=>[{route:"pages/post/index",options:{id:articleId,source:"editorial"}}];
 (globalThis as any).wx={getStorageSync:(key:string)=>storage.get(key)||"",setStorageSync:vi.fn((key:string,value:unknown)=>storage.set(key,value)),
  removeStorageSync:vi.fn((key:string)=>storage.delete(key)),getStorageInfoSync:()=>({keys:[...storage.keys()]}),
  navigateTo:vi.fn(),reLaunch:vi.fn(),showToast:vi.fn(),request:vi.fn((options:NativeRequest)=>{
   requests.push(options);const abort=vi.fn(()=>options.fail({code:"REQUEST_ABORTED"}));options.abort=abort;
   if(!hold)queueMicrotask(()=>deliver(options));return {abort};
  })};
});

describe("editorial comment reads through the real native transport",()=>{
 it("reads as a guest, encodes an opaque cursor, and keeps published counts distinct from rows",async()=>{
  runtime.globalData.sessionToken="";response={...commentsPage(),commentCount:4,nextCursor:"next_cursor",hasMore:true,truncated:true};
  const result=await (await client()).readEditorialComments(articleId,undefined,"opaque+/= &中文");
  expect(pathOf(requests[0]!)).toBe(`${commentBase}?limit=30&cursor=opaque%2B%2F%3D%20%26%E4%B8%AD%E6%96%87`);
  expect(requests[0]).toMatchObject({method:"GET",header:{Authorization:"","Idempotency-Key":""}});
  expect(result).toMatchObject({commentCount:4,loadedCount:1,hasMore:true,preview:false,canModerate:false});
  expect((globalThis as any).wx.navigateTo).not.toHaveBeenCalled();
 });
 it("accepts an actor's private pending row without falsely counting it as published",async()=>{
  response={...commentsPage(),comments:[{...publicComment(),status:"pending",isMine:true}],commentCount:0};
  const result=await (await client()).readEditorialComments(articleId);
  expect(requests[0]!.header.Authorization).toBe("Bearer synthetic-member-session");
  expect(result.comments[0]).toMatchObject({status:"pending",isMine:true});expect(result.commentCount).toBe(0);
 });
 it("clears a captured expired token on actual optional HTTP401 and permits a fresh anonymous read without navigation",async()=>{
  status=401;response={code:"AUTH_EXPIRED"};const api=await client();
  await expect(api.readEditorialComments(articleId)).rejects.toMatchObject({status:401,code:"AUTH_EXPIRED"});
  expect(runtime.globalData.sessionToken).toBe("");expect(storage.get("synthetic.session")).toBe("");
  expect(requests).toHaveLength(1);expect((globalThis as any).wx.navigateTo).not.toHaveBeenCalled();
  status=200;response=commentsPage();await api.readEditorialComments(articleId);
  expect(requests).toHaveLength(2);expect(requests[1]!.header.Authorization).toBe("");
 });
 it("rejects an older read's HTTP401 without revoking a different current actor",async()=>{
  hold=true;const reading=(await client()).readEditorialComments(articleId);const rejected=expect(reading).rejects.toMatchObject({code:"REQUEST_SESSION_CHANGED"});
  expect(requests).toHaveLength(1);const api=await import("../../apps/miniprogram/services/api");api.setSessionToken("synthetic-other-session");
  status=401;response={code:"AUTH_EXPIRED"};deliver(requests[0]!);await rejected;
  expect(runtime.globalData.sessionToken).toBe("synthetic-other-session");expect((globalThis as any).wx.navigateTo).not.toHaveBeenCalled();
 });
 it("cancels only the page's read subscription and rejects its late response",async()=>{
  hold=true;const page={};const reading=(await client()).readEditorialComments(articleId,page);
  const rejected=expect(reading).rejects.toMatchObject({code:"REQUEST_ABORTED"});
  (await import("../../apps/miniprogram/services/page-requests")).cancelPageReads(page);await rejected;
  expect(requests[0]!.abort).toHaveBeenCalledOnce();deliver(requests[0]!);expect(runtime.globalData.sessionToken).toBe("synthetic-member-session");
 });
 it.each([
  ["deleted rows",(p:any)=>{p.comments[0].status="deleted";}],
  ["coerced array status",(p:any)=>{p.comments[0].status=["published"];}],
  ["zero row version",(p:any)=>{p.comments[0].version=0;}],
  ["fractional like count",(p:any)=>{p.comments[0].likeCount=0.5;}],
  ["invalid parent",(p:any)=>{p.comments[0].parentId="not-an-id";}],
  ["invalid author",(p:any)=>{p.comments[0].authorId="not-an-id";}],
  ["missing row count",(p:any)=>{delete p.loadedCount;}],
  ["invalid snapshot time",(p:any)=>{p.asOf="not-a-date";}],
  ["invalid truncation flag",(p:any)=>{p.truncated="false";}],
  ["invalid author projection",(p:any)=>{p.authors[authorId].name=123;}],
  ["another actor's private pending row",(p:any)=>{p.comments[0].status="pending";p.comments[0].isMine=false;}],
  ["preview data",(p:any)=>{p.preview=true;}],
  ["nonboolean policy",(p:any)=>{p.commentsEnabled="true";}],
 ] as const)("fails closed for %s",async(_label,mutate)=>{
  const page=commentsPage();mutate(page);response=page;
  await expect((await client()).readEditorialComments(articleId)).rejects.toThrow("EDITORIAL_COMMENTS_RESPONSE_INVALID");
 });
});

describe("editorial comment command transport and receipts",()=>{
 it("sends an explicit reply and the caller's stable operation key without rewriting the draft",async()=>{
  response={id:commentId,status:"pending",version:1,replayed:false};const input={body:"保留这段原始正文",replyToId:otherId};
  const result=await (await client()).createEditorialComment(articleId,input,operation);
  expect(requests[0]).toMatchObject({url:origin+commentBase,method:"POST",data:input,header:{Authorization:"Bearer synthetic-member-session","Idempotency-Key":operation}});
  expect(result).toEqual(response);expect(input).toEqual({body:"保留这段原始正文",replyToId:otherId});
 });
 it("keeps the same key for an explicit replay and accepts an already deleted result only as a replay",async()=>{
  const api=await client();response={id:commentId,status:"pending",version:1,replayed:false};await api.createEditorialComment(articleId,{body:"待确认评论"},operation);
  response={id:commentId,status:"deleted",version:2,replayed:true};expect(await api.createEditorialComment(articleId,{body:"待确认评论"},operation)).toEqual(response);
  expect(requests.map(item=>item.header["Idempotency-Key"])).toEqual([operation,operation]);
 });
 it.each(["short","contains spaces","a".repeat(201)])("rejects invalid operation %s before transport",async(key)=>{
  await expect((await client()).createEditorialComment(articleId,{body:"明确提交"},key)).rejects.toThrow("EDITORIAL_COMMENT_OPERATION_INVALID");expect(requests).toEqual([]);
 });
 it.each([
  {id:commentId,status:"deleted",version:1,replayed:false},
  {id:commentId,status:["pending"],version:1,replayed:false},
  {id:commentId,status:"published",version:0,replayed:true},
  {id:"bad",status:"pending",version:1,replayed:false},
 ])("rejects malformed create receipt %#",async(receipt)=>{
  response=receipt;await expect((await client()).createEditorialComment(articleId,{body:"明确提交"},operation)).rejects.toThrow("EDITORIAL_COMMENT_RESPONSE_INVALID");
 });
 it("does not replay an unknown network outcome or replace the operation key",async()=>{
  networkFailure={errMsg:"request:fail timeout"};await expect((await client()).createEditorialComment(articleId,{body:"待确认评论"},operation)).rejects.toMatchObject({code:"NETWORK_TIMEOUT"});
  expect(requests).toHaveLength(1);expect(requests[0]!.header["Idempotency-Key"]).toBe(operation);
 });
 it("passes current-legal rejection to the page without accepting terms or reissuing the mutation",async()=>{
  status=409;response={code:"CURRENT_LEGAL_CONSENT_REQUIRED"};await expect((await client()).createEditorialComment(articleId,{body:"明确提交"},operation)).rejects.toMatchObject({code:"CURRENT_LEGAL_CONSENT_REQUIRED"});
  expect(requests).toHaveLength(1);expect(runtime.globalData.sessionToken).toBe("synthetic-member-session");expect((globalThis as any).wx.navigateTo).not.toHaveBeenCalled();
 });
 it("requires authentication for participation without sending a guest write",async()=>{
  runtime.globalData.sessionToken="";await expect((await client()).createEditorialComment(articleId,{body:"明确提交"},operation)).rejects.toMatchObject({code:"AUTHENTICATION_REQUIRED"});
  expect(requests).toEqual([]);expect((globalThis as any).wx.navigateTo).toHaveBeenCalledOnce();
  expect((globalThis as any).wx.navigateTo.mock.calls[0][0].url).toMatch(/^\/pages\/account\/index\?intent=login&authFlow=/);
 });
 it("sets like state with PUT, deletes only the addressed comment, and reports through the independent editorial route",async()=>{
  const api=await client();response={id:commentId,liked:true,likeCount:1};expect(await api.setEditorialCommentLike(articleId,commentId,true)).toEqual(response);
  response={id:commentId,status:"deleted"};await api.deleteEditorialComment(articleId,commentId);
  response={id:otherId,status:"open"};await api.reportEditorialComment(articleId,commentId,{category:"privacy",description:"具体举报说明"});
  expect(requests.map(r=>[pathOf(r),r.method,r.data])).toEqual([
   [`${commentBase}/${commentId}/like`,"PUT",{active:true}],
   [`${commentBase}/${commentId}`,"DELETE",{}],
   [`${commentBase}/${commentId}/report`,"POST",{category:"privacy",description:"具体举报说明"}],
  ]);
 });
 it("uses the author UUID only in the independent block route and returns the actual block state",async()=>{
  response={authorId,blocked:true};expect(await (await client()).setEditorialBlock(authorId,true)).toEqual(response);
  expect(requests[0]).toMatchObject({url:`${origin}/v1/editorial/blocks/${authorId}`,method:"PUT",data:{active:true}});
 });
 it("reads persistent own blocks with the real paged projection rather than a transient last-action list",async()=>{
  response={items:[{authorId,name:"公开昵称",avatar:"",avatarRevision:null}],loadedCount:1,hasMore:false,nextCursor:null};
  expect(await (await client()).readEditorialBlocks({},"encoded_cursor")).toEqual(response);
  expect(requests[0]).toMatchObject({url:`${origin}/v1/editorial/blocks?limit=30&cursor=encoded_cursor`,method:"GET",header:{Authorization:"Bearer synthetic-member-session"}});
 });
 it("requires a session for the persistent block list and does not mistake it for public profile data",async()=>{
  runtime.globalData.sessionToken="";await expect((await client()).readEditorialBlocks()).rejects.toMatchObject({code:"AUTHENTICATION_REQUIRED"});expect(requests).toEqual([]);
 });
 it.each([{items:[{authorId:"bad",name:"公开昵称",avatar:"",avatarRevision:null}],loadedCount:1,hasMore:false,nextCursor:null},
  {items:[],loadedCount:1,hasMore:false,nextCursor:null}])("rejects malformed persistent block page %#",async(receipt)=>{
  response=receipt;await expect((await client()).readEditorialBlocks()).rejects.toThrow("EDITORIAL_BLOCKS_RESPONSE_INVALID");
 });
 it.each([{id:"invalid-report",status:"open"},{id:otherId,status:"pending"}])("rejects a malformed report receipt %#",async(receipt)=>{
  response=receipt;await expect((await client()).reportEditorialComment(articleId,commentId,{category:"other"})).rejects.toThrow("EDITORIAL_COMMENT_REPORT_RESPONSE_INVALID");
 });
 it.each([{authorId:otherId,blocked:true},{authorId,blocked:false}])("rejects a block receipt for the wrong target or unconfirmed state %#",async(receipt)=>{
  response=receipt;await expect((await client()).setEditorialBlock(authorId,true)).rejects.toThrow("EDITORIAL_BLOCK_RESPONSE_INVALID");
 });
 it.each(["like","delete"] as const)("rejects a %s receipt for a different comment",async(kind)=>{
  const api=await client();response=kind==="like"?{id:otherId,liked:true,likeCount:1}:{id:otherId,status:"deleted"};
  await expect(kind==="like"?api.setEditorialCommentLike(articleId,commentId,true):api.deleteEditorialComment(articleId,commentId)).rejects.toThrow(kind==="like"?"EDITORIAL_COMMENT_LIKE_RESPONSE_INVALID":"EDITORIAL_COMMENT_DELETE_RESPONSE_INVALID");
 });
 it.each(["read","create","like","delete","report","block","review","policy"] as const)("rejects a foreign path identifier for %s before transport",async(kind)=>{
  const api=await client();const bad="../other?inject=true";
  await expect((async()=>{
   if(kind==="read")return api.readEditorialComments(bad);
   if(kind==="create")return api.createEditorialComment(bad,{body:"明确提交"},operation);
   if(kind==="like")return api.setEditorialCommentLike(articleId,bad,true);
   if(kind==="delete")return api.deleteEditorialComment(articleId,bad);
   if(kind==="report")return api.reportEditorialComment(articleId,bad,{category:"other"});
   if(kind==="block")return api.setEditorialBlock(bad,true);
   if(kind==="review")return api.reviewEditorialComment(bad,{decision:"approve",reason:"核对内容",expectedVersion:1});
   return api.setEditorialCommentsPolicy(bad,{enabled:true,expectedVersion:0});
  })()).rejects.toThrow("EDITORIAL_ID_INVALID");expect(requests).toEqual([]);
 });
});

describe("editorial moderation uses its own DTO and authority-bearing requests",()=>{
 it("requires a member session before requesting a governance queue",async()=>{
  runtime.globalData.sessionToken="";await expect((await client()).editorialCommentReviewQueue()).rejects.toMatchObject({code:"AUTHENTICATION_REQUIRED"});
  expect(requests).toEqual([]);expect((globalThis as any).wx.navigateTo).toHaveBeenCalledOnce();
 });
 it("reads the actual review DTO without inventing public-reader fields",async()=>{
  response=reviewPage();const result=await (await client()).editorialCommentReviewQueue({}, {state:"reported",articleId,cursor:"review+/="});
  expect(pathOf(requests[0]!)).toBe(`/v1/management/editorial/comments?state=reported&limit=30&cursor=review%2B%2F%3D&articleId=${articleId}`);
  expect(result.items[0]).toMatchObject({articleId,articleTitle:"精选标题",safetyState:"safe",reportCount:0});
  expect(result.items[0]).not.toHaveProperty("isMine");expect(result.items[0]).not.toHaveProperty("likeCount");expect(result.items[0]).not.toHaveProperty("liked");
 });
 it("keeps the review CAS version and reason without inventing another reviewer credential",async()=>{
  response={id:commentId,status:"published",version:3};const input={decision:"approve" as const,reason:"核对公开内容和安全检查结果",expectedVersion:2};
  expect(await (await client()).reviewEditorialComment(commentId,input)).toEqual(response);
  expect(requests[0]).toMatchObject({url:`${origin}/v1/management/editorial/comments/${commentId}/review`,method:"POST",data:input});
 });
 it("changes only the addressed article policy with its separate expected version",async()=>{
  response={commentsEnabled:false,commentsPolicyVersion:2};await (await client()).setEditorialCommentsPolicy(articleId,{enabled:false,expectedVersion:1});
  expect(requests[0]).toMatchObject({url:`${origin}/v1/management/editorial/articles/${articleId}/comments-policy`,method:"PUT",data:{enabled:false,expectedVersion:1}});
 });
 it("surfaces authority denial without fabricating an empty successful queue or changing the session",async()=>{
  status=403;response={code:"CAPABILITY_REQUIRED"};await expect((await client()).editorialCommentReviewQueue()).rejects.toMatchObject({status:403,code:"CAPABILITY_REQUIRED"});
  expect(requests).toHaveLength(1);expect(runtime.globalData.sessionToken).toBe("synthetic-member-session");
 });
 it.each([
  ["deleted queue row",(p:any)=>{p.items[0].status="deleted";}],
  ["invalid article",(p:any)=>{p.items[0].articleId="bad";}],
  ["coerced queue status",(p:any)=>{p.items[0].status=["pending"];}],
  ["missing review body",(p:any)=>{delete p.items[0].body;}],
  ["missing article title",(p:any)=>{delete p.items[0].articleTitle;}],
  ["invalid safety state",(p:any)=>{p.items[0].safetyState="approved";}],
  ["negative report count",(p:any)=>{p.items[0].reportCount=-1;}],
 ])("rejects %s in the governance projection",async(_label,mutate)=>{
  const queue=reviewPage();mutate(queue);response=queue;
  await expect((await client()).editorialCommentReviewQueue()).rejects.toThrow("EDITORIAL_COMMENT_REVIEW_RESPONSE_INVALID");
 });
});
