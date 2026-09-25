import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
const mocks = vi.hoisted(() => ({ request: vi.fn(), login: vi.fn(), runtime: { globalData: { sessionToken: "" } } }));
vi.mock("../../apps/miniprogram/services/api", () => ({ request: mocks.request, cancelAuthentication: vi.fn(), consumeAuthReturnUrl: vi.fn(), navigateAfterAuthentication: vi.fn(), setPrivacyRightsToken: vi.fn(), setSessionToken: vi.fn(), suppressAuthenticationRedirectOnce: vi.fn() }));
vi.mock("../../apps/miniprogram/release-config", () => ({ legalDocumentVersions: () => null, shouldUseDevelopmentIdentity: () => false }));
vi.mock("../../apps/miniprogram/services/member-identity", () => ({ publishMemberIdentity: vi.fn() }));
vi.mock("../../apps/miniprogram/services/member-avatar", () => ({ defaultMemberAvatar: "local-avatar", localMemberAvatar: vi.fn(), prepareAvatarUpload: vi.fn() }));
vi.mock("../../apps/miniprogram/services/layout", () => ({ currentChromeStyle: () => "", motionDuration: () => 0 }));
vi.mock("../../apps/miniprogram/services/share", () => ({ attributePendingShare: vi.fn() }));
let definition: any;
const legal = () => ({ ready: true, documents: [{ document_type: "privacy", version: "v1" }, { document_type: "terms", version: "v1" }] });
async function mount() {
  await import("../../apps/miniprogram/pages/account/index");
  return { ...definition, data: { ...definition.data, legalLoading: false, legalTextsReady: true, agreementAccepted: true, serverLegalDocuments: { privacy: "v1", terms: "v1", localFixture: false } },
    setData(patch: object, callback?: () => void) { Object.assign(this.data, patch); callback?.(); } };
}
beforeEach(() => {
  vi.resetModules(); definition = undefined; mocks.request.mockReset(); mocks.login.mockReset();
  vi.stubGlobal("getApp", () => mocks.runtime); vi.stubGlobal("getCurrentPages", () => []);
  vi.stubGlobal("Page", (value: unknown) => { definition = value; });
  vi.stubGlobal("wx", { getAccountInfoSync: () => ({ miniProgram: { envVersion: "trial" } }), getDeviceInfo: () => ({ platform: "ios" }), login: mocks.login, pageScrollTo: vi.fn() });
});
afterEach(() => vi.unstubAllGlobals());
describe("account consumes validated legal bootstrap without weakening consent", () => {
  it.each(["<html>gateway</html>", { ...legal(), ready: "false" }, { ready: true, documents: [...legal().documents, { document_type: "terms", version: "v2" }] }])(
    "blocks a malformed successful response %# before wx.login", async input => {
      const page = await mount(); mocks.request.mockResolvedValue(input);
      await page.syncLegalDocuments(); await page.login();
      expect(page.data).toMatchObject({ legalTextsReady: false, agreementAccepted: false, serverLegalDocuments: null, legalLoadError: "invalid", legalFailureCode: "LEGAL_RESPONSE_INVALID" });
      expect(mocks.login).not.toHaveBeenCalled();
      expect(mocks.request.mock.calls.every(([input]) => input.path === "/v1/legal")).toBe(true);
    });
  it("retains an HTTP status but no raw server or native text", async () => {
    const page = await mount(); mocks.request.mockRejectedValue({ status: 503, title: "fixture-sensitive-value", errMsg: "fixture-sensitive-value" });
    await page.syncLegalDocuments();
    expect(page.data.legalFailureCode).toBe("HTTP_503"); expect(page.data.legalLoadError).toBe("unreachable");
    expect(JSON.stringify(page.data)).not.toContain("fixture-sensitive-value");
  });
  it("recovers from invalid data without restoring prior consent automatically", async () => {
    const page = await mount(); mocks.request.mockResolvedValueOnce(null).mockResolvedValueOnce(legal());
    await page.syncLegalDocuments(); await page.syncLegalDocuments();
    expect(page.data).toMatchObject({ legalTextsReady: true, agreementAccepted: false, legalLoadError: "", legalFailureCode: "" });
  });
  it("keeps failure text readable while the consent checkbox stays disabled", () => {
    const markup = readFileSync("apps/miniprogram/pages/account/index.wxml", "utf8");
    expect(markup).toContain("account-row account-agreement {{loading || leaving ?");
    expect(markup).toContain('disabled="{{loading || leaving || !legalTextsReady}}"');
    expect(markup).toContain("account-legal-status--error");
    expect(markup).not.toContain('class="account-row__icon">1</view>');
    expect(markup).toContain("手机号可稍后绑定，不影响登录。");
  });
});
