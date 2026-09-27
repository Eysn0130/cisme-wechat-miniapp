import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { nativeCatalogImage, syntheticOwnedCatalogImage } from "../../apps/miniprogram/services/catalog";

describe("native catalog assets", () => {
  it("replaces retired prototype paths with the packaged neutral icon", () => {
    for (const path of [null,"/assets/cisme/community-card-purple-bottle-v1.webp", "/assets/cisme/community-card-care-journal-v2.jpg"]) {
      expect(nativeCatalogImage(path)).toBe("/assets/icons/spray-bottle-plum.svg");
      expect(existsSync(`apps/miniprogram${nativeCatalogImage(path)}`)).toBe(true);
    }
  });
  it("preserves independent remote asset URLs", () => {
    const url = "https://example.com/product.webp";
    expect(nativeCatalogImage(url)).toBe(url);
  });
  it("keeps the exact owned acceptance image loadable without reopening retired paths", () => {
    expect(nativeCatalogImage(syntheticOwnedCatalogImage)).toBe(syntheticOwnedCatalogImage);
    const jpeg=readFileSync(`apps/miniprogram${syntheticOwnedCatalogImage}`);
    expect([...jpeg.subarray(0,3)]).toEqual([0xff,0xd8,0xff]);
    expect(nativeCatalogImage("/assets/cisme/community-card-care-journal-v2.jpg")).toBe("/assets/icons/spray-bottle-plum.svg");
  });
});
