import { localPerformanceDatabase } from "./performance-measurement.js";
import { availableParallelism } from "node:os";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { resetDatabase } from "@cisme/testkit";
import { createPool } from "../services/api/src/db.js";
import { processOutboxBatch } from "../services/worker/src/jobs.js";

function integer(name: string, fallback: number, minimum: number, maximum: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < minimum || value > maximum) throw new Error(`WORKER_CAPACITY_OPTION_INVALID:${name}`);
  return value;
}
function round(value: number) { return Math.round(value * 100) / 100; }
if (process.env.CAPACITY_ALLOW_RESET !== "true") throw new Error("CAPACITY_ALLOW_RESET_REQUIRED: benchmark resets a dedicated cisme_*test* database");
const databaseUrl = localPerformanceDatabase();
const events = integer("WORKER_CAPACITY_EVENTS", 10_000, 100, 100_000);
const rounds = integer("WORKER_CAPACITY_ROUNDS", 3, 2, 10);
const levels = [...new Set((process.env.WORKER_CAPACITY_LEVELS ?? "1,2,4,8").split(",").map(Number))];
if (levels.some((value) => !Number.isInteger(value) || value < 1 || value > 20)) throw new Error("WORKER_CAPACITY_OPTION_INVALID:WORKER_CAPACITY_LEVELS");
const pool = createPool(databaseUrl, { poolMax: 20, globalConnectionBudget: 40, instanceCount: 1, poolAcquireTimeoutMs: 2_000, statementTimeoutMs: 2_500, lockTimeoutMs: 750, idleTransactionTimeoutMs: 5_000, transactionDeadlineMs: 4_000, transactionMaxAttempts: 6 });
try {
await resetDatabase(pool);

const results = [];
for (const workers of levels) {
  for (let currentRound = 1; currentRound <= rounds; currentRound += 1) {
    await pool.query("TRUNCATE outbox_event");
    await pool.query(`INSERT INTO outbox_event(event_type,aggregate_type,aggregate_id,aggregate_version,business_key,payload,occurred_at,next_attempt_at)
      SELECT 'identity.accepted.v1','member',gen_random_uuid(),1,'worker-capacity-'||$1||'-'||$2||'-'||n,'{}'::jsonb,clock_timestamp(),clock_timestamp()
      FROM generate_series(1,$3::int) n`, [workers, currentRound, events]);
    await pool.query("ANALYZE outbox_event");
    let peakRss = process.memoryUsage().rss;
    const sampler = setInterval(() => { peakRss = Math.max(peakRss, process.memoryUsage().rss); }, 5);
    const cpuBefore = process.cpuUsage();
    const eluBefore = performance.eventLoopUtilization();
    const started = performance.now();
    const perWorker: number[] = [];
    await Promise.all(Array.from({ length: workers }, async (_, worker) => {
      let processed = 0;
      while (true) {
        // Give the database clock one second of tolerance so a small host/DB
        // clock skew cannot make freshly seeded synthetic events look future-dated.
        const count = await processOutboxBatch(pool, new Date(Date.now() + 1_000), 50, { ugcGoLiveGate: false });
        if (count === 0) break;
        processed += count;
      }
      perWorker[worker] = processed;
    }));
    const elapsedMs = performance.now() - started;
    clearInterval(sampler);
    const cpu = process.cpuUsage(cpuBefore);
    const elu = performance.eventLoopUtilization(eluBefore);
    const state = (await pool.query<{ total: number; pending: number; dead: number; oldest_seconds: number | null }>(`SELECT count(*)::int total,
      count(*) FILTER(WHERE processed_at IS NULL)::int pending,count(*) FILTER(WHERE dead_lettered_at IS NOT NULL)::int dead,
      extract(epoch FROM clock_timestamp()-(min(occurred_at) FILTER(WHERE processed_at IS NULL)))::float AS oldest_seconds FROM outbox_event`)).rows[0]!;
    results.push({ workers, round: currentRound, events, processed: perWorker.reduce((sum, value) => sum + value, 0), perWorker,
      elapsedMs: round(elapsedMs), eventsPerSecond: round(events / elapsedMs * 1000), eventsPerLogicalCpuSecond: round(events / elapsedMs * 1000 / availableParallelism()),
      cpuMs: round((cpu.user + cpu.system) / 1000), cpuMsPerEvent: round((cpu.user + cpu.system) / 1000 / events),
      eventLoopUtilization: round(elu.utilization * 10_000) / 10_000, peakRssBytes: peakRss, pool: { total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount }, state });
  }
}

const report = { schemaVersion: 1, generatedAt: new Date().toISOString(), mode: "local_isolated_postgresql_audit_only_outbox", events,
  host: { logicalCpuCount: availableParallelism(), memoryLimit: "UNVERIFIED_NO_CONTAINER_QUOTA" }, batchSize: 50, rounds, results,
  limitations: ["Audit-only events measure claim/finalize throughput, not publication SQL or external I/O.", "Loopback PostgreSQL and an unconstrained workstation are not staging or production capacity evidence.", "Process-kill recovery is covered by functional tests, not timed by this harness."] };
console.log(JSON.stringify(report, null, 2));
if (process.env.WORKER_CAPACITY_OUTPUT) {
  const output = resolve(process.env.WORKER_CAPACITY_OUTPUT);
  const allowed = resolve("docs/evidence/performance");
  if (relative(allowed, output).startsWith("..")) throw new Error("WORKER_CAPACITY_OUTPUT_MUST_BE_UNDER_DOCS_EVIDENCE_PERFORMANCE");
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}
if (results.some(result => result.processed !== events || result.state.total !== events || result.state.pending !== 0 || result.state.dead !== 0)) process.exitCode = 1;
} finally { await pool.end(); }
