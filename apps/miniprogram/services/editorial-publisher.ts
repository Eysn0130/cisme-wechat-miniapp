// Brand presentation for owner-published editorial only. Member identity,
// profile avatars and comment attribution keep their independent sources.
export const defaultEditorialPublisherName = "CISME头皮实验室";
export const defaultEditorialPublisherAvatar = "/assets/cisme/cisme-scalp-lab-avatar-v1.webp";

export function editorialPublisherAvatar(authorName: unknown, neutralAvatar: string): string {
  return authorName === defaultEditorialPublisherName ? defaultEditorialPublisherAvatar : neutralAvatar;
}
