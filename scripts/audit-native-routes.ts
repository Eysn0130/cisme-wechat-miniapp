import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { nativeRouteAccess } from "../apps/miniprogram/services/route-access";
import { inspectMiniProgramPackage } from "./miniprogram-package-lib";

function sourceInventory(route: string, logic: string, markup: string) {
  const serviceImports = [...logic.matchAll(/import\s*\{([^}]+)\}\s*from\s*["']\.\.\/\.\.\/services\/[^"']+["']/g)]
    .flatMap(match => match[1]!.split(",").map(name => name.trim().replace(/^type\s+/, "").split(/\s+as\s+/).at(-1) ?? ""))
    .filter(Boolean);
  const called = [...new Set(serviceImports.filter(name => new RegExp(`\\b${name}\\s*(?:<[^;]*?>)?\\(`).test(logic)))].sort();
  const hooks = [...new Set([...logic.matchAll(/\b(onLoad|onShow|onHide|onUnload)\s*\(/g)].map(match => match[1]!))].sort();
  // These are source tokens, not resolved request graphs. Imported service
  // wrappers and runtime template substitutions require a separate trace.
  const apiPathExpressions = [...new Set([...logic.matchAll(/\/v1\/[A-Za-z0-9_/?=${}.-]+/g)].map(match => match[0]))].sort();

  return {
    lifecycleHooks: hooks,
    apiPathExpressions,
    serviceCallsites: called.filter(name => name !== "request"),
    sourceMarkers: {
      memberAccessCall: called.includes("requireMemberAccess"),
      snapshotOwnerCall: called.includes("retainMemberSnapshot"),
      loadingBinding: /\{\{[^}]*\bloading\b[^}]*\}\}/.test(markup),
      errorBinding: /\{\{[^}]*\berror\b[^}]*\}\}/.test(markup)
    }
  };
}

export async function auditNativeRoutes(root = resolve("apps/miniprogram")) {
  const packageResult = await inspectMiniProgramPackage(root);
  if (!packageResult.ok) throw new Error(`MINIPROGRAM_PACKAGE_INVALID:${packageResult.errors.join(",")}`);
  const manifest = JSON.parse(await readFile(resolve(root, "../../docs/evidence/visual/current-source-acceptance.json"), "utf8")) as {
    packageSourceSha256: string; routeCoverage: Array<{ route: string; matrixComplete: boolean; result: string }>;
  };
  const coverage = new Map(manifest.routeCoverage.map(item => [item.route, item]));
  const routes = await Promise.all(packageResult.routes.map(async route => {
    const access = nativeRouteAccess[`/${route}`];
    const stateGate = coverage.get(route);
    if (!access || !stateGate) throw new Error(`ROUTE_AUDIT_POLICY_OR_GATE_MISSING:${route}`);
    const [logic, markup] = await Promise.all([
      readFile(resolve(root, `${route}.ts`), "utf8"),
      readFile(resolve(root, `${route}.wxml`), "utf8")
    ]);
    return { route, access, ...sourceInventory(route, logic, markup), stateGate: {
      matrixComplete: stateGate.matrixComplete, result: stateGate.result
    } };
  }));
  return {
    schemaVersion: 1,
    packageSourceSha256: packageResult.actual.sourceSha256,
    evidenceManifestMatchesSource: manifest.packageSourceSha256 === packageResult.actual.sourceSha256,
    scope: "Static source tokens and current design-QA gate only; API paths omit imported wrapper internals and do not prove executed requests, permissions, visual states, or device behavior.",
    routes
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await auditNativeRoutes();
  console.log(JSON.stringify(result, null, 2));
  if (!result.evidenceManifestMatchesSource) process.exitCode = 1;
}
