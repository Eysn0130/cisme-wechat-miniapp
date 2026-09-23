interface IAppOption {
  globalData: {
    sessionToken: string;
    privacyRightsToken: string;
    sessionStorageKey?: string;
    apiBaseUrl: string;
    cloudFunction?: import("../release-config").CloudHttpTarget | null;
    remoteDebugMode: boolean;
    chromeMetrics: import("../services/layout").ChromeMetrics;
    chromeStyle: string;
  };
}
