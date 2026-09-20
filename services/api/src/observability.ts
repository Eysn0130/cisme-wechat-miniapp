import type pg from "pg";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { DomainError } from "@cisme/domain";

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
const startedMono = performance.now();
const loopDelay = monitorEventLoopDelay({ resolution: 20 });
loopDelay.enable();
const completedSeries = new BoundedSeries();
const abortedSeries = new BoundedSeries();
const httpStatuses = { total: 0, clientErrors: 0, serverErrors: 0, timeouts: 0, completed: 0, aborted: 0, unmatched: 0 };
const methods = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "TRACE", "CONNECT"]);
const normalizeMethod = (method?: string) => methods.has(method ?? "") ? method! : "OTHER";
const registeredRoutes = new Set<string>();
function routeValue() { return { durationMs: new BoundedSeries(512), completedDurationMs: new BoundedSeries(512), responseBytes: new BoundedSeries(512), total: 0, errors: 0, timeouts: 0, completed: 0, aborted: 0 }; }
const routeSeries = new Map<string, ReturnType<typeof routeValue>>();

/** Only call from Fastify's static onRoute registration, never a request URL. */
export function registerHttpRoute(method: string | readonly string[], template: string): void {
  for (const verb of typeof method === "string" ? [method] : method) {
    const key = `${normalizeMethod(verb)} ${template}`;
    if (!registeredRoutes.has(key) && registeredRoutes.size >= 1024) throw new Error("STATIC_HTTP_METRIC_ROUTE_BUDGET_EXCEEDED");
    registeredRoutes.add(key);
    if (!routeSeries.has(key)) routeSeries.set(key, routeValue());
  }
}
function metricKey(method?: string, template?: string): { key: string; matched: boolean } {
  const verb = normalizeMethod(method);
  const key = `${verb} ${template ?? ""}`;
  return registeredRoutes.has(key) ? { key, matched: true } : { key: `${verb} <unmatched>`, matched: false };
}
function routeFor(key: string) {
  let value = routeSeries.get(key);
  if (!value) { value = routeValue(); routeSeries.set(key, value); }
  return value;
}
export function recordMetric(name: MetricName, value: number): void { series[name].add(value); }
export function recordHttpRequest(input: { method?: string; route?: string; durationMs: number; responseBytes: number | null; statusCode: number; coldStart: boolean; timedOut?: boolean }): void {
  recordMetric("http_ms", input.durationMs);
  if (input.responseBytes !== null) recordMetric("response_bytes", input.responseBytes);
  if (input.coldStart) recordMetric("cold_http_ms", input.durationMs);
  httpStatuses.total++;
  if (input.statusCode >= 400 && input.statusCode < 500) httpStatuses.clientErrors++;
  if (input.statusCode >= 500) httpStatuses.serverErrors++;
  if (input.timedOut) httpStatuses.timeouts++;
  const { key, matched } = metricKey(input.method, input.route);
  if (!matched) httpStatuses.unmatched++;
  const route = routeFor(key);
  route.durationMs.add(input.durationMs);
  if (input.responseBytes !== null) route.responseBytes.add(input.responseBytes);
  route.total++;
  if (input.statusCode >= 400) route.errors++;
  if (input.timedOut) route.timeouts++;
}

const businessStatuses = new WeakMap<object, number>();
export function preserveHttpBusinessStatus(request: object, status: number): void { businessStatuses.set(request, status); }
const timeoutCodes = new Set(["FST_ERR_HANDLER_TIMEOUT", "FST_ERR_REQUEST_TIMEOUT", "HANDLER_DEADLINE_EXCEEDED", "OPERATION_DEADLINE_EXCEEDED", "DATABASE_DEADLINE_EXCEEDED", "57014"]);
export function isTimeoutFailure(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && timeoutCodes.has(String((error as { code?: unknown }).code)));
}

/** Install after transport serialization hooks, before application routes. */
export function installHttpMetrics(app: FastifyInstance): void {
  const states = new WeakMap<FastifyRequest, { start: number; cold: boolean; timedOut: boolean; sent: boolean; finished: boolean }>();
  let cold = true;
  app.addHook("onRequest", (request, reply, done) => {
    const state = { start: performance.now(), cold, timedOut: false, sent: false, finished: false };
    states.set(request, state); cold = false;
    reply.raw.once("close", () => {
      if (state.finished || reply.raw.writableFinished) return;
      state.finished = true;
      httpStatuses.aborted++;
      abortedSeries.add(performance.now() - state.start);
      routeFor(metricKey(request.method, request.routeOptions.url).key).aborted++;
    });
    done();
  });
  app.addHook("onError", (request, _reply, error, done) => {
    const state = states.get(request);
    if (state && isTimeoutFailure(error)) state.timedOut = true;
    done();
  });
  app.addHook("onSend", (request, reply, payload, done) => {
    const state = states.get(request);
    if (state && !state.sent) {
      state.sent = true;
      const bytes = typeof payload === "string" ? Buffer.byteLength(payload) : Buffer.isBuffer(payload) ? payload.length : null;
      const status = businessStatuses.get(request) ?? reply.statusCode;
      const durationMs = performance.now() - state.start;
      recordHttpRequest({ method: request.method, ...(request.routeOptions.url ? { route: request.routeOptions.url } : {}), durationMs, responseBytes: bytes, statusCode: status, coldStart: state.cold, timedOut: state.timedOut || status === 408 || status === 504 });
      request.log.info({ event: "http_request", request_id: request.id, route: metricKey(request.method, request.routeOptions.url).key,
        status_code: status, transport_status_code: reply.statusCode, timing_boundary: "onSend", duration_ms: Math.round(durationMs * 100) / 100,
        response_bytes: bytes, cold_start: state.cold });
    }
    done(null, payload);
  });
  app.addHook("onResponse", (request, _reply, done) => {
    const state = states.get(request);
    if (state && !state.finished) {
      state.finished = true; httpStatuses.completed++;
      const duration = performance.now() - state.start;
      completedSeries.add(duration);
      const route = routeFor(metricKey(request.method, request.routeOptions.url).key);
      route.completed++; route.completedDurationMs.add(duration);
    }
    done();
  });
}
export function resetRuntimeMetrics(): void {
  for (const metric of Object.values(series)) metric.clear();
  completedSeries.clear(); abortedSeries.clear(); loopDelay.reset();
  for (const key of Object.keys(httpStatuses) as (keyof typeof httpStatuses)[]) httpStatuses[key] = 0;
  routeSeries.clear();
  for (const key of registeredRoutes) routeSeries.set(key, routeValue());
}
export function runtimeMetrics(pool?: pg.Pool) {
  const memory = process.memoryUsage();
  const ms = (value: number) => Number.isFinite(value) ? value / 1e6 : null;
  return {
    startedAt: startedAt.toISOString(), uptimeSeconds: Math.floor((performance.now() - startedMono) / 1000),
    process: { pid: process.pid, rssBytes: memory.rss, heapUsedBytes: memory.heapUsed, cpuMicroseconds: process.cpuUsage(),
      eventLoopDelayMs: { samples: loopDelay.count, p95: loopDelay.count ? ms(loopDelay.percentile(95)) : null, max: loopDelay.count ? ms(loopDelay.max) : null } },
    pool: pool ? { total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount } : null,
    poolWaitMs: series.pool_wait_ms.snapshot(), sqlMs: series.sql_ms.snapshot(), storageMs: series.storage_ms.snapshot(), transactionRetries: series.transaction_retry.snapshot(),
    http: {
      timingBoundary: "durationMs: onRequest to onSend, before socket completion; completedDurationMs: onRequest to onResponse; neither proves client receipt",
      sampling: "process-local rolling rings: aggregate 2048, per method/template 512; counters cumulative since reset; never average instance percentiles",
      payloadBoundary: "serialized onSend payload bytes, excludes headers/compression; streams missing, not zero",
      durationMs: series.http_ms.snapshot(), completedDurationMs: completedSeries.snapshot(), abortedDurationMs: abortedSeries.snapshot(),
      coldDurationMs: series.cold_http_ms.snapshot(), responseBytes: series.response_bytes.snapshot(), ...httpStatuses,
      registeredRouteCount: registeredRoutes.size,
      routes: Object.fromEntries([...routeSeries.entries()].map(([name, value]) => [name, {
        durationMs: value.durationMs.snapshot(), completedDurationMs: value.completedDurationMs.snapshot(), responseBytes: value.responseBytes.snapshot(), total: value.total, errors: value.errors, timeouts: value.timeouts, completed: value.completed, aborted: value.aborted
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

// Never serialize arbitrary Error objects: database drivers and upstream SDKs
// can put SQL parameters, signed URLs, or response bodies in message/stack.
export function safeFailureFields(error: unknown): { failure_class: string; failure_code?: string } {
  if (error instanceof DomainError && /^[A-Z][A-Z0-9_]{1,63}$/.test(error.code))
    return { failure_class: "domain", failure_code: error.code };
  const code = error && typeof error === "object" && "code" in error ? (error as { code?: unknown }).code : undefined;
  if (typeof code === "string" && new Set(["22P02", "23505", "40001", "40P01", "55P03", "57014", "53300"]).has(code))
    return { failure_class: "database", failure_code: code };
  return { failure_class: "runtime" };
}
