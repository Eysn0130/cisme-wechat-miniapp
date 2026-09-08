import { access, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { miniProgramApiOrigins } from "../apps/miniprogram/release-config";
import { evaluateDesignQaEvidence } from "./design-qa-lib";
import { validateWeChatCiPreview } from "./wechat-release-lib";

const root = resolve(import.meta.dirname, "..");
const appid = process.env.WECHAT_APP_ID;
const keyPath = process.env.WECHAT_PRIVATE_KEY_PATH;
if (!appid || !keyPath) throw new Error("FAIL_CLOSED:WECHAT_APP_ID_AND_PRIVATE_KEY_REQUIRED");
await readFile(keyPath);
const projectPath = resolve(root, "apps/miniprogram");
const projectConfig = JSON.parse(await readFile(resolve(projectPath, "project.config.json"), "utf8")) as { appid?: string };
const appConfig = JSON.parse(await readFile(resolve(projectPath, "app.json"), "utf8")) as { __usePrivacyCheck__?: boolean };
const flag = (name: string) => process.env[name] === "true";
const releaseErrors = validateWeChatCiPreview({
  projectAppId: projectConfig.appid ?? "",
  expectedAppId: appid,
  apiOrigin: miniProgramApiOrigins.preview,
  privacyCheckEnabled: appConfig.__usePrivacyCheck__ === true,
  riskAccepted: flag("WECHAT_CI_RISK_ACCEPTED"),
  manualGates: {
    privacyGuideConfigured: flag("WECHAT_PRIVACY_GUIDE_CONFIGURED"),
    legalTextsApproved: flag("WECHAT_LEGAL_TEXTS_APPROVED"),
    serverDomainsConfigured: flag("WECHAT_SERVER_DOMAINS_CONFIGURED"),
    demoScopeApproved: flag("WECHAT_DEMO_SCOPE_APPROVED"),
    experienceMembersConfigured: flag("WECHAT_EXPERIENCE_MEMBERS_CONFIGURED")
  }
});
releaseErrors.push(...(await evaluateDesignQaEvidence(root)).releaseErrors);
if (releaseErrors.length) {
  console.error(JSON.stringify({ ok: false, command: "isolated-preview", errors: [...new Set(releaseErrors)] }, null, 2));
  process.exit(1);
}

const toolRoot = resolve(root, "tools/wechat-ci/node_modules/miniprogram-ci");
try { await access(toolRoot); } catch { throw new Error("FAIL_CLOSED:ISOLATED_WECHAT_CI_TOOL_NOT_INSTALLED"); }
const require = createRequire(import.meta.url);
const ci = require(toolRoot) as {
  Project: new (input: Record<string, unknown>) => unknown;
  packNpm(project: unknown, options: Record<string, unknown>): Promise<void>;
  preview(options: Record<string, unknown>): Promise<void>;
};
const project = new ci.Project({ appid, type: "miniProgram", projectPath, privateKeyPath: keyPath, ignores: ["node_modules/**/*"] });
await ci.packNpm(project, { ignores: [] });
await ci.preview({ project, version: "0.1.0", desc: "CISME R0 credentialed preview", setting: { es6: true, minify: true }, qrcodeFormat: "terminal" });
