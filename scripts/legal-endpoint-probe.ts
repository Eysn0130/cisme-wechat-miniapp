import { parseLegalBootstrap } from "../apps/miniprogram/services/legal-bootstrap";

export interface LegalEndpointProbe {
  origin: string;
  path: "/v1/legal";
  ok: boolean;
  code: string;
  status?: number;
  elapsedMs: number;
}
const bodyLimit = 1024 * 1024;
const knownNetworkCodes: Record<string, string> = {
  ENOTFOUND: "NETWORK_DNS_ERROR", EAI_AGAIN: "NETWORK_DNS_ERROR",
  ECONNREFUSED: "NETWORK_CONNECTION_REFUSED", ETIMEDOUT: "NETWORK_TIMEOUT",
  UND_ERR_CONNECT_TIMEOUT: "NETWORK_TIMEOUT", UND_ERR_HEADERS_TIMEOUT: "NETWORK_TIMEOUT",
  UND_ERR_BODY_TIMEOUT: "NETWORK_TIMEOUT", CERT_HAS_EXPIRED: "NETWORK_TLS_ERROR",
  CERT_NOT_YET_VALID: "NETWORK_TLS_ERROR", DEPTH_ZERO_SELF_SIGNED_CERT: "NETWORK_TLS_ERROR",
  SELF_SIGNED_CERT_IN_CHAIN: "NETWORK_TLS_ERROR", UNABLE_TO_VERIFY_LEAF_SIGNATURE: "NETWORK_TLS_ERROR",
  UNABLE_TO_GET_ISSUER_CERT_LOCALLY: "NETWORK_TLS_ERROR", ERR_TLS_CERT_ALTNAME_INVALID: "NETWORK_TLS_ERROR"
};
function transportCode(error: unknown): string {
  const value = error as { code?: unknown; cause?: { code?: unknown } } | null;
  const code = value?.cause?.code ?? value?.code;
  return typeof code === "string" && Object.hasOwn(knownNetworkCodes, code) ? knownNetworkCodes[code]! : "NETWORK_ERROR";
}
class ProbeFailure extends Error {
  constructor(readonly code: string) { super(code); }
}

/** One anonymous GET; no redirects, credentials, response-body logs or unbounded
 * read. Success proves only this machine's public legal bootstrap, not WeChat
 * domain registration, a real-device journey or production identity/config. */
export async function probeLegalEndpoint(origin: string, fetcher: typeof fetch = fetch, budgetMs = 8_000): Promise<LegalEndpointProbe> {
  const started = Date.now();
  let safeOrigin = "(invalid origin)";
  const result = (ok: boolean, code: string, status?: number): LegalEndpointProbe => ({
    origin: safeOrigin, path: "/v1/legal", ok, code, ...(status === undefined ? {} : { status }), elapsedMs: Date.now() - started
  });
  try {
    const url = new URL(origin);
    if (url.protocol !== "https:" || url.origin !== origin || url.username || url.password || url.search || url.hash)
      return result(false, "API_ORIGIN_INVALID");
    safeOrigin = origin;
  } catch { return result(false, "API_ORIGIN_INVALID"); }
  if (!Number.isInteger(budgetMs) || budgetMs < 1 || budgetMs > 60_000) return result(false, "PROBE_BUDGET_INVALID");
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, budgetMs);
  let response: Response | undefined;
  try {
    response = await fetcher(`${origin}/v1/legal`, {
      method: "GET", credentials: "omit", redirect: "manual", cache: "no-store",
      headers: { Accept: "application/json" }, signal: controller.signal
    });
    if (response.status >= 300 && response.status <= 399) return result(false, "HTTP_REDIRECT", response.status);
    if (!response.ok) return result(false, `HTTP_${response.status}`, response.status);
    const mime = (response.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
    if (mime !== "application/json" && !/^application\/[a-z0-9.+-]+\+json$/.test(mime))
      return result(false, "LEGAL_CONTENT_TYPE_INVALID", response.status);
    if (!response.body) return result(false, "LEGAL_RESPONSE_EMPTY", response.status);
    const declaredLength = response.headers.get("content-length");
    if (declaredLength && /^\d+$/.test(declaredLength) && Number(declaredLength) > bodyLimit)
      return result(false, "LEGAL_RESPONSE_TOO_LARGE", response.status);
    const reader = response.body.getReader(), decoder = new TextDecoder("utf-8", { fatal: true });
    let bytes = 0, text = "";
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        bytes += next.value.byteLength;
        if (bytes > bodyLimit) throw new ProbeFailure("LEGAL_RESPONSE_TOO_LARGE");
        text += decoder.decode(next.value, { stream: true });
      }
      text += decoder.decode();
    } catch (error) {
      if (timedOut || error instanceof ProbeFailure) throw error;
      // Preserve fetch stream failures; malformed UTF-8 is not a DNS verdict.
      if (error instanceof TypeError && /encoded data/i.test(error.message)) throw new ProbeFailure("LEGAL_JSON_INVALID");
      throw error;
    } finally { reader.releaseLock(); }
    let body: unknown;
    try { body = JSON.parse(text); } catch { throw new ProbeFailure("LEGAL_JSON_INVALID"); }
    const parsed = parseLegalBootstrap(body);
    return result(parsed.documents !== null, parsed.diagnostic || "LEGAL_BOOTSTRAP_READY", response.status);
  } catch (error) {
    return result(false, timedOut ? "NETWORK_TIMEOUT" : error instanceof ProbeFailure ? error.code : transportCode(error), response?.status);
  } finally {
    clearTimeout(timer);
    // Cancel an unread/oversized body before releasing the request. Do not wait
    // for a server-controlled stream to finish after deciding it is invalid.
    if (response?.body && !response.body.locked) void response.body.cancel().catch(() => {});
    controller.abort();
  }
}
