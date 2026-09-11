import { chromeStyle, deriveChromeMetrics, type ChromeMetrics, type MenuGeometry } from "./layout-metrics";
export { chromeStyle, deriveChromeMetrics, type ChromeMetrics } from "./layout-metrics";

export function readChromeMetrics(): ChromeMetrics {
  const windowInfo = wx.getWindowInfo();
  let menu: MenuGeometry | undefined;
  try { menu = wx.getMenuButtonBoundingClientRect(); }
  catch { /* Base-library fallback uses measured window data above. */ }
  return deriveChromeMetrics(windowInfo, menu);
}

export function currentChromeStyle(): string {
  const app = getApp<IAppOption>();
  const metrics = readChromeMetrics();
  const style = chromeStyle(metrics);
  if (app?.globalData) {
    app.globalData.chromeMetrics = metrics;
    app.globalData.chromeStyle = style;
  }
  return style;
}

export function shouldReduceMotion(): boolean {
  try {
    const device = wx.getDeviceInfo() as WechatMiniprogram.DeviceInfo & { benchmarkLevel?: number };
    return typeof device.benchmarkLevel === "number" && device.benchmarkLevel > 0 && device.benchmarkLevel <= 20;
  } catch {
    return false;
  }
}

export function motionDuration(_duration: number): number {
  // JavaScript-driven scrolling cannot reliably observe the OS motion setting
  // across supported WeChat base libraries, so recovery motion stays instant.
  return 0;
}
