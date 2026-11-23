import { officialEditorialPublisherId } from "./editorial-publisher";

export type CommunityIdentityBadge = "sharing-officer" | "administrator" | "official";
const labels: Record<string, string> = {
  member: "普通会员",
  "sharing-officer": "分享官",
  administrator: "管理员",
  official: "CISME 官方",
  support: "官方客服"
};

export function identityLabel(kind: unknown): string {
  return typeof kind === "string" && Object.prototype.hasOwnProperty.call(labels, kind) ? labels[kind]! : "";
}

export function communityIdentityBadge(kind: unknown, authorId?: string): CommunityIdentityBadge | "" {
  if (authorId === officialEditorialPublisherId) return "official";
  return kind === "administrator" || kind === "sharing-officer" ? kind : "";
}

const badgesSeen = new Set<string>();

export function claimIdentityBadgeIntro(authorId: string, badge: CommunityIdentityBadge): boolean {
  const key = authorId + ":" + badge;
  if (badgesSeen.has(key)) return false;
  badgesSeen.add(key);
  return true;
}
