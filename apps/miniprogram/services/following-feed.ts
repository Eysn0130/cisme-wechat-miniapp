import { pageRead } from "./page-requests";
import { defaultMemberAvatar, localMemberAvatar } from "./member-avatar";
import { editorialMediaSrc } from "./editorial";
import { editorialPublisherAvatar } from "./editorial-publisher";

export async function readFollowingFeed(page: object, cursor?: string | null) {
  const result = await pageRead<{ items: any[]; nextCursor: string | null }>(page, {
    path: `/v1/me/community/following?limit=30${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`
  });
  if (!Array.isArray(result?.items) || !(result.nextCursor === null || typeof result.nextCursor === "string") ||
    (cursor && result.nextCursor === cursor) || result.items.some(item => !item?.id || !item.authorId ||
      !["editorial", "formal", "ugc"].includes(item.kind))) throw new Error("FOLLOWING_RESPONSE_INVALID");
  const origin = getApp<IAppOption>().globalData.apiBaseUrl.replace(/\/$/, "");
  return { nextCursor: result.nextCursor, items: await Promise.all(result.items.map(async item => ({ ...item,
    author_id: item.authorId,
    image: item.kind === "editorial" ? editorialMediaSrc(item.coverUrl)
      : /^\/v1\/ugc\/media\/[0-9a-f-]{36}\?variant=thumbnail$/i.test(item.coverUrl ?? "") ? origin + item.coverUrl : "",
    avatar: item.kind === "editorial" ? editorialPublisherAvatar(item.author, defaultMemberAvatar)
      : await localMemberAvatar(item.avatar, item.avatarRevision),
    engagementLabel: item.kind === "ugc" ? "" : `${item.likeCount} 赞`
  }))) };
}
