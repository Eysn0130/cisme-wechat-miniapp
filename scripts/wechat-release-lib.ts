export type WeChatReleaseTarget = "local" | "preview" | "trial" | "release";

export interface WeChatReleaseInput {
  target: WeChatReleaseTarget;
  projectAppId: string;
  expectedAppId?: string;
  apiOrigin: string;
  privacyCheckEnabled: boolean;
  devtoolsCliAvailable: boolean;
  manualGates: {
    privacyGuideConfigured: boolean;
    legalTextsApproved: boolean;
    serverDomainsConfigured: boolean;
    demoScopeApproved: boolean;
    experienceMembersConfigured: boolean;
  };
}

export type WeChatCiPreviewInput = Omit<WeChatReleaseInput, "target" | "devtoolsCliAvailable"> & {
  riskAccepted: boolean;
};

const APP_ID = /^wx[0-9a-fA-F]{16}$/;

// Syntax only: matching this pattern does not establish account ownership or role.
export function isRealWeChatAppId(value: string): boolean {
  return APP_ID.test(value);
}

export function isPublicHttpsOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.origin === value.replace(/\/$/, "") && !["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  } catch {
    return false;
  }
}

export function validateWeChatRelease(input: WeChatReleaseInput): string[] {
  const errors: string[] = [];
  if (!input.devtoolsCliAvailable) errors.push("DEVTOOLS_CLI_MISSING");
  if (!input.privacyCheckEnabled) errors.push("APP_PRIVACY_CHECK_DISABLED");

  if (input.target === "local") {
    if (!input.apiOrigin.startsWith("http://127.0.0.1:") && !isPublicHttpsOrigin(input.apiOrigin)) {
      errors.push("LOCAL_API_ORIGIN_INVALID");
    }
    return errors;
  }

  if (!isRealWeChatAppId(input.projectAppId)) errors.push("REAL_WECHAT_APP_ID_REQUIRED");
  if (!input.expectedAppId || !isRealWeChatAppId(input.expectedAppId)) errors.push("EXPECTED_WECHAT_APP_ID_REQUIRED");
  if (input.expectedAppId && input.projectAppId !== input.expectedAppId) errors.push("WECHAT_APP_ID_MISMATCH");
  if (!isPublicHttpsOrigin(input.apiOrigin)) errors.push(`${input.target.toUpperCase()}_HTTPS_API_ORIGIN_REQUIRED`);
  if (!input.manualGates.privacyGuideConfigured) errors.push("PRIVACY_GUIDE_CONSOLE_PROOF_REQUIRED");
  if (!input.manualGates.legalTextsApproved) errors.push("LEGAL_TEXTS_APPROVAL_REQUIRED");
  if (!input.manualGates.serverDomainsConfigured) errors.push("SERVER_DOMAIN_ALLOWLIST_PROOF_REQUIRED");
  if (!input.manualGates.demoScopeApproved) errors.push("DEMO_SCOPE_APPROVAL_REQUIRED");
  if ((input.target === "trial" || input.target === "release") && !input.manualGates.experienceMembersConfigured) {
    errors.push("EXPERIENCE_MEMBERS_PROOF_REQUIRED");
  }
  return errors;
}

export function validateWeChatCiPreview(input: WeChatCiPreviewInput): string[] {
  const errors = input.riskAccepted ? [] : ["WECHAT_CI_RISK_ACCEPTANCE_REQUIRED"];
  return [
    ...errors,
    ...validateWeChatRelease({
      target: "preview",
      projectAppId: input.projectAppId,
      ...(input.expectedAppId ? { expectedAppId: input.expectedAppId } : {}),
      apiOrigin: input.apiOrigin,
      privacyCheckEnabled: input.privacyCheckEnabled,
      // miniprogram-ci itself is checked by the isolated runner before use.
      devtoolsCliAvailable: true,
      manualGates: input.manualGates
    })
  ];
}
