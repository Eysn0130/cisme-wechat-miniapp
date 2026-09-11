export interface ChromeMetrics {
  windowWidth: number;
  statusBarHeight: number;
  menuTop: number;
  menuHeight: number;
  navBarHeight: number;
  topbarHeight: number;
  stackTop: number;
  backButtonTop: number;
  sideReserve: number;
  safeBottom: number;
}

export interface WindowGeometry {
  windowWidth?: number;
  windowHeight?: number;
  screenHeight?: number;
  statusBarHeight?: number;
  safeArea?: { bottom?: number };
}

export interface MenuGeometry {
  top?: number;
  left?: number;
  width?: number;
  height?: number;
}

function finite(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}

export function deriveChromeMetrics(windowInfo: WindowGeometry, menu?: MenuGeometry): ChromeMetrics {
  const statusBarHeight = finite(windowInfo.statusBarHeight, 0);
  const windowWidth = finite(windowInfo.windowWidth, 375);
  const windowHeight = finite(windowInfo.windowHeight, 667);
  let menuTop = statusBarHeight + 6;
  let menuHeight = 32;
  let menuLeft = windowWidth - 97;
  if (finite(menu?.width, 0) > 0 && finite(menu?.height, 0) > 0 && finite(menu?.top, 0) >= statusBarHeight) {
    menuTop = finite(menu?.top, menuTop);
    menuHeight = finite(menu?.height, menuHeight);
    menuLeft = finite(menu?.left, menuLeft);
  }
  const verticalGap = Math.max(4, menuTop - statusBarHeight);
  const navBarHeight = Math.max(44, verticalGap * 2 + menuHeight);
  const topbarHeight = statusBarHeight + navBarHeight;
  const safeBottom = typeof windowInfo.safeArea?.bottom === "number" ? Math.max(0, finite(windowInfo.screenHeight, windowHeight) - finite(windowInfo.safeArea.bottom, windowHeight)) : 0;
  return { windowWidth, statusBarHeight, menuTop, menuHeight, navBarHeight, topbarHeight, stackTop: topbarHeight + 12, backButtonTop: statusBarHeight + Math.max(0, (navBarHeight - 44) / 2), sideReserve: Math.max(56, windowWidth - menuLeft + 12), safeBottom };
}

export function chromeStyle(metrics: ChromeMetrics): string {
  return [
    `--cisme-status-bar:${metrics.statusBarHeight}px`, `--cisme-menu-top:${metrics.menuTop}px`, `--cisme-menu-height:${metrics.menuHeight}px`,
    `--cisme-navbar-height:${metrics.navBarHeight}px`, `--cisme-topbar-height:${metrics.topbarHeight}px`, `--cisme-stack-top:${metrics.stackTop}px`,
    `--cisme-back-top:${metrics.backButtonTop}px`, `--cisme-nav-side:${metrics.sideReserve}px`, `--cisme-safe-bottom:${metrics.safeBottom}px`
  ].join(";");
}
