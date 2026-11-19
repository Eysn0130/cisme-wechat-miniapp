import { clearPreviousAvatarFiles } from "./services/member-avatar";
import { pruneUgcBackups } from "./services/ugc-local-backup";
import { miniProgramApiOrigins, miniProgramCloudFunctions, remoteDebugApiOrigin, type RemoteDebugQuery } from "./release-config";
import { chromeStyle, readChromeMetrics } from "./services/layout";
import { acceptWechatReceiptReferrer } from "./services/wechat-receipt-return";
import {flushOfficerVisits} from './services/officer-attribution';
import { request } from "./services/api";
import { confirmMemberEntry, memberEntryReady } from "./services/member-entry";
import { hasRegisteredAccount, type SetupProfile } from "./services/member-setup";

function runtimeApiConfig(query: RemoteDebugQuery): { origin: string; remoteDebugMode: boolean; cloudFunction?: import("./release-config").CloudHttpTarget } {
  const { miniProgram } = wx.getAccountInfoSync();
  if (miniProgram.envVersion === "trial") return { origin: miniProgramApiOrigins.trial, remoteDebugMode: false, ...(miniProgramCloudFunctions.trial ? { cloudFunction: miniProgramCloudFunctions.trial } : {}) };
  if (miniProgram.envVersion === "release") return { origin: miniProgramApiOrigins.release, remoteDebugMode: false, ...(miniProgramCloudFunctions.release ? { cloudFunction: miniProgramCloudFunctions.release } : {}) };
  const platform = wx.getDeviceInfo().platform;
  const remoteOrigin = remoteDebugApiOrigin(miniProgram.envVersion, platform, query);
  if (remoteOrigin) return { origin: remoteOrigin, remoteDebugMode: true };
  const runtime = platform === "devtools" ? "devtools" : "preview";
  return { origin: miniProgramApiOrigins[runtime], remoteDebugMode: false, ...(miniProgramCloudFunctions[runtime] ? { cloudFunction: miniProgramCloudFunctions[runtime] } : {}) };
}

const initialChrome = readChromeMetrics();

App({
  globalData: {
    sessionToken: "",
    privacyRightsToken: "",
    sessionStorageKey: "cisme.sessionToken",
    apiBaseUrl: "",
    cloudFunction: null as import("./release-config").CloudHttpTarget | null,
    remoteDebugMode: false,
    chromeMetrics: initialChrome,
    chromeStyle: chromeStyle(initialChrome)
  },
  onLaunch(options) {
    clearPreviousAvatarFiles();
    pruneUgcBackups();
    const runtime = runtimeApiConfig(options.query ?? {});
    this.globalData.apiBaseUrl = runtime.origin;
    this.globalData.cloudFunction = runtime.cloudFunction ?? null;
    this.globalData.sessionStorageKey = runtime.cloudFunction
      ? `cisme.sessionToken.cloud.${runtime.cloudFunction.env}.${runtime.cloudFunction.name}`
      : `cisme.sessionToken.origin.${runtime.origin}`;
    this.globalData.sessionToken = wx.getStorageSync<string>(this.globalData.sessionStorageKey) || "";
    this.globalData.privacyRightsToken = this.globalData.sessionToken ? "" :
      wx.getStorageSync<string>(`${this.globalData.sessionStorageKey}.privacyRightsToken`) || "";
    this.globalData.remoteDebugMode = runtime.remoteDebugMode;
    const metrics = readChromeMetrics();
    this.globalData.chromeMetrics = metrics;
    this.globalData.chromeStyle = chromeStyle(metrics);
  },
  onShow(options){
    pruneUgcBackups();
    acceptWechatReceiptReferrer(options?.referrerInfo);
    const token = this.globalData.sessionToken;
    if (!token) return;
    void flushOfficerVisits().catch(() => {});
    // The public entry replaces Account as the first route. Restore an existing
    // member quietly; an absent, expired or incomplete session stays browsable.
    void Promise.resolve().then(async () => {
      if (token !== this.globalData.sessionToken || memberEntryReady()) return;
      const member = await request<SetupProfile>({ path: "/v1/me", authMode: "optional" });
      if (member?.id && hasRegisteredAccount(member)) confirmMemberEntry(token);
    }).catch(() => {});
  }
});
