/** Local-only, bounded diagnostic samples. No raw URL, identity, body, headers,
 * device identifier or signed media URL ever enters this buffer. */
export type MetricAction = "home" | "profile" | "care" | "support" | "feed" | "catalog" | "other";
export type MetricStage = "transport" | "retry_wait" | "coalesced" | "cancel" | "data_processing" | "set_data" | "critical_ready";
export interface NetworkPhases {
  queueMs: number | null; dnsMs: number | null; connectIncludingTlsMs: number | null;
  tlsMs: number | null; firstByteAfterRequestMs: number | null; receiveMs: number | null;
  protocol: "http1.1" | "h2" | "quic" | "unknown" | null; socketReused: boolean | null;
}
interface Sample { action: MetricAction; stage: MetricStage; durationMs: number; transport?: "direct" | "cloud"; status?: number; phases?: NetworkPhases }
const samples: Sample[] = [];
let sampleEvery = 16, sequence = 0, lastClock = 0;
const nativeClock = typeof globalThis !== "undefined" ? (globalThis as unknown as { performance?: { now?: () => number } }).performance : undefined;
const hasMonotonicClock = typeof nativeClock?.now === "function";
export function measurementClock(): number {
  if (hasMonotonicClock) return nativeClock!.now!();
  // wx.getPerformance exposes entries, not a documented now() method.
  // The independent operation timer remains the hard deadline on fallback.
  lastClock = Math.max(lastClock, Date.now()); return lastClock;
}
export function nativeRuntimePhases() {
  const allowed = new Set(["appLaunch", "route", "firstRender", "evaluateScript", "downloadPackage"]);
  try {
    if (typeof wx.getPerformance !== "function") return { supported: false, entries: null };
    const entries = wx.getPerformance().getEntries();
    return { supported: true, entries: entries.filter(entry => allowed.has(entry.name) && Number.isFinite(entry.duration) && entry.duration >= 0)
      .slice(-64).map(entry => ({ name: entry.name, durationMs: entry.duration })) };
  } catch { return { supported: false, entries: null }; }
}

export function metricAction(path: string): MetricAction {
  const route = path.split("?")[0] ?? "";
  if (route === "/v1/bootstrap/home") return "home";
  if (route === "/v1/bootstrap/profile") return "profile";
  if (route.startsWith("/v1/care-cycles/")) return "care";
  if (route.startsWith("/v1/me/support")) return "support";
  if (route === "/v1/feed" || route.startsWith("/v1/feed/") || route.startsWith("/v1/ugc/") || route.startsWith("/v1/community/")) return "feed";
  if (route === "/v1/catalog" || route.startsWith("/v1/catalog/")) return "catalog";
  return "other";
}
export function recordClientMetric(sample: Sample): void {
  if (!["home", "profile", "care", "support", "feed", "catalog", "other"].includes(sample.action) || !["transport", "retry_wait", "coalesced", "cancel", "data_processing", "set_data", "critical_ready"].includes(sample.stage)) return;
  if (++sequence % sampleEvery !== 0 || !Number.isFinite(sample.durationMs) || sample.durationMs < 0) return;
  if (samples.length >= 128) samples.shift();
  // Explicit projection: even a runtime caller passing extra fields cannot
  // accidentally place tokens, bodies or URLs in exported samples.
  samples.push({ action: sample.action, stage: sample.stage, durationMs: sample.durationMs,
    ...(sample.transport === "direct" || sample.transport === "cloud" ? { transport: sample.transport } : {}),
    ...(Number.isInteger(sample.status) && sample.status! >= 100 && sample.status! <= 599 ? { status: sample.status } : {}),
    ...(sample.phases ? { phases: projectNetworkPhases(sample.phases, true) } : {}) });
}
export function configureLocalMeasurements(every = 16): void {
  if (!Number.isInteger(every) || every < 1 || every > 1024) throw new Error("INVALID_MEASUREMENT_SAMPLE_RATE");
  sampleEvery = every; sequence = 0; samples.length = 0;
}
export function localMeasurements() {
  return { scope: "local-memory-only; last 128 selected samples; no automatic upload or persistence", sampleEvery,
    clock: hasMonotonicClock ? "runtime monotonic clock" : "clamped wall-clock fallback; independent timer still bounds request",
    nativePhases: nativeRuntimePhases(),
    boundary: "network phases overlap; connect includes TLS; missing is null; not a device acceptance result", samples: samples.map(s => ({ ...s, ...(s.phases ? { phases: { ...s.phases } } : {}) })) };
}
export function projectNetworkPhases(raw: unknown, projected = false): NetworkPhases {
  const p = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const value = (key: string) => typeof p[key] === "number" && Number.isFinite(p[key]) && (p[key] as number) >= 0 ? p[key] as number : null;
  const delta = (start: string, end: string) => { const a = value(start), b = value(end); return a !== null && b !== null && b >= a ? b - a : null; };
  const duration = (key: string, start: string, end: string) => projected ? value(key) : delta(start, end);
  return { queueMs: duration("queueMs", "queueStart", "queueEnd"), dnsMs: duration("dnsMs", "domainLookUpStart", "domainLookUpEnd"),
    connectIncludingTlsMs: duration("connectIncludingTlsMs", "connectStart", "connectEnd"), tlsMs: duration("tlsMs", "SSLconnectionStart", "SSLconnectionEnd"),
    firstByteAfterRequestMs: duration("firstByteAfterRequestMs", "requestStart", "responseStart"), receiveMs: duration("receiveMs", "responseStart", "responseEnd"),
    protocol: ["http1.1", "h2", "quic", "unknown"].includes(String(p.protocol)) ? p.protocol as NetworkPhases["protocol"] : null,
    socketReused: typeof p.socketReused === "boolean" ? p.socketReused : null };
}
