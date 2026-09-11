import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const releaseId = process.argv[2] ?? `r1-r2-staging-slice-${new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z")}`;
if (!/^r1-r2-staging-slice-[A-Za-z0-9._-]+$/.test(releaseId)) throw new Error("RELEASE_ID_INVALID");
const destination = resolve(root, "dist", releaseId);
try { await stat(destination); throw new Error("RELEASE_DESTINATION_ALREADY_EXISTS"); } catch (error) { if (error.code !== "ENOENT") throw error; }

const baselineSlice = resolve(root, "dist/p0-p1-staging-slice-20260911T045758Z");
const candidateRuntime = resolve(root, "dist/tencent-release");
const expectedBaseline = {
  migrationCount: 29,
  tableCount: 66,
  apiSha256: "7df242062417c1190b5c714ba4a34fb46cf927508989514d9e9aa5c088ed7f8b",
  workerSha256: "f55787871193d3533b0066090bb8f3b46aa25964301a39d2d3650c9bc89f0716",
  workerOnceSha256: "92991aa4ce0da619ca771216224740b00dcfd479f0fb2861fbdf0d5af3df4696"
};

async function listFiles(path) {
  const entries = await readdir(path, { withFileTypes: true });
  return (await Promise.all(entries.map(async entry => {
    const next = join(path, entry.name);
    return entry.isDirectory() ? listFiles(next) : [next];
  }))).flat();
}
async function sha(path) { return createHash("sha256").update(await readFile(path)).digest("hex"); }
async function treeSummary(path, excluded = () => false) {
  const files = (await listFiles(path)).filter(file => !excluded(relative(path, file))).sort();
  const aggregate = createHash("sha256"); let bytes = 0;
  for (const file of files) { const name = relative(path, file); const body = await readFile(file); bytes += body.length; aggregate.update(name).update("\0").update(body); }
  return { sha256: aggregate.digest("hex"), files: files.length, bytes };
}
async function copyFile(source, target) { await mkdir(dirname(target), { recursive: true }); await cp(source, target); }
async function copyTree(source, target, excluded = () => false) {
  for (const file of await listFiles(source)) { const name = relative(source, file); if (!excluded(name)) await copyFile(file, join(target, name)); }
}

await mkdir(destination, { recursive: true });
for (const name of ["index.js", "worker.js", "worker-once.js", "package.json", "package-lock.json", "release-manifest.json"]) {
  await copyFile(join(candidateRuntime, name), join(destination, "runtime", name));
}
await copyFile(join(baselineSlice, "runtime/index.js"), join(destination, "baseline/index.js"));
await copyFile(join(baselineSlice, "MANIFEST.json"), join(destination, "baseline/P0-P1-MANIFEST.json"));
await copyFile(join(baselineSlice, "evidence/CISME-P0-P1-STAGING-VERIFICATION-2026-09-11.json"), join(destination, "baseline/CISME-P0-P1-STAGING-VERIFICATION-2026-09-11.json"));

const migrations = ["202609110003_role_aware_authority.sql", "202609110004_support_foundation.sql"];
for (const name of migrations) await copyFile(join(root, "db/migrations", name), join(destination, "migrations", name));

const miniExcluded = name => name === "project.private.config.json" || name.endsWith("/.DS_Store") || basename(name) === ".DS_Store";
await copyTree(join(root, "apps/miniprogram"), join(destination, "miniprogram"), miniExcluded);

const sourceDirectories = [
  "services/api/src", "services/worker/src", "packages/config/src", "packages/contracts/src", "packages/domain/src",
  "openapi", "docs/legal", "docs/privacy"
];
for (const name of sourceDirectories) await copyTree(join(root, name), join(destination, "source", name));
for (const name of ["package.json", "package-lock.json", "docs/EVENT-CATALOG.md", "docs/adr/0004-one-app-role-aware-support.md", "docs/adr/0005-commerce-authority-direction.md", "docs/adr/0006-support-retention-lifecycle.md", "docs/evidence/CISME-R1-R2-ROLE-AWARE-SUPPORT-2026-09-11.md"]) {
  await copyFile(join(root, name), join(destination, "source", name));
}
for (const name of ["r1-r2-staging-migration-rehearsal.sh", "r1-r2-staging-runtime-verify.mjs", "r1-r2-staging-performance.mjs", "r1-r2-staging-final-state.mjs"]) {
  await copyFile(join(root, "scripts", name), join(destination, "verification", name));
}
for (const name of ["role-aware-support.test.ts", "support-performance.test.ts", "migration-lifecycle.test.ts"]) {
  await copyFile(join(root, "tests/integration", name), join(destination, "source/tests/integration", `${name}.snapshot`));
}
for (const name of ["role-aware-support-ui.test.ts", "support-model-projection.test.ts", "native-boundaries.test.ts"]) {
  await copyFile(join(root, "tests/unit", name), join(destination, "source/tests/unit", `${name}.snapshot`));
}

const patchResult = spawnSync("diff", ["-u", "--label", "baseline/index.js", "--label", "runtime/index.js", join(destination, "baseline/index.js"), join(destination, "runtime/index.js")], { encoding: "utf8" });
if (patchResult.status !== 1 || !patchResult.stdout) throw new Error(`RUNTIME_PATCH_FAILED:${patchResult.stderr}`);
await writeFile(join(destination, "runtime/index.patch"), patchResult.stdout);
const reconstructed = join(destination, "baseline/reconstructed-index.js");
await copyFile(join(destination, "baseline/index.js"), reconstructed);
const applyResult = spawnSync("patch", ["--silent", reconstructed, join(destination, "runtime/index.patch")], { encoding: "utf8" });
if (applyResult.status !== 0 || await sha(reconstructed) !== await sha(join(destination, "runtime/index.js"))) throw new Error(`RUNTIME_RECONSTRUCTION_FAILED:${applyResult.stderr}`);

const app = JSON.parse(await readFile(join(destination, "miniprogram/app.json"), "utf8"));
const mini = await treeSummary(join(destination, "miniprogram"));
mini.routes = (app.pages ?? []).length + (app.subPackages ?? []).reduce((sum, item) => sum + item.pages.length, 0);
const candidate = {
  migrationCount: 31,
  tableCount: 69,
  indexCount: 158,
  constraintCount: 905,
  apiSha256: await sha(join(destination, "runtime/index.js")),
  workerSha256: await sha(join(destination, "runtime/worker.js")),
  workerOnceSha256: await sha(join(destination, "runtime/worker-once.js")),
  packageLockSha256: await sha(join(destination, "runtime/package-lock.json")),
  runtimePatchSha256: await sha(join(destination, "runtime/index.patch")),
  migration030Sha256: await sha(join(destination, "migrations", migrations[0])),
  migration031Sha256: await sha(join(destination, "migrations", migrations[1])),
  miniprogram: mini
};
if (await sha(join(destination, "baseline/index.js")) !== expectedBaseline.apiSha256) throw new Error("BASELINE_API_HASH_MISMATCH");

const forbiddenNames = /(^|\/)(\.env($|\.)|project\.private\.config\.json|[^/]+\.(pem|key|p12|crt))$/i;
const forbiddenContent = /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\bAKID[A-Za-z0-9]{13,}\b/;
for (const file of await listFiles(destination)) {
  const name = relative(destination, file);
  if (forbiddenNames.test(name)) throw new Error(`FORBIDDEN_SECRET_FILE:${name}`);
  const body = await readFile(file);
  if (body.length <= 5_000_000 && forbiddenContent.test(body.toString("utf8"))) throw new Error(`FORBIDDEN_SECRET_CONTENT:${name}`);
}

const manifest = {
  schemaVersion: 1, releaseId, environment: "staging-only", createdAt: new Date().toISOString(),
  baseline: expectedBaseline, candidate,
  migrationOrder: ["up:29->30", "verify:30", "up:30->31", "verify:31", "down:31->30", "verify:30", "down:30->29", "verify:29-fingerprint", "up:29->30", "up:30->31", "verify:31-final"],
  candidateComponents: ["api", "worker", "worker-once", "miniprogram-staging-candidate"],
  safety: { productionAuthorized: false, formalMiniProgramUploadAuthorized: false, paymentAuthorized: false, containsConfiguration: false, containsCredentials: false, webAdminChangedBySlice: false },
  authority: { database: "CISME PostgreSQL", adminCapabilitySource: "authority_grant", clientAdminFlagsAuthoritative: false },
  retention: { conversationPolicy: "POLICY PENDING", auditPolicy: "POLICY PENDING", purgeMechanismIncluded: true, legalHoldEnforced: true },
  baselineArtifact: "baseline/P0-P1-MANIFEST.json",
  verification: ["verification/r1-r2-staging-migration-rehearsal.sh", "verification/r1-r2-staging-runtime-verify.mjs", "verification/r1-r2-staging-performance.mjs", "verification/r1-r2-staging-final-state.mjs"]
};
await writeFile(join(destination, "MANIFEST.json"), `${JSON.stringify(manifest, null, 2)}\n`);
await writeFile(join(destination, "README.md"), `# ${releaseId}\n\nStaging-only R1/R2 closure slice built from the verified P0/P1 migration-29 baseline. It contains no environment files, keys, certificates, or production authorization. The mini-program directory is the full candidate source but is not authorized for formal upload or release.\n`);

const sums = [];
for (const file of (await listFiles(destination)).sort()) {
  const name = relative(destination, file); if (name === "SHA256SUMS") continue;
  sums.push(`${await sha(file)}  ${name}`);
}
await writeFile(join(destination, "SHA256SUMS"), `${sums.join("\n")}\n`);
console.log(JSON.stringify({ packaged: true, destination, manifest }, null, 2));
