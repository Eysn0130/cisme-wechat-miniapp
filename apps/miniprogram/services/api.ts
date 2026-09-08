const app = getApp<IAppOption>();
const authReturnKey = "cisme.authReturnUrl";
const submissionReturnKey = "cisme.submissionReturnContext";
const tabRoutes = new Set(["/pages/home/index", "/pages/records/index", "/pages/community/index", "/pages/profile/index"]);
let authRedirecting = false;
let suppressedAuthRedirectPath = "";

function normalizedAuthPath(url: string): string {
  return url.split("?")[0] ?? url;
}

function apiBaseUrl(): string {
  if (!app.globalData.apiBaseUrl) throw new Error("MINIPROGRAM_API_BASE_URL_MISSING");
  return app.globalData.apiBaseUrl;
}

export function setSessionToken(token: string): void {
  app.globalData.sessionToken = token;
  wx.setStorageSync("cisme.sessionToken", token);
  if (token) {
    authRedirecting = false;
    suppressedAuthRedirectPath = "";
  }
}

function currentRouteUrl(): string {
  const pages = getCurrentPages();
  const page = pages[pages.length - 1] as (WechatMiniprogram.Page.Instance<Record<string, unknown>, Record<string, unknown>> & { route?: string; options?: Record<string, string> }) | undefined;
  if (!page?.route) return "/pages/community/index";
  const query = Object.entries(page.options ?? {}).map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`).join("&");
  return `/${page.route}${query ? `?${query}` : ""}`;
}

export function beginAuthentication(returnUrl = currentRouteUrl()): void {
  const authPath = normalizedAuthPath(returnUrl);
  if (suppressedAuthRedirectPath === authPath) {
    return;
  }
  if (returnUrl.startsWith("/pages/") && !returnUrl.startsWith("/pages/account/")) wx.setStorageSync(authReturnKey, returnUrl);
  if (authRedirecting) return;
  authRedirecting = true;
  wx.navigateTo({
    url: "/pages/account/index",
    fail: () => {
      wx.reLaunch({
        url: "/pages/account/index",
        fail: () => {
          authRedirecting = false;
          wx.showToast({ title: "登录页面暂时无法打开，请重试", icon: "none" });
        }
      });
    }
  });
}

export function cancelAuthentication(): void {
  authRedirecting = false;
}

export function suppressAuthenticationRedirectOnce(returnUrl: string): void {
  const authPath = normalizedAuthPath(returnUrl);
  suppressedAuthRedirectPath = authPath.startsWith("/pages/") && !authPath.startsWith("/pages/account/") ? authPath : "";
}

export function clearAuthenticationRedirectSuppression(): void {
  suppressedAuthRedirectPath = "";
}

export function resumeAuthentication(returnUrl = currentRouteUrl()): void {
  clearAuthenticationRedirectSuppression();
  beginAuthentication(returnUrl);
}

export function consumeAuthReturnUrl(): string {
  const stored = wx.getStorageSync<string>(authReturnKey);
  wx.removeStorageSync(authReturnKey);
  return stored.startsWith("/pages/") && !stored.startsWith("/pages/account/") ? stored : "/pages/home/index";
}

export function navigateAfterAuthentication(url: string): Promise<"target" | "failed"> {
  const path = url.split("?")[0] ?? url;
  return new Promise((resolve) => {
    const failed = () => { wx.showToast({ title: "身份已确认，但目标页面暂时无法打开", icon: "none" }); resolve("failed"); };
    if (tabRoutes.has(path)) {
      wx.switchTab({ url: path, success: () => resolve("target"), fail: failed });
      return;
    }
    const pages = getCurrentPages();
    const previous = pages[pages.length - 2] as { route?: string } | undefined;
    if (previous?.route === path.slice(1)) {
      // Authentication is an overlay on the protected page. Pop that overlay so
      // the original page (and any unsaved local state) remains the only copy.
      wx.navigateBack({
        delta: 1,
        success: () => resolve("target"),
        fail: () => wx.reLaunch({ url, success: () => resolve("target"), fail: failed })
      });
      return;
    }
    wx.redirectTo({ url, success: () => resolve("target"), fail: failed });
  });
}

export function rememberSubmissionReturn(context: { submissionId: string; taskId: string; returnUrl: string }): void {
  if (!context.submissionId || !context.taskId || !context.returnUrl.startsWith("/pages/task/")) return;
  wx.setStorageSync(submissionReturnKey, context);
}

export function submissionReturnUrl(submissionId: string): string {
  const context = wx.getStorageSync<{ submissionId?: string; taskId?: string; returnUrl?: string }>(submissionReturnKey);
  if (context?.submissionId !== submissionId || !context.taskId || !context.returnUrl?.startsWith("/pages/task/")) return "";
  return context.returnUrl;
}

export function request<T>(options: { path: string; method?: "GET" | "POST" | "PUT" | "DELETE"; data?: WechatMiniprogram.IAnyObject; idempotencyKey?: string; authMode?: "required" | "optional" | "public" }): Promise<T> {
  const method = options.method ?? "GET";
  const data = options.data ?? (method === "GET" ? undefined : {});
  const authMode = options.authMode ?? "required";
  if (authMode === "required" && !app.globalData.sessionToken) {
    beginAuthentication();
    return Promise.reject({ status: 401, code: "AUTHENTICATION_REQUIRED", title: "请先完成身份确认" });
  }
  const requestOrigin = currentRouteUrl();
  return new Promise((resolve, reject) => {
    wx.request<WechatMiniprogram.IAnyObject>({
      url: `${apiBaseUrl()}${options.path}`,
      method,
      ...(data ? { data } : {}),
      header: {
        Authorization: authMode !== "public" && app.globalData.sessionToken ? `Bearer ${app.globalData.sessionToken}` : "",
        "Idempotency-Key": options.idempotencyKey ?? "",
        "Content-Type": "application/json"
      },
      success: (response) => {
        if (response.statusCode >= 200 && response.statusCode < 300) {
          resolve(response.data as T);
          return;
        }
        const problem = response.data as { code?: string };
        if (response.statusCode === 401 || problem.code === "MEMBER_NOT_FOUND") {
          setSessionToken("");
          if (authMode === "required" && currentRouteUrl() === requestOrigin) beginAuthentication(requestOrigin);
        }
        reject(response.data);
      },
      fail: reject
    });
  });
}

export function uploadAuthorized(filePath: string, authorization: { url: string; fields: Record<string, string> }): Promise<void> {
  return new Promise((resolve, reject) => {
    wx.uploadFile({
      url: authorization.url,
      filePath,
      name: "file",
      formData: authorization.fields,
      success: (response) => response.statusCode >= 200 && response.statusCode < 300 ? resolve() : reject(response),
      fail: reject
    });
  });
}
