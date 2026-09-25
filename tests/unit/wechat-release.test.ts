import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { isPublicHttpsOrigin, isRealWeChatAppId, validateInternalTestPackageSafety, validateWeChatCiPreview, validateWeChatRelease } from "../../scripts/wechat-release-lib";
import {
  isPrivateLanHttpOrigin,
  isTemporaryRemoteDebugHttpsOrigin,
  remoteDebugApiOrigin,
  miniProgramApiOrigins,
  legalDocumentVersions,
  shouldUseDevelopmentIdentity
} from "../../apps/miniprogram/release-config";

const completeGates = {
  privacyGuideConfigured: true,
  legalTextsApproved: true,
  serverDomainsConfigured: true,
  demoScopeApproved: true,
  experienceMembersConfigured: true,
  miniProgramFilingCompleted: true
};
const exec = promisify(execFile);

describe("WeChat release preflight", () => {
  it("keeps preview and trial on staging while release targets the registered production API", () => {
    expect(miniProgramApiOrigins.preview).toBe("https://staging-api.cisme.cn");
    expect(miniProgramApiOrigins.trial).toBe("https://staging-api.cisme.cn");
    expect(miniProgramApiOrigins.release).toBe("https://api.cisme.cn");
    expect(miniProgramApiOrigins.devtools).toMatch(/^http:\/\/127\.0\.0\.1:/);
  });

  it("never uses a development identity or local consent fixture against a cloud function", () => {
    for (const platform of ["devtools", "ios", "android"]) {
      expect(shouldUseDevelopmentIdentity("develop", platform, true, true)).toBe(false);
      expect(legalDocumentVersions("develop", platform, true, true)).toBeNull();
    }
    expect(legalDocumentVersions("develop", "devtools")?.localFixture).toBe(true);
  });
  it("uses the development identity only in the simulator or an explicit develop-mode device session", () => {
    expect(shouldUseDevelopmentIdentity("develop", "devtools")).toBe(true);
    expect(shouldUseDevelopmentIdentity("develop", "ios")).toBe(false);
    expect(shouldUseDevelopmentIdentity("develop", "android")).toBe(false);
    expect(shouldUseDevelopmentIdentity("develop", "ios", true)).toBe(true);
    expect(shouldUseDevelopmentIdentity("develop", "android", true)).toBe(true);
    expect(shouldUseDevelopmentIdentity("trial", "ios", true)).toBe(false);
    expect(shouldUseDevelopmentIdentity("trial", "devtools")).toBe(false);
  });

  it("accepts only explicit private-LAN origins for physical develop-mode debugging", () => {
    expect(isPrivateLanHttpOrigin("http://192.168.31.68:3100")).toBe(true);
    expect(isPrivateLanHttpOrigin("http://10.0.0.2:3100")).toBe(true);
    expect(isPrivateLanHttpOrigin("http://172.31.4.2:3100")).toBe(true);
    expect(isPrivateLanHttpOrigin("http://127.0.0.1:3100")).toBe(false);
    expect(isPrivateLanHttpOrigin("https://192.168.31.68:3100")).toBe(false);
    expect(isPrivateLanHttpOrigin("http://192.168.31.68:3100/v1")).toBe(false);
    const query = { cisme_remote_debug: "1", api_origin: "http://192.168.31.68:3100" };
    expect(remoteDebugApiOrigin("develop", "ios", query)).toBe("http://192.168.31.68:3100");
    expect(remoteDebugApiOrigin("develop", "android", query)).toBe("http://192.168.31.68:3100");
    expect(remoteDebugApiOrigin("develop", "devtools", query)).toBe("");
    expect(remoteDebugApiOrigin("trial", "ios", query)).toBe("");
    expect(remoteDebugApiOrigin("develop", "ios", { ...query, cisme_remote_debug: "0" })).toBe("");
  });

  it("accepts only origin-shaped Quick Tunnel URLs for explicit remote physical develop launches", () => {
    const origin = "https://advocate-alex-adjacent-nelson.trycloudflare.com";
    const query = { cisme_remote_debug: "1", api_origin: origin };
    expect(isTemporaryRemoteDebugHttpsOrigin(origin)).toBe(true);
    expect(isTemporaryRemoteDebugHttpsOrigin(`${origin}:443`)).toBe(true);
    expect(isTemporaryRemoteDebugHttpsOrigin("https://trycloudflare.com")).toBe(false);
    expect(isTemporaryRemoteDebugHttpsOrigin(`${origin}/v1`)).toBe(false);
    expect(isTemporaryRemoteDebugHttpsOrigin(`${origin}?debug=1`)).toBe(false);
    expect(isTemporaryRemoteDebugHttpsOrigin("http://advocate-alex-adjacent-nelson.trycloudflare.com")).toBe(false);
    expect(isTemporaryRemoteDebugHttpsOrigin("https://example.trycloudflare.com.evil.test")).toBe(false);
    expect(remoteDebugApiOrigin("develop", "ios", query)).toBe(origin);
    expect(remoteDebugApiOrigin("develop", "android", query)).toBe(origin);
    expect(remoteDebugApiOrigin("develop", "devtools", query)).toBe("");
    expect(remoteDebugApiOrigin("trial", "ios", query)).toBe("");
    expect(remoteDebugApiOrigin("release", "android", query)).toBe("");
  });

  it("accepts only randomized localhost.run origins for explicit remote physical develop launches", () => {
    const origin = "https://e3f214c903d870.lhr.life";
    const query = { cisme_remote_debug: "1", api_origin: origin };
    expect(isTemporaryRemoteDebugHttpsOrigin(origin)).toBe(true);
    expect(isTemporaryRemoteDebugHttpsOrigin(`${origin}:443`)).toBe(true);
    expect(isTemporaryRemoteDebugHttpsOrigin("https://lhr.life")).toBe(false);
    expect(isTemporaryRemoteDebugHttpsOrigin("https://friendly-name.lhr.life")).toBe(false);
    expect(isTemporaryRemoteDebugHttpsOrigin(`${origin}/v1`)).toBe(false);
    expect(isTemporaryRemoteDebugHttpsOrigin(`${origin}?debug=1`)).toBe(false);
    expect(isTemporaryRemoteDebugHttpsOrigin("http://e3f214c903d870.lhr.life")).toBe(false);
    expect(isTemporaryRemoteDebugHttpsOrigin("https://e3f214c903d870.lhr.life.evil.test")).toBe(false);
    expect(remoteDebugApiOrigin("develop", "ios", query)).toBe(origin);
    expect(remoteDebugApiOrigin("develop", "android", query)).toBe(origin);
    expect(remoteDebugApiOrigin("devtools", "ios", query)).toBe("");
    expect(remoteDebugApiOrigin("trial", "ios", query)).toBe("");
    expect(remoteDebugApiOrigin("release", "android", query)).toBe("");
    expect(remoteDebugApiOrigin("develop", "ios", { ...query, api_origin: encodeURIComponent(origin) })).toBe(origin);
    expect(remoteDebugApiOrigin("develop", "ios", { ...query, api_origin: "%E0%A4%A" })).toBe("");
    expect(remoteDebugApiOrigin("develop", "ios", { ...query, api_origin: encodeURIComponent(`${origin}/v1`) })).toBe("");
  });
  it("checks Mini Program AppID syntax without claiming ownership", () => {
    expect(isRealWeChatAppId("wx0123456789abcdef")).toBe(true);
    expect(isRealWeChatAppId("touristappid")).toBe(false);
  });

  it("accepts only origin-only public HTTPS API URLs", () => {
    expect(isPublicHttpsOrigin("https://demo-api.cisme.example")).toBe(true);
    expect(isPublicHttpsOrigin("https://demo-api.cisme.example/v1")).toBe(false);
    expect(isPublicHttpsOrigin("http://127.0.0.1:3100")).toBe(false);
  });

  it("fails closed for the checked-in uncredentialed trial configuration", () => {
    const errors = validateWeChatRelease({
      target: "trial",
      projectAppId: "touristappid",
      apiOrigin: "",
      privacyCheckEnabled: true,
      devtoolsCliAvailable: true,
      manualGates: { ...completeGates, privacyGuideConfigured: false }
    });
    expect(errors).toEqual(expect.arrayContaining([
      "REAL_WECHAT_APP_ID_REQUIRED",
      "TRIAL_HTTPS_API_ORIGIN_REQUIRED",
      "PRIVACY_GUIDE_CONSOLE_PROOF_REQUIRED"
    ]));
    expect(validateWeChatCiPreview({
      projectAppId: "touristappid",
      expectedAppId: "wx0123456789abcdef",
      apiOrigin: "",
      privacyCheckEnabled: true,
      riskAccepted: false,
      testTargetIsolated: false,
      paymentsDisabled: false,
      publicUgcDisabled: false,
      testMembersConfigured: false,
      manualGates: { ...completeGates, privacyGuideConfigured: false }
    })).toEqual(expect.arrayContaining([
      "WECHAT_CI_RISK_ACCEPTANCE_REQUIRED",
      "REAL_WECHAT_APP_ID_REQUIRED",
      "WECHAT_APP_ID_MISMATCH",
      "PREVIEW_HTTPS_API_ORIGIN_REQUIRED",
      "PRIVACY_GUIDE_CONSOLE_PROOF_REQUIRED"
    ]));
  });

  it("requires an explicit target AppID even when the project AppID has valid syntax", () => {
    expect(validateWeChatRelease({
      target: "trial",
      projectAppId: "wx0123456789abcdef",
      apiOrigin: "https://demo-api.cisme.example",
      privacyCheckEnabled: true,
      devtoolsCliAvailable: true,
      manualGates: completeGates
    })).toContain("EXPECTED_WECHAT_APP_ID_REQUIRED");
  });

  it("accepts a fully evidenced experience-version configuration", () => {
    expect(validateWeChatRelease({
      target: "trial",
      projectAppId: "wx0123456789abcdef",
      expectedAppId: "wx0123456789abcdef",
      apiOrigin: "https://demo-api.cisme.example",
      privacyCheckEnabled: true,
      devtoolsCliAvailable: true,
      manualGates: completeGates
    })).toEqual([]);
    expect(validateWeChatCiPreview({
      projectAppId: "wx0123456789abcdef",
      expectedAppId: "wx0123456789abcdef",
      apiOrigin: "https://demo-api.cisme.example",
      privacyCheckEnabled: true,
      riskAccepted: true,
      testTargetIsolated: true,
      paymentsDisabled: true,
      publicUgcDisabled: true,
      testMembersConfigured: true,
      manualGates: completeGates
    })).toEqual([]);
  });

  it("keeps every internal test-package safety proof independent of final design evidence", () => {
    const safe = { riskAccepted: true, testTargetIsolated: true, paymentsDisabled: true,
      publicUgcDisabled: true, testMembersConfigured: true };
    expect(validateInternalTestPackageSafety(safe)).toEqual([]);
    expect(validateInternalTestPackageSafety({ ...safe, testTargetIsolated: false })).toContain("INTERNAL_TEST_TARGET_ISOLATION_PROOF_REQUIRED");
    expect(validateInternalTestPackageSafety({ ...safe, paymentsDisabled: false })).toContain("INTERNAL_TEST_PAYMENTS_DISABLED_PROOF_REQUIRED");
    expect(validateInternalTestPackageSafety({ ...safe, publicUgcDisabled: false })).toContain("INTERNAL_TEST_PUBLIC_UGC_DISABLED_PROOF_REQUIRED");
    expect(validateInternalTestPackageSafety({ ...safe, testMembersConfigured: false })).toContain("INTERNAL_TEST_MEMBERS_SCOPE_PROOF_REQUIRED");
  });

  it("does not require unrelated CI-tool risk consent for official DevTools safety checks", () => {
    expect(validateInternalTestPackageSafety({testTargetIsolated:true,paymentsDisabled:true,
      publicUgcDisabled:true,testMembersConfigured:true})).toEqual([]);
    expect(validateWeChatCiPreview({projectAppId:'wx0123456789abcdef',expectedAppId:'wx0123456789abcdef',
      apiOrigin:'https://demo-api.cisme.example',privacyCheckEnabled:true,manualGates:completeGates,
      riskAccepted:false,testTargetIsolated:true,paymentsDisabled:true,publicUgcDisabled:true,testMembersConfigured:true
    })).toContain('WECHAT_CI_RISK_ACCEPTANCE_REQUIRED');
  });

  it("requires cloud transport evidence and keeps experience membership scoped to trial", () => {
    const input = {
      target: "release" as const, projectAppId: "wx0123456789abcdef", expectedAppId: "wx0123456789abcdef",
      apiOrigin: "", cloudTarget: { env: "cloud1-test", name: "cismeApi" },
      privacyCheckEnabled: true, devtoolsCliAvailable: true,
      manualGates: { ...completeGates, experienceMembersConfigured: false }
    };
    expect(validateWeChatRelease(input)).toEqual(["CLOUD_HTTP_TRANSPORT_PROOF_REQUIRED"]);
    expect(validateWeChatRelease({ ...input, cloudTransportVerified: true })).toEqual([]);
    expect(validateWeChatRelease({ ...input, target: "trial", cloudTransportVerified: true })).toEqual(["EXPERIENCE_MEMBERS_PROOF_REQUIRED"]);
    expect(validateWeChatRelease({ ...input, cloudTransportVerified: true, cloudTarget: { env: "", name: "cismeApi" } })).toContain("CLOUD_HTTP_TARGET_INVALID");
  });

  it("keeps the local simulator independent of public release gates", () => {
    expect(validateWeChatRelease({
      target: "local",
      projectAppId: "touristappid",
      apiOrigin: "http://127.0.0.1:3100",
      privacyCheckEnabled: true,
      devtoolsCliAvailable: true,
      manualGates: {
        privacyGuideConfigured: false,
        legalTextsApproved: false,
        serverDomainsConfigured: false,
        demoScopeApproved: false,
        experienceMembersConfigured: false
      }
    })).toEqual([]);
  });

  it("requires filing for public release even when native cloud transport is verified", () => {
    const input = {
      target: "release" as const, projectAppId: "wx0123456789abcdef", expectedAppId: "wx0123456789abcdef",
      apiOrigin: "", cloudTarget: { env: "cloud1-test", name: "cismeApi" }, cloudTransportVerified: true,
      privacyCheckEnabled: true, devtoolsCliAvailable: true,
      manualGates: { ...completeGates, serverDomainsConfigured: false, miniProgramFilingCompleted: false }
    };
    expect(validateWeChatRelease(input)).toEqual(["MINIPROGRAM_FILING_REQUIRED"]);
    expect(validateWeChatRelease({ ...input, target: "trial" })).toEqual([]);
    const { cloudTarget, ...directInput } = input;
    expect(validateWeChatRelease({ ...directInput, apiOrigin: "https://api.cisme.example" }))
      .toEqual(expect.arrayContaining(["SERVER_DOMAIN_ALLOWLIST_PROOF_REQUIRED", "MINIPROGRAM_FILING_REQUIRED"]));
  });

  it("fails a direct isolated CI invocation before loading the upload tool when release gates are absent", async () => {
    const fixtureRoot = await mkdtemp(resolve(tmpdir(), "cisme-wechat-ci-"));
    const keyPath = resolve(fixtureRoot, "private.key");
    await writeFile(keyPath, "test-only-key");
    try {
      const failure = await exec("./node_modules/.bin/tsx", ["scripts/miniprogram-ci.ts"], {
        env: {
          ...process.env,
          WECHAT_APP_ID: "wx0123456789abcdef",
          WECHAT_PRIVATE_KEY_PATH: keyPath,
          WECHAT_CI_RISK_ACCEPTED: "false",
          WECHAT_PRIVACY_GUIDE_CONFIGURED: "false",
          WECHAT_LEGAL_TEXTS_APPROVED: "false",
          WECHAT_SERVER_DOMAINS_CONFIGURED: "false",
          WECHAT_DEMO_SCOPE_APPROVED: "false"
        }
      }).then(() => undefined, (error: unknown) => error);
      expect(failure).toMatchObject({
        code: 1,
        stderr: expect.stringContaining("WECHAT_CI_RISK_ACCEPTANCE_REQUIRED")
      });
      expect(failure).toMatchObject({
        stderr: expect.stringContaining("WECHAT_APP_ID_MISMATCH")
      });
      expect(failure).toMatchObject({
        stderr: expect.stringContaining("PRIVACY_GUIDE_CONSOLE_PROOF_REQUIRED")
      });
      expect(failure).toMatchObject({
        stderr: expect.stringContaining("INTERNAL_TEST_TARGET_ISOLATION_PROOF_REQUIRED")
      });
      expect((failure as {stderr:string}).stderr).not.toContain("DESIGN_QA_FINAL_RESULT_NOT_PASSED");
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  });
});
