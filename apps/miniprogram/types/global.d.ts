interface IAppOption {
  globalData: {
    sessionToken: string;
    apiBaseUrl: string;
    remoteDebugMode: boolean;
    chromeMetrics: import("../services/layout").ChromeMetrics;
    chromeStyle: string;
  };
}
