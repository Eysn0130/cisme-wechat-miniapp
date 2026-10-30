import { request } from "./api";
import { pageRead } from "./page-requests";
import { editorialIdentifier } from "./editorial";
import type { CommunityComment } from "./community";

export type EditorialCommentStatus="pending"|"published"|"rejected"|"hidden";
export type EditorialComment=Omit<CommunityComment,"status">&{status:EditorialCommentStatus;version:number;replyRootId:string};
export type EditorialCommentAuthors=Record<string,{name:string;avatar:string;avatarRevision:string|null}>;
export interface EditorialCommentsPage {
  comments:EditorialComment[];authors:EditorialCommentAuthors;commentCount:number;
  commentsEnabled:boolean;commentsPolicyVersion:number;canModerate:boolean;
  loadedCount:number;hasMore:boolean;nextCursor:string|null;truncated:boolean;preview:false;asOf:string;
}
export type EditorialCommentReviewState="pending"|"published"|"rejected"|"hidden"|"reported";
export interface EditorialReviewComment {
  id:string;version:number;body:string;status:EditorialCommentStatus;parentId:string|null;replyToId:string|null;replyRootId:string;createdAt:string;
  articleId:string;articleTitle:string;authorId:string;authorName:string;safetyState:"pending"|"safe"|"review"|"risky"|"error";reportCount:number;
}
export interface EditorialCommentReviewPage {
  items:EditorialReviewComment[];authors:EditorialCommentAuthors;loadedCount:number;hasMore:boolean;nextCursor:string|null;
}
export interface EditorialBlocksPage {
  items:Array<{authorId:string;name:string;avatar:string;avatarRevision:string|null}>;
  loadedCount:number;hasMore:boolean;nextCursor:string|null;
}
export type EditorialReportCategory="spam"|"abuse"|"privacy"|"misinformation"|"rights"|"other";

const pathId=(id:string)=>{if(!editorialIdentifier(id))throw new Error("EDITORIAL_ID_INVALID");return encodeURIComponent(id);};
const commentPath=(articleId:string,commentId?:string)=>`/v1/editorial/articles/${pathId(articleId)}/comments${commentId?`/${pathId(commentId)}`:""}`;
const nonnegative=(value:unknown):value is number=>Number.isSafeInteger(value)&&Number(value)>=0;
const validStatus=(value:unknown):value is EditorialCommentStatus=>typeof value==="string"&&["pending","published","rejected","hidden"].includes(value);
const record=(value:unknown):value is Record<string,unknown>=>Boolean(value)&&typeof value==="object"&&!Array.isArray(value);
function validAuthors(value:unknown):boolean {
  return record(value)&&Object.entries(value).every(([id,author])=>editorialIdentifier(id)&&record(author)
    &&typeof author.name==="string"&&typeof author.avatar==="string"&&(author.avatarRevision===null||typeof author.avatarRevision==="string"));
}
function validPage(value:{loadedCount:number;hasMore:boolean;nextCursor:string|null},count:number):boolean {
  return nonnegative(value.loadedCount)&&value.loadedCount===count&&typeof value.hasMore==="boolean"
    &&(value.nextCursor===null||typeof value.nextCursor==="string"&&/^[A-Za-z0-9_-]{1,600}$/.test(value.nextCursor))
    &&value.hasMore===(value.nextCursor!==null);
}
function validateComment(value:EditorialComment):boolean {
  return Boolean(value)&&editorialIdentifier(value.id)&&nonnegative(value.version)&&value.version>0&&validStatus(value.status)
    &&typeof value.body==="string"&&typeof value.authorName==="string"&&editorialIdentifier(value.authorId??"")&&typeof value.isMine==="boolean"
    &&(value.status==="published"||value.isMine)&& (value.replyToName===null||typeof value.replyToName==="string")
    &&nonnegative(value.likeCount)&&typeof value.liked==="boolean"&&typeof value.createdAt==="string"&&Number.isFinite(Date.parse(value.createdAt))
    &&editorialIdentifier(value.replyRootId)&&(value.parentId===null||editorialIdentifier(value.parentId))
    &&(value.replyToId===null||editorialIdentifier(value.replyToId));
}
function query(input:Record<string,string|undefined>):string {
  const values=Object.entries(input).filter((entry):entry is [string,string]=>entry[1]!==undefined);
  return values.length?`?${values.map(([key,value])=>`${key}=${encodeURIComponent(value)}`).join("&")}`:"";
}
function read<T>(page:object|undefined,path:string,authMode:"optional"|"required"):Promise<T> {
  const options={path,authMode};return page?pageRead<T>(page,options):request<T>(options);
}
export async function readEditorialComments(articleId:string,page?:object,cursor?:string|null):Promise<EditorialCommentsPage> {
  const result=await read<EditorialCommentsPage>(page,commentPath(articleId)+query({limit:"30",cursor:cursor??undefined}),"optional");
  if(!result||!Array.isArray(result.comments)||!result.comments.every(validateComment)||!nonnegative(result.commentCount)
    ||typeof result.commentsEnabled!=="boolean"||typeof result.canModerate!=="boolean"||!nonnegative(result.commentsPolicyVersion)
    ||result.preview!==false||!validPage(result,result.comments.length)||result.truncated!==result.hasMore
    ||typeof result.asOf!=="string"||!Number.isFinite(Date.parse(result.asOf))||!validAuthors(result.authors))throw new Error("EDITORIAL_COMMENTS_RESPONSE_INVALID");
  return result;
}
export async function createEditorialComment(articleId:string,input:{body:string;replyToId?:string},operationId:string):Promise<{id:string;status:EditorialCommentStatus|"deleted";version:number;replayed:boolean}> {
  if(!/^[A-Za-z0-9._:-]{8,200}$/.test(operationId))throw new Error("EDITORIAL_COMMENT_OPERATION_INVALID");
  const result=await request<{id:string;status:EditorialCommentStatus|"deleted";version:number;replayed:boolean}>({path:commentPath(articleId),method:"POST",data:input,idempotencyKey:operationId});
  if(!result||!editorialIdentifier(result.id)||!(validStatus(result.status)||result.status==="deleted"&&result.replayed===true)||!nonnegative(result.version)||result.version<1||typeof result.replayed!=="boolean")
    throw new Error("EDITORIAL_COMMENT_RESPONSE_INVALID");
  return result;
}
export async function setEditorialCommentLike(articleId:string,commentId:string,active:boolean):Promise<{id:string;liked:boolean;likeCount:number}> {
  const result=await request<{id:string;liked:boolean;likeCount:number}>({path:commentPath(articleId,commentId)+"/like",method:"PUT",data:{active}});
  if(!result||result.id!==commentId||typeof result.liked!=="boolean"||!nonnegative(result.likeCount))throw new Error("EDITORIAL_COMMENT_LIKE_RESPONSE_INVALID");
  return result;
}
export async function deleteEditorialComment(articleId:string,commentId:string):Promise<{id:string;status:"deleted"}> {
  const result=await request<{id:string;status:"deleted"}>({path:commentPath(articleId,commentId),method:"DELETE"});
  if(!result||result.id!==commentId||result.status!=="deleted")throw new Error("EDITORIAL_COMMENT_DELETE_RESPONSE_INVALID");return result;
}
export async function reportEditorialComment(articleId:string,commentId:string,input:{category:EditorialReportCategory;description?:string}):Promise<{id:string;status:"open"|"resolved"}> {
  const result=await request<{id:string;status:"open"|"resolved"}>({path:commentPath(articleId,commentId)+"/report",method:"POST",data:input});
  if(!result||!editorialIdentifier(result.id)||!["open","resolved"].includes(result.status))throw new Error("EDITORIAL_COMMENT_REPORT_RESPONSE_INVALID");return result;
}
export async function setEditorialBlock(authorId:string,active:boolean):Promise<{authorId:string;blocked:boolean}> {
  const result=await request<{authorId:string;blocked:boolean}>({path:`/v1/editorial/blocks/${pathId(authorId)}`,method:"PUT",data:{active}});
  if(!result||result.authorId!==authorId||typeof result.blocked!=="boolean"||result.blocked!==active)throw new Error("EDITORIAL_BLOCK_RESPONSE_INVALID");return result;
}
export async function readEditorialBlocks(page?:object,cursor?:string|null):Promise<EditorialBlocksPage> {
  const result=await read<EditorialBlocksPage>(page,"/v1/editorial/blocks"+query({limit:"30",cursor:cursor??undefined}),"required");
  if(!result||!Array.isArray(result.items)||!result.items.every(item=>editorialIdentifier(item.authorId)&&typeof item.name==="string"
    &&typeof item.avatar==="string"&&(item.avatarRevision===null||typeof item.avatarRevision==="string"))
    ||!validPage(result,result.items.length))throw new Error("EDITORIAL_BLOCKS_RESPONSE_INVALID");return result;
}
export async function editorialCommentReviewQueue(page?:object,input:{state?:EditorialCommentReviewState;cursor?:string|null;articleId?:string}={}):Promise<EditorialCommentReviewPage> {
  const result=await read<EditorialCommentReviewPage>(page,"/v1/management/editorial/comments"+query({state:input.state??"published",limit:"30",cursor:input.cursor??undefined,articleId:input.articleId}),"required");
  if(!result||!Array.isArray(result.items)||!result.items.every(item=>editorialIdentifier(item.id)&&editorialIdentifier(item.articleId)&&nonnegative(item.version)&&item.version>0&&validStatus(item.status)
    &&typeof item.body==="string"&&typeof item.articleTitle==="string"&&editorialIdentifier(item.authorId)&&typeof item.authorName==="string"
    &&(item.parentId===null||editorialIdentifier(item.parentId))&&(item.replyToId===null||editorialIdentifier(item.replyToId))&&editorialIdentifier(item.replyRootId)
    &&typeof item.createdAt==="string"&&Number.isFinite(Date.parse(item.createdAt))&&["pending","safe","review","risky","error"].includes(item.safetyState)&&nonnegative(item.reportCount))
    ||!validPage(result,result.items.length)||!validAuthors(result.authors))throw new Error("EDITORIAL_COMMENT_REVIEW_RESPONSE_INVALID");return result;
}
export async function reviewEditorialComment(commentId:string,input:{decision:"approve"|"reject"|"hide";reason:string;expectedVersion:number}):Promise<{id:string;status:EditorialCommentStatus;version:number}> {
  const result=await request<{id:string;status:EditorialCommentStatus;version:number}>({path:`/v1/management/editorial/comments/${pathId(commentId)}/review`,method:"POST",data:input});
  if(!result||result.id!==commentId||!validStatus(result.status)||!nonnegative(result.version)||result.version<1)throw new Error("EDITORIAL_COMMENT_REVIEW_RESPONSE_INVALID");return result;
}
export async function setEditorialCommentsPolicy(articleId:string,input:{enabled:boolean;expectedVersion:number}):Promise<{commentsEnabled:boolean;commentsPolicyVersion:number}> {
  const result=await request<{commentsEnabled:boolean;commentsPolicyVersion:number}>({path:`/v1/management/editorial/articles/${pathId(articleId)}/comments-policy`,method:"PUT",data:input});
  if(!result||typeof result.commentsEnabled!=="boolean"||!nonnegative(result.commentsPolicyVersion))throw new Error("EDITORIAL_COMMENT_POLICY_RESPONSE_INVALID");return result;
}
