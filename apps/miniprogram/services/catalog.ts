export const catalogPlaceholderImage = "/assets/icons/spray-bottle-plum.svg";
export const syntheticOwnedCatalogImage = "/assets/cisme/synthetic-owned-acceptance.jpg";

// Historic catalog and order snapshots may still name unapproved prototype
// images. Never show or fetch those paths after their removal from the package.
export function nativeCatalogImage(image: string | null | undefined): string {
  if (!image || (image.startsWith("/assets/cisme/") && image !== syntheticOwnedCatalogImage)) return catalogPlaceholderImage;
  return image;
}

export function hiddenHistoricalCatalogImage(image: string | null | undefined): boolean {
  return Boolean(image?.startsWith("/assets/cisme/") && image !== syntheticOwnedCatalogImage);
}
