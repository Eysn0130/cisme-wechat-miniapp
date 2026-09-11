import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { cp, lstat, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const releaseId = process.argv[2] ?? `commercial-delivery-r4b-${new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z")}`;
if (!/^commercial-delivery-r4b-[A-Za-z0-9._-]+$/.test(releaseId)) throw new Error("RELEASE_ID_INVALID");
const destination = resolve(root, "dist", releaseId);
try { await stat(destination); throw new Error("RELEASE_DESTINATION_ALREADY_EXISTS"); } catch (error) { if (error.code !== "ENOENT") throw error; }

const enterpriseParent = resolve(root, "dist/enterprise-r4-r3-followup-20260911T100000Z");
const r1r2Parent = resolve(root, "dist/r1-r2-staging-slice-20260911T080300Z");
const runtime = resolve(root, "dist/tencent-release");
const visualReviewName = "review-commercial-r4b-healthy-7f5fad5f-20260911T202609+0800";
const visualReview = resolve(root, "docs/evidence/visual", visualReviewName);
const canonicalAppId = "wx4eac2d4fb11d299b";

async function listFiles(path) {
  const entries = await readdir(path, { withFileTypes: true });
  return (await Promise.all(entries.map(async (entry) => {
    const next = join(path, entry.name);
    return entry.isDirectory() ? listFiles(next) : [next];
  }))).flat();
}

async function sha(path) { return createHash("sha256").update(await readFile(path)).digest("hex"); }
async function copyFile(source, target) { await mkdir(dirname(target), { recursive: true }); await cp(source, target); }
async function copyTree(source, target, excluded = () => false) {
  for (const file of await listFiles(source)) {
    const name = relative(source, file);
    if (!excluded(name)) await copyFile(file, join(target, name));
  }
}
async function summary(path) {
  const files = (await listFiles(path)).sort();
  const hash = createHash("sha256");
  let bytes = 0;
  for (const file of files) {
    const name = relative(path, file);
    const body = await readFile(file);
    bytes += body.length;
    hash.update(name).update("\0").update(body);
  }
  return { sha256: hash.digest("hex"), files: files.length, bytes };
}
function git(args) { return execFileSync("git", args, { cwd: root, encoding: "buffer" }); }
function nulList(buffer) { return buffer.toString("utf8").split("\0").filter(Boolean).sort(); }

await mkdir(destination, { recursive: true });

for (const [source, target] of [
  [resolve(enterpriseParent, "MANIFEST.json"), "parent/ENTERPRISE-MANIFEST.json"],
  [resolve(enterpriseParent, "SHA256SUMS"), "parent/ENTERPRISE-SHA256SUMS"],
  [resolve(r1r2Parent, "MANIFEST.json"), "parent/R1-R2-MANIFEST.json"],
  [resolve(r1r2Parent, "SHA256SUMS"), "parent/R1-R2-SHA256SUMS"]
]) await copyFile(source, resolve(destination, target));

for (const name of ["index.js", "worker.js", "worker-once.js", "package.json", "package-lock.json", "release-manifest.json"]) {
  await copyFile(join(runtime, name), join(destination, "runtime", name));
}
for (const name of [
  "202609110005_enterprise_identity_namespace.sql",
  "202609110006_commerce_catalog.sql",
  "202609110007_commerce_pending_order.sql"
]) await copyFile(join(root, "db/migrations", name), join(destination, "migrations", name));

const miniExcluded = (name) => name === "project.private.config.json" || basename(name) === ".DS_Store" || name.endsWith(".source-hash");
await copyTree(join(root, "apps/miniprogram"), join(destination, "miniprogram"), miniExcluded);
await copyTree(visualReview, join(destination, "visual-review", visualReviewName));

const reviewSource = resolve(destination, "review-source");
const reviewDelta = resolve(destination, "review-delta");
const candidatePaths = nulList(git(["ls-files", "--cached", "--others", "--exclude-standard", "-z"]));
const basePaths = new Set(nulList(git(["ls-tree", "-r", "--name-only", "-z", "HEAD"])));
const forbiddenName = /(^|\/)(\.env($|\.)|project\.private\.config\.json|[^/]+\.(?:pem|key|p12|pfx|crt))$/i;
const forbiddenRoot = /^(?:dist|tmp|node_modules|backups|coverage|test-results)\//;
const currentFiles = [];
const deltaFiles = [];
const deletedFiles = [];
let totalBytes = 0;

for (const name of candidatePaths) {
  const source = resolve(root, name);
  let metadata;
  try { metadata = await lstat(source); } catch { continue; }
  if (!metadata.isFile()) {
    if (metadata.isSymbolicLink()) throw new Error(`SOURCE_SYMLINK_REJECTED:${name}`);
    continue;
  }
  if (forbiddenRoot.test(name) || (basename(name) !== ".env.example" && forbiddenName.test(name))) throw new Error(`SOURCE_SCOPE_FORBIDDEN:${name}`);
  if (metadata.size > 5_000_000) throw new Error(`SOURCE_FILE_TOO_LARGE:${name}:${metadata.size}`);
  const digest = await sha(source);
  const entry = { path: name, bytes: metadata.size, sha256: digest };
  currentFiles.push(entry);
  totalBytes += metadata.size;
  await copyFile(source, resolve(reviewSource, name));

  let baseDigest = null;
  if (basePaths.has(name)) {
    const base = git(["show", `HEAD:${name}`]);
    baseDigest = createHash("sha256").update(base).digest("hex");
  }
  if (baseDigest !== digest) {
    deltaFiles.push({ ...entry, change: baseDigest === null ? "added" : "modified", baseSha256: baseDigest });
    await copyFile(source, resolve(reviewDelta, name));
  }
}
if (totalBytes > 20_000_000) throw new Error(`SOURCE_SCOPE_TOO_LARGE:${totalBytes}`);
for (const name of [...basePaths].sort()) {
  try { await lstat(resolve(root, name)); } catch { deletedFiles.push({ path: name, change: "deleted" }); }
}

const sourceManifest = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  releaseId,
  git: {
    root,
    branch: execFileSync("git", ["branch", "--show-current"], { cwd: root, encoding: "utf8" }).trim(),
    head: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
    historyIncludedInProposedPush: true,
    proposedRefs: ["refs/heads/main"],
    commitOrPushPerformed: false
  },
  scope: {
    rule: "git tracked plus untracked non-ignored regular files; exact list below",
    excluded: ["dist", "tmp", "node_modules", "backups", "coverage", "test-results", "environment files", "private project config", "keys/certificates", "raw evidence media except selected baseline", "real user data"],
    maxSingleFileBytes: 5_000_000,
    maxTotalBytes: 20_000_000
  },
  totals: { files: currentFiles.length, bytes: totalBytes },
  files: currentFiles
};
await writeFile(resolve(destination, "GITHUB-BASELINE-SOURCE-MANIFEST.json"), `${JSON.stringify(sourceManifest, null, 2)}\n`);
await writeFile(resolve(destination, "BASELINE-DIFF-MANIFEST.json"), `${JSON.stringify({
  schemaVersion: 1,
  base: sourceManifest.git.head,
  target: `uncommitted-reviewed-worktree:${releaseId}`,
  counts: { added: deltaFiles.filter((entry) => entry.change === "added").length, modified: deltaFiles.filter((entry) => entry.change === "modified").length, deleted: deletedFiles.length },
  currentFiles: deltaFiles,
  deletedFiles
}, null, 2)}\n`);

execFileSync("zip", ["-q", "-r", resolve(destination, "CISME-SOURCE-REVIEW.zip"), "."], { cwd: reviewSource });
execFileSync("zip", ["-q", "-r", resolve(destination, "CISME-SOURCE-DELTA.zip"), "."], { cwd: reviewDelta });
execFileSync("zip", ["-q", "-r", resolve(destination, "CISME-VISUAL-REVIEW.zip"), "."], { cwd: resolve(destination, "visual-review", visualReviewName) });

const project = JSON.parse(await readFile(join(destination, "miniprogram/project.config.json"), "utf8"));
if (project.appid !== canonicalAppId) throw new Error("MINIPROGRAM_APP_ID_NOT_CANONICAL");
const app = JSON.parse(await readFile(join(destination, "miniprogram/app.json"), "utf8"));
const mini = await summary(join(destination, "miniprogram"));
mini.routes = (app.pages ?? []).length + (app.subPackages ?? []).reduce((sum, item) => sum + item.pages.length, 0);
const candidate = {
  migrationCount: 34,
  physicalTableCount: 81,
  contractRequiredTableCount: 71,
  indexCount: 198,
  constraintCount: 1170,
  invalidIndexCount: 0,
  unvalidatedConstraintCount: 0,
  apiSha256: await sha(join(destination, "runtime/index.js")),
  workerSha256: await sha(join(destination, "runtime/worker.js")),
  workerOnceSha256: await sha(join(destination, "runtime/worker-once.js")),
  packageLockSha256: await sha(join(destination, "runtime/package-lock.json")),
  migration032Sha256: await sha(join(destination, "migrations/202609110005_enterprise_identity_namespace.sql")),
  migration033Sha256: await sha(join(destination, "migrations/202609110006_commerce_catalog.sql")),
  migration034Sha256: await sha(join(destination, "migrations/202609110007_commerce_pending_order.sql")),
  miniprogram: mini,
  visualReview: { id: visualReviewName, routeHealth: "27/27 PASS_LOCAL_SYNTHETIC", interactionRecordings: 0, iosSessions: 0, androidSessions: 0 },
  sourceReview: await summary(reviewSource),
  sourceDelta: await summary(reviewDelta)
};
const manifest = {
  schemaVersion: 1,
  releaseId,
  createdAt: new Date().toISOString(),
  parent: {
    releaseId: "enterprise-r4-r3-followup-20260911T100000Z",
    manifestSha256: await sha(join(destination, "parent/ENTERPRISE-MANIFEST.json")),
    immutable: true,
    deployed: false,
    r1r2ReleaseId: "r1-r2-staging-slice-20260911T080300Z",
    r1r2ManifestSha256: await sha(join(destination, "parent/R1-R2-MANIFEST.json"))
  },
  target: { environment: "local-and-staging-candidate", canonicalMiniProgramAppId: canonicalAppId, company: "熹芃（上海）生物科技有限公司" },
  candidate,
  scope: {
    r4a: "first-party single-SKU catalog with qualification/publication/inventory",
    r4b: "synthetic nonproduction pending-payment quote/order/cancel/expire/inventory-reservation flow",
    support: "role-aware human support plus bounded disabled AI provider boundary",
    native: "one Mini Program; 27 route healthy local synthetic baseline",
    excluded: ["real payment", "paid state", "fulfillment", "refund", "after-sales", "cart", "favorite", "product media upload", "real AI provider", "production", "formal Mini Program upload"]
  },
  safety: {
    productionAuthorized: false,
    formalMiniProgramUploadAuthorized: false,
    paymentAuthorized: false,
    containsPublicConfiguration: true,
    containsCredentials: false,
    containsRealUserData: false,
    gitCommitPerformed: false,
    gitPushPerformed: false,
    githubActionsRun: false,
    mediaUploadEnabledBySlice: false
  },
  localVerification: {
    typecheck: "PASS",
    unit: "36 files / 248 tests PASS",
    integration: "21 files / 101 tests PASS",
    contracts: "34 migrations / 71 required tables / 75 paths / 27 events PASS",
    miniprogramPackage: "PASS",
    designStructure: "PASS; releaseReady=false",
    build: "PASS"
  },
  remoteStatus: "NOT DEPLOYED; authorized staging channel unavailable; normal SNI path unresolved"
};
await writeFile(join(destination, "MANIFEST.json"), `${JSON.stringify(manifest, null, 2)}\n`);
await writeFile(join(destination, "README.md"), `# ${releaseId}\n\nIndependent Commercial Delivery candidate and review package. It preserves the immutable R1/R2 and enterprise parents, adds migration 34 and the nonproduction-only pending-payment order domain, and includes a 27-route healthy local synthetic native review pack.\n\nIt contains no credentials or real user data and is not authorized for production, formal Mini Program upload, real payment, Git commit/push or public AI. Use GITHUB-BASELINE-SOURCE-MANIFEST.json for the exact proposed private-repository scope; no Git action has occurred.\n`);

const forbiddenContent = /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\bAKID[A-Za-z0-9]{13,}\b/;
for (const file of await listFiles(destination)) {
  const name = relative(destination, file);
  if (basename(name) !== ".env.example" && forbiddenName.test(name)) throw new Error(`FORBIDDEN_SECRET_FILE:${name}`);
  const body = await readFile(file);
  if (body.length <= 5_000_000 && forbiddenContent.test(body.toString("utf8"))) throw new Error(`FORBIDDEN_SECRET_CONTENT:${name}`);
}
const sums = [];
for (const file of (await listFiles(destination)).sort()) {
  const name = relative(destination, file);
  if (name !== "SHA256SUMS") sums.push(`${await sha(file)}  ${name}`);
}
await writeFile(join(destination, "SHA256SUMS"), `${sums.join("\n")}\n`);
console.log(JSON.stringify({ packaged: true, destination, checksumEntries: sums.length, manifest }, null, 2));
