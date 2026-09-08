// The native package optimizes these frozen Web assets as JPEG files.
// Keep remote URLs and all other server-provided paths unchanged.
export function nativeCatalogImage(image: string): string {
  const aliases: Record<string, string> = {
    "/assets/cisme/community-card-purple-bottle-v1.webp": "/assets/cisme/community-card-purple-bottle-v1.jpg",
    "/assets/cisme/community-card-care-journal-v2.webp": "/assets/cisme/community-card-care-journal-v2.jpg"
  };
  return aliases[image] ?? image;
}
