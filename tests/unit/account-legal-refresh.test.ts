import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  request: vi.fn(),
  login: vi.fn(),
  navigate: vi.fn(),
  runtime: { globalData: { sessionToken: "" } }
}));

vi.mock("../../apps/miniprogram/services/api", () => ({
  request: mocks.request,
  cancelAuthentication: vi.fn(),
  consumeAuthReturnUrl: () => "/pages/home/index",
  navigateAfterAuthentication: mocks.navigate,
  setPrivacyRightsToken: vi.fn(),
  setSessionToken: (token: string) => { mocks.runtime.globalData.sessionToken = token; },
  suppressAuthenticationRedirectOnce: vi.fn()
}));
vi.mock("../../apps/miniprogram/release-config", () => ({
  legalDocumentVersions: () => null,
  shouldUseDevelopmentIdentity: () => false
}));
vi.mock("../../apps/miniprogram/services/member-identity", () => ({ publishMemberIdentity: vi.fn() }));
vi.mock("../../apps/miniprogram/services/member-avatar", () => ({
  defaultMemberAvatar: "local-avatar",
  localMemberAvatar: async () => "local-avatar",
  prepareAvatarUpload: vi.fn()
}));
vi.mock("../../apps/miniprogram/services/layout", () => ({ currentChromeStyle: () => "", motionDuration: () => 0 }));
vi.mock("../../apps/miniprogram/services/share", () => ({ attributePendingShare: vi.fn() }));

type PageDefinition = Record<string, any> & { data: Record<string, any> };
let captured: PageDefinition | undefined;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function legalResponse(version = "v1") {
  return { ready: true, documents: [
    { document_type: "privacy", version }, { document_type: "terms", version }
  ] };
}
async function mount(overrides: Record<string, any> = {}) {
  await import("../../apps/miniprogram/pages/account/index");
  if (!captured) throw new Error("Account page was not registered");
  return {
    ...captured,
    data: { ...captured.data, legalLoading: false, legalTextsReady: true, agreementAccepted: true,
      serverLegalDocuments: { privacy: "v1", terms: "v1", localFixture: false }, ...overrides },
    setData(patch: Record<string, any>, callback?: () => void) {
      Object.assign(this.data, patch);
      callback?.();
    }
  } as PageDefinition;
}
function identityRequests() { return mocks.request.mock.calls.filter(([input]) => input.path === "/v1/identity/wechat"); }

beforeEach(() => {
  vi.resetModules();
  captured = undefined;
  mocks.runtime.globalData.sessionToken = "";
  mocks.request.mockReset();
  mocks.login.mockReset().mockResolvedValue({ code: "isolated-code" });
  mocks.navigate.mockReset().mockResolvedValue("target");
  vi.stubGlobal("getApp", () => mocks.runtime);
  vi.stubGlobal("getCurrentPages", () => []);
  vi.stubGlobal("Page", (definition: PageDefinition) => { captured = definition; });
  vi.stubGlobal("wx", {
    getAccountInfoSync: () => ({ miniProgram: { envVersion: "trial" } }),
    getDeviceInfo: () => ({ platform: "ios" }),
    login: mocks.login,
    pageScrollTo: vi.fn(), enableAlertBeforeUnload: vi.fn(), disableAlertBeforeUnload: vi.fn(),
    getStorageSync: () => "", setStorageSync: vi.fn(), removeStorageSync: vi.fn(), showToast: vi.fn()
  });
});
afterEach(() => vi.unstubAllGlobals());

describe("account consent freshness during legal refresh", () => {
  it("removes cached readiness and blocks a fresh login during the read", async () => {
    const page = await mount(), pending = deferred<ReturnType<typeof legalResponse>>();
    mocks.request.mockReturnValueOnce(pending.promise);
    const reading = page.syncLegalDocuments();
    expect(page.data.legalTextsReady).toBe(false);
    expect(page.data.legalLoading).toBe(true);
    await page.login();
    expect(mocks.login).not.toHaveBeenCalled();
    expect(identityRequests()).toHaveLength(0);
    pending.resolve(legalResponse()); await reading;
  });
  it("preserves explicit consent when the versions did not change", async () => {
    const page = await mount(); mocks.request.mockResolvedValueOnce(legalResponse());
    await page.syncLegalDocuments();
    expect(page.data.agreementAccepted).toBe(true);
    expect(page.data.legalTextsReady).toBe(true);
  });
  it("requires consent again when the versions changed", async () => {
    const page = await mount(); mocks.request.mockResolvedValueOnce(legalResponse("v2"));
    await page.syncLegalDocuments(); await page.login();
    expect(page.data.agreementAccepted).toBe(false);
    expect(mocks.login).not.toHaveBeenCalled();
  });
  it("clears stale documents on a network failure without calling them unpublished", async () => {
    const page = await mount(); mocks.request.mockRejectedValueOnce(new Error("isolated-network-failure"));
    await page.syncLegalDocuments();
    expect(page.data.serverLegalDocuments).toBeNull();
    expect(page.data.legalLoadError).toBe("unreachable");
    expect(page.data.agreementAccepted).toBe(false);
    expect(page.data.legalTextsReady).toBe(false);
  });
  it("ignores a late older legal response", async () => {
    const page = await mount(), first = deferred<ReturnType<typeof legalResponse>>(), second = deferred<ReturnType<typeof legalResponse>>();
    mocks.request.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const a = page.syncLegalDocuments(), b = page.syncLegalDocuments();
    second.resolve(legalResponse("v2")); await b;
    first.resolve(legalResponse()); await a;
    expect(page.data.serverLegalDocuments.privacy).toBe("v2");
    expect(page.data.agreementAccepted).toBe(false);
  });
  it("does not submit captured consent if a refresh crossed wx.login", async () => {
    const page = await mount(), identity = deferred<{ code: string }>();
    mocks.login.mockReturnValueOnce(identity.promise);
    const signing = page.login();
    mocks.request.mockResolvedValueOnce(legalResponse("v2"));
    await page.syncLegalDocuments();
    identity.resolve({ code: "late-isolated-code" }); await signing;
    expect(identityRequests()).toHaveLength(0);
    expect(page.data.loading).toBe(false);
    expect(page.data.error).toBe("协议状态已更新，请确认后重新登录。");
  });
  it("does not start fresh authentication from a phone callback during refresh", async () => {
    const page = await mount(), pending = deferred<ReturnType<typeof legalResponse>>();
    mocks.request.mockReturnValueOnce(pending.promise); const reading = page.syncLegalDocuments();
    await page.loginWithPhone({ detail: { code: "isolated-phone-code" } });
    expect(mocks.login).not.toHaveBeenCalled();
    pending.resolve(legalResponse()); await reading;
  });
  it("allows an already authenticated member to continue during refresh", async () => {
    const page = await mount({ pendingDestination: "/pages/profile/index" });
    mocks.runtime.globalData.sessionToken = "isolated-existing-session";
    const pending = deferred<ReturnType<typeof legalResponse>>();
    mocks.request.mockImplementation(async ({ path }) => path === "/v1/legal" ? pending.promise : { id: "member-1", avatar_data_url: "avatar" });
    const reading = page.syncLegalDocuments(); await page.login();
    expect(mocks.login).not.toHaveBeenCalled();
    expect(mocks.navigate).toHaveBeenCalledWith("/pages/profile/index");
    pending.resolve(legalResponse()); await reading;
  });
  it("ignores a legal response after page unload", async () => {
    const page = await mount(), pending = deferred<ReturnType<typeof legalResponse>>();
    mocks.request.mockReturnValueOnce(pending.promise); const reading = page.syncLegalDocuments();
    page.onUnload(); const before = { ...page.data };
    pending.resolve(legalResponse("v2")); await reading;
    expect(page.data).toEqual(before);
  });
  it("allows one new login after a successful unchanged refresh", async () => {
    const page = await mount();
    mocks.request.mockImplementation(async ({ path }) => path === "/v1/legal" ? legalResponse() :
      path === "/v1/identity/wechat" ? { sessionToken: "isolated-session" } : { id: "member-1", avatar_data_url: "avatar" });
    await page.syncLegalDocuments(); await page.login();
    expect(mocks.login).toHaveBeenCalledTimes(1);
    expect(identityRequests()).toHaveLength(1);
    expect(identityRequests()[0]![0].data.consents[0].version).toBe("v1");
  });
  it("preserves unrelated errors and clears a stale legal error on retry", async () => {
    const page = await mount({ error: "头像未保存" });
    mocks.request.mockResolvedValue(legalResponse());
    await page.syncLegalDocuments(); expect(page.data.error).toBe("头像未保存");
    page.data.error = "协议服务暂时无法连接，请稍后重试。";
    await page.syncLegalDocuments(); expect(page.data.error).toBe("");
  });
});
