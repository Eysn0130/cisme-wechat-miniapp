import { defaultMemberAvatar, localMemberAvatar } from "./member-avatar";
export interface CommunityComment {
  authorId?:string; avatar?:string; id: string; body: string; status: "pending" | "published" | "rejected" | "deleted"; parentId: string | null;
  replyToId: string | null; replyToName: string | null; authorName: string; isMine: boolean; createdAt: string; likeCount: number; liked: boolean;
}
export interface CommunityView {
  authors?: Record<string,{name:string;avatar:string;avatarRevision:string|null}>;
  preview: boolean; liked: boolean; saved: boolean; likeCount: number; saveCount: number; commentCount: number; aggregateVersion: number; truncated: boolean; comments: CommunityComment[];
}
export const emptyCommunity: CommunityView = { preview: true, liked: false, saved: false, likeCount: 0, saveCount: 0, commentCount: 0, aggregateVersion: 0, truncated: false, comments: [] };
const decorate = (comment: CommunityComment) => ({ ...comment, dateLabel: new Date(comment.createdAt).toLocaleDateString(), statusLabel: comment.status === "pending" ? "审核中 · 仅本人可见" : comment.status === "rejected" ? "审核未通过 · 仅本人可见" : "" });
export function commentThreads(comments: CommunityComment[], expanded: string[]) {
  const ids = new Set(comments.map(comment => comment.id));
  return comments.filter(comment => !comment.parentId || !ids.has(comment.parentId)).map(root => {
    const replies = comments.filter(comment => comment.parentId === root.id);
    const isExpanded = expanded.includes(root.id);
    return { ...decorate(root), expanded: isExpanded, replyCount: replies.length, hiddenCount: Math.max(0, replies.length - 1), replies: (isExpanded ? replies : replies.slice(0, 1)).map(decorate) };
  });
}

export async function prepareCommentAuthors(input:CommunityView):Promise<CommunityView> {
  const {authors,...social}=input;
  const entries=await Promise.all(Object.entries(authors || {}).map(async([id,author])=>[id,await localMemberAvatar(author.avatar,author.avatarRevision)] as const));
  const avatars=Object.fromEntries(entries);
  return {...social,comments:social.comments.map(comment=>({...comment,avatar:comment.status==="deleted" ? defaultMemberAvatar : avatars[comment.authorId || ""] || defaultMemberAvatar}))};
}
