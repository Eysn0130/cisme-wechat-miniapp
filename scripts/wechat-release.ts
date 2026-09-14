import { access, mkdir, readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { miniProgramApiOrigins, miniProgramCloudFunctions } from "../apps/miniprogram/release-config";
import { evaluateDesignQaEvidence } from "./design-qa-lib";
import { validateInternalTestPackageSafety, validateWeChatRelease, type WeChatReleaseTarget } from "./wechat-release-lib";

type Command = "preflight" | "preview" | "upload";

const root = resolve(import.meta.dirname, "..");
const projectPath = resolve(root, "apps/miniprogram");
const projectConfigPath = resolve(projectPath, "project.config.json");
const appConfigPath = resolve(projectPath, "app.json");
const devtoolsCli = process.env.WECHAT_DEVTOOLS_CLI ?? "/Applications/wechatwebdevtools.app/Contents/MacOS/cli";
const command = (process.argv[2] ?? "preflight") as Command;
const requestedTarget = process.argv[3] as WeChatReleaseTarget | undefined;

if (!["preflight", "preview", "upload"].includes(command)) throw new Error(`UNKNOWN_WECHAT_RELEASE_COMMAND:${command}`);

const target: WeChatReleaseTarget = command === "preview" ? "preview" : command === "upload" ? "trial" : (requestedTarget ?? "trial");
if (!["local", "preview", "trial", "release"].includes(target)) throw new Error(`UNKNOWN_WECHAT_RELEASE_TARGET:${target}`);

async function exists(path: string): Promise<boolean> {
  try { await access(path); return true; } catch { return false; }
}

function flag(name: string): boolean {
  return process.env[name] === "true";
}

function run(executable: string, args: string[]): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(executable, args, { cwd: root, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolvePromise() : reject(new Error(`WECHAT_DEVTOOLS_CLI_EXIT_${code ?? "UNKNOWN"}`)));
  });
}

const projectConfig = JSON.parse(await readFile(projectConfigPath, "utf8")) as { appid?: string };
const appConfig = JSON.parse(await readFile(appConfigPath, "utf8")) as { __usePrivacyCheck__?: boolean };
const apiOrigin = miniProgramApiOrigins[target === "local" ? "devtools" : target];
const errors = validateWeChatRelease({
  target,
  projectAppId: projectConfig.appid ?? "",
  ...(process.env.WECHAT_APP_ID ? { expectedAppId: process.env.WECHAT_APP_ID } : {}),
  apiOrigin,
  ...(miniProgramCloudFunctions[target === "local" ? "devtools" : target] ? { cloudTarget: miniProgramCloudFunctions[target === "local" ? "devtools" : target]! } : {}),
  cloudTransportVerified: flag("WECHAT_CLOUD_HTTP_TRANSPORT_VERIFIED"),
  privacyCheckEnabled: appConfig.__usePrivacyCheck__ === true,
  devtoolsCliAvailable: await exists(devtoolsCli),
  manualGates: {
    privacyGuideConfigured: flag("WECHAT_PRIVACY_GUIDE_CONFIGURED"),
    legalTextsApproved: flag("WECHAT_LEGAL_TEXTS_APPROVED"),
    serverDomainsConfigured: flag("WECHAT_SERVER_DOMAINS_CONFIGURED"),
    demoScopeApproved: flag("WECHAT_DEMO_SCOPE_APPROVED"),
    experienceMembersConfigured: flag("WECHAT_EXPERIENCE_MEMBERS_CONFIGURED"),
    miniProgramFilingCompleted: flag("WECHAT_MINIPROGRAM_FILING_COMPLETED")
  }
});
if (target === "preview") {
  errors.push(...validateInternalTestPackageSafety({
    riskAccepted: flag("WECHAT_CI_RISK_ACCEPTED"),
    testTargetIsolated: flag("WECHAT_TEST_TARGET_ISOLATED_VERIFIED"),
    paymentsDisabled: flag("WECHAT_TEST_PAYMENTS_DISABLED_VERIFIED"),
    publicUgcDisabled: flag("WECHAT_TEST_PUBLIC_UGC_DISABLED_VERIFIED"),
    testMembersConfigured: flag("WECHAT_EXPERIENCE_MEMBERS_CONFIGURED")
  }));
  const designQa = await evaluateDesignQaEvidence(root);
  errors.push(...designQa.structuralErrors);
} else if (target === "trial" || target === "release") {
  const designQa = await evaluateDesignQaEvidence(root);
  errors.push(...designQa.releaseErrors);
}

if (errors.length) {
  console.error(JSON.stringify({ ok: false, command, target, errors }, null, 2));
  process.exitCode = 1;
} else if (command === "preflight") {
  console.log(JSON.stringify({ ok: true, command, target, appid: projectConfig.appid, apiOrigin }, null, 2));
} else {
  const evidenceDir = resolve(root, "docs/evidence/wechat");
  await mkdir(evidenceDir, { recursive: true });

  if (command === "preview") {
    const qrOutput = process.env.WECHAT_QR_OUTPUT ?? resolve(evidenceDir, "development-preview.png");
    const infoOutput = process.env.WECHAT_INFO_OUTPUT ?? resolve(evidenceDir, "development-preview.json");
    await run(devtoolsCli, ["preview", "--project", projectPath, "--qr-format", "image", "--qr-output", qrOutput, "--info-output", infoOutput, "--lang", "zh"]);
    console.log(JSON.stringify({ ok: true, command, target, qrOutput, infoOutput }, null, 2));
  } else {
    if (!process.argv.includes("--confirm-upload")) throw new Error("UPLOAD_REQUIRES_EXPLICIT_CONFIRMATION_FLAG");
    const version = process.env.WECHAT_VERSION?.trim();
    const desc = process.env.WECHAT_RELEASE_DESC?.trim();
    if (!version || !desc) throw new Error("WECHAT_VERSION_AND_RELEASE_DESC_REQUIRED");
    const infoOutput = process.env.WECHAT_INFO_OUTPUT ?? resolve(evidenceDir, `upload-${version}.json`);
    await run(devtoolsCli, ["upload", "--project", projectPath, "--version", version, "--desc", desc, "--info-output", infoOutput, "--lang", "zh"]);
    console.log(JSON.stringify({ ok: true, command, target, version, desc, infoOutput }, null, 2));
  }
}
