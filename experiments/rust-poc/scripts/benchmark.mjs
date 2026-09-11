import os from "node:os";
import { performance } from "node:perf_hooks";
import { spawnSync } from "node:child_process";

const targetUrl = process.env.TARGET_URL;
const targetName = process.env.TARGET_NAME;
const route = process.env.ROUTE ?? "/v1/capabilities";
const token = process.env.AUTH_TOKEN;
const samples = Number(process.env.SAMPLES ?? 300);
const concurrency = Number(process.env.CONCURRENCY ?? 10);
const warmup = Number(process.env.WARMUP ?? 50);
const round = Number(process.env.ROUND ?? 1);
const serverContainer = process.env.SERVER_CONTAINER;
if (!targetUrl || !targetName) throw new Error("TARGET_URL and TARGET_NAME are required");
if (![samples, concurrency, warmup, round].every(Number.isInteger)
  || samples < 1 || samples > 100_000 || concurrency < 1 || concurrency > 1_000
  || warmup < 0 || warmup > 10_000 || round < 1) throw new Error("BENCHMARK_OPTIONS_INVALID");
if (route.startsWith("/v1/bootstrap/") && !token) throw new Error("AUTH_TOKEN is required for bootstrap routes");

const headers = token ? { authorization: `Bearer ${token}` } : undefined;
async function one() {
  const started = performance.now();
  try {
    const response = await fetch(`${targetUrl}${route}`, { headers });
    const bytes = (await response.arrayBuffer()).byteLength;
    return { latencyMs: performance.now() - started, status: response.status, bytes };
  } catch (error) {
    return { latencyMs: performance.now() - started, status: 0, bytes: 0, error: error?.code ?? error?.name ?? "Error" };
  }
}
async function run(count, workers) {
  let cursor = 0;
  const output = [];
  await Promise.all(Array.from({ length: workers }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= count) return;
      output[index] = await one();
    }
  }));
  return output;
}

function readCgroup() {
  if (!serverContainer) return null;
  const read = (path) => {
    const result = spawnSync("docker", ["exec", serverContainer, "cat", path], { encoding: "utf8" });
    if (result.status !== 0) throw new Error(`Unable to read ${path} from ${serverContainer}`);
    return result.stdout.trim();
  };
  const cpu = Object.fromEntries(read("/sys/fs/cgroup/cpu.stat").split("\n").map((line) => line.trim().split(/\s+/, 2)));
  const processStatus = read("/proc/1/status");
  const processPeakRssKiB = Number(processStatus.match(/^VmHWM:\s+(\d+)\s+kB$/m)?.[1]);
  if (!Number.isFinite(processPeakRssKiB)) throw new Error(`Unable to read VmHWM from ${serverContainer}`);
  return {
    cpuUsageUsec: Number(cpu.usage_usec),
    memoryCurrentBytes: Number(read("/sys/fs/cgroup/memory.current")),
    memoryPeakBytes: Number(read("/sys/fs/cgroup/memory.peak")),
    processPeakRssBytes: processPeakRssKiB * 1_024,
  };
}

await run(warmup, Math.min(concurrency, Math.max(1, warmup)));
const serverBefore = readCgroup();
const startedAt = new Date().toISOString();
const started = performance.now();
const results = await run(samples, concurrency);
const elapsedMs = performance.now() - started;
const serverAfter = readCgroup();
const sorted = results.map((item) => item.latencyMs).sort((a, b) => a - b);
const percentile = (value) => sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * value) - 1)] ?? 0;
const errors = results.filter((item) => item.status < 200 || item.status >= 300);
const statuses = Object.fromEntries([...new Set(results.map((item) => item.status))].sort((a, b) => a - b)
  .map((status) => [status, results.filter((item) => item.status === status).length]));
const round2 = (value) => Math.round(value * 100) / 100;
const serverCpuMs = serverBefore && serverAfter ? (serverAfter.cpuUsageUsec - serverBefore.cpuUsageUsec) / 1_000 : null;
process.stdout.write(`${JSON.stringify({
  schemaVersion: 1,
  mode: "loopback_tcp_developer_smoke",
  startedAt,
  target: targetName,
  targetUrl,
  route,
  round,
  samples,
  concurrency,
  warmup,
  elapsedMs: round2(elapsedMs),
  requestsPerSecond: round2(samples * 1_000 / elapsedMs),
  latencyMs: { p50: round2(percentile(0.5)), p90: round2(percentile(0.9)), p95: round2(percentile(0.95)), p99: round2(percentile(0.99)), max: round2(percentile(1)) },
  errors: errors.length,
  errorRate: errors.length / samples,
  statuses,
  responseBytes: results.reduce((sum, item) => sum + item.bytes, 0),
  environment: { platform: process.platform, arch: process.arch, logicalCpus: os.cpus().length, node: process.version },
  serverCpuMs: serverCpuMs === null ? null : round2(serverCpuMs),
  serverCpuMsPerRequest: serverCpuMs === null ? null : round2(serverCpuMs / samples),
  serverMemoryCurrentBytes: serverAfter?.memoryCurrentBytes ?? null,
  serverPeakRssBytes: serverAfter?.processPeakRssBytes ?? null,
  serverContainerMemoryPeakBytes: serverAfter?.memoryPeakBytes ?? null,
  decisionGrade: Boolean(serverContainer),
  unverified: serverContainer ? ["broad_route_parity", "soak", "production_topology"] : ["serverCpu", "serverPeakRss", "capacity", "concurrency_50_to_1000", "soak", "production_topology"],
})}\n`);
