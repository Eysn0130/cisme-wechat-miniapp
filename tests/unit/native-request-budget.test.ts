import { beforeEach, afterEach, expect, it, vi } from "vitest";
let state: any, requests: any[], abort: ReturnType<typeof vi.fn<() => void>>;
beforeEach(() => {
  vi.resetModules(); vi.useFakeTimers(); vi.spyOn(Math, "random").mockReturnValue(0);
  state = { globalData: { sessionToken: "account-a", apiBaseUrl: "https://synthetic.invalid" } };
  requests = []; abort = vi.fn();
  Object.assign(globalThis, { getApp: () => state, getCurrentPages: () => [{ route: "pages/home/index" }], wx: {
    request: vi.fn((options: any) => { requests.push(options); return { abort: () => { abort(); options.fail({ errMsg: "request:fail abort" }); } }; }),
    setStorageSync: vi.fn(), navigateTo: vi.fn()
  } });
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
it("caps both attempts and retry delay at one interaction deadline", async () => {
  const { request } = await import("../../apps/miniprogram/services/api");
  const result = request({ path: "/v1/bootstrap/home", budgetMs: 500 }).catch(e => e);
  await vi.advanceTimersByTimeAsync(400); requests[0].fail({ errMsg: "request:fail timeout" });
  await vi.advanceTimersByTimeAsync(40);
  expect(requests).toHaveLength(2); expect(requests[1].timeout).toBe(60);
  await vi.advanceTimersByTimeAsync(60);
  expect(await result).toMatchObject({ code: "NETWORK_TIMEOUT" }); expect(abort).toHaveBeenCalledTimes(1);
  requests[1].success({ statusCode: 200, data: { stale: true } });
  expect(requests).toHaveLength(2);
});
it("canceling one consumer keeps a shared read alive; canceling all aborts exactly once", async () => {
  const { requestCancelable } = await import("../../apps/miniprogram/services/api");
  const a = requestCancelable({ path: "/v1/me" }), b = requestCancelable({ path: "/v1/me" });
  const failed = a.promise.catch(e => e); a.abort();
  expect(await failed).toMatchObject({ code: "REQUEST_ABORTED" }); expect(requests).toHaveLength(1); expect(abort).not.toHaveBeenCalled();
  requests[0].success({ statusCode: 200, data: { id: "a" } }); expect(await b.promise).toEqual({ id: "a" });
  const c = requestCancelable({ path: "/v1/me" }), d = requestCancelable({ path: "/v1/me" });
  const cancelled = Promise.all([c.promise.catch(e => e), d.promise.catch(e => e)]);
  c.abort(); d.abort(); d.abort(); expect(abort).toHaveBeenCalledTimes(1); await cancelled;
  const e = requestCancelable({ path: "/v1/me" }); expect(requests).toHaveLength(3);
  requests[1].success({ statusCode: 401, data: { code: "AUTH_INVALID" } }); expect(state.globalData.sessionToken).toBe("account-a");
  requests[2].success({ statusCode: 200, data: { id: "fresh" } }); expect(await e.promise).toEqual({ id: "fresh" });
});
it("a departed first page does not cancel another page's shared retry", async () => {
  const { request } = await import("../../apps/miniprogram/services/api");
  const a = request({ path: "/v1/me" }).catch(e => e);
  Object.assign(globalThis, { getCurrentPages: () => [{ route: "pages/profile/index" }] });
  const b = request({ path: "/v1/me" });
  requests[0].success({ statusCode: 429, data: { code: "RATE_LIMITED", retryAfterSeconds: 1 } });
  await vi.advanceTimersByTimeAsync(100); expect(await a).toMatchObject({ code: "REQUEST_CONTEXT_CHANGED" });
  expect(abort).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(900); expect(requests).toHaveLength(2);
  requests[1].success({ statusCode: 200, data: { current: true } }); expect(await b).toEqual({ current: true });
});
it("does not serve completed sensitive cache entries or retry unapproved reads and writes", async () => {
  const { request } = await import("../../apps/miniprogram/services/api");
  const a = request({ path: "/v1/capabilities" }); requests[0].success({ statusCode: 200, data: { allowed: true } }); await a;
  const b = request({ path: "/v1/capabilities" }); expect(requests).toHaveLength(2); requests[1].success({ statusCode: 200, data: { allowed: false } }); expect(await b).toEqual({ allowed: false });
  for (const options of [{ path: "/v1/unreviewed-read" }, { path: "/v1/me/orders", method: "POST" as const, idempotencyKey: "stable-intent" }]) {
    const result = request(options).catch(e => e); requests.at(-1).fail({ errMsg: "request:fail timeout" });
    expect(await result).toMatchObject({ code: "NETWORK_TIMEOUT" });
    const count = requests.length; await vi.advanceTimersByTimeAsync(1000); expect(requests).toHaveLength(count);
  }
});
it("Cloud cancellation is logical and late success cannot mutate identity", async () => {
  state.globalData.cloudFunction = { env: "synthetic", name: "api" };
  const calls: any[] = []; (globalThis as any).wx.cloud = { init() {}, callHTTPFunction: (o: any) => calls.push(o) };
  const { requestCancelable } = await import("../../apps/miniprogram/services/api");
  const task = requestCancelable({ path: "/v1/me" }); const result = task.promise.catch(e => e); task.abort();
  expect(await result).toMatchObject({ code: "REQUEST_ABORTED" });
  calls[0].success({ statusCode: 401, data: { code: "AUTH_INVALID" } }); expect(state.globalData.sessionToken).toBe("account-a"); expect(abort).not.toHaveBeenCalled();
});
it("projects only supported numeric network phases, never peer IPs, headers or URLs", async () => {
  const metrics = await import("../../apps/miniprogram/services/performance-metrics"); metrics.configureLocalMeasurements(1);
  const phases = metrics.projectNetworkPhases({ domainLookUpStart: 10, domainLookUpEnd: 20, connectStart: 20, connectEnd: 80, SSLconnectionStart: 40, SSLconnectionEnd: 80, responseStart: 90, responseEnd: 110, peerIP: "private", url: "secret" });
  expect(phases).toMatchObject({ dnsMs: 10, connectIncludingTlsMs: 60, tlsMs: 40, queueMs: null, receiveMs: 20 });
  metrics.recordClientMetric({ action: "home", stage: "transport", durationMs: 100, phases, token: "secret" } as any);
  const output = JSON.stringify(metrics.localMeasurements()); expect(output).not.toContain("secret"); expect(output).not.toContain("peerIP");
  for (let i = 0; i < 300; i++) metrics.recordClientMetric({ action: "home", stage: "set_data", durationMs: i });
  expect(metrics.localMeasurements().samples).toHaveLength(128);
});
