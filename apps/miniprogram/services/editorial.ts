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
