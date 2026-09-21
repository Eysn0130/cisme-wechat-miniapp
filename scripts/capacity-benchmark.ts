import { localPerformanceDatabase, loopbackPopulation, timeoutResponse } from "./performance-measurement.js";
import { availableParallelism } from "node:os";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { loadConfig } from "@cisme/config";
import { resetDatabase } from "@cisme/testkit";
import { issueSessionToken } from "../services/api/src/auth.js";
import { createPool } from "../services/api/src/db.js";
import { resetRuntimeMetrics, runtimeMetrics } from "../services/api/src/observability.js";
import { createApp } from "../services/api/src/server.js";
import { createApiGatewayStorage } from "../services/api/src/storage.js";

type Scenario = "cheap" | "bootstrap" | "feed" | "comments" | "mixed";
type Pattern = "matrix" | "spike" | "soak" | "pool_saturation";

function integer(name: string, fallback: number, minimum: number, maximum: number): number {
  const parsed = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) throw new Error(`CAPACITY_OPTION_INVALID:${name}`);
  return parsed;
}

function levels(): number[] {
  const values = (process.env.CAPACITY_LEVELS ?? "50,100,200,500,1000").split(",").map(Number);
  if (!values.length || values.some((value) => !Number.isInteger(value) || value < 1 || value > 1_000)) throw new Error("CAPACITY_OPTION_INVALID:CAPACITY_LEVELS");
  return [...new Set(values)];
}

function percentile(sorted: number[], fraction: number): number {
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)] ?? 0;
}

function round(value: number): number { return Math.round(value * 100) / 100; }

function summarize(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  return { p50: round(percentile(sorted, 0.5)), p90: round(percentile(sorted, 0.9)), p95: round(percentile(sorted, 0.95)), p99: round(percentile(sorted, 0.99)), max: round(sorted.at(-1) ?? 0) };
}

if (process.env.CAPACITY_ALLOW_RESET !== "true") throw new Error("CAPACITY_ALLOW_RESET_REQUIRED: benchmark resets a dedicated cisme_*test* database");
const databaseUrl = localPerformanceDatabase();
const fixtureUsers = integer("CAPACITY_FIXTURE_USERS", 1_000, 100, 100_000);
if (![100, 1_000, 10_000, 100_000].includes(fixtureUsers)) throw new Error("CAPACITY_OPTION_INVALID:CAPACITY_FIXTURE_USERS");
const rounds = integer("CAPACITY_ROUNDS", 3, 2, 10);
const requestsPerWorker = integer("CAPACITY_REQUESTS_PER_WORKER", 4, 1, 100);
const scenario = (process.env.CAPACITY_SCENARIO ?? "mixed") as Scenario;
if (!["cheap", "bootstrap", "feed", "comments", "mixed"].includes(scenario)) throw new Error("CAPACITY_OPTION_INVALID:CAPACITY_SCENARIO");
const pattern = (process.env.CAPACITY_PATTERN ?? "matrix") as Pattern;
if (!["matrix", "spike", "soak", "pool_saturation"].includes(pattern)) throw new Error("CAPACITY_OPTION_INVALID:CAPACITY_PATTERN");
const sessionSecret = "capacity-benchmark-session";
const config = loadConfig({
  APP_ENV: "test", DATABASE_URL: databaseUrl, ALLOW_DEV_ADAPTERS: "true", APP_SESSION_SECRET: sessionSecret,
  ADMIN_API_TOKEN: "capacity-benchmark-admin", UPLOAD_TOKEN_SECRET: "capacity-benchmark-upload", OBJECT_STORAGE_DRIVER: "api_gateway",
  DATABASE_POOL_MAX: process.env.CAPACITY_POOL_MAX ?? "20", DATABASE_GLOBAL_CONNECTION_BUDGET: "40", SERVICE_INSTANCE_COUNT: "1",
  DATABASE_POOL_ACQUIRE_TIMEOUT_MS: process.env.CAPACITY_POOL_ACQUIRE_TIMEOUT_MS ?? (pattern === "pool_saturation" ? "250" : "2000"),
  UGC_GO_LIVE_GATE: "true", UGC_LEGAL_APPROVAL_ID: "capacity-test-only", UGC_PROVENANCE_READY: "true",
  UGC_CONTENT_SAFETY_READY: "true", UGC_MODERATION_READY: "true", LOG_LEVEL: "silent"
});
const pool = createPool(databaseUrl, config.database);

async function seed(): Promise<string[]> {
  await resetDatabase(pool);
  await pool.query(`INSERT INTO member(display_name,created_at)
    SELECT 'Capacity member ' || sequence, now() - (sequence % 10000) * interval '1 second'
    FROM generate_series(1,$1::int) sequence`, [fixtureUsers]);
  await pool.query("INSERT INTO points_projection(member_id) SELECT id FROM member");
  const feedItems = Math.min(fixtureUsers, 5_000);
  await pool.query(`INSERT INTO submission(member_id,status,post_url,platform_account,disclosure,license_payload,created_at,updated_at)
    SELECT id,'approved','https://capacity.invalid/' || id,'capacity','synthetic isolated fixture','{}'::jsonb,created_at,created_at
    FROM member ORDER BY created_at,id LIMIT $1`, [feedItems]);
  await pool.query(`INSERT INTO feed_item(submission_id,member_id,title,excerpt,published_at,visible,ai_usage)
    SELECT id,member_id,'Capacity item','Synthetic isolated benchmark item',created_at,true,'none' FROM submission`);
  const interactionRows = Math.min(fixtureUsers, 20_000);
  // Bulk synthetic loading is not an application write path. Avoid measuring
  // tens of thousands of row-trigger counter updates as fixture setup, then
  // rebuild the exact derived counters before enabling the triggers again.
  const fixtureClient = await pool.connect();
  try {
    await fixtureClient.query("BEGIN");
    await fixtureClient.query("ALTER TABLE community_comment DISABLE TRIGGER community_comment_stats; ALTER TABLE community_reaction DISABLE TRIGGER community_reaction_stats");
    await fixtureClient.query(`INSERT INTO community_comment(post_id,member_id,body,status,was_public,operation_id,created_at)
      SELECT 'brand-scalp-ritual',id,'Synthetic comment','published',true,'capacity-' || id,created_at
      FROM member ORDER BY created_at,id LIMIT $1`, [interactionRows]);
    await fixtureClient.query(`INSERT INTO community_reaction(member_id,post_id,kind)
      SELECT id,'brand-scalp-ritual','like' FROM member ORDER BY created_at,id LIMIT $1`, [interactionRows]);
    await fixtureClient.query(`INSERT INTO community_reaction(member_id,post_id,kind)
      SELECT id,'brand-scalp-ritual','save' FROM member WHERE mod(abs(hashtext(id::text)),3)=0 ORDER BY created_at,id LIMIT $1`, [Math.ceil(interactionRows / 3)]);
    await fixtureClient.query("TRUNCATE community_post_stats");
    await fixtureClient.query(`INSERT INTO community_post_stats(post_id,like_count,save_count,comment_count)
      SELECT post_id,count(*) FILTER (WHERE source='reaction' AND kind='like')::int,
        count(*) FILTER (WHERE source='reaction' AND kind='save')::int,count(*) FILTER (WHERE source='comment')::int
      FROM (
        SELECT r.post_id,'reaction'::text source,r.kind FROM community_reaction r JOIN member m ON m.id=r.member_id AND m.status='active'
        UNION ALL SELECT c.post_id,'comment'::text,NULL::text FROM community_comment c JOIN member m ON m.id=c.member_id AND m.status='active' WHERE c.status='published'
      ) interactions GROUP BY post_id`);
    await fixtureClient.query("ALTER TABLE community_comment ENABLE TRIGGER community_comment_stats; ALTER TABLE community_reaction ENABLE TRIGGER community_reaction_stats");
    await fixtureClient.query("COMMIT");
  } catch (error) {
    await fixtureClient.query("ROLLBACK");
    throw error;
  } finally {
    fixtureClient.release();
  }
  // Bulk synthetic fixtures otherwise leave PostgreSQL with empty-table
  // estimates and measure an artificial post-load planning failure.
  await pool.query("ANALYZE member, points_projection, submission, feed_item, community_comment, community_reaction, community_comment_like");
  const members = await pool.query<{ id: string }>("SELECT id FROM member ORDER BY created_at,id LIMIT 2000");
  return members.rows.map((row) => row.id);
}

const seedStarted = performance.now();
const memberIds = await seed();
const seedMs = performance.now() - seedStarted;
const tokens = memberIds.map((memberId) => issueSessionToken({ principalId: `member:${memberId}`, memberId, adapter: "dev", provider: "dev_test", appId: "dev" }, sessionSecret));
const startupStarted = performance.now();
const app = await createApp({ config, pool, storage: createApiGatewayStorage(config) });
const address = await app.listen({ host: "127.0.0.1", port: 0 });
const startupMs = performance.now() - startupStarted;
const populationMode = process.env.CAPACITY_CLIENT_MODE ?? "single-origin";
if (!["single-origin", "loopback-population"].includes(populationMode)) throw new Error("CAPACITY_CLIENT_MODE_INVALID");
const population = populationMode === "loopback-population" ? loopbackPopulation(tokens.length) : undefined;

function requestFor(index: number, selected: Scenario): { path: string; init?: RequestInit } {
  const token = tokens[index % tokens.length]!;
  const authenticated = { authorization: `Bearer ${token}` };
  if (selected === "cheap") return { path: "/v1/capabilities" };
  if (selected === "bootstrap") return { path: "/v1/bootstrap/home", init: { headers: authenticated } };
  if (selected === "feed") return { path: "/v1/feed/page?limit=20" };
  if (selected === "comments") return { path: "/v1/community/brand-scalp-ritual?limit=50" };
  const selector = index % 24;
  if (selector < 2) return { path: "/v1/capabilities" };
  if (selector < 8) return { path: "/v1/bootstrap/home", init: { headers: authenticated } };
  if (selector < 12) return { path: "/v1/feed/page?limit=20" };
  if (selector < 15) return { path: "/v1/community/brand-scalp-ritual?limit=50" };
  if (selector < 17) return { path: "/v1/bootstrap/profile", init: { headers: authenticated } };
  if (selector === 17) return { path: "/v1/bootstrap/settings", init: { headers: authenticated } };
  if (selector < 20) return { path: "/v1/me/points?limit=20", init: { headers: authenticated } };
  if (selector < 22) return { path: "/v1/me/care?limit=20", init: { headers: authenticated } };
  return { path: "/v1/community/brand-scalp-ritual/reaction", init: { method: "PUT", headers: { ...authenticated, "content-type": "application/json" }, body: JSON.stringify({ kind: "like", active: index % 48 !== 23 }) } };
}

async function one(index: number, selected: Scenario) {
  const input = requestFor(index, selected);
  const route = `${input.init?.method ?? "GET"} ${input.path.split("?")[0]}`;
  const started = performance.now();
  try {
    const response = population ? await population.send(`${address}${input.path}`, index, input.init) : await (async () => {
      const value = await fetch(`${address}${input.path}`, { ...input.init, signal: AbortSignal.timeout(12_000) });
      const body = await value.text(); return { status: value.status, body, bytes: Buffer.byteLength(body) };
    })();
    return { route, latencyMs: performance.now() - started, status: response.status, bytes: response.bytes,
      timeout: timeoutResponse(response.status, response.body) };
  } catch {
    return { route, latencyMs: performance.now() - started, status: 0, bytes: 0, timeout: true };
  }
}

async function load(concurrency: number, targetRequests: number | null, selected: Scenario = scenario, durationMs?: number) {
  let cursor = 0;
  const latencies: number[] = [], bytes: number[] = [];
  const statuses = new Map<number, number>();
  const byRoute: Record<string, { latencies: number[]; successes: number[]; errors: number; timeouts: number; statuses: Record<string, number> }> = {};
  let timeoutCount = 0;
  let peakRss = process.memoryUsage().rss, peakPoolTotal = pool.totalCount, peakPoolWaiting = pool.waitingCount;
  const sampler = setInterval(() => {
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
    peakPoolTotal = Math.max(peakPoolTotal, pool.totalCount);
    peakPoolWaiting = Math.max(peakPoolWaiting, pool.waitingCount);
  }, 5);
  const cpuBefore = process.cpuUsage();
  const eluBefore = performance.eventLoopUtilization();
  const started = performance.now();
  const deadline = durationMs === undefined ? null : started + durationMs;
  async function worker() {
    while (true) {
      const index = cursor++;
      if (targetRequests !== null && index >= targetRequests) return;
      if (deadline !== null && performance.now() >= deadline && index >= concurrency) return;
      const result = await one(index, selected);
      latencies.push(result.latencyMs); bytes.push(result.bytes);
      if (result.timeout) timeoutCount++;
      const bucket = byRoute[result.route] ??= { latencies: [], successes: [], errors: 0, timeouts: 0, statuses: {} };
      bucket.latencies.push(result.latencyMs);
      if (result.status < 200 || result.status >= 300) bucket.errors++; else bucket.successes.push(result.latencyMs);
      if (result.timeout) bucket.timeouts++;
      bucket.statuses[result.status] = (bucket.statuses[result.status] ?? 0) + 1;
      statuses.set(result.status, (statuses.get(result.status) ?? 0) + 1);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  const elapsedMs = performance.now() - started;
  const cpu = process.cpuUsage(cpuBefore);
  const elu = performance.eventLoopUtilization(eluBefore);
  clearInterval(sampler);
  const failures = [...statuses].filter(([status]) => status < 200 || status >= 300).reduce((total, [, count]) => total + count, 0);
  const requests = latencies.length;
  const snapshot = runtimeMetrics(pool);
  const errorRate = failures / requests;
  const routes = Object.fromEntries(Object.entries(byRoute).map(([route, bucket]) => [route, {
    samples: bucket.latencies.length, successfulSamples: bucket.successes.length,
    latencyMs: summarize(bucket.latencies), successfulLatencyMs: bucket.successes.length ? summarize(bucket.successes) : null,
    errors: bucket.errors, errorRate: bucket.errors / bucket.latencies.length, timeouts: bucket.timeouts, statuses: bucket.statuses,
    exploratory: bucket.latencies.length < 1_000
  }]));
  const routeTargetsMet = Object.values(routes).every(route => route.latencyMs.p95 <= 500 && route.errorRate <= .01);
  const serverErrorCount = [...statuses].filter(([status]) => status >= 500).reduce((total, [, count]) => total + count, 0);
  const latency = summarize(latencies);
  return {
    routes, requests, concurrency, durationTargetMs: durationMs ?? null, elapsedMs: round(elapsedMs), latencyMs: latency, responseBytes: summarize(bytes),
    requestsPerSecond: round(requests / elapsedMs * 1000), requestsPerLogicalCpuSecond: round(requests / elapsedMs * 1000 / availableParallelism()),
    cpuMs: round((cpu.user + cpu.system) / 1000), cpuMsPerRequest: round((cpu.user + cpu.system) / 1000 / requests),
    eventLoopUtilization: round(elu.utilization * 100) / 100, rssPeakBytes: peakRss, pool: { peakTotal: peakPoolTotal, peakWaiting: peakPoolWaiting },
    statuses: Object.fromEntries([...statuses].sort(([left], [right]) => left - right).map(([status, count]) => [String(status), count])),
    failures, errorRate: round(errorRate * 10000) / 10000, timeoutRate: round(timeoutCount / requests * 10000) / 10000,
    serverErrorRate: round(serverErrorCount / requests * 10000) / 10000, runtime: snapshot,
    slo: {
      coreApiP95TargetMs: 500, routeTargetsMet, totalErrorRate: errorRate <= .01, latencyP95: latency.p95 <= 400, latencyP99: latency.p99 <= 800, poolWaitP95: snapshot.poolWaitMs.p95 <= 50,
      sqlP95: snapshot.sqlMs.p95 <= 50, timeoutRate: timeoutCount / requests <= 0.001, serverErrorRate: serverErrorCount / requests <= 0.005,
      met: errorRate <= .01 && routeTargetsMet && latency.p95 <= 400 && latency.p99 <= 800 && snapshot.poolWaitMs.p95 <= 50 && snapshot.sqlMs.p95 <= 50 && timeoutCount / requests <= 0.001 && serverErrorCount / requests <= 0.005
    }
  };
}

try {
const cold = await one(0, scenario);
const warm = await one(1, scenario);
const results: Array<Record<string, unknown>> = [];
const configuredLevels = levels();
if (pattern === "matrix") {
  for (const concurrency of configuredLevels) {
    const requests = Math.max(concurrency * requestsPerWorker, 200);
    await load(Math.min(concurrency, 50), Math.min(requests, 500));
    const repeated = [];
    for (let currentRound = 1; currentRound <= rounds; currentRound += 1) {
      resetRuntimeMetrics();
      repeated.push({ round: currentRound, ...await load(concurrency, requests) });
    }
    const p95s = repeated.map((entry) => entry.latencyMs.p95);
    const rpsValues = repeated.map((entry) => entry.requestsPerSecond);
    results.push({ concurrency, rounds: repeated, variance: {
      p95Min: Math.min(...p95s), p95Max: Math.max(...p95s), p95Spread: round(Math.max(...p95s) - Math.min(...p95s)),
      rpsMin: Math.min(...rpsValues), rpsMax: Math.max(...rpsValues), rpsSpread: round(Math.max(...rpsValues) - Math.min(...rpsValues))
    } });
  }
} else if (pattern === "spike") {
  if (configuredLevels.length < 2) throw new Error("CAPACITY_SPIKE_REQUIRES_TWO_LEVELS");
  const baselineConcurrency = configuredLevels[0]!, spikeConcurrency = configuredLevels.at(-1)!;
  for (let currentRound = 1; currentRound <= rounds; currentRound += 1) {
    resetRuntimeMetrics(); const baseline = await load(baselineConcurrency, Math.max(200, baselineConcurrency * 2));
    resetRuntimeMetrics(); const spike = await load(spikeConcurrency, Math.max(500, spikeConcurrency * requestsPerWorker));
    resetRuntimeMetrics(); const recovery = await load(baselineConcurrency, Math.max(200, baselineConcurrency * 2));
    results.push({ round: currentRound, baseline, spike, recovery });
  }
} else if (pattern === "soak") {
  const soakSeconds = integer("CAPACITY_SOAK_SECONDS", 60, 10, 3_600);
  const concurrency = configuredLevels[0]!;
  for (let currentRound = 1; currentRound <= rounds; currentRound += 1) {
    resetRuntimeMetrics();
    const beforeRss = process.memoryUsage().rss;
    const measured = await load(concurrency, null, scenario, soakSeconds * 1000);
    results.push({ round: currentRound, beforeRss, afterRss: process.memoryUsage().rss, rssDelta: process.memoryUsage().rss - beforeRss, measured });
  }
} else {
  const concurrency = configuredLevels.at(-1)!;
  for (let currentRound = 1; currentRound <= rounds; currentRound += 1) {
    const held = await Promise.all(Array.from({ length: config.database.poolMax }, () => pool.connect()));
    resetRuntimeMetrics();
    const saturated = await load(concurrency, Math.max(200, concurrency * 2), "bootstrap");
    for (const client of held) client.release();
    resetRuntimeMetrics();
    const recovery = await load(Math.min(50, concurrency), 200, "bootstrap");
    results.push({ round: currentRound, saturated, recovery });
  }
}

const reconciliation = (await pool.query(`SELECT
  COALESCE(s.like_count,0)::int AS stats_likes,COALESCE(s.save_count,0)::int AS stats_saves,COALESCE(s.comment_count,0)::int AS stats_comments,
  (SELECT count(*)::int FROM community_reaction r JOIN member m ON m.id=r.member_id AND m.status='active' WHERE r.post_id='brand-scalp-ritual' AND r.kind='like') AS source_likes,
  (SELECT count(*)::int FROM community_reaction r JOIN member m ON m.id=r.member_id AND m.status='active' WHERE r.post_id='brand-scalp-ritual' AND r.kind='save') AS source_saves,
  (SELECT count(*)::int FROM community_comment c JOIN member m ON m.id=c.member_id AND m.status='active' WHERE c.post_id='brand-scalp-ritual' AND c.status='published') AS source_comments
  FROM (VALUES(1)) singleton(value) LEFT JOIN community_post_stats s ON s.post_id='brand-scalp-ritual'`)).rows[0];
const aggregateExact = reconciliation.stats_likes === reconciliation.source_likes && reconciliation.stats_saves === reconciliation.source_saves && reconciliation.stats_comments === reconciliation.source_comments;
if (!aggregateExact) throw new Error("COMMUNITY_POST_STATS_RECONCILIATION_FAILED");

const report = {
  clientPopulation: { mode: populationMode, syntheticMembers: tokens.length, rateLimitsUnchanged: true },
  timingBoundary: "real loopback HTTP/1.1 + isolated DB; no public DNS/TLS or native rendering",
  schemaVersion: 1, generatedAt: new Date().toISOString(), mode: "local_tcp_isolated_postgresql", scenario, pattern, fixtureUsers,
  fixtureCaps: { feedItems: Math.min(fixtureUsers, 5_000), commentsAndLikes: Math.min(fixtureUsers, 20_000) },
  host: { logicalCpuCount: availableParallelism(), memoryLimit: "UNVERIFIED_NO_CONTAINER_QUOTA" },
  fairness: { warmupSeparated: true, repeatedRounds: rounds, sameMachine: true, samePostgreSql: true, syntheticDataOnly: true },
  startupMs: round(startupMs), fixtureSeedMs: round(seedMs), coldRequest: { ...cold, latencyMs: round(cold.latencyMs) }, warmRequest: { ...warm, latencyMs: round(warm.latencyMs) }, results,
  consistency: { communityPostStatsExact: aggregateExact, reconciliation },
  limitations: ["Local loopback is not CloudBase or production-like network evidence.", "Logical CPU count is reported; no vCPU quota was enforced.", "Mini Program render, image decode, physical-device and 4G latency are not measured."]
};
console.log(JSON.stringify(report, null, 2));

if (process.env.CAPACITY_OUTPUT) {
  const output = resolve(process.env.CAPACITY_OUTPUT);
  const allowedRoot = resolve("docs/evidence/performance");
  if (relative(allowedRoot, output).startsWith("..")) throw new Error("CAPACITY_OUTPUT_MUST_BE_UNDER_DOCS_EVIDENCE_PERFORMANCE");
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

// Exploratory capacity reports now fail on actual request failures instead of
// silently treating fast 429s as healthy throughput. Saturation is intentional;
// its recovery plus the separate fault assertions remain the relevant gates.
const checks = results.flatMap((entry: any) => entry.rounds ?? (pattern === "pool_saturation" ? [entry.recovery] : [entry.baseline, entry.spike, entry.recovery, entry.measured].filter(Boolean)));
if (checks.some((entry: any) => !entry.slo.met)) process.exitCode = 1;
} finally {
  population?.close();
  await app.close();
  await pool.end();
}
