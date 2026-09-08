export interface CommunityComment {
  id: string; body: string; status: "pending" | "published" | "rejected" | "deleted"; parentId: string | null;
  replyToId: string | null; replyToName: string | null; authorName: string; isMine: boolean; createdAt: string; likeCount: number; liked: boolean;
}
export interface CommunityView {
  preview: boolean; liked: boolean; saved: boolean; likeCount: number; saveCount: number; commentCount: number; truncated: boolean; comments: CommunityComment[];
}
export const emptyCommunity: CommunityView = { preview: true, liked: false, saved: false, likeCount: 0, saveCount: 0, commentCount: 0, truncated: false, comments: [] };
const decorate = (comment: CommunityComment) => ({ ...comment, dateLabel: new Date(comment.createdAt).toLocaleDateString(), statusLabel: comment.status === "pending" ? "审核中 · 仅本人可见" : comment.status === "rejected" ? "审核未通过 · 仅本人可见" : "" });
export function commentThreads(comments: CommunityComment[], expanded: string[]) {
  const ids = new Set(comments.map(comment => comment.id));
  return comments.filter(comment => !comment.parentId || !ids.has(comment.parentId)).map(root => {
    const replies = comments.filter(comment => comment.parentId === root.id);
    const isExpanded = expanded.includes(root.id);
    return { ...decorate(root), expanded: isExpanded, replyCount: replies.length, hiddenCount: Math.max(0, replies.length - 1), replies: (isExpanded ? replies : replies.slice(0, 1)).map(decorate) };
  });
}
