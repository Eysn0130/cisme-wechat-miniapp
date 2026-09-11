import { describe, expect, it } from "vitest";
import { chromeStyle, deriveChromeMetrics } from "../../apps/miniprogram/services/layout-metrics";

describe("custom navbar metrics", () => {
  it("centres the nav row around a measured capsule without artificial depth", () => {
    const metrics = deriveChromeMetrics(
      { windowWidth: 393, windowHeight: 759, screenHeight: 852, statusBarHeight: 59, safeArea: { bottom: 818 } },
      { top: 63, left: 296, width: 87, height: 32 }
    );
    expect(metrics).toMatchObject({ navBarHeight: 44, topbarHeight: 103, stackTop: 115, backButtonTop: 59, sideReserve: 109, safeBottom: 34 });
    expect(chromeStyle(metrics)).toContain("--cisme-navbar-height:44px");
    expect(chromeStyle(metrics)).toContain("--cisme-back-top:59px");
  });

  it("keeps symmetric capsule spacing when it requires a taller nav row", () => {
    const metrics = deriveChromeMetrics(
      { windowWidth: 375, windowHeight: 700, screenHeight: 800, statusBarHeight: 24, safeArea: { bottom: 780 } },
      { top: 34, left: 278, width: 87, height: 32 }
    );
    expect(metrics.navBarHeight).toBe(52);
    expect(metrics.topbarHeight).toBe(76);
    expect(metrics.backButtonTop).toBe(28);
    expect(metrics.safeBottom).toBe(20);
  });

  it("uses deterministic safe fallbacks when capsule data is unavailable", () => {
    expect(deriveChromeMetrics({ windowWidth: 375, windowHeight: 667, screenHeight: 800 }).topbarHeight).toBe(44);
    expect(deriveChromeMetrics({ windowWidth: 375, windowHeight: 667, screenHeight: 800 }).safeBottom).toBe(0);
  });
});
