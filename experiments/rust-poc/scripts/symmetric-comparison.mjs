import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const benchmark = join(root, "scripts", "benchmark.mjs");
const evidencePath = join(root, "evidence", "symmetric-container-2026-09-10.json");
const baseUrl = "http://127.0.0.1:3330";
const containerName = "cisme-rust-fair-benchmark";
const databaseUrl = "postgres://cisme:cisme-dev-only@postgres:5432/cisme_rust_poc_test";
const sessionSecret = "rust-poc-test";
const rounds = 5;
const samples = 1_000;
const warmup = 200;
const concurrency = 50;

const commonEnv = [
  "APP_ENV=test",
  "ALLOW_DEV_ADAPTERS=true",
  `APP_SESSION_SECRET=${sessionSecret}`,
  `DATABASE_URL=${databaseUrl}`,
  "DATABASE_POOL_MAX=10",
  "DATABASE_GLOBAL_CONNECTION_BUDGET=40",
  "SERVICE_INSTANCE_COUNT=1",
  "DATABASE_POOL_ACQUIRE_TIMEOUT_MS=2000",
  "DATABASE_STATEMENT_TIMEOUT_MS=2500",
  "DATABASE_LOCK_TIMEOUT_MS=750",
  "DATABASE_IDLE_TRANSACTION_TIMEOUT_MS=5000",
  "API_ROUTE_DEADLINE_MS=8000",
];
const candidates = {
  fastify: {
    image: "cisme-fastify-benchmark:local",
    internalPort: 3100,
    env: [...commonEnv, "PORT=3100", "ADMIN_API_TOKEN=rust-poc-admin", "UPLOAD_TOKEN_SECRET=rust-poc-upload", "OBJECT_STORAGE_DRIVER=api_gateway", "RUN_BACKGROUND_WORKER=false", "LOG_LEVEL=silent"],
  },
  rust: {
    image: "cisme-rust-poc:local",
    internalPort: 3210,
    env: [...commonEnv, "RUST_POC_BIND=0.0.0.0:3210", "RUST_LOG=warn"],
  },
};

function docker(args, options = {}) {
  const result = spawnSync("docker", args, { encoding: "utf8", ...options });
  if (result.status !== 0) throw new Error(result.stderr || `docker ${args[0]} failed`);
  return result.stdout.trim();
}

function stop() {
  spawnSync("docker", ["rm", "-f", containerName], { encoding: "utf8" });
}

async function waitReady() {
  const deadline = Date.now() + 30_000;
  let last = "not attempted";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/health/ready`);
      if (response.ok) return;
      last = `HTTP ${response.status}`;
    } catch (error) {
      last = error?.cause?.code ?? error?.message ?? "request failed";
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`candidate readiness timeout: ${last}`);
}

async function start(target) {
  stop();
  const candidate = candidates[target];
  const started = performance.now();
  docker([
    "run", "-d", "--rm", "--name", containerName,
    "--platform", "linux/arm64", "--cpus", "1", "--memory", "512m", "--pids-limit", "256",
    "--network", "cisme-r0_default", "-p", `127.0.0.1:3330:${candidate.internalPort}`,
    ...candidate.env.flatMap((value) => ["-e", value]),
    candidate.image,
  ]);
  await waitReady();
  return Math.round((performance.now() - started) * 100) / 100;
}

async function jsonResponse(path, init) {
  const started = performance.now();
  const response = await fetch(`${baseUrl}${path}`, init);
  return {
    status: response.status,
    body: await response.json(),
    latencyMs: Math.round((performance.now() - started) * 100) / 100,
  };
}

function normalized(value, key = "") {
  if (key === "asOf" || key === "trace_id") return undefined;
  if (Array.isArray(value)) return value.map((item) => normalized(item));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).flatMap(([childKey, child]) => {
    const result = normalized(child, childKey);
    return result === undefined ? [] : [[childKey, result]];
  }));
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value)) {
    const timestamp = Date.parse(value);
    if (Number.isFinite(timestamp)) return new Date(timestamp).toISOString();
  }
  return value;
}

function same(left, right) {
  return JSON.stringify(normalized(left)) === JSON.stringify(normalized(right));
}

function runBenchmark(target, route, token, round) {
  const result = spawnSync(process.execPath, [benchmark], {
    encoding: "utf8",
    env: {
      ...process.env,
      TARGET_NAME: target,
      TARGET_URL: baseUrl,
      ROUTE: route,
      ROUND: String(round),
      SAMPLES: String(samples),
      CONCURRENCY: String(concurrency),
      WARMUP: String(warmup),
      SERVER_CONTAINER: containerName,
      ...(token ? { AUTH_TOKEN: token } : {}),
    },
  });
  if (result.status !== 0) throw new Error(result.stderr || `${target} ${route} benchmark failed`);
  return JSON.parse(result.stdout);
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

const startup = [];
const results = [];
const parityBodies = {};
let token;
try {
  startup.push({ target: "fastify", phase: "fixture", startupMs: await start("fastify") });
  const identity = await jsonResponse("/v1/identity/dev", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      externalUserId: "rust-poc-symmetric-benchmark",
      displayName: "Rust PoC symmetric benchmark",
      consents: [{ documentType: "privacy", version: "rust-poc" }, { documentType: "terms", version: "rust-poc" }],
    }),
  });
  if (identity.status !== 200 || typeof identity.body.sessionToken !== "string") throw new Error(`fixture identity failed: ${identity.status}`);
  token = identity.body.sessionToken;
  stop();

  for (let round = 1; round <= rounds; round += 1) {
    const order = round % 2 === 1 ? ["fastify", "rust"] : ["rust", "fastify"];
    for (const target of order) {
      const startupMs = await start(target);
      const cold = await jsonResponse("/v1/capabilities");
      const capabilities = cold.body;
      const settings = (await jsonResponse("/v1/bootstrap/settings", { headers: { authorization: `Bearer ${token}` } })).body;
      parityBodies[target] = { capabilities, settings };
      startup.push({ target, phase: "measured", round, startupMs, firstRequestMs: cold.latencyMs });
      results.push(runBenchmark(target, "/v1/capabilities", null, round));
      results.push(runBenchmark(target, "/v1/bootstrap/settings", token, round));
      stop();
    }
  }
} finally {
  stop();
}

const summary = Object.fromEntries(Object.keys(candidates).map((target) => [target, Object.fromEntries([
  "/v1/capabilities", "/v1/bootstrap/settings",
].map((route) => {
  const rows = results.filter((item) => item.target === target && item.route === route);
  return [route, {
    medianP95Ms: median(rows.map((item) => item.latencyMs.p95)),
    medianP99Ms: median(rows.map((item) => item.latencyMs.p99)),
    medianRps: median(rows.map((item) => item.requestsPerSecond)),
    medianServerCpuMsPerRequest: median(rows.map((item) => item.serverCpuMsPerRequest)),
    medianPeakRssBytes: median(rows.map((item) => item.serverPeakRssBytes)),
    medianContainerMemoryPeakBytes: median(rows.map((item) => item.serverContainerMemoryPeakBytes)),
    errors: rows.reduce((sum, item) => sum + item.errors, 0),
  }];
}))]));

const evidence = {
  schemaVersion: 2,
  generatedAt: new Date().toISOString(),
  mode: "symmetric_linux_arm64_container",
  parameters: { rounds, samplesPerRouteCandidateRound: samples, warmupPerRouteCandidateRound: warmup, concurrency, cpuLimit: 1, memoryLimitBytes: 536_870_912, poolMax: 10 },
  environment: { architecture: "linux/arm64", dockerNetwork: "same_bridge_and_host_port_path", database: "same_isolated_cisme_test_database", candidatesRunOneAtATime: true, imageBuilds: { fastify: candidates.fastify.image, rust: candidates.rust.image } },
  parity: { capabilities: same(parityBodies.fastify.capabilities, parityBodies.rust.capabilities), settingsBootstrap: same(parityBodies.fastify.settings, parityBodies.rust.settings) },
  startup,
  results,
  medianSummary: summary,
  decisionGradeForImplementedScope: results.every((item) => item.decisionGrade && item.errors === 0) && Object.values({ capabilities: same(parityBodies.fastify.capabilities, parityBodies.rust.capabilities), settings: same(parityBodies.fastify.settings, parityBodies.rust.settings) }).every(Boolean),
  migrationDecisionGrade: false,
  limitations: ["only_capabilities_and_settings_bootstrap", "tiny_identity_fixture", "no_feed_comments_writes_worker_or_media_parity", "no_production_network_or_cold_start", "no_long_soak"],
};
await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({ evidencePath, parity: evidence.parity, medianSummary: evidence.medianSummary, decisionGradeForImplementedScope: evidence.decisionGradeForImplementedScope })}\n`);
