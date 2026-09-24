import { commerceContextRevision, invalidateCommerceRecoveryContext, redactCommerceCommandPayloads } from "./commerce-command-store";
import { measurementClock, metricAction, recordClientMetric } from "./performance-metrics";
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
const privateDownloads = new Set<() => void>();
let authRedirecting = false;
let suppressedAuthRedirectPath = "";

function normalizedAuthPath(url: string): string {
  return url.split("?")[0] ?? url;
}

export function setSessionToken(token: string): void {
  for (const release of privateDownloads) release();
  invalidateCommerceRecoveryContext();
  if(!token){clearAllUgcBackups();try{redactCommerceCommandPayloads();}catch{/* Keep malformed recovery records fail-closed; never retain the auth session. */}}
  clearMemberAvatarCache();
  clearMemberIdentity();
  reads.invalidate();
  app.globalData.sessionToken = token;
  app.globalData.privacyRightsToken = "";
  wx.setStorageSync(app.globalData.sessionStorageKey || "cisme.sessionToken", token);
  wx.removeStorageSync(`${app.globalData.sessionStorageKey || "cisme.sessionToken"}.privacyRightsToken`);
  if (token) {
    authRedirecting = false;
    suppressedAuthRedirectPath = "";
  }
}

export function setPrivacyRightsToken(token:string):void {
  setSessionToken("");
  app.globalData.privacyRightsToken=token;
  const key=`${app.globalData.sessionStorageKey || "cisme.sessionToken"}.privacyRightsToken`;
  if(token)wx.setStorageSync(key,token);else wx.removeStorageSync(key);
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

function requestEnvironment(): string {
  const data = app.globalData;
  return JSON.stringify([data.apiBaseUrl, data.cloudFunction?.env ?? null, data.cloudFunction?.name ?? null]);
}

const snapshotOwners = new WeakMap<object, string>();
export function retainMemberSnapshot(page: object): boolean {
  const token = app.globalData.sessionToken;
  const owner = JSON.stringify([token, commerceContextRevision(), requestEnvironment()]);
  const retain = Boolean(token && snapshotOwners.get(page) === owner);
  snapshotOwners.set(page, owner);
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

/** Fresh WeChat re-identification after closure reaches historical orders and
 * aftersales only. The server independently enforces the narrow route scope. */
export function historicalCommerceToken():string {
  return app.globalData.sessionToken||app.globalData.privacyRightsToken||"";
}
export function historicalCommerceClosed():boolean {
  return Boolean(!app.globalData.sessionToken&&app.globalData.privacyRightsToken);
}
export function requireHistoricalCommerceAccess(returnUrl=currentRouteUrl()):boolean {
  if(historicalCommerceToken())return true;
  beginAuthentication(returnUrl);return false;
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

export type RequestOptions = { path: string; method?: "GET" | "POST" | "PUT" | "DELETE"; data?: WechatMiniprogram.IAnyObject; idempotencyKey?: string; authMode?: "required" | "optional" | "public"; cacheTags?: string[]; budgetMs?: number; registerAbort?: (abort: () => void) => void };

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
function readPolicy(_path: string, tags: string[]) {
  // Pages do not yet subscribe to background refreshes or label stale results.
  // Keep session/tag isolation and concurrent coalescing, but do not silently
  // serve completed permission, price, inventory, care or legal snapshots.
  // Avatar/file caches remain separate and unchanged.
  return { ttlMs: 0, staleMs: 0, tags };
}
export function request<T>(options: RequestOptions): Promise<T> { return requestCancelable<T>(options).promise; }
function requestId(): string { return `wx-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`; }
const approvedRetryReads = new Set([
  "/v1/bootstrap/home", "/v1/bootstrap/profile", "/v1/bootstrap/settings",
  "/v1/me", "/v1/capabilities", "/v1/identity/capabilities", "/v1/legal", "/v1/catalog",
  "/v1/me/support/summary", "/v1/me/authority"
]);
function retryDelayMs(error: unknown, options: RequestOptions): number | null {
  if ((options.method ?? "GET") !== "GET" || !approvedRetryReads.has(options.path.split("?")[0]!)) return null;
  const problem = error as { status?: number; code?: string; retryAfterSeconds?: number } | null;
  if (problem?.status === 429) {
    const seconds = problem.retryAfterSeconds;
    return problem.code === "RATE_LIMITED" && Number.isInteger(seconds) && seconds! > 0 && seconds! <= 2 ? seconds! * 1000 : null;
  }
  return problem?.status === 502 || problem?.status === 503 || problem?.code === "NETWORK_ERROR" || problem?.code === "NETWORK_TIMEOUT"
    ? 40 + Math.floor(Math.random() * 81) : null;
}
const cancelledProblem = () => ({ code: "REQUEST_ABORTED", title: "请求已取消；已发送写入不会因此撤回，请查询结果" });
const deadlineProblem = () => ({ code: "NETWORK_TIMEOUT", title: "暂未确认操作结果，请先查看记录，勿重复提交。" });

function performRequest<T>(options: RequestOptions): { promise: Promise<T>; abort(): void } {
  const method = options.method ?? "GET", authMode = options.authMode ?? "required";
  const session = app.globalData.sessionToken, revision = commerceContextRevision(), environment = requestEnvironment();
  const path=options.path.split("?")[0]||options.path;
  const rightsPath=/^\/v1\/me\/privacy-requests(?:\/|$)/.test(path)||
    (method==="GET"&&(
      path==="/v1/me/orders"||/^\/v1\/me\/orders\/[0-9a-f-]{36}$/i.test(path)||
      /^\/v1\/me\/orders\/[0-9a-f-]{36}\/(?:aftersales\/availability|shipment(?:\/tracking)?)$/i.test(path)||
      path==="/v1/me/aftersales"||/^\/v1\/me\/aftersales\/[0-9a-f-]{36}$/i.test(path)||
      path==="/v1/me/refund-requests"||path==="/v1/me/commercial-membership"||path==="/v1/me/support/messages"||
      /^\/v1\/me\/support\/media\/[0-9a-f-]{36}$/i.test(path)||
      path==="/v1/me/commission/settlement-requests"||path==="/v1/me/commission/credit-conversions"))||
    (method==="POST"&&(/^\/v1\/me\/orders\/[0-9a-f-]{36}\/aftersales$/i.test(path)||
      /^\/v1\/me\/aftersales\/[0-9a-f-]{36}\/actions$/i.test(path)||path==="/v1/me/support/messages"));
  const rightsSession=app.globalData.privacyRightsToken;
  const token = authMode === "public" ? "" : session || (rightsPath ? rightsSession : "");
  const origin = currentRouteUrl();
  const budgetMs = options.budgetMs ?? 12_000;
  if (!Number.isInteger(budgetMs) || budgetMs < 1 || budgetMs > 60_000)
    return { promise: Promise.reject({ code: "INVALID_REQUEST_BUDGET", title: "请求等待预算无效" }), abort() {} };
  const deadline = measurementClock() + budgetMs;
  let stopped: unknown = null, transport: TransportHandle | null = null, interrupt: ((reason: unknown) => void) | null = null;
  const stop = (reason: unknown) => { if (stopped) return; stopped = reason; interrupt?.(reason); transport?.abort(); };
  const timer = setTimeout(() => stop(deadlineProblem()), budgetMs);
  const remaining = () => {
    if (stopped) throw stopped;
    if (commerceContextRevision() !== revision || app.globalData.sessionToken !== session)
      throw { code: "REQUEST_SESSION_CHANGED", title: "会员身份已变化，请重新加载" };
    if (requestEnvironment() !== environment)
      throw { code: "REQUEST_ENVIRONMENT_CHANGED", title: "连接已变化，请刷新后核对操作结果" };
    if (token === rightsSession && rightsSession && app.globalData.privacyRightsToken !== rightsSession)
      throw { code: "REQUEST_SESSION_CHANGED", title: "隐私请求身份已变化，请重新加载" };
    const left = Math.ceil(deadline - measurementClock());
    if (left <= 0) throw deadlineProblem();
    return left;
  };
  const once = (): Promise<T> => new Promise((resolve, reject) => {
    let settled = false;
    const fail = (error: unknown) => { if (settled) return; settled = true; if (interrupt === fail) interrupt = null; reject(error); };
    interrupt = fail;
    try {
      const timeoutMs = remaining();
      if (authMode === "required" && !token) { beginAuthentication(origin); fail({ status: 401, code: "AUTHENTICATION_REQUIRED", title: "请先完成身份确认" }); return; }
      transport = sendJsonRequest({ path: options.path, origin: app.globalData.apiBaseUrl, cloud: app.globalData.cloudFunction ?? null,
        method, ...(options.data ? { data: options.data } : method !== "GET" ? { data: {} } : {}), timeoutMs,
        header: { Authorization: token ? `Bearer ${token}` : "", "Idempotency-Key": options.idempotencyKey ?? "", "Content-Type": "application/json", "X-Request-Id": requestId() },
        success: response => {
          if (settled) return;
          try { remaining(); } catch (error) { fail(error); return; }
          if (response.statusCode >= 200 && response.statusCode < 300) { settled = true; if (interrupt === fail) interrupt = null; resolve(response.data as T); return; }
          const problem = response.data as Record<string, unknown>;
          // AUTH_REVOKED identifies this session. MEMBER_NOT_ACTIVE can refer
          // to an admin's target member and must not sign the admin out.
          const accountUnavailable=problem?.code === "AUTH_REVOKED";
          if ((response.statusCode === 401 || problem?.code === "MEMBER_NOT_FOUND") && token && app.globalData.sessionToken === token) {
            setSessionToken("");
            if (!accountUnavailable && authMode === "required" && currentRouteUrl() === origin) beginAuthentication(origin);
          }else if(response.statusCode===401&&token&&app.globalData.privacyRightsToken===token){
            setPrivacyRightsToken("");
          }
          fail({ ...problem, status: response.statusCode });
        }, fail });
    } catch (error) { fail(error); }
  });
  const delay = (milliseconds: number) => new Promise<void>((resolve, reject) => {
    const started = measurementClock();
    let timeout: ReturnType<typeof setTimeout>;
    const cancelled = (reason: unknown) => { clearTimeout(timeout); if (interrupt === cancelled) interrupt = null; reject(reason); };
    interrupt = cancelled;
    timeout = setTimeout(() => {
      if (interrupt === cancelled) interrupt = null;
      try { remaining(); recordClientMetric({ action: metricAction(options.path), stage: "retry_wait", durationMs: measurementClock() - started }); resolve(); } catch (error) { reject(error); }
    }, milliseconds);
  });
  const promise = (async () => {
    try { return await once(); }
    catch (error) {
      const milliseconds = retryDelayMs(error, options);
      if (milliseconds === null || stopped) throw error;
      if (remaining() <= milliseconds) throw error;
      await delay(milliseconds);
      return once(); // At most one approved safe-GET retry, inside the same budget.
    }
  })().finally(() => { clearTimeout(timer); interrupt = null; });
  return { promise, abort: () => stop(cancelledProblem()) };
}

export function requestCancelable<T>(options: RequestOptions): { promise: Promise<T>; abort(): void } {
  const method = options.method ?? "GET", tags = options.cacheTags ?? tagsForPath(options.path);
  const session = app.globalData.sessionToken, rightsSession = app.globalData.privacyRightsToken, origin = currentRouteUrl();
  const revision = commerceContextRevision(), environment = requestEnvironment();
  let task: { promise: Promise<T>; abort(reason?: unknown): void };
  if (method === "GET") {
    const key = JSON.stringify([environment, revision, session, rightsSession, options.path, options.data, options.authMode ?? "required", options.budgetMs ?? 12_000, options.idempotencyKey]);
    const subscription = reads.acquire(key, () => performRequest<T>(options), readPolicy(options.path, tags));
    task = subscription;
    if (subscription.coalesced) recordClientMetric({ action: metricAction(options.path), stage: "coalesced", durationMs: 0 });
  } else {
    reads.invalidate(tags);
    const write = performRequest<T>(options);
    task = { promise: write.promise.finally(() => reads.invalidate(tags)), abort: write.abort };
  }
  // Context belongs to each consumer. A departed first reader cannot suppress
  // another page's shared retry. Lifecycle owners can cancel immediately.
  const monitor = method === "GET" ? setInterval(() => {
    if (commerceContextRevision() !== revision || requestEnvironment() !== environment ||
      app.globalData.sessionToken !== session || app.globalData.privacyRightsToken !== rightsSession || currentRouteUrl() !== origin)
      task.abort({ code: "REQUEST_CONTEXT_CHANGED", title: "页面或会员身份已变化，已取消本页读取" });
  }, 100) : null;
  const promise = task.promise.finally(() => { if (monitor) clearInterval(monitor); });
  const abort = () => { recordClientMetric({ action: metricAction(options.path), stage: "cancel", durationMs: 0 }); task.abort(); };
  options.registerAbort?.(abort);
  return { promise, abort };
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

/** Temporary private files live only until their caller releases them or identity changes. */
export function downloadPrivateMedia(path: string,allowClosedRights=false): { promise: Promise<string>; abort(): void } {
  const currentToken=()=>app.globalData.sessionToken||(allowClosedRights?app.globalData.privacyRightsToken:'');
  const token = currentToken(), revision = commerceContextRevision();
  const origin = app.globalData.apiBaseUrl.replace(/\/$/, "");
  let task: WechatMiniprogram.DownloadTask | null = null, cancelled = false, file = "";
  let rejectPending: (reason: unknown) => void = () => {};
  const remove = (filePath: string) => { if (filePath) { try { wx.getFileSystemManager().unlink({filePath, fail: () => {}}); } catch { /* Temporary file may already be removed by WeChat. */ } } };
  const abort = () => { cancelled = true; privateDownloads.delete(abort); rejectPending({code:"REQUEST_ABORTED"}); task?.abort(); remove(file); file=""; };
  const promise = new Promise<string>((resolve, reject) => {
    rejectPending = reject;
    if (!token) { reject({ code: "AUTHENTICATION_REQUIRED" }); return; }
    if (app.globalData.cloudFunction) { reject({ code: "SUPPORT_MEDIA_PREVIEW_TRANSPORT_UNAVAILABLE" }); return; }
    privateDownloads.add(abort);
    task = wx.downloadFile({ url: `${origin}${path}`, header: { Authorization: `Bearer ${token}` }, timeout: 30_000,
      success: (response) => {
        if (cancelled || currentToken() !== token || commerceContextRevision() !== revision) {
          remove(response.tempFilePath); privateDownloads.delete(abort);
          reject({code:cancelled?"REQUEST_ABORTED":"REQUEST_SESSION_CHANGED"}); return;
        }
        if (response.statusCode >= 200 && response.statusCode < 300) { file=response.tempFilePath; resolve(file); }
        else { remove(response.tempFilePath); privateDownloads.delete(abort); reject({ status: response.statusCode, code: "SUPPORT_MEDIA_PREVIEW_FAILED" }); }
      }, fail: error => { privateDownloads.delete(abort); reject(error); } });
  });
  return { promise, abort };
}
