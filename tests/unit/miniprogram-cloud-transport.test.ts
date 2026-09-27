import { beforeEach, expect, it, vi } from "vitest";

let state: { globalData: { apiBaseUrl: string; sessionToken: string; cloudFunction: { env: string; name: string } } };
let sdk: { init: ReturnType<typeof vi.fn>; callHTTPFunction: ReturnType<typeof vi.fn> };
let wxMock: { cloud?: typeof sdk; request: ReturnType<typeof vi.fn>; navigateTo: ReturnType<typeof vi.fn>; setStorageSync: ReturnType<typeof vi.fn>; removeStorageSync: ReturnType<typeof vi.fn> };
beforeEach(() => {
  vi.resetModules();
  state = { globalData: { apiBaseUrl: "https://unused.example", sessionToken: "old-session", cloudFunction: { env: "test-env", name: "cismeApi" } } };
  sdk = { init: vi.fn(), callHTTPFunction: vi.fn() };
  wxMock = { cloud: sdk, request: vi.fn(), navigateTo: vi.fn(), setStorageSync: vi.fn(), removeStorageSync: vi.fn() };
  Object.assign(globalThis, { wx: wxMock, getApp: () => state, getCurrentPages: () => [{ route: "pages/records/index" }] });
});

it("preserves authentication and idempotency headers over native cloud calls", async () => {
  const api = await vi.importActual<any>("../../apps/miniprogram/services/api");
  const pending = api.request({ path: "/v1/shares", method: "POST", data: { test: true }, idempotencyKey: "stable-request-001" });
  const options = sdk.callHTTPFunction.mock.calls[0]![0];
  expect(options).toMatchObject({ name: "cismeApi", config: { env: "test-env" }, path: "/v1/shares", method: "POST", data: { test: true }, header: { Authorization: "Bearer old-session", "Idempotency-Key": "stable-request-001" } });
  expect(sdk.init).toHaveBeenCalledWith({ env: "test-env", traceUser: false });
  options.success({ statusCode: 201, data: { created: true } });
  await expect(pending).resolves.toEqual({ created: true });
  expect(wxMock.request).not.toHaveBeenCalled();
});

it("does not erase a renewed session after a delayed cloud 401", async () => {
  const api = await vi.importActual<any>("../../apps/miniprogram/services/api");
  const pending = api.request({ path: "/v1/me" }).catch((error: unknown) => error);
  api.setSessionToken("new-session");
  sdk.callHTTPFunction.mock.calls[0]![0].success({ statusCode: 401, data: { code: "SESSION_EXPIRED" } });
  await pending;
  expect(state.globalData.sessionToken).toBe("new-session");
  expect(wxMock.navigateTo).not.toHaveBeenCalled();
});

it("fails without sending credentials to an HTTPS fallback when the SDK is unavailable", async () => {
  delete wxMock.cloud;
  const api = await vi.importActual<any>("../../apps/miniprogram/services/api");
  await expect(api.request({ path: "/v1/me" })).rejects.toMatchObject({ code: "CLOUD_HTTP_UNAVAILABLE" });
  expect(wxMock.request).not.toHaveBeenCalled();
});

it("omits member credentials from public cloud requests and preserves the current session", async () => {
  const api = await vi.importActual<any>("../../apps/miniprogram/services/api");
  const pending = api.request({ path: "/v1/catalog", authMode: "public" }).catch((error: unknown) => error);
  const options = sdk.callHTTPFunction.mock.calls[0]![0];
  expect(options.header.Authorization).toBe("");
  options.success({ statusCode: 401, data: { code: "AUTH_REQUIRED" } });
  await pending;
  expect(state.globalData.sessionToken).toBe("old-session");
});

it("clears an expired session when the cloud SDK delivers an HTTP-200 error envelope", async () => {
  const api = await vi.importActual<any>("../../apps/miniprogram/services/api");
  const pending = api.request({ path: "/v1/me" });
  const options = sdk.callHTTPFunction.mock.calls[0]![0];
  expect(options.header["X-CISME-Transport"]).toBe("cloud-http-v1");
  const problem = { code: "AUTH_INVALID", status: 401, title: "Invalid session token", trace_id: "trace-1" };
  options.success({ statusCode: 200, data: { cismeHttpError: { version: 1, statusCode: 401, data: problem } } });
  await expect(pending).rejects.toEqual(problem);
  expect(state.globalData.sessionToken).toBe("");
  expect(wxMock.navigateTo).toHaveBeenCalledWith(expect.objectContaining({ url: "/pages/account/index?intent=login" }));
});

it("preserves a renewed session when an earlier request returns an enveloped 401", async () => {
  const api = await vi.importActual<any>("../../apps/miniprogram/services/api");
  const pending = api.request({ path: "/v1/me" }).catch((error: unknown) => error);
  api.setSessionToken("new-session");
  sdk.callHTTPFunction.mock.calls[0]![0].success({ statusCode: 200, data: { cismeHttpError: { version: 1, statusCode: 401, data: { code: "AUTH_INVALID" } } } });
  await pending;
  expect(state.globalData.sessionToken).toBe("new-session");
  expect(wxMock.navigateTo).not.toHaveBeenCalled();
});

it("retains business validation details from an enveloped 422", async () => {
  const api = await vi.importActual<any>("../../apps/miniprogram/services/api");
  const pending = api.request({ path: "/v1/identity/wechat", method: "POST", authMode: "public" });
  const problem = { code: "CONSENT_REQUIRED", status: 422, title: "Privacy and terms acceptance are required" };
  sdk.callHTTPFunction.mock.calls[0]![0].success({ statusCode: 200, data: { cismeHttpError: { version: 1, statusCode: 422, data: problem } } });
  await expect(pending).rejects.toEqual(problem);
  expect(state.globalData.sessionToken).toBe("old-session");
});

it("ends a stalled cloud request within the interaction recovery budget and ignores a late callback", async () => {
  vi.useFakeTimers();
  try {
    const api = await vi.importActual<any>("../../apps/miniprogram/services/api");
    const pending = api.request({ path: "/v1/me" }).catch((error: unknown) => error);
    const options = sdk.callHTTPFunction.mock.calls[0]![0];

    expect(options.timeout).toBe(12_000);
    await vi.advanceTimersByTimeAsync(12_000);
    await expect(pending).resolves.toMatchObject({ code: "NETWORK_TIMEOUT" });

    options.success({ statusCode: 200, data: { id: "too-late" } });
    expect(state.globalData.sessionToken).toBe("old-session");
  } finally {
    vi.useRealTimers();
  }
});
