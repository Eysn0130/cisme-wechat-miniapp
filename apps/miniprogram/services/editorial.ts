export interface EditorialStory {
  id: string;
  kind: "brand";
  title: string;
  excerpt: string;
  image: string;
  media?: string[];
  avatar: string;
  author: string;
  publishedLabel: string;
  engagementLabel: string;
  provenanceLabel: string;
}

// Preview stories and portraits have no confirmed publication rights. Retain
// only their IDs so old shared links fail closed before a feed request.
const retiredEditorialIds = new Set([
  "brand-scalp-ritual",
  "brand-night-routine",
  "brand-care-journal",
  "brand-roots-check",
  "brand-product-ritual"
]);

export const editorialStories: EditorialStory[] = [];
export function editorialPreviewAllowed(): boolean { return false; }
export function editorialStoriesForRuntime(): EditorialStory[] { return []; }
export function isBundledEditorialId(id: string): boolean { return retiredEditorialIds.has(id); }
export function editorialStory(_id: string): EditorialStory | null { return null; }
import { request } from "./api";
import { pageRead } from "./page-requests";


export interface PublishedEditorialCard {
  id:string; title:string; excerpt:string; authorId:string; author:string; avatar:string;
  coverUrl:string|null; publishedAt:string; likeCount:number; saveCount:number;
}
export interface PublishedEditorialArticle extends PublishedEditorialCard {
  version:number; body:string; media:PublishedEditorialMedia[]; liked:boolean; saved:boolean;
  following:boolean; isMine:boolean; interactionsEnabled:boolean; sourceUrl:string|null; provenanceLabel:string;
}
export type PublishedEditorialMedia = {id:string;url:string;type?:"image"} | {
  id:string;url:string;type:"video";mimeType:"video/mp4";width:number;height:number;durationMs:number;posterUrl:string;
};
export interface EditorialVideo { src:string;poster:string;height:number;durationSeconds:number }
/** Images and videos share the publication-controlled media route. A video
 * must have its own authorized poster and cannot enter the image gallery. */
export function editorialDisplayMedia(media:PublishedEditorialMedia[]):{images:string[];video:EditorialVideo|null} {
  const videos=media.filter(item=>item.type==="video");
  if(!videos.length)return {images:media.map(item=>editorialMediaSrc(item.url)).filter(Boolean),video:null};
  const video=videos[0];
  if(media.length!==1||video?.type!=="video"||video.mimeType!=="video/mp4"||
    ![video.width,video.height,video.durationMs].every(value=>Number.isSafeInteger(value)&&value>0))throw new Error("EDITORIAL_VIDEO_INVALID");
  const src=editorialMediaSrc(video.url),poster=editorialMediaSrc(video.posterUrl);
  if(!src||!poster)throw new Error("EDITORIAL_VIDEO_INVALID");
  return {images:[],video:{src,poster,height:Math.max(420,Math.min(1000,Math.round(750*video.height/video.width))),durationSeconds:video.durationMs/1000}};
}
export interface PublishedEditorialPage { items:PublishedEditorialCard[]; nextCursor:string|null }
export interface EditorialAuthor { id:string; name:string; avatar:string; postCount:number; following:boolean; isMine:boolean }
export interface EditorialAuthorPage extends PublishedEditorialPage { author:EditorialAuthor }
export interface EditorialReaction { kind:"like"|"save"; active:boolean; count:number; liked:boolean; saved:boolean; likeCount:number; saveCount:number }
/** A current read may recover to a guest retry only after its own expired
 * session was cleared. A different signed-in actor is never that transition. */
export function expiredEditorialRead(error:unknown,token:string):boolean {
  const problem=error as {status?:number;code?:string}|null;
  return Boolean(token)&&getApp<IAppOption>().globalData.sessionToken===""&&
    (problem?.status===401||problem?.code==="REQUEST_SESSION_CHANGED");
}
export const editorialIdentifier = (id:string):boolean => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id);
function identifier(id:string):string { if(!editorialIdentifier(id))throw new Error("EDITORIAL_ID_INVALID");return encodeURIComponent(id); }
/** Only the licensed public-media route may become a media URL. Object keys
 * and external URLs are never treated as an authorized publication. */
export function editorialMediaSrc(path:string|null|undefined):string {
  if(!path||!/^\/v1\/editorial\/media\/[0-9a-f-]{36}\/[0-9a-f]{64}$/.test(path))return "";
  const origin=getApp<IAppOption>().globalData.apiBaseUrl.replace(/\/$/,"");
  return /^https:\/\/[^/?#]+$/.test(origin)?origin+path:"";
}
function read<T>(page:object|undefined,path:string):Promise<T> {
  const options={path,authMode:"optional" as const};return page?pageRead<T>(page,options):request<T>(options);
}
export function publishedEditorialArticles(page?:object,cursor?:string|null):Promise<PublishedEditorialPage> {
  return read(page,`/v1/editorial/articles?limit=20${cursor?`&cursor=${encodeURIComponent(cursor)}`:""}`);
}
export function publishedEditorialArticle(id:string,page?:object):Promise<PublishedEditorialArticle> {
  return read(page,`/v1/editorial/articles/${identifier(id)}`);
}
export function publishedEditorialAuthor(id:string,page?:object,cursor?:string|null):Promise<EditorialAuthorPage> {
  return read(page,`/v1/editorial/authors/${identifier(id)}?limit=20${cursor?`&cursor=${encodeURIComponent(cursor)}`:""}`);
}
export async function reactToEditorialArticle(id:string,kind:"like"|"save",active:boolean):Promise<EditorialReaction> {
  const result=await request<EditorialReaction>({path:`/v1/editorial/articles/${identifier(id)}/reaction`,method:"PUT",data:{kind,active}});
  if(result?.kind!==kind||typeof result.active!=="boolean"||typeof result.liked!=="boolean"||typeof result.saved!=="boolean"||
    ![result.count,result.likeCount,result.saveCount].every(value=>Number.isSafeInteger(value)&&value>=0)||
    result.active!==(kind==="like"?result.liked:result.saved)||result.count!==(kind==="like"?result.likeCount:result.saveCount))throw new Error("EDITORIAL_REACTION_RESPONSE_INVALID");
  return result;
}
export async function followEditorialArticle(id:string,active:boolean):Promise<{authorId:string;following:boolean}> {
  const result=await request<{authorId:string;following:boolean}>({path:`/v1/editorial/articles/${identifier(id)}/follow`,method:"PUT",data:{active}});
  if(!result||!editorialIdentifier(result.authorId)||typeof result.following!=="boolean")throw new Error("EDITORIAL_FOLLOW_RESPONSE_INVALID");
  return result;
}
