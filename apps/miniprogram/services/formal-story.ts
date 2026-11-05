import {request} from './api';
import {pageRead} from './page-requests';
import {editorialIdentifier,type PublishedEditorialArticle,type PublishedEditorialMedia,type EditorialReaction} from './editorial';
import type {EditorialCommentsPage,EditorialCommentStatus} from './editorial-comments';

const id=(value:string)=>{if(!editorialIdentifier(value))throw new Error('FORMAL_POST_ID_INVALID');return encodeURIComponent(value);};
function read<T>(page:object|undefined,path:string):Promise<T>{return page?pageRead<T>(page,{path,authMode:'optional'}):request<T>({path,authMode:'optional'});}
type FormalPost={id:string;version:number;authorId:string;author:string;avatar:string;avatarRevision?:string|null;title:string;body:string;
 publishedAt:string;isMine:boolean;following:boolean;liked:boolean;saved:boolean;likeCount:number;saveCount:number;aiUsage:string;
 media:Array<{id:string;position:number}>;commentsTotal:number};
export async function publishedFormalStory(postId:string,page?:object):Promise<PublishedEditorialArticle&{avatarRevision:string|null}>{
 const post=await read<FormalPost>(page,`/v1/ugc/posts/${id(postId)}`);
 if(!post||post.id!==postId||!editorialIdentifier(post.authorId)||!Number.isSafeInteger(post.version)||post.version<1||
  typeof post.author!=='string'||typeof post.title!=='string'||typeof post.body!=='string'||typeof post.isMine!=='boolean'||
  !Array.isArray(post.media)||!post.media.every(x=>editorialIdentifier(x.id))||!Number.isFinite(Date.parse(post.publishedAt)))throw new Error('FORMAL_POST_RESPONSE_INVALID');
 return {...post,avatar:post.avatar||'',avatarRevision:post.avatarRevision??null,excerpt:post.body.slice(0,100),coverUrl:null,
  media:post.media.map(x=>({id:x.id,url:`/v1/ugc/media/${x.id}`,type:'image',aiUsage:post.aiUsage==='generated'?'generated':'not_declared'})),
  sourceUrl:null,provenanceLabel:'',interactionsEnabled:true,commentsEnabled:true,commentCount:post.commentsTotal,
  canManage:false,canModerate:false,commentsPolicyVersion:0};
}
export function formalStoryMedia(media:PublishedEditorialMedia[]):{images:string[];video:null}{
 const origin=getApp<IAppOption>().globalData.apiBaseUrl.replace(/\/$/,'');
 if(!/^https:\/\/[^/?#]+$/.test(origin))throw new Error('FORMAL_MEDIA_ORIGIN_INVALID');
 return {images:media.map(item=>{if(!/^\/v1\/ugc\/media\/[0-9a-f-]{36}$/i.test(item.url)||item.type==='video')throw new Error('FORMAL_MEDIA_INVALID');return origin+item.url;}),video:null};
}
type FormalComment={id:string;version:number;state:string;body:string;createdAt:string;authorId:string;author:string;avatar:string;avatarRevision:string|null;
 isMine:boolean;parentId:string|null;replyToId:string|null;likeCount:number;liked:boolean};
const status=(state:string):EditorialCommentStatus=>state==='pending_review'?'pending':state==='published'?'published':state==='rejected'?'rejected':'hidden';
export async function readFormalComments(postId:string,page?:object,cursor?:string|null):Promise<EditorialCommentsPage>{
 const result=await read<{items:FormalComment[];nextCursor:string|null;matchingTotal:number}>(page,`/v1/ugc/posts/${id(postId)}/comments?reader=1&limit=30${cursor?`&cursor=${encodeURIComponent(cursor)}`:''}`);
 if(!Array.isArray(result?.items)||!result.items.every(c=>editorialIdentifier(c.id)&&editorialIdentifier(c.authorId)&&typeof c.body==='string'&&typeof c.isMine==='boolean'&&Number.isSafeInteger(c.likeCount)&&c.likeCount>=0))throw new Error('FORMAL_COMMENTS_RESPONSE_INVALID');
 const authors=Object.fromEntries(result.items.map(c=>[c.authorId,{name:c.author,avatar:c.avatar||'',avatarRevision:c.avatarRevision??null}]));
 const comments=result.items.map(c=>({id:c.id,version:c.version,body:c.body,status:status(c.state),authorId:c.authorId,authorName:c.author,isMine:c.isMine,
  parentId:c.parentId,replyToId:c.replyToId,replyRootId:c.parentId||c.id,replyToName:result.items.find(other=>other.id===c.replyToId)?.author??null,
  createdAt:c.createdAt,likeCount:c.likeCount,liked:c.liked}));
 return {comments,authors,commentCount:result.matchingTotal,commentsEnabled:true,commentsPolicyVersion:0,canModerate:false,
  loadedCount:comments.length,hasMore:result.nextCursor!==null,nextCursor:result.nextCursor,truncated:result.nextCursor!==null,preview:false,asOf:new Date().toISOString()};
}
export async function createFormalComment(postId:string,input:{body:string;replyToId?:string;parentId?:string},operationId:string){
 const answer=await request<{id:string;state:string;version:number;replayed:boolean}>({path:`/v1/ugc/posts/${id(postId)}/comments`,method:'POST',data:input,idempotencyKey:operationId});
 if(!editorialIdentifier(answer?.id)||!Number.isSafeInteger(answer.version)||typeof answer.replayed!=='boolean')throw new Error('FORMAL_COMMENT_RESPONSE_INVALID');
 return {id:answer.id,status:answer.state==='deleted'?'deleted' as const:status(answer.state),version:answer.version,replayed:answer.replayed};
}
export async function likeFormalComment(postId:string,commentId:string,active:boolean){
 const answer=await request<{id:string;liked:boolean;likeCount:number}>({path:`/v1/ugc/posts/${id(postId)}/comments/${id(commentId)}/like`,method:'PUT',data:{active}});
 if(answer?.id!==commentId||answer.liked!==active||!Number.isSafeInteger(answer.likeCount)||answer.likeCount<0)throw new Error('FORMAL_COMMENT_LIKE_INVALID');return answer;
}
export async function deleteFormalComment(postId:string,commentId:string){
 const answer=await request<{id:string;state:string}>({path:`/v1/ugc/posts/${id(postId)}/comments/${id(commentId)}`,method:'DELETE'});
 if(answer?.id!==commentId||answer.state!=='deleted')throw new Error('FORMAL_COMMENT_DELETE_INVALID');return {id:answer.id,status:'deleted' as const};
}
export async function reactToFormalStory(postId:string,kind:'like'|'save',active:boolean):Promise<EditorialReaction>{
 const answer=await request<{kind:string;active:boolean;count:number}>({path:`/v1/ugc/posts/${id(postId)}/reaction`,method:'PUT',data:{kind,active}});
 if(answer?.kind!==kind||answer.active!==active||!Number.isSafeInteger(answer.count))throw new Error('FORMAL_REACTION_INVALID');
 const post=await publishedFormalStory(postId);
 return {kind,active:kind==='like'?post.liked:post.saved,count:kind==='like'?post.likeCount:post.saveCount,liked:post.liked,saved:post.saved,likeCount:post.likeCount,saveCount:post.saveCount};
}
export async function followFormalAuthor(authorId:string,active:boolean){
 const answer=await request<{authorId:string;following:boolean}>({path:`/v1/me/ugc/follows/${id(authorId)}`,method:'PUT',data:{active}});
 if(answer?.authorId!==authorId||answer.following!==active)throw new Error('FORMAL_FOLLOW_INVALID');return answer;
}
