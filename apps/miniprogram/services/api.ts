import { clearMemberIdentity } from "./member-identity";
import { clearMemberAvatarCache } from "./member-avatar";
import { clearAllUgcBackups } from "./ugc-local-backup";
import { RequestCoordinator } from "./request-coordinator";
import { sendJsonRequest, type TransportHandle } from "./http";
const app = { get globalData() { return getApp<IAppOption>().globalData; } };
const authReturnKey = "cisme.authReturnUrl";
const submissionReturnKey = "cisme.submissionReturnContext";
const tabRoutes = new Set(["/pages/home/index", "/pages/records/index", "/pages/community/index", "/pages/profile/index"]);
const reads = new RequestCoordinator();
let authRedirecting = false;
let suppressedAuthRedirectPath = "";

function normalizedAuthPath(url: string): string {
  return url.split("?")[0] ?? url;
}

export function setSessionToken(token: string): void {
  if(!token)clearAllUgcBackups();
  clearMemberAvatarCache();
  clearMemberIdentity();
  reads.invalidate();
  app.globalData.sessionToken = token;
  wx.setStorageSync(app.globalData.sessionStorageKey || "cisme.sessionToken", token);
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
    url: "/pages/account/index?intent=login",
    fail: () => {
      wx.reLaunch({
        url: "/pages/account/index?intent=login",
        fail: () => {
          authRedirecting = false;
          wx.showToast({ title: "登录页面暂时无法打开，请重试", icon: "none" });
        }
      });
    }
  });
}

const snapshotOwners = new WeakMap<object, string>();
export function retainMemberSnapshot(page: object): boolean {
  const token = app.globalData.sessionToken;
  const retain = Boolean(token && snapshotOwners.get(page) === token);
  snapshotOwners.set(page, token);
  return retain;
}

export function requireMemberAccess(returnUrl = currentRouteUrl()): boolean {
  if (app.globalData.sessionToken) return true;
  // A member may explicitly leave Account and return to the protected source
  // that opened it. Honour that one suppressed automatic redirect; an explicit
  // member action can call resumeAuthentication() to open Account again.
  beginAuthentication(returnUrl);
  return false;
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

type RequestOptions = { path: string; method?: "GET" | "POST" | "PUT" | "DELETE"; data?: WechatMiniprogram.IAnyObject; idempotencyKey?: string; authMode?: "required" | "optional" | "public"; cacheTags?: string[] };

function tagsForPath(path: string): string[] {
  const tags = new Set<string>();
  if (path.includes("feed") || path.includes("community") || path.includes("follow")) tags.add("feed");
  if (path.includes("care")) tags.add("care");
  if (path.includes("points") || path.includes("task")) tags.add("points");
  if (path.includes("submission") || path.includes("upload")) tags.add("submission");
  if (path.includes("support")) tags.add("support");
  if (path.includes("order") || path.includes("quote")) tags.add("orders");
  if (path.includes("authority")) tags.add("authority");
  if (path.includes("profile") || path.includes("phone") || path.includes("address") || path.includes("consent") || path === "/v1/me") tags.add("member");
  if (!tags.size) tags.add("public");
  return [...tags];
}

function readPolicy(path: string, tags: string[]) {
  if (path === "/v1/catalog" || path === "/v1/capabilities" || path === "/v1/identity/capabilities" || path === "/v1/legal") return { ttlMs: 5 * 60_000, staleMs: 55 * 60_000, tags };
  if (path === "/v1/feed" || path.includes("/community/")) return { ttlMs: 5_000, staleMs: 15_000, tags };
  if (path.includes("bootstrap") || path === "/v1/me" || path === "/v1/me/profile") return { ttlMs: 1_500, staleMs: 0, tags };
  return { ttlMs: 0, staleMs: 0, tags };
}

export function request<T>(options: RequestOptions): Promise<T> {
  const tags = options.cacheTags ?? tagsForPath(options.path);
  if ((options.method ?? "GET") !== "GET") {
    reads.invalidate(tags);
    return performRequest<T>(options).finally(() => reads.invalidate(tags));
  }
  // Include identity, transport and auth semantics so a public or old-account
  // request can never satisfy another member's read.
  const key = JSON.stringify([app.globalData.apiBaseUrl, app.globalData.cloudFunction, app.globalData.sessionToken, options]);
  return reads.read(key, () => performRequest<T>(options), readPolicy(options.path, tags));
}

function requestId(): string { return `wx-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`; }
function retryable(error: unknown): boolean {
  const problem = error as { status?: number; statusCode?: number; code?: string; errMsg?: string };
  const signal = `${problem?.code ?? ""} ${problem?.errMsg ?? ""}`;
  return problem?.status === 502 || problem?.status === 503 || problem?.statusCode === 502 || problem?.statusCode === 503
    || ["NETWORK_ERROR", "request:fail"].some((code) => signal.includes(code));
}

async function performRequest<T>(options: RequestOptions): Promise<T> {
  const method = options.method ?? "GET";
  try { return await performRequestOnce<T>(options); }
  catch (error) {
    if (method !== "GET" || !retryable(error)) throw error;
    await new Promise((resolve) => setTimeout(resolve, 40 + Math.floor(Math.random() * 81)));
    return performRequestOnce<T>(options);
  }
}

function performRequestOnce<T>(options: RequestOptions): Promise<T> {
  const method = options.method ?? "GET";
  const data = options.data ?? (method === "GET" ? undefined : {});
  const authMode = options.authMode ?? "required";
  if (authMode === "required" && !app.globalData.sessionToken) {
    beginAuthentication();
    return Promise.reject({ status: 401, code: "AUTHENTICATION_REQUIRED", title: "请先完成身份确认" });
  }
  const requestOrigin = currentRouteUrl();
  const requestSessionToken = authMode === "public" ? "" : app.globalData.sessionToken;
  return new Promise((resolve, reject) => {
    sendJsonRequest({
      path: options.path,
      origin: app.globalData.apiBaseUrl,
      cloud: app.globalData.cloudFunction ?? null,
      method,
      ...(data ? { data } : {}),
      header: {
        Authorization: requestSessionToken ? `Bearer ${requestSessionToken}` : "",
        "Idempotency-Key": options.idempotencyKey ?? "",
        "Content-Type": "application/json",
        "X-Request-Id": requestId()
      },
      success: (response) => {
        if (requestSessionToken && app.globalData.sessionToken !== requestSessionToken) {
          reject({ code: "REQUEST_SESSION_CHANGED", title: "会员身份已切换，请重新加载" });
          return;
        }
        if (response.statusCode >= 200 && response.statusCode < 300) {
          resolve(response.data as T);
          return;
        }
        const problem = response.data as { code?: string };
        if ((response.statusCode === 401 || problem.code === "MEMBER_NOT_FOUND") && requestSessionToken && app.globalData.sessionToken === requestSessionToken) {
          setSessionToken("");
          if (authMode === "required" && currentRouteUrl() === requestOrigin) beginAuthentication(requestOrigin);
        }
        const responseProblem = response.data as Record<string, unknown>;
        reject({ ...responseProblem, status: response.statusCode });
      },
      fail: reject
    });
  });
}

export function requestCancelable<T>(options: RequestOptions): { promise: Promise<T>; abort(): void } {
  let handle: TransportHandle | null = null;
  const method = options.method ?? "GET";
  const data = options.data ?? (method === "GET" ? undefined : {});
  const authMode = options.authMode ?? "required";
  const token = authMode === "public" ? "" : app.globalData.sessionToken;
  const requestOrigin = currentRouteUrl();
  const promise = new Promise<T>((resolve, reject) => {
    if (authMode === "required" && !token) { beginAuthentication(requestOrigin); reject({ status: 401, code: "AUTHENTICATION_REQUIRED", title: "请先完成身份确认" }); return; }
    handle = sendJsonRequest({ path: options.path, origin: app.globalData.apiBaseUrl, cloud: app.globalData.cloudFunction ?? null, method, ...(data ? { data } : {}),
      header: { Authorization: token ? `Bearer ${token}` : "", "Idempotency-Key": options.idempotencyKey ?? "", "Content-Type": "application/json", "X-Request-Id": requestId() },
      success: (response) => {
        if (token && app.globalData.sessionToken !== token) { reject({ code: "REQUEST_SESSION_CHANGED", title: "会员身份已切换，请重新加载" }); return; }
        if (response.statusCode >= 200 && response.statusCode < 300) { resolve(response.data as T); return; }
        const problem = response.data as { code?: string };
        if ((response.statusCode === 401 || problem.code === "MEMBER_NOT_FOUND") && token && app.globalData.sessionToken === token) {
          setSessionToken("");
          if (authMode === "required" && currentRouteUrl() === requestOrigin) beginAuthentication(requestOrigin);
        }
        reject({ ...(response.data as Record<string, unknown>), status: response.statusCode });
      }, fail: reject });
  });
  return { promise, abort() { handle?.abort(); } };
}

export async function uploadAuthorized(filePath: string, authorization: { url: string; method?: "POST" | "PUT"; fields: Record<string, string>; headers?: Record<string,string>; mediaId?: string }, options: {
  onProgress?: (percent: number) => void;
  registerAbort?: (abort: () => void) => void;
} = {}): Promise<void> {
  let cancelled = false;
  let abortTransport = () => {};
  options.registerAbort?.(() => { cancelled = true; abortTransport(); });
  const assertActive = () => { if (cancelled) throw { code: "UPLOAD_CANCELLED", errMsg: "upload:fail abort" }; };
  options.onProgress?.(0);
  if (authorization.method === "PUT") {
    const data = await new Promise<ArrayBuffer>((resolve, reject) => wx.getFileSystemManager().readFile({ filePath, success: result => resolve(result.data as ArrayBuffer), fail: reject }));
    if (!data.byteLength || data.byteLength > 10 * 1024 * 1024) throw new Error("文件须在 10 MiB 以内");
    assertActive();
    await new Promise<void>((resolve, reject) => {
      const task = wx.request({
      url: authorization.url, method: "PUT", data, header: authorization.headers ?? {}, timeout: 60_000,
      success: response => response.statusCode >= 200 && response.statusCode < 300 ? resolve() : reject(response), fail: reject
      });
      abortTransport = () => task.abort();
    });
    assertActive();
    options.onProgress?.(100);
    return;
  }
  if (app.globalData.cloudFunction && authorization.fields.token) {
    const mediaId = authorization.mediaId || /\/v1\/uploads\/([0-9a-f-]{36})$/.exec(authorization.url)?.[1];
    if (!mediaId) throw new Error("上传编号缺失");
    const fs = wx.getFileSystemManager();
    const info = await new Promise<WechatMiniprogram.GetFileInfoSuccessCallbackResult>((resolve,reject) => fs.getFileInfo({ filePath, success:resolve, fail:reject }));
    if (!info.size || info.size > 10*1024*1024) throw new Error("文件须在 10 MiB 以内");
    const chunkSize = 512*1024;
    const chunkCount = Math.ceil(info.size/chunkSize);
    for (let index=0; index<chunkCount; index++) {
      assertActive();
      const base64 = await new Promise<string>((resolve,reject) => fs.readFile({ filePath, encoding:"base64", position:index*chunkSize, length:Math.min(chunkSize,info.size-index*chunkSize), success: result => resolve(String(result.data)), fail:reject }));
      await request({ path:`/v1/uploads/${mediaId}/chunks`, method:"POST", authMode:"public", data:{ token:authorization.fields.token, index, totalBytes:info.size, base64 } });
      options.onProgress?.(Math.min(90, Math.round((index + 1) / chunkCount * 90)));
    }
    assertActive();
    await request({ path:`/v1/uploads/${mediaId}/assemble`, method:"POST", authMode:"public", data:{token:authorization.fields.token} });
    assertActive();
    options.onProgress?.(100);
    return;
  }
  return new Promise((resolve, reject) => {
    const task = wx.uploadFile({
      url: authorization.url,
      filePath,
      name: "file",
      formData: authorization.fields,
      success: (response) => response.statusCode >= 200 && response.statusCode < 300 ? (options.onProgress?.(100), resolve()) : reject(response),
      fail: reject
    });
    abortTransport = () => task.abort();
    task.onProgressUpdate?.((event) => options.onProgress?.(Math.max(0, Math.min(99, event.progress))));
  });
}

export function downloadPrivateMedia(path: string): { promise: Promise<string>; abort(): void } {
  const token = app.globalData.sessionToken;
  const origin = app.globalData.apiBaseUrl.replace(/\/$/, "");
  let task: WechatMiniprogram.DownloadTask | null = null;
  const promise = new Promise<string>((resolve, reject) => {
    if (!token) { reject({ code: "AUTHENTICATION_REQUIRED" }); return; }
    if (app.globalData.cloudFunction) { reject({ code: "SUPPORT_MEDIA_PREVIEW_TRANSPORT_UNAVAILABLE" }); return; }
    task = wx.downloadFile({ url: `${origin}${path}`, header: { Authorization: `Bearer ${token}` }, timeout: 30_000,
      success: (response) => {
        if (app.globalData.sessionToken !== token) { reject({ code: "REQUEST_SESSION_CHANGED" }); return; }
        if (response.statusCode >= 200 && response.statusCode < 300) resolve(response.tempFilePath);
        else reject({ status: response.statusCode, code: "SUPPORT_MEDIA_PREVIEW_FAILED" });
      }, fail: reject });
  });
  return { promise, abort() { task?.abort(); } };
}
