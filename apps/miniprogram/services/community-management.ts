import {request} from './api';
import {pageRead} from './page-requests';

export type PostPlacement='recommend'|'featured'|'hidden';
export type ManagedCommunityPost={id:string;version:number;revision:number;title:string;body:string;authorId:string;author:string;
  avatar:string;avatarRevision:string|null;coverId:string|null;publishedAt:string;state:'published'|'hidden';placement:PostPlacement;likeCount:number;commentCount:number};
export type ManagedCommunityPage={items:ManagedCommunityPost[];matchingTotal:number;nextCursor:string|null};
export const communityPostId=(value:unknown):value is string=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
export async function managedCommunityPosts(owner:object,state:PostPlacement,q:string,cursor?:string|null):Promise<ManagedCommunityPage>{
  const result=await pageRead<ManagedCommunityPage>(owner,{path:`/v1/management/ugc/posts?state=${state}&limit=20${q?`&q=${encodeURIComponent(q)}`:''}${cursor?`&cursor=${encodeURIComponent(cursor)}`:''}`});
  if(!result||!Array.isArray(result.items)||!Number.isSafeInteger(result.matchingTotal)||result.matchingTotal<0||
    result.nextCursor!==null&&typeof result.nextCursor!=='string'||result.items.some(r=>!communityPostId(r.id)||!Number.isSafeInteger(r.version)||r.version<1||
      typeof r.title!=='string'||typeof r.body!=='string'||typeof r.author!=='string'||!['published','hidden'].includes(r.state)||!['recommend','featured','hidden'].includes(r.placement)))
    throw {title:'帖子列表暂时无法读取，请重试'};
  return result;
}
export async function changeCommunityPost(row:Pick<ManagedCommunityPost,'id'|'version'>,action:'featured'|'recommend'|'hide'|'delete'){
  if(!communityPostId(row.id)||!Number.isSafeInteger(row.version)||row.version<1)throw {title:'请刷新帖子后重试'};
  const base=`/v1/management/ugc/posts/${row.id}`,data={expectedVersion:row.version};
  if(action==='delete')return request({path:base,method:'DELETE',data});
  if(action==='hide')return request({path:base+'/hide',method:'POST',data:{...data,reason:'管理员下架公开帖子'}});
  return request({path:base+'/placement',method:'PUT',data:{...data,placement:action}});
}
