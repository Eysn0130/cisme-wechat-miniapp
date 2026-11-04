// Brand presentation for owner-published editorial only. Member identity,
// profile avatars and comment attribution keep their independent sources.
export const defaultEditorialPublisherName = "CISME头皮实验室";
export const defaultEditorialPublisherAvatar = "/assets/cisme/cisme-scalp-lab-avatar-v1.jpg";
// Mirrors the public publisher namespace in @cisme/contracts, not a member ID.
export const officialEditorialPublisherId = "fe841ebb-1db1-57de-988b-4ff1534f23e6";

export function editorialPublisherAvatar(_authorName: unknown, neutralAvatar: string, authorId?:unknown): string {
  return authorId === officialEditorialPublisherId ? defaultEditorialPublisherAvatar : neutralAvatar;
}
