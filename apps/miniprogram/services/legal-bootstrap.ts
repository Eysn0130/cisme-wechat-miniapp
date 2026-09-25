/** Validate the public bootstrap, not legal approval or WeChat-console status. */
export type LegalLoadError = "" | "unreachable" | "unpublished" | "invalid";
export interface PublishedLegalVersions {
  privacy: string;
  terms: string;
  crossBorder?: string;
  localFixture: false;
}
export interface LegalBootstrap {
  documents: PublishedLegalVersions | null;
  error: LegalLoadError;
  diagnostic: string;
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
const invalid = (): LegalBootstrap => ({ documents: null, error: "invalid", diagnostic: "LEGAL_RESPONSE_INVALID" });

export function parseLegalBootstrap(value: unknown): LegalBootstrap {
  if (!record(value) || typeof value.ready !== "boolean" || !Array.isArray(value.documents)) return invalid();
  const versions = new Map<string, string>();
  for (const entry of value.documents) {
    if (!record(entry) || typeof entry.document_type !== "string") return invalid();
    if (!["terms", "privacy", "cross_border"].includes(entry.document_type)) continue;
    // Never coerce versions, choose one of two active versions, or turn a
    // truthy string such as ready="false" into permission to authenticate.
    if (typeof entry.version !== "string" || !entry.version.trim() || versions.has(entry.document_type)) return invalid();
    versions.set(entry.document_type, entry.version);
  }
  if (!value.ready) return { documents: null, error: "unpublished", diagnostic: "LEGAL_NOT_PUBLISHED" };
  const privacy = versions.get("privacy"), terms = versions.get("terms"), crossBorder = versions.get("cross_border");
  if (!privacy || !terms) return invalid();
  return { documents: { privacy, terms, ...(crossBorder ? { crossBorder } : {}), localFixture: false }, error: "", diagnostic: "" };
}

const safeFailureCodes = new Set([
  "NETWORK_ERROR", "NETWORK_TIMEOUT", "NETWORK_DOMAIN_NOT_ALLOWED", "NETWORK_TLS_ERROR", "NETWORK_DNS_ERROR",
  "NETWORK_CONNECTION_REFUSED", "REQUEST_ABORTED", "REQUEST_CONTEXT_CHANGED", "REQUEST_SESSION_CHANGED",
  "REQUEST_ENVIRONMENT_CHANGED", "CLOUD_HTTP_UNAVAILABLE"
]);
/** Only bounded codes reach page data. Never retain response bodies, URLs,
 * native errMsg, login codes, tokens or headers in diagnostic state. */
export function legalRequestFailure(value: unknown): Pick<LegalBootstrap, "error" | "diagnostic"> {
  if (record(value)) {
    if (value.code === "LEGAL_RESPONSE_INVALID") return { error: "invalid", diagnostic: "LEGAL_RESPONSE_INVALID" };
    if (typeof value.status === "number" && Number.isInteger(value.status) && value.status >= 300 && value.status <= 599)
      return { error: "unreachable", diagnostic: `HTTP_${value.status}` };
    if (typeof value.code === "string" && safeFailureCodes.has(value.code))
      return { error: "unreachable", diagnostic: value.code };
  }
  return { error: "unreachable", diagnostic: "LEGAL_REQUEST_FAILED" };
}
