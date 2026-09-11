import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { nativeCatalogImage } from "../../apps/miniprogram/services/catalog";

describe("native catalog assets", () => {
  it("resolves the Web catalog paths to actual native package images", () => {
    for (const path of ["/assets/cisme/community-card-purple-bottle-v1.webp", "/assets/cisme/community-card-care-journal-v2.webp", "/assets/cisme/community-card-care-flatlay-v2.webp"]) {
      expect(existsSync(`apps/miniprogram${nativeCatalogImage(path)}`)).toBe(true);
    }
  });
  it("preserves independent remote asset URLs", () => {
    const url = "https://example.com/product.webp";
    expect(nativeCatalogImage(url)).toBe(url);
  });
});
