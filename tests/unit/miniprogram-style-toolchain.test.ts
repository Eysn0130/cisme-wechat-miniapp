import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { compile } = require("miniprogram-simulate/src/wxss") as {
  compile(source: string, options: { prefix: string; less?: boolean }): string;
};

describe("patched mini program simulator style toolchain", () => {
  it("preserves scoped selectors, decimal values and media rules with PostCSS 8", () => {
    const css = compile(".card, .card.active { opacity: .5; padding: 16rpx; } @media (min-width: 300px) { .card { display: flex; } }", { prefix: "native" });
    expect(css).toContain(".native--card,.native--card.native--active");
    expect(css).toContain("opacity:.5");
    expect(css).toContain("padding:16rpx");
    expect(css).toContain("@media (min-width:300px){.native--card{display:flex}}");
  });

  it("keeps the simulator's synchronous Less callback path compatible with Less 4", () => {
    const css = compile("@gap: 8rpx; .card { padding: (@gap * 2); .title { font-weight: 600; } }", { prefix: "native", less: true });
    expect(css).toContain(".native--card{padding:16rpx}");
    expect(css).toContain(".native--card .native--title{font-weight:600}");
    expect(css).not.toContain("@gap");
  });
});
