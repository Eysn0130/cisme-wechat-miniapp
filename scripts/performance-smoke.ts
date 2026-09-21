import { localPerformanceDatabase, timeoutResponse } from "./performance-measurement.js";
import { performance } from "node:perf_hooks";
import { loadConfig } from "@cisme/config";
import { resetDatabase } from "@cisme/testkit";
import { createPool } from "../services/api/src/db.js";
import { createApp } from "../services/api/src/server.js";
import { createApiGatewayStorage } from "../services/api/src/storage.js";

if (process.env.PERF_ALLOW_RESET !== "true") throw new Error("PERF_ALLOW_RESET_REQUIRED: this smoke test resets its dedicated cisme_*test* database");
const databaseUrl = localPerformanceDatabase();
const concurrency = Number(process.env.PERF_CONCURRENCY ?? 10);
const samples = Number(process.env.PERF_SAMPLES ?? 200);
const p95BudgetMs = Number(process.env.PERF_P95_MS ?? 500);
const errorRateBudget = Number(process.env.PERF_ERROR_RATE ?? 0.01);
if (![concurrency, samples].every(Number.isInteger) || ![concurrency, samples, p95BudgetMs, errorRateBudget].every(Number.isFinite) || concurrency < 1 || concurrency > 100 || samples < concurrency || samples > 10_000 || p95BudgetMs < 1 || errorRateBudget < 0 || errorRateBudget > 1) throw new Error("PERF_OPTIONS_INVALID");

const config = loadConfig({ APP_ENV: "test", DATABASE_URL: databaseUrl, ALLOW_DEV_ADAPTERS: "true", APP_SESSION_SECRET: "perf-session", ADMIN_API_TOKEN: "perf-admin", UPLOAD_TOKEN_SECRET: "perf-upload", OBJECT_STORAGE_DRIVER: "api_gateway", DATABASE_POOL_MAX: String(Math.min(20, concurrency)) });
const pool = createPool(databaseUrl, config.database);
await resetDatabase(pool);
const app = await createApp({ config, pool, storage: createApiGatewayStorage(config) });
try {
  // Preserve production limits. Setup 100 independent synthetic members and
  // inject explicit synthetic source addresses instead of overloading one user.
  const identities: Array<{ sessionToken: string; remoteAddress: string }> = [];
  for (let index = 0; index < 100; index++) {
    const remoteAddress = `192.0.2.${index + 1}`;
    const response = await app.inject({ method: "POST", url: "/v1/identity/dev", remoteAddress,
      payload: { externalUserId: `performance-smoke-${index}`, displayName: "性能门禁合成会员",
        consents: [{ documentType: "privacy", version: "perf" }, { documentType: "terms", version: "perf" }] } });
    if (response.statusCode !== 200 || !response.json().sessionToken) throw new Error("PERF_IDENTITY_SETUP_FAILED");
    identities.push({ sessionToken: response.json().sessionToken, remoteAddress });
  }
  const latencies: number[] = [];
  const byRoute: Record<string, { latencies: number[]; errors: number; timeouts: number; statuses: Record<string, number>; successLatencies: number[] }> = {};
  let errors = 0, cursor = 0;
  const started = performance.now();
  async function worker() {
    while (true) {
      const index = cursor++;
      if (index >= samples) return;
      const identity = identities[index % identities.length]!;
      const before = performance.now();
      const response = index % 4 === 0
        ? await app.inject({ method: "GET", url: "/v1/capabilities", remoteAddress: identity.remoteAddress })
        : await app.inject({ method: "GET", url: "/v1/bootstrap/home", remoteAddress: identity.remoteAddress, headers: { authorization: `Bearer ${identity.sessionToken}` } });
      const elapsed = performance.now() - before;
      latencies.push(elapsed);
      const route = index % 4 === 0 ? "GET /v1/capabilities" : "GET /v1/bootstrap/home";
      const bucket = byRoute[route] ??= { latencies: [], errors: 0, timeouts: 0, statuses: {}, successLatencies: [] };
      bucket.latencies.push(elapsed);
      if (response.statusCode < 200 || response.statusCode >= 300) { errors += 1; bucket.errors += 1; }
      else bucket.successLatencies.push(elapsed);
      bucket.statuses[response.statusCode] = (bucket.statuses[response.statusCode] ?? 0) + 1;
      if (timeoutResponse(response.statusCode, response.payload)) bucket.timeouts += 1;
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  const elapsedMs = performance.now() - started;
  latencies.sort((a,b) => a-b);
  const percentile = (p: number) => latencies[Math.min(latencies.length - 1, Math.ceil(latencies.length * p) - 1)] ?? 0;
  const routes = Object.fromEntries(Object.entries(byRoute).map(([route, bucket]) => {
    bucket.latencies.sort((a,b) => a-b);
    const p = (fraction: number) => bucket.latencies[Math.min(bucket.latencies.length-1,Math.ceil(bucket.latencies.length*fraction)-1)] ?? 0;
    return [route, { samples: bucket.latencies.length, latencyMs: { p50:p(.5),p95:p(.95),p99:p(.99),max:bucket.latencies.at(-1) ?? 0 }, errors:bucket.errors,timeouts:bucket.timeouts,statuses:bucket.statuses,rateLimited:bucket.statuses[429] ?? 0,successfulSamples:bucket.successLatencies.length,errorRate:bucket.errors/bucket.latencies.length }];
  }));
  const report = { population: { syntheticMembers: identities.length, rateLimitsUnchanged: true, setupExcluded: true }, timingBoundary: "server app.inject + isolated DB; no DNS/TLS/mobile/rendering", routes, mode: "in_process_isolated_db_smoke", samples, concurrency, elapsedMs: Math.round(elapsedMs * 100) / 100, requestsPerSecond: Math.round(samples / elapsedMs * 100_000) / 100,
    latencyMs: { p50: percentile(.5), p95: percentile(.95), p99: percentile(.99), max: latencies.at(-1) ?? 0 }, errors, errorRate: errors / samples,
    thresholds: { p95Ms: p95BudgetMs, errorRate: errorRateBudget } };
  console.log(JSON.stringify(report, null, 2));
  if (report.latencyMs.p95 > p95BudgetMs || report.errorRate > errorRateBudget || Object.values(routes).some(route => route.latencyMs.p95 > p95BudgetMs || route.errorRate > errorRateBudget)) process.exitCode = 1;
} finally {
  await app.close();
  await pool.end();
}
