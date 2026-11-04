import { pageRead } from "./page-requests";
import { localMemberAvatar } from "./member-avatar";
import { editorialIdentifier, editorialMediaSrc } from "./editorial";
import { editorialPublisherAvatar, officialEditorialPublisherId } from "./editorial-publisher";
import type { FeedCard } from "./feed-projection";

export interface CommunityAuthor {
  id:string;name:string;avatar:string;avatarRevision:string|null;membershipLabel:string;bio:string;bioRevision:number|null;
  accountType?:"member"|"official";canManage?:boolean;
  postCount:number;following:boolean;isMine:boolean;canFollow:boolean;followArticleId:string|null;
}
export interface CommunityProfilePage {author:CommunityAuthor;items:FeedCard[];nextCursor:string|null}
export function canEditCommunityBio(author:CommunityAuthor|null):boolean{
  return Boolean(author&&(author.isMine&&author.id!==officialEditorialPublisherId||
    author.id===officialEditorialPublisherId&&author.accountType==="official"&&author.canManage===true));
}

export async function readCommunityProfile(page:object,authorId:string,mine:boolean,cursor?:string|null):Promise<CommunityProfilePage>{
  if(!mine&&!editorialIdentifier(authorId))throw new Error("COMMUNITY_AUTHOR_INVALID");
  const path=mine?"/v1/me/community-profile":`/v1/community/authors/${encodeURIComponent(authorId)}`;
  const result=await pageRead<{author:CommunityAuthor;items:any[];nextCursor:string|null}>(page,{
    path:`${path}?limit=20${cursor?`&cursor=${encodeURIComponent(cursor)}`:""}`,authMode:mine?"required":"optional"
  });
  const author=result?.author;
  if(!author||!editorialIdentifier(author.id)||(!mine&&author.id!==authorId)||(mine&&!author.isMine)||
    typeof author.name!=="string"||typeof author.bio!=="string"||typeof author.membershipLabel!=="string"||
    typeof author.following!=="boolean"||typeof author.isMine!=="boolean"||typeof author.canFollow!=="boolean"||
    (author.canManage!==undefined&&typeof author.canManage!=="boolean")||
    (author.accountType!==undefined&&author.accountType!==(author.id===officialEditorialPublisherId?"official":"member"))||
    (author.id===officialEditorialPublisherId&&(mine||author.isMine||(!author.canManage&&author.bioRevision!==null)))||
    (author.canManage===true&&(author.id!==officialEditorialPublisherId||!Number.isSafeInteger(author.bioRevision)||Number(author.bioRevision)<0))||
    !Number.isSafeInteger(author.postCount)||author.postCount<0||
    (author.isMine&&(!Number.isSafeInteger(author.bioRevision)||Number(author.bioRevision)<0))||
    !(author.followArticleId===null||editorialIdentifier(author.followArticleId))||
    !Array.isArray(result.items)||!(result.nextCursor===null||typeof result.nextCursor==="string")||
    (cursor&&result.nextCursor===cursor))throw new Error("COMMUNITY_PROFILE_INVALID");
  const personalAvatar=await localMemberAvatar(author.avatar,author.avatarRevision);
  const avatar=editorialPublisherAvatar(author.name,personalAvatar,author.id);
  const origin=getApp<IAppOption>().globalData.apiBaseUrl.replace(/\/$/,"");
  const items=await Promise.all(result.items.map(async item=>{
    if(!editorialIdentifier(item?.id)||item.authorId!==author.id||!["editorial","formal","ugc"].includes(item.kind))
      throw new Error("COMMUNITY_PROFILE_INVALID");
    return {id:item.id,kind:item.kind,title:item.title,author:item.author,
      image:item.kind==="editorial"?editorialMediaSrc(item.coverUrl)
        :/^\/v1\/ugc\/media\/[0-9a-f-]{36}\?variant=thumbnail$/i.test(item.coverUrl??"")?origin+item.coverUrl:"",
      avatar:item.kind==="editorial"?editorialPublisherAvatar(item.author,await localMemberAvatar(item.avatar,item.avatarRevision),item.authorId)
        :await localMemberAvatar(item.avatar,item.avatarRevision),
      engagementLabel:"",compactImage:false};
  }));
  return {author:{...author,avatar},items,nextCursor:result.nextCursor};
}
