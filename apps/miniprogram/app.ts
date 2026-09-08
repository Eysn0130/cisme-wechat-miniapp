import { miniProgramApiOrigins, remoteDebugApiOrigin, type RemoteDebugQuery } from "./release-config";
import { chromeStyle, readChromeMetrics } from "./services/layout";

function runtimeApiConfig(query: RemoteDebugQuery): { origin: string; remoteDebugMode: boolean } {
  const { miniProgram } = wx.getAccountInfoSync();
  if (miniProgram.envVersion === "trial") return { origin: miniProgramApiOrigins.trial, remoteDebugMode: false };
  if (miniProgram.envVersion === "release") return { origin: miniProgramApiOrigins.release, remoteDebugMode: false };
  const platform = wx.getDeviceInfo().platform;
  const remoteOrigin = remoteDebugApiOrigin(miniProgram.envVersion, platform, query);
  if (remoteOrigin) return { origin: remoteOrigin, remoteDebugMode: true };
  return { origin: platform === "devtools" ? miniProgramApiOrigins.devtools : miniProgramApiOrigins.preview, remoteDebugMode: false };
}

const initialChrome = readChromeMetrics();

App({
  globalData: {
    sessionToken: wx.getStorageSync<string>("cisme.sessionToken") || "",
    apiBaseUrl: "",
    remoteDebugMode: false,
    chromeMetrics: initialChrome,
    chromeStyle: chromeStyle(initialChrome)
  },
  onLaunch(options) {
    const runtime = runtimeApiConfig(options.query ?? {});
    this.globalData.apiBaseUrl = runtime.origin;
    this.globalData.remoteDebugMode = runtime.remoteDebugMode;
    const metrics = readChromeMetrics();
    this.globalData.chromeMetrics = metrics;
    this.globalData.chromeStyle = chromeStyle(metrics);
  }
});
