import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import { inspectMiniProgramPackage } from "./miniprogram-package-lib.js";

const reviewId = process.argv[2];
const fixtureFlag = process.argv.indexOf("--fixture");
const fixtureSource = fixtureFlag >= 0 ? process.argv[fixtureFlag + 1] : undefined;
const finalizeOnly = process.argv.includes("--finalize-only");
if (!reviewId || !/^[a-z0-9][a-z0-9+._-]{11,119}$/i.test(reviewId) || !fixtureSource) {
  throw new Error("Usage: tsx scripts/capture-miniprogram-review.ts REVIEW_ID --fixture FIXTURE_JSON");
}

const root = process.cwd();
const project = resolve(root, "apps/miniprogram");
const reviewRoot = resolve(root, `docs/evidence/visual/review-${reviewId}`);
const fixturePath = resolve(root, fixtureSource);
const fixture = JSON.parse(await readFile(fixturePath, "utf8")) as {
  scope: string;
  origin: string;
  database: { name: string; migrationCount: number; latestMigration: string };
  developmentIdentity: { externalUserId: string };
  routes: Record<string, { path: string; query: string }>;
  assertions: { orderFlowEnabled: boolean; paymentAvailable: boolean; credentialsOrTokensPersisted: boolean };
};
if (fixture.scope !== "local_devtools_synthetic_nonproduction" || fixture.origin !== "http://127.0.0.1:18080" || !/(^|_)test(_|$)/.test(fixture.database.name)) {
  throw new Error("Local synthetic acceptance fixture required");
}
if (fixture.assertions.orderFlowEnabled !== true || fixture.assertions.paymentAvailable !== false || fixture.assertions.credentialsOrTokensPersisted !== false) {
  throw new Error("Acceptance fixture boundary failed");
}

const inspection = await inspectMiniProgramPackage();
if (!inspection.ok) throw new Error(`Mini Program package gate failed: ${inspection.errors.join(",")}`);
const app = JSON.parse(await readFile(resolve(project, "app.json"), "utf8")) as { pages: string[]; subPackages: Array<{ root: string; pages: string[] }> };
const routes = [...app.pages, ...app.subPackages.flatMap((subpackage) => subpackage.pages.map((page) => `${subpackage.root}/${page}`))];
// Default healthy capture must not select a later deleted/error fixture for
// the same route. State-specific fixtures remain in the manifest for review.
const fixtureRoutes = new Map<string, string>();
for (const [name, entry] of Object.entries(fixture.routes)) {
  if (name === "communityDeleted" || fixtureRoutes.has(entry.path)) continue;
  fixtureRoutes.set(entry.path, entry.query);
}
const queryFor = (route: string) => route === "pages/account/index" ? "intent=login" : fixtureRoutes.get(route) ?? "";
const slug = (route: string) => route.replaceAll("/", "__");

function parseToolOutput(raw: string): any {
  const offset = raw.indexOf("{");
  if (offset < 0) throw new Error(`wechatide returned no JSON: ${raw.slice(0, 160)}`);
  const parsed = JSON.parse(raw.slice(offset));
  if (!parsed.ok || parsed.result?.success === false) throw new Error(`wechatide ${parsed.tool ?? "tool"} failed: ${parsed.message ?? JSON.stringify(parsed.result)}`);
  return parsed;
}

function wechatide(client: "project-action" | "runtime", tool: string, args: string[]): any {
  const raw = execFileSync("wechatide", ["-c", client, tool, "--project", project, ...args], { cwd: root, encoding: "utf8", timeout: 45_000 });
  return parseToolOutput(raw);
}

function pageData(path: string): unknown {
  return wechatide("project-action", "automation_page_action", ["--action", "getData", "--data-path", path]).result.data;
}

function lineCount(value: unknown): number {
  if (typeof value !== "string" || !value.trim()) return 0;
  return value.trim().split(/\r?\n/).length;
}

const runtime = wechatide("project-action", "automation_evaluate", [
  "--fn-source",
  `function(){var a=getApp();return {apiBaseUrl:a.globalData.apiBaseUrl,hasSession:Boolean(a.globalData.sessionToken),storedSession:Boolean(wx.getStorageSync(a.globalData.sessionStorageKey)),platform:wx.getDeviceInfo().platform,envVersion:wx.getAccountInfoSync().miniProgram.envVersion,devUserMatches:wx.getStorageSync("cisme.devUserId")===${JSON.stringify(fixture.developmentIdentity.externalUserId)}};}`
]).result.result.result as Record<string, unknown>;
if (runtime.apiBaseUrl !== fixture.origin || runtime.hasSession !== true || runtime.storedSession !== true || runtime.platform !== "devtools" || runtime.envVersion !== "develop" || runtime.devUserMatches !== true) {
  throw new Error(`DevTools authenticated acceptance preflight failed: ${JSON.stringify(runtime)}`);
}

const opened: Array<{ route: string; query: string; result: string }> = [];
const routeHealth: Array<{ route: string; query: string; currentPage: string; loading: boolean | "not_exposed"; error: string; screenshot: string; result: string }> = [];
if (!finalizeOnly) {
  execFileSync(resolve(root, "node_modules/.bin/tsx"), ["scripts/generate-visual-review-pack.ts", reviewId, "--fixture", fixtureSource], { cwd: root, stdio: "inherit" });
  for (const route of routes) {
    const query = queryFor(route);
    const openArguments = ["--page", route, ...(query ? ["--query", query] : [])];
    wechatide("project-action", "simulator_open_page", openArguments);
    const screenshot = resolve(reviewRoot, `screenshots/raw/${slug(route)}.png`);
    const captured = wechatide("runtime", "simulator_screenshot", ["--path", screenshot, "--wait", "4", "--optimize=false"]).result;
    // Match the existing evidence gate before a low-resolution frame can enter
    // the current acceptance index. Change the IDE display scale; never upscale.
    if (!(captured.imageWidth >= 320 && captured.imageHeight >= 480)) {
      throw new Error(`Native capture resolution too small (${captured.imageWidth}x${captured.imageHeight}); increase the IDE simulator display scale and capture again.`);
    }
    const current = wechatide("project-action", "automation_runtime_info", ["--action", "currentPage"]).result.currentPage as { path?: string };
    const loadingValue = pageData("loading");
    const errorValue = pageData("error");
    const loading = typeof loadingValue === "boolean" ? loadingValue : "not_exposed";
    const error = typeof errorValue === "string" ? errorValue : "";
    // This fixture deliberately has no payment provider. Verify the guarded
    // finance state instead of enabling money just to produce a clean frame.
    const guardedFinance = route === "pages/management-finance/index"
      && error === "当前环境没有开放资金核对。"
      && pageData("moneyEnabled") === false
      && JSON.stringify(pageData("sections")) === "[]"
      && wechatide("project-action", "automation_evaluate", ["--fn-source",
        "function(){var p=getCurrentPages();return p[p.length-1].data.authority===null;}"]
      ).result.result.result === true;
    if (current.path !== route || loading === true || (error.trim() && !guardedFinance)) {
      throw new Error(`Route health failed for ${route}: ${JSON.stringify({ current: current.path, loading, error })}`);
    }
    opened.push({ route, query, result: "success" });
    const result = guardedFinance ? "PASS_EXPECTED_MONEY_DISABLED" : "PASS_LOCAL_SYNTHETIC";
    routeHealth.push({ route, query, currentPage: current.path, loading, error, screenshot: relative(reviewRoot, screenshot), result });
    console.log(JSON.stringify({ event: "MINIPROGRAM_ROUTE_HEALTH", route, query, result }));
  }
  execFileSync(resolve(root, "node_modules/.bin/tsx"), ["scripts/generate-visual-review-pack.ts", reviewId, "--fixture", fixtureSource], { cwd: root, stdio: "inherit" });
} else {
  const saved = JSON.parse(await readFile(resolve(reviewRoot, "route-runtime-health.json"), "utf8")) as { routes: typeof routeHealth };
  if (saved.routes.length !== routes.length) throw new Error("Finalize-only route health evidence is incomplete");
  routeHealth.push(...saved.routes);
  opened.push(...saved.routes.map(({ route, query }) => ({ route, query, result: "success" })));
}

const prefix = inspection.actual.sourceSha256.slice(0, 8);
const compilePath = resolve(reviewRoot, `devtools-${prefix}-compile-open.json`);
const consolePath = resolve(reviewRoot, `devtools-${prefix}-console-filter.json`);
const networkPath = resolve(reviewRoot, `devtools-${prefix}-network-filter.json`);
const routeHealthPath = resolve(reviewRoot, `route-runtime-health-${inspection.actual.sourceSha256.slice(0,8)}.json`);
const consoleFilter = "grep -Ein 'error|uncaught|exception|fail'";
const networkFilter = "grep -Ein 'fail|error|ECONN|ERR_|status[^0-9]*(0|4[0-9]{2}|5[0-9]{2})'";
const consoleResult = wechatide("runtime", "get_simulator_console", ["--command", consoleFilter]).result;
const networkResult = wechatide("runtime", "get_simulator_network", ["--command", networkFilter]).result;
const consoleMatches = lineCount(consoleResult);
const networkMatches = lineCount(networkResult);
if (consoleMatches || networkMatches) throw new Error(`Bounded runtime filters found matches: console=${consoleMatches}, network=${networkMatches}`);

const verifiedAt = new Date().toISOString();
await Promise.all([
  writeFile(compilePath, JSON.stringify({
    schemaVersion: 1,
    sourceSha256: inspection.actual.sourceSha256,
    tool: "wechatide 0.3.9 project-action.simulator_open_page",
    project,
    routeCount: routes.length,
    routes: opened,
    verifiedAt,
    result: "PASS_LOCAL_SYNTHETIC",
    qualification: "All route opens used the query recorded here after authenticated local API/session preflight; this is not physical-device acceptance."
  }, null, 2) + "\n"),
  writeFile(consolePath, JSON.stringify({
    schemaVersion: 1,
    sourceSha256: inspection.actual.sourceSha256,
    tool: "wechatide 0.3.9 runtime.get_simulator_console",
    filter: consoleFilter,
    matches: consoleMatches,
    verifiedAt,
    result: "PASS_BOUNDED_FILTER",
    qualification: "The bounded post-route-open filter had no matches; this does not prove the complete historical console buffer is empty."
  }, null, 2) + "\n"),
  writeFile(networkPath, JSON.stringify({
    schemaVersion: 1,
    sourceSha256: inspection.actual.sourceSha256,
    tool: "wechatide 0.3.9 runtime.get_simulator_network",
    filter: networkFilter,
    matches: networkMatches,
    verifiedAt,
    result: "PASS_BOUNDED_FILTER",
    qualification: "The bounded post-route-open filter had no matches; this is not a structured HAR or staging-network proof."
  }, null, 2) + "\n"),
  writeFile(routeHealthPath, JSON.stringify({
    schemaVersion: 1,
    sourceSha256: inspection.actual.sourceSha256,
    verifiedAt,
    environment: { origin: fixture.origin, database: fixture.database, runtime },
    routes: routeHealth,
    result: `PASS_LOCAL_SYNTHETIC_${routeHealth.length}_OF_${routes.length}`,
    exclusions: ["production data", "real payment", "formal upload", "physical-device acceptance"]
  }, null, 2) + "\n")
]);

const routesCsvPath = resolve(reviewRoot, "routes.csv");
const routesCsv = (await readFile(routesCsvPath, "utf8"))
  .replaceAll("CAPTURED_NOT_VISUALLY_ACCEPTED", "HEALTHY_RUNTIME_FRAME_CAPTURED_REVIEW_OPEN")
  .replaceAll("Route-specific authenticated/default frame captured after health preflight; interaction/device matrices still require review", "API/session/runtime health passed; visual interaction and physical-device matrices remain open");
await writeFile(routesCsvPath, routesCsv);

const sourceManifestPath = resolve(reviewRoot, "source-manifest.json");
const sourceManifest = JSON.parse(await readFile(sourceManifestPath, "utf8"));
sourceManifest.capture.runtimeHealthyRoutes = routeHealth.filter(row => row.result === "PASS_LOCAL_SYNTHETIC").length;
sourceManifest.capture.runtimeGuardedRoutes = routeHealth.filter(row => row.result === "PASS_EXPECTED_MONEY_DISABLED").length;
sourceManifest.capture.runtimeHealthEvidence = basename(routeHealthPath);
sourceManifest.capture.result = "AUTHENTICATED_HEALTHY_NATIVE_BASELINE_CAPTURED_VISUAL_ACCEPTANCE_BLOCKED";
await writeFile(sourceManifestPath, JSON.stringify(sourceManifest, null, 2) + "\n");

const acceptancePath = resolve(root, "docs/evidence/visual/current-source-acceptance.json");
const acceptance = JSON.parse(await readFile(acceptancePath, "utf8"));
for (const evidence of Object.values(acceptance.evidenceIndex ?? {}) as Array<Record<string, unknown>>) {
  if (evidence.kind === "route_native") evidence.state = routeHealth.find(row => row.route === evidence.route)?.result === "PASS_EXPECTED_MONEY_DISABLED" ? "money-disabled" : "authenticated-route-success";
}
const routeHealthRelative = relative(root, routeHealthPath);
for (const [path, kind] of [
  [compilePath, "devtools_compile"],
  [consolePath, "devtools_console"],
  [networkPath, "devtools_network"],
  [routeHealthPath, "devtools_route_runtime_health"]
] as const) {
  const content = await readFile(path);
  acceptance.evidenceIndex[relative(root, path)] = {
    sha256: createHash("sha256").update(content).digest("hex"),
    bytes: content.length,
    mimeType: "application/json",
    kind,
    packageSourceSha256: inspection.actual.sourceSha256
  };
}
acceptance.devtools = {
  packageSourceSha256: inspection.actual.sourceSha256,
  compileErrors: 0,
  consoleErrors: 0,
  networkFailures: 0,
  healthyRuntimeRoutes: sourceManifest.capture.runtimeHealthyRoutes,
  guardedRuntimeRoutes: sourceManifest.capture.runtimeGuardedRoutes,
  environment: "local_devtools_synthetic_nonproduction",
  compileEvidenceFiles: [relative(root, compilePath)],
  consoleEvidenceFiles: [relative(root, consolePath)],
  networkEvidenceFiles: [relative(root, networkPath)],
  routeRuntimeHealthFiles: [routeHealthRelative]
};
acceptance.finalResult = "blocked";
await writeFile(acceptancePath, JSON.stringify(acceptance, null, 2) + "\n");

const rawScreenshots = routes.map((route) => resolve(reviewRoot, `screenshots/raw/${slug(route)}.png`));
execFileSync("magick", ["montage", "-font", "/System/Library/Fonts/HelveticaNeue.ttc", ...rawScreenshots, "-thumbnail", "181x392", "-tile", "5x", "-geometry", "+4+4", resolve(reviewRoot, "contact-sheets/healthy-routes.png")]);

async function filesUnder(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  return (await Promise.all(entries.map(async (entry) => {
    const absolute = join(directory, entry.name);
    return entry.isDirectory() ? filesUnder(absolute) : [absolute];
  }))).flat();
}
const artifactFiles = (await filesUnder(reviewRoot)).filter((file) => basename(file) !== "SHA256SUMS").sort((a, b) => a.localeCompare(b));
const sums: string[] = [];
for (const file of artifactFiles) sums.push(`${createHash("sha256").update(await readFile(file)).digest("hex")}  ${relative(reviewRoot, file)}`);
await writeFile(resolve(reviewRoot, "SHA256SUMS"), sums.join("\n") + "\n");
console.log(JSON.stringify({
  event: "CISME_MINIPROGRAM_HEALTHY_REVIEW_CAPTURED",
  reviewId,
  reviewRoot,
  sourceSha256: inspection.actual.sourceSha256,
  routeHealth: `${routeHealth.length}/${routes.length}`,
  consoleMatches,
  networkMatches,
  checksums: sums.length
}, null, 2));
