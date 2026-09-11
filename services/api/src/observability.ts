import type pg from "pg";

type MetricName = "pool_wait_ms" | "sql_ms" | "storage_ms" | "transaction_retry" | "http_ms" | "cold_http_ms" | "response_bytes";

class BoundedSeries {
  private values: number[];
  private count = 0;
  private next = 0;
  constructor(private readonly limit = 2048) { this.values = new Array<number>(limit); }
  add(value: number) {
    if (!Number.isFinite(value) || value < 0) return;
    this.values[this.next] = value;
    this.next = (this.next + 1) % this.limit;
    this.count = Math.min(this.limit, this.count + 1);
  }
  snapshot() {
    if (!this.count) return { count: 0, p50: 0, p95: 0, p99: 0, max: 0 };
    const sorted = this.values.slice(0, this.count).sort((a, b) => a - b);
    const pick = (percentile: number) => sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * percentile) - 1)]!;
    return { count: sorted.length, p50: pick(0.5), p95: pick(0.95), p99: pick(0.99), max: sorted[sorted.length - 1]! };
  }
  clear() { this.count = 0; this.next = 0; }
}

const series: Record<MetricName, BoundedSeries> = {
  pool_wait_ms: new BoundedSeries(),
  sql_ms: new BoundedSeries(),
  storage_ms: new BoundedSeries(),
  transaction_retry: new BoundedSeries(),
  http_ms: new BoundedSeries(),
  cold_http_ms: new BoundedSeries(),
  response_bytes: new BoundedSeries()
};
const startedAt = new Date();
const httpStatuses = { total: 0, clientErrors: 0, serverErrors: 0, timeouts: 0 };
const routeSeries = new Map<string, { durationMs: BoundedSeries; responseBytes: BoundedSeries; total: number; errors: number }>();

export function recordMetric(name: MetricName, value: number): void { series[name].add(value); }

export function recordHttpRequest(input: { route?: string; durationMs: number; responseBytes: number; statusCode: number; coldStart: boolean; timedOut?: boolean }): void {
  recordMetric("http_ms", input.durationMs);
  recordMetric("response_bytes", input.responseBytes);
  if (input.coldStart) recordMetric("cold_http_ms", input.durationMs);
  httpStatuses.total += 1;
  if (input.statusCode >= 400 && input.statusCode < 500) httpStatuses.clientErrors += 1;
  if (input.statusCode >= 500) httpStatuses.serverErrors += 1;
  if (input.timedOut) httpStatuses.timeouts += 1;
  if (input.route) {
    let route = routeSeries.get(input.route);
    if (!route && routeSeries.size < 96) {
      route = { durationMs: new BoundedSeries(512), responseBytes: new BoundedSeries(512), total: 0, errors: 0 };
      routeSeries.set(input.route, route);
    }
    if (route) {
      route.durationMs.add(input.durationMs);
      route.responseBytes.add(input.responseBytes);
      route.total += 1;
      if (input.statusCode >= 400) route.errors += 1;
    }
  }
}

export function resetRuntimeMetrics(): void {
  for (const metric of Object.values(series)) metric.clear();
  httpStatuses.total = 0; httpStatuses.clientErrors = 0; httpStatuses.serverErrors = 0; httpStatuses.timeouts = 0;
  routeSeries.clear();
}

export function runtimeMetrics(pool?: pg.Pool) {
  return {
    startedAt: startedAt.toISOString(),
    uptimeSeconds: Math.floor((Date.now() - startedAt.getTime()) / 1000),
    pool: pool ? { total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount } : null,
    poolWaitMs: series.pool_wait_ms.snapshot(),
    sqlMs: series.sql_ms.snapshot(),
    storageMs: series.storage_ms.snapshot(),
    transactionRetries: series.transaction_retry.snapshot(),
    http: {
      durationMs: series.http_ms.snapshot(),
      coldDurationMs: series.cold_http_ms.snapshot(),
      responseBytes: series.response_bytes.snapshot(),
      ...httpStatuses,
      routes: Object.fromEntries([...routeSeries.entries()].map(([name, value]) => [name, {
        durationMs: value.durationMs.snapshot(), responseBytes: value.responseBytes.snapshot(), total: value.total, errors: value.errors
      }]))
    }
  };
}

export function safeLoggerOptions(level: string) {
  return {
    level,
    // Fastify's standard request serializer omits headers. Redaction remains a
    // second line of defence for any future structured log fields.
    redact: { paths: ["req.headers", "request.headers", "headers", "env", "*.token", "*.secret", "*.password"], censor: "[REDACTED]" }
  };
}
