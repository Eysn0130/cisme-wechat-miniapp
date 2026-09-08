export interface ChromeMetrics {
  windowWidth: number;
  statusBarHeight: number;
  menuTop: number;
  menuHeight: number;
  topbarHeight: number;
  stackTop: number;
  sideReserve: number;
  safeBottom: number;
}

function finite(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}

export function readChromeMetrics(): ChromeMetrics {
  const windowInfo = wx.getWindowInfo();
  const statusBarHeight = finite(windowInfo.statusBarHeight, 20);
  const windowWidth = finite(windowInfo.windowWidth, 375);
  let menuTop = statusBarHeight + 6;
  let menuHeight = 32;
  let menuLeft = windowWidth - 97;
  try {
    const menu = wx.getMenuButtonBoundingClientRect();
    if (menu.width > 0 && menu.height > 0 && menu.top >= statusBarHeight) {
      menuTop = menu.top;
      menuHeight = menu.height;
      menuLeft = menu.left;
    }
  } catch { /* Base-library fallback uses measured window data above. */ }
  const verticalGap = Math.max(4, menuTop - statusBarHeight);
  // The capsule metrics protect the system-owned hit area; the CISME glass
  // header also needs its own measured breathing room below that area.
  const navBottomDepth = 24;
  const topbarHeight = Math.max(statusBarHeight + 44, menuTop + menuHeight + verticalGap) + navBottomDepth;
  const safeBottom = Math.max(0, finite(windowInfo.screenHeight, windowInfo.windowHeight) - finite(windowInfo.safeArea?.bottom, windowInfo.windowHeight));
  return {
    windowWidth,
    statusBarHeight,
    menuTop,
    menuHeight,
    topbarHeight,
    stackTop: topbarHeight + 18,
    sideReserve: Math.max(56, windowWidth - menuLeft + 12),
    safeBottom
  };
}

export function chromeStyle(metrics: ChromeMetrics): string {
  return [
    `--cisme-status-bar:${metrics.statusBarHeight}px`,
    `--cisme-menu-top:${metrics.menuTop}px`,
    `--cisme-menu-height:${metrics.menuHeight}px`,
    `--cisme-topbar-height:${metrics.topbarHeight}px`,
    `--cisme-stack-top:${metrics.stackTop}px`,
    `--cisme-nav-side:${metrics.sideReserve}px`,
    `--cisme-safe-bottom:${metrics.safeBottom}px`
  ].join(";");
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
