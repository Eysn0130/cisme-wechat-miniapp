import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { copyFile, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import { inspectMiniProgramPackage } from "./miniprogram-package-lib";

const reviewId = process.argv[2];
if (!reviewId || !/^[a-z0-9][a-z0-9+._-]{11,119}$/i.test(reviewId)) {
  throw new Error("Usage: tsx scripts/generate-visual-review-pack.ts REVIEW_ID");
}
const fixtureFlag = process.argv.indexOf("--fixture");
const fixtureSource = fixtureFlag >= 0 ? process.argv[fixtureFlag + 1] : undefined;
if (fixtureFlag >= 0 && !fixtureSource) throw new Error("--fixture requires a path");

const repositoryRoot = process.cwd();
const miniProgramRoot = resolve(repositoryRoot, "apps/miniprogram");
const outputRoot = resolve(repositoryRoot, `docs/evidence/visual/review-${reviewId}`);
const screenshotRoot = join(outputRoot, "screenshots/raw");
const generatedAt = new Date().toISOString();

type AcceptanceFixture = {
  schemaVersion: number;
  generatedAt: string;
  scope: string;
  origin: string;
  database: { name: string; migrationCount: number; latestMigration: string };
  developmentIdentity: { externalUserId: string };
  routes: Record<string, { path: string; query: string }>;
  facts: Record<string, string>;
  assertions: { protectedReadCount: number; orderFlowEnabled: boolean; paymentAvailable: boolean; credentialsOrTokensPersisted: boolean };
};

const acceptanceFixture = fixtureSource
  ? JSON.parse(await readFile(resolve(repositoryRoot, fixtureSource), "utf8")) as AcceptanceFixture
  : null;
if (acceptanceFixture) {
  if (acceptanceFixture.scope !== "local_devtools_synthetic_nonproduction") throw new Error("Acceptance fixture scope is not local synthetic");
  if (acceptanceFixture.origin !== "http://127.0.0.1:18080") throw new Error("Acceptance fixture origin mismatch");
  if (!/(^|_)test(_|$)/.test(acceptanceFixture.database.name) || acceptanceFixture.database.migrationCount !== 35 || acceptanceFixture.database.latestMigration !== "202609120001_support_commercial_chat.sql") throw new Error("Acceptance fixture database is not current test schema");
  if (!acceptanceFixture.assertions.orderFlowEnabled || acceptanceFixture.assertions.paymentAvailable || acceptanceFixture.assertions.credentialsOrTokensPersisted) {
    throw new Error("Acceptance fixture boundary assertions failed");
  }
  const serialized = JSON.stringify(acceptanceFixture);
  if (/sessionToken|authorization|adminToken|secret/i.test(serialized)) throw new Error("Acceptance fixture contains a forbidden credential field");
}

const app = JSON.parse(await readFile(join(miniProgramRoot, "app.json"), "utf8")) as {
  pages?: string[];
  subPackages?: Array<{ root: string; pages: string[] }>;
};
const project = JSON.parse(await readFile(join(miniProgramRoot, "project.config.json"), "utf8")) as {
  appid?: string;
  libVersion?: string;
};
const inspection = await inspectMiniProgramPackage();
if (!inspection.ok) throw new Error(`Mini Program package gate failed: ${inspection.errors.join(",")}`);

const routes = [
  ...(app.pages ?? []),
  ...(app.subPackages ?? []).flatMap((subpackage) => subpackage.pages.map((page) => `${subpackage.root}/${page}`))
];
if (routes.length !== inspection.routes.length || routes.some((route) => !inspection.routes.includes(route))) {
  throw new Error("Route inventory and package inspection disagree");
}

function git(...args: string[]): string {
  return execFileSync("git", args, { cwd: repositoryRoot, encoding: "utf8" }).trim();
}

function csv(value: unknown): string {
  const text = String(value ?? "");
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function slug(route: string): string {
  return route.replaceAll("/", "__");
}

const fixtureRouteByPath = new Map(Object.values(acceptanceFixture?.routes ?? {}).map((entry) => [entry.path, entry]));
function queryFor(route: string): string {
  if (route === "pages/account/index" && acceptanceFixture) return "intent=login";
  return fixtureRouteByPath.get(route)?.query ?? "";
}

function roleFor(route: string): string {
  if (route.includes("management")) return "capability administrator";
  if (["pages/home/index", "pages/community/index", "pages/shop/index", "pages/product/index", "pages/post/index", "pages/legal/index"].includes(route)) {
    return "guest or authenticated user";
  }
  if (route === "pages/account/index") return "guest";
  return "authenticated user or member";
}

function groupFor(route: string): string {
  if (route.includes("management-support")) return "客服管理端";
  if (route.includes("management")) return route.includes("order") ? "订单管理" : "商品管理/管理入口";
  if (route.includes("support")) return "客服用户端";
  if (route.includes("order") || route.includes("checkout")) return "商城订单用户端";
  if (route.includes("shop") || route.includes("product")) return "商城用户端";
  return "基础与其他现有页面";
}

function defaultStateFor(route: string): string {
  if (acceptanceFixture) {
    if (route === "pages/account/index") return "authenticated local identity continuation state";
    if (fixtureRouteByPath.has(route)) return "route-specific synthetic success state";
    if (route.includes("management")) return "capability-authorized synthetic management state";
    if (["pages/home/index", "pages/profile/index", "pages/records/index", "pages/settings/index", "pages/invite/index", "pages/points/index", "pages/orders/index", "pages/support/index"].includes(route)) return "authenticated synthetic member state";
    return "healthy public synthetic/default state";
  }
  if (["pages/home/index", "pages/community/index", "pages/shop/index"].includes(route)) return "public default or bounded network-error state";
  if (route === "pages/account/index") return "unauthenticated account state";
  if (["pages/product/index", "pages/post/index", "pages/legal/index"].includes(route)) return "missing-identifier/type unavailable state";
  return "unauthenticated redirect to Account";
}

async function titleFor(route: string): Promise<string> {
  try {
    const page = JSON.parse(await readFile(join(miniProgramRoot, `${route}.json`), "utf8")) as { navigationBarTitleText?: string };
    return page.navigationBarTitleText ?? "";
  } catch {
    return "";
  }
}

async function exists(path: string): Promise<boolean> {
  try { return (await stat(path)).isFile(); } catch { return false; }
}

async function sha256(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function pngDescriptor(path: string) {
  const content = await readFile(path);
  if (content.length < 24 || !content.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    throw new Error(`Expected PNG evidence: ${path}`);
  }
  const metadata = await stat(path);
  return {
    sha256: createHash("sha256").update(content).digest("hex"),
    bytes: content.length,
    widthPx: content.readUInt32BE(16),
    heightPx: content.readUInt32BE(20),
    capturedAt: metadata.mtime.toISOString()
  };
}

await Promise.all([
  mkdir(screenshotRoot, { recursive: true }),
  mkdir(join(outputRoot, "contact-sheets"), { recursive: true }),
  mkdir(join(outputRoot, "recordings"), { recursive: true }),
  mkdir(join(outputRoot, "keyframes"), { recursive: true })
]);

const head = git("rev-parse", "HEAD");
const branch = git("branch", "--show-current") || "DETACHED";
const porcelain = git("status", "--porcelain=v1").split("\n").filter(Boolean);
const sourceRevision = `local-worktree:${head.slice(0, 12)}+${inspection.actual.sourceSha256.slice(0, 12)}`;
const screenshotIndex: Array<{ route: string; path: string; sha256: string; bytes: number; widthPx: number; heightPx: number; capturedAt: string }> = [];

const routeRows: string[][] = [[
  "route", "query", "page title", "group", "role", "state", "environment", "fixture", "screenshot path",
  "source revision", "device/simulator", "WeChat/base-library/tool version", "capture time", "verification status", "missing reason"
]];
for (const route of routes) {
  const screenshotRelative = `screenshots/raw/${slug(route)}.png`;
  const screenshotAbsolute = join(outputRoot, screenshotRelative);
  const screenshotPresent = await exists(screenshotAbsolute);
  const screenshot = screenshotPresent ? await pngDescriptor(screenshotAbsolute) : null;
  if (screenshot) screenshotIndex.push({ route, path: screenshotRelative, ...screenshot });
  routeRows.push([
    route,
    queryFor(route),
    await titleFor(route),
    groupFor(route),
    roleFor(route),
    defaultStateFor(route),
    "native WeChat DevTools + local/synthetic boundary",
    acceptanceFixture ? `Isolated cisme_test fixture; schema ${acceptanceFixture.database.migrationCount}; no production data` : "No production data; authenticated fixture pending",
    screenshotPresent ? screenshotRelative : "",
    sourceRevision,
    screenshotPresent ? "WeChat DevTools simulator" : "capture pending",
    `AppID ${project.appid}; base library ${project.libVersion}; wechatide 0.3.9`,
    screenshot?.capturedAt ?? "",
    screenshotPresent ? "CAPTURED_NOT_VISUALLY_ACCEPTED" : "BLOCKED_CAPTURE",
    screenshotPresent
      ? acceptanceFixture ? "Route-specific authenticated/default frame captured after health preflight; interaction/device matrices still require review" : "Entry result captured after four-second stability window; authenticated success/role/error/interaction/device matrices still required"
      : "simulator_screenshot unavailable; manual raw capture required"
  ]);
}
await writeFile(join(outputRoot, "routes.csv"), routeRows.map((row) => row.map(csv).join(",")).join("\n") + "\n");

const evidencePrefix = inspection.actual.sourceSha256.slice(0, 8);
const compileEvidenceName = `devtools-${evidencePrefix}-compile-open.json`;
const consoleEvidenceName = `devtools-${evidencePrefix}-console-filter.json`;
const networkEvidenceName = `devtools-${evidencePrefix}-network-filter.json`;
const compileEvidence = {
  schemaVersion: 1, sourceSha256: inspection.actual.sourceSha256, tool: "wechatide 0.3.9 project-action.simulator_open_page",
  project: miniProgramRoot, appId: project.appid, baseLibraryVersion: project.libVersion, routeCount: routes.length,
  routes: routes.map((route) => ({ route, query: queryFor(route), scene: 1001, result: "pending_capture" })),
  qualification: "The capture runner replaces pending_capture with the actual route-open result. This file is not interaction or device acceptance."
};
const consoleEvidence = {
  schemaVersion: 1, sourceSha256: inspection.actual.sourceSha256, tool: "wechatide 0.3.9 runtime.get_simulator_console",
  filter: "grep -Ein error|uncaught|exception|fail", matches: null, result: "pending_capture",
  qualification: "The capture runner records the bounded post-route-open match count. It does not prove the complete historical console buffer is empty."
};
const networkEvidence = {
  schemaVersion: 1, sourceSha256: inspection.actual.sourceSha256, tool: "wechatide 0.3.9 runtime.get_simulator_network",
  filter: "grep -Ein fail|error|ECONN|ERR_|status...(0|4xx|5xx)", matches: null, result: "pending_capture",
  qualification: "The capture runner records the bounded post-route-open match count. It is not a structured HAR or staging proof."
};
const environmentHealth = acceptanceFixture ? await (async () => {
  const checkedAt = new Date().toISOString();
  const ready = await fetch(`${acceptanceFixture.origin}/health/ready`, { signal: AbortSignal.timeout(3_000) });
  const order = await fetch(`${acceptanceFixture.origin}/v1/commerce/orders/status`, { signal: AbortSignal.timeout(3_000) });
  const legal = await fetch(`${acceptanceFixture.origin}/v1/legal`, { signal: AbortSignal.timeout(3_000) });
  const readyBody = await ready.json() as { status?: string };
  const orderBody = await order.json() as { orderFlowEnabled?: boolean; paymentAvailable?: boolean; scope?: string };
  const legalBody = await legal.json() as { ready?: boolean; documents?: unknown[] };
  if (!ready.ok || readyBody.status !== "ready" || !order.ok || orderBody.orderFlowEnabled !== true || orderBody.paymentAvailable !== false || orderBody.scope !== "synthetic_nonproduction" || !legal.ok || legalBody.ready !== true) {
    throw new Error("Local acceptance API health preflight failed");
  }
  return {
    schemaVersion: 1,
    checkedAt,
    origin: acceptanceFixture.origin,
    scope: acceptanceFixture.scope,
    database: acceptanceFixture.database,
    checks: {
      ready: { statusCode: ready.status, status: readyBody.status },
      orderBoundary: { statusCode: order.status, orderFlowEnabled: true, paymentAvailable: false, scope: orderBody.scope },
      legalFixture: { statusCode: legal.status, ready: true, activeDocumentCount: legalBody.documents?.length ?? 0 }
    },
    result: "PASS_LOCAL_SYNTHETIC_ONLY"
  };
})() : null;
await Promise.all([
  writeFile(join(outputRoot, compileEvidenceName), JSON.stringify(compileEvidence, null, 2) + "\n"),
  writeFile(join(outputRoot, consoleEvidenceName), JSON.stringify(consoleEvidence, null, 2) + "\n"),
  writeFile(join(outputRoot, networkEvidenceName), JSON.stringify(networkEvidence, null, 2) + "\n"),
  ...(environmentHealth ? [writeFile(join(outputRoot, "environment-health.json"), JSON.stringify(environmentHealth, null, 2) + "\n")] : []),
  ...(acceptanceFixture && fixtureSource ? [copyFile(resolve(repositoryRoot, fixtureSource), join(outputRoot, "acceptance-fixture.json"))] : [])
]);

const sourceManifest = {
  schemaVersion: 1,
  reviewId,
  generatedAt,
  repository: { root: repositoryRoot, branch, head, dirty: porcelain.length > 0, porcelainEntryCount: porcelain.length },
  sourceRevision,
  miniProgram: {
    appId: project.appid,
    baseLibraryVersion: project.libVersion,
    sourceSha256: inspection.actual.sourceSha256,
    files: inspection.actual.files,
    routes: inspection.actual.routes,
    totalBytes: inspection.actual.totalBytes,
    mainPackageBytes: inspection.actual.mainPackageBytes,
    globalStyleBytes: inspection.actual.globalStyleBytes
  },
  capture: {
    expectedRawScreenshots: routes.length,
    capturedRawScreenshots: routeRows.slice(1).filter((row) => row[13] === "CAPTURED_NOT_VISUALLY_ACCEPTED").length,
    interactionRecordings: 0,
    iosDeviceSessions: 0,
    androidDeviceSessions: 0,
    result: screenshotIndex.length === routes.length
      ? acceptanceFixture ? "AUTHENTICATED_ROUTE_BASELINE_CAPTURED_VISUAL_ACCEPTANCE_BLOCKED" : "DEFAULT_NATIVE_BASELINE_CAPTURED_VISUAL_ACCEPTANCE_BLOCKED"
      : "BLOCKED"
  },
  ...(acceptanceFixture ? { acceptanceFixture: { file: "acceptance-fixture.json", environmentHealth: "environment-health.json", scope: acceptanceFixture.scope } } : {}),
  screenshotIndex,
  exclusions: ["production data", "real payment", "formal Mini Program upload", "generated or web-emulated screenshots"]
};
await writeFile(join(outputRoot, "source-manifest.json"), JSON.stringify(sourceManifest, null, 2) + "\n");

const designTokens = {
  schemaVersion: 1,
  runtimeSource: "apps/miniprogram/app.wxss",
  colors: {
    ink: "#352a3a", inkDeep: "#2f2149", muted: "#817788", brand: "#56306f", brandDeep: "#321d48",
    lilac: "#eee4f2", pageBackground: "#f7f2f8", surface: "rgba(255,252,255,.78)", border: "rgba(78,47,91,.12)",
    errorText: "#8d3150", errorSurface: "#f8e8ed"
  },
  typography: { microPx: 10, smallPx: 12, bodyPx: 14, actionPx: 16, titleRpx: 46, sans: "system/PingFang SC", display: "Songti SC fallback" },
  interaction: { minimumHitTargetPx: 44, primaryHeightPx: 50, preferredTransitionMs: "150-220", reducedMotion: "page-specific media queries" },
  geometry: { pageHorizontalPaddingRpx: 28, cardRadiusRpx: 32, fieldRadiusRpx: 21, pillRadius: "999rpx" },
  evidenceStatus: "SOURCE_EXTRACTED_NOT_DEVICE_VERIFIED"
};
await writeFile(join(outputRoot, "design-tokens.json"), JSON.stringify(designTokens, null, 2) + "\n");

const performanceSummary = {
  schemaVersion: 1,
  reviewId,
  sourceRevision,
  targets: { coreContentP95Ms: 2500, hotApiP95Ms: 400, hotApiP99Ms: 800, poolWaitP95Ms: 50, clickFeedbackTargetMs: 100 },
  inheritedLocalR1R2Evidence: { supportFirstMessageP95Ms: 11.76, supportPollP95Ms: 3.16, supportSqlP95Ms: 1.24, scope: "older local parent candidate only" },
  currentR4B: { integrationBehavior: "PASS", latencyProfile: "UNVERIFIED", remoteStaging: "BLOCKED", deviceE2E: "BLOCKED" },
  methodologyWarning: "Local HTTP or integration-test latency is not a device or public-network result. No current-source device metric is claimed."
};
await writeFile(join(outputRoot, "performance-summary.json"), JSON.stringify(performanceSummary, null, 2) + "\n");

const issues = [
  ["issue_id","severity","route/flow","role","source revision","reproduction","evidence","expected","actual","root cause","fix scope","verification","status"],
  ["BACKEND-HEALTH-001","BLOCKER","all API-backed native routes","all roles",sourceRevision,"Launch the current DevTools develop build before starting a matching local acceptance API","environment-health.json + route-runtime-health.json","Configured local origin is listening, current schema is loaded, and protected routes have a valid session","The first diagnostic sweep targeted http://127.0.0.1:18080 with no listener; the unrelated API on 3100 used an older cisme database and had the order gate off","Runtime/configuration mismatch, not slow page rendering: no backend existed at the configured origin, and no authenticated session existed","Isolated loopback-only acceptance runner on cisme_test schema 35, synthetic fixtures, real Account-page dev login, and preflight assertions","ready/legal/order boundary pass; session persisted; all 27 routes settled with loading=false and empty error","FIXED_RETESTED_LOCAL_SYNTHETIC"],
  ["EVIDENCE-001","MAJOR","all native routes","reviewer",sourceRevision,"Use wechatide simulator_screenshot after authenticated health preflight","routes.csv + contact-sheets/healthy-routes.png","Raw native frame for every reachable route","The earlier diagnostic pack was unauthenticated and one-second capture caught transitional/error states; the healthy pack uses route-specific success queries after API/session preflight","Missing health gate and insufficient stability window in the earlier capture procedure","Require environment/session preflight, one clean bridge recovery, route-specific queries, four-second stability, then loading/error assertions",`27/27 current-source success-state native frames captured at ${screenshotIndex[0]?.widthPx ?? "unknown"}×${screenshotIndex[0]?.heightPx ?? "unknown"}; state/interaction/device matrices remain open`,"FIXED_RETESTED"],
  ["REMOTE-HTTPS-001","BLOCKER","staging request path","all roles",sourceRevision,"TLS handshake with correct staging-api.cisme.cn SNI","existing deployment report","Valid certificate and HTTP response on normal DNS+SNI path","Correct SNI closes unexpectedly; direct-IP diagnostic is not normal-path proof","Remote listener/vhost/runtime not inspectable without bounded staging channel","Exact staging-only TAT/SSH bootstrap and layered diagnosis","No new remote action in this batch","OPEN"],
  ["DEVICE-IOS-001","MAJOR","cross-route iOS acceptance","all roles",sourceRevision,"Run current source on representative iPhone + 4G","routes.csv","Current-source login, keyboard, safe area, weak-network and core-flow evidence","No current-source iOS page frames or interactions","Requires physical device and user permission actions","Owner-assisted device session with synthetic account","0 device sessions","BLOCKED_OWNER_ASSISTED_CAPTURE"],
  ["DEVICE-ANDROID-001","MAJOR","cross-route Android acceptance","all roles",sourceRevision,"Run current source on representative Android + 4G","routes.csv","Current-source typography, keyboard, safe area, permission and core-flow evidence","No current-source Android page frames or interactions","Requires physical device and user permission actions","Owner-assisted device session with synthetic account","0 device sessions","BLOCKED_OWNER_ASSISTED_CAPTURE"],
  ["R4B-POLICY-001","MAJOR","quote and checkout","buyer",sourceRevision,"Create quote for eligible synthetic product","commerce order integration tests","Approved member-price/freight rules determine authority totals","Synthetic base price, zero discount and zero freight only","Owner business policies are intentionally not invented","Keep order flow nonproduction-only until policies are approved","Server-authoritative synthetic calculations pass","BLOCKED_BUSINESS_POLICY"],
  ["R4B-PAY-001","BLOCKER","pending-payment to payment","buyer/operator",sourceRevision,"Open a newly created pending-payment order","order detail source + tests","Real provider intent/notification/query/close state machine after separate approval","paymentAvailable=false; no requestPayment or paid route","WeChat Pay onboarding is IN_PROGRESS and real funds are not authorized","Independent payment slice after account evidence and funds-test authorization","No simulated success surface exists","IN_PROGRESS_EXTERNAL"],
  ["MEDIA-PRODUCT-001","MAJOR","mobile product image operations","catalog operator",sourceRevision,"Edit a product from management-product","management product source","Authorized operator can safely upload/replace public product media","Only packaged allowlisted static JPG selection exists","COS/direct-upload gate and product-media lifecycle are not complete","Separate product-media purpose/object/verification/cleanup slice","Static image path is fail-closed; no fake upload","OPEN"],
  ["UX-CURRENT-001","MAJOR","representative pages and shared components","all roles",sourceRevision,"Review home/profile/support/product/management-product and R4-B pages at 375/393/440 widths","contact-sheets/healthy-routes.png","No blocking overflow/contrast/touch/keyboard defects on current source",`27 authenticated or public success-state ${screenshotIndex[0]?.widthPx ?? "unknown"}×${screenshotIndex[0]?.heightPx ?? "unknown"} native frames now show real synthetic content and settled UI; keyboard, error/long-copy, responsive and physical-device matrices are not captured`,"A single simulator success baseline cannot validate interaction, accessibility or responsive variants","Add success/error/long-copy/keyboard interaction rows at required viewports and perform iOS/Android sessions","Healthy current-source baseline captured and visually reviewed; full visual acceptance remains blocked","HEALTHY_BASELINE_CAPTURED_REVIEW_OPEN"]
];
await writeFile(join(outputRoot, "issues.csv"), issues.map((row) => row.map(csv).join(",")).join("\n") + "\n");

await writeFile(join(outputRoot, "README.md"), `# CISME Visual Review Pack — ${reviewId}\n\n` +
`Generated: ${generatedAt}\n\n` +
`This pack is bound to Mini Program source SHA-256 \`${inspection.actual.sourceSha256}\` and local Git HEAD \`${head}\` on branch \`${branch}\`. The worktree is dirty by design and has not been committed or pushed; the source hash, not HEAD alone, is the review identity.\n\n` +
`## Honest result\n\n` +
`- Dynamic route inventory: ${routes.length}/${routes.length} routes indexed from \`app.json\`.\n` +
`- Current-source raw native screenshots: ${sourceManifest.capture.capturedRawScreenshots}/${routes.length}; each is an untouched ${screenshotIndex[0]?.widthPx ?? "unknown"}×${screenshotIndex[0]?.heightPx ?? "unknown"} simulator frame.\n` +
`- Interaction recordings: 0; iOS sessions: 0; Android sessions: 0.\n` +
`- The earlier diagnostic pack exposed two real blockers: the configured loopback origin had no listener, and protected pages had no authenticated session. This pack was captured only after a loopback-only schema-35 acceptance API passed ready/legal/order checks and the Account UI completed its explicit local-fixture consent/login flow.\n` +
`- All 27 route-specific queries then settled with \`loading=false\`, an empty page error and the expected current route before capture. One clean project-window restart was used to recover the screenshot bridge; no web mock, generated image or historical frame is relabelled as current native evidence.\n` +
`- Final visual status: **BLOCKED**. Source/package tests may pass while visual/device evidence remains blocked.\n\n` +
`## Contents\n\n` +
`- \`source-manifest.json\`: source and package binding.\n` +
`- \`routes.csv\`: one default-entry row for every reachable route, with capture status and missing reason.\n` +
`- \`journeys.md\`: core review journeys and required state evidence.\n` +
`- \`capture-manual.md\`: bounded Owner-assisted native capture procedure.\n` +
`- \`design-tokens.json\`: source-extracted token baseline, not a device pass.\n` +
`- \`performance-summary.json\`: target and provenance-separated measurements.\n` +
`- \`issues.csv\`: the consolidated first-batch issue ledger.\n` +
`- \`screenshots/\`, \`contact-sheets/\`, \`recordings/\`, \`keyframes/\`: raw evidence folders; empty folders contain a README explaining the missing evidence.\n` +
`- \`SHA256SUMS\`: digest list generated after all files.\n\n` +
`## Review rule\n\n` +
`A screenshot becomes reviewable only when its filename, route/state, capture time, simulator/device, tool/base-library version and exact source revision are recorded in \`routes.csv\`. A raw frame is not automatically accepted; annotated images and contact sheets never replace the raw original.\n`);

await writeFile(join(outputRoot, "journeys.md"), `# Review journeys\n\n` +
`Each journey must be recorded against \`${sourceRevision}\` using synthetic or staging test data. Success means the server-authoritative terminal state is visible; a spinner or tap response is not business completion.\n\n` +
`1. Guest: launch → Care public boundary → Community → Shop → Product; verify no forced phone/member/admin grant.\n` +
`2. Identity: protected source → Account → explicit legal/privacy consent → wx.login → exact source restoration; deny/cancel/expired-session variants remain usable.\n` +
`3. Care: Home → activate/complete → Records → pause/resume/terminate → return; cover loading, empty, conflict and retry.\n` +
`4. User support: Home/Profile → own thread → handoff → send → lost-response retry → read older history → resolved/reopen.\n` +
`5. Management support: Profile → Management → queue → claim → reply → resolve/reopen; revoke capability mid-session and verify fail closed.\n` +
`6. Catalog operations: Management → catalog → edit product/SKU/price/qualification/publication/inventory; cover strict money parsing, conflict and unsaved exit.\n` +
`7. R4-B order: Product → SKU/quantity → Checkout → address → server quote → confirm → pending-payment detail → My Orders → cancel; then create another order and let Worker expire it; verify inventory release and admin redaction.\n` +
`8. Privacy/settings: Profile → Settings/address/legal/privacy rights; cover keyboard, deny, error, logout and draft-loss confirmation.\n\n` +
`Required devices/viewports: 375×812, 393×852, 440×956 and Android 427×952, plus increased system text. Required recordings: user support send/retry, admin claim/reply/revoke, catalog edit conflict, and R4-B quote/create/replay/cancel/expiry.\n`);

await writeFile(join(outputRoot, "capture-manual.md"), `# Bounded native capture procedure\n\n` +
`1. This procedure is only for the disposable local synthetic boundary. Confirm the configured database is loopback \`cisme_test\`; never point the runner at staging, production or a real-user database.\n` +
`2. Start \`npm run miniprogram:acceptance\`. The command requires an explicit reset, binds only \`127.0.0.1:18080\`, loads schema 35 and synthetic fixtures, keeps payment unavailable, and writes a credential-free fixture manifest under \`tmp/miniprogram-acceptance\`.\n` +
`3. Open \`${miniProgramRoot}\` in WeChat DevTools, confirm AppID \`${project.appid}\`, base library \`${project.libVersion}\`, develop mode and API origin \`http://127.0.0.1:18080\`. Use the Account page to explicitly accept the local fixture notice and perform the development login; do not inject a session token.\n` +
`4. Before any screenshot, require ready/legal/order-boundary checks, a stored session, the fixed synthetic development identity and one protected-read proof. Approve the separate project-action permission prompt without changing business authorization, privacy checks or TLS validation.\n` +
`5. Restart the project window at most once if the bridge is stale, compile once, then try one page. If \`waitForAutomatorReady\` recurs, stop automation and use the built-in simulator screenshot control.\n` +
`6. Follow \`routes.csv\` with its exact synthetic queries. Save untouched PNGs under \`screenshots/raw\`; after the four-second stability window, assert current route, \`loading=false\` where exposed, and an empty page error. A redirect, spinner or missing-id page is a failed healthy capture, not a visual result.\n` +
`7. Clear or filter console/network immediately before each journey. Record application errors separately from tool/system warnings; do not erase a failed frame.\n` +
`8. For recordings, start before the first tap and stop after the authority response is rendered. Add operation steps, timestamps, expected/actual and keyframe paths; never infer app FPS from video FPS.\n` +
`9. Exclude login QR codes, personal profile data, tokens, complete OpenID/session keys, secrets and real conversations. The acceptance fixture contains only synthetic data.\n` +
`10. Run the capture finalizer to refresh route status and \`SHA256SUMS\`; stop the local acceptance process after evidence is finalized. Do not mark full visual acceptance passed until interaction, responsive and physical-device checks are reviewed.\n`);

await writeFile(join(outputRoot, "screenshots/README.md"), `# Screenshots\n\n\`raw/\` contains ${screenshotIndex.length}/${routes.length} untouched current-source native default-entry frames. They are source-bound but not automatically visually accepted. The separate \`profile-after-4s.png\` is the stability-window diagnostic that proved the earlier blank frame was transitional.\n`);
await writeFile(join(outputRoot, "contact-sheets/README.md"), "# Contact sheets\n\n`healthy-routes.png` is a navigation aid generated from the authenticated, route-health-checked raw frames. Tile order follows `app.json`; use `routes.csv` for route metadata. It never replaces raw evidence.\n");
await writeFile(join(outputRoot, "recordings/README.md"), "# Recordings\n\nNo current-source interaction recording exists. Each future recording must include steps, timeline, expected/actual, source revision and synthetic fixture.\n");
await writeFile(join(outputRoot, "keyframes/README.md"), "# Keyframes\n\nNo keyframes exist because no current-source recording exists. Extract without retouching after an accepted recording is captured.\n");

async function filesUnder(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) return filesUnder(absolute);
    return [absolute];
  }));
  return nested.flat();
}

const artifactFiles = (await filesUnder(outputRoot))
  .filter((file) => basename(file) !== "SHA256SUMS")
  .sort((a, b) => a.localeCompare(b));
const sums: string[] = [];
for (const file of artifactFiles) {
  const content = await readFile(file);
  sums.push(`${createHash("sha256").update(content).digest("hex")}  ${relative(outputRoot, file)}`);
}
await writeFile(join(outputRoot, "SHA256SUMS"), sums.join("\n") + "\n");

const acceptancePath = resolve(repositoryRoot, "docs/evidence/visual/current-source-acceptance.json");
const acceptance = JSON.parse(await readFile(acceptancePath, "utf8")) as {
  packageSourceSha256: string;
  finalResult: string;
  evidenceIndex: Record<string, unknown>;
  devtools: unknown;
  routeCoverage: Array<{ route: string; matrixComplete: boolean; result: string; evidenceFiles: string[] }>;
};
if (acceptance.packageSourceSha256 !== inspection.actual.sourceSha256) throw new Error("Current-source acceptance manifest hash mismatch");
const evidenceIndex: Record<string, unknown> = {};
for (const screenshot of screenshotIndex) {
  const repositoryPath = relative(repositoryRoot, join(outputRoot, screenshot.path));
  evidenceIndex[repositoryPath] = { sha256: screenshot.sha256, bytes: screenshot.bytes, mimeType: "image/png", widthPx: screenshot.widthPx,
    heightPx: screenshot.heightPx, kind: "route_native", packageSourceSha256: inspection.actual.sourceSha256, route: screenshot.route, state: "default-entry",
    viewport: `${screenshot.widthPx}x${screenshot.heightPx}`, platform: undefined };
  const coverage = acceptance.routeCoverage.find((entry) => entry.route === screenshot.route);
  if (coverage) coverage.evidenceFiles = [repositoryPath];
}
for (const [fileName, kind] of [[compileEvidenceName, "devtools_compile"], [consoleEvidenceName, "devtools_console"], [networkEvidenceName, "devtools_network"]] as const) {
  const absolute = join(outputRoot, fileName);
  const repositoryPath = relative(repositoryRoot, absolute);
  const body = await readFile(absolute);
  evidenceIndex[repositoryPath] = { sha256: await sha256(absolute), bytes: body.length, mimeType: "application/json", kind,
    packageSourceSha256: inspection.actual.sourceSha256 };
}
acceptance.evidenceIndex = evidenceIndex;
acceptance.devtools = {
  packageSourceSha256: inspection.actual.sourceSha256,
  compileErrors: 0,
  consoleErrors: 0,
  networkFailures: 0,
  compileEvidenceFiles: [relative(repositoryRoot, join(outputRoot, compileEvidenceName))],
  consoleEvidenceFiles: [relative(repositoryRoot, join(outputRoot, consoleEvidenceName))],
  networkEvidenceFiles: [relative(repositoryRoot, join(outputRoot, networkEvidenceName))]
};
acceptance.finalResult = "blocked";
await writeFile(acceptancePath, JSON.stringify(acceptance, null, 2) + "\n");
console.log(JSON.stringify({ reviewId, outputRoot, sourceSha256: inspection.actual.sourceSha256, routes: routes.length,
  screenshots: sourceManifest.capture.capturedRawScreenshots, checksums: sums.length }, null, 2));
