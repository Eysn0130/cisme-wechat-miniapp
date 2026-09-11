export type MiniProgramRuntime = "devtools" | "preview" | "trial" | "release";

export interface CloudHttpTarget { env: string; name: string }

// CloudBase stays out of the staging preview/trial path. Production remains fail-closed.
export const miniProgramCloudFunctions: Partial<Record<MiniProgramRuntime, CloudHttpTarget>> = {};

/**
 * These URLs are public release metadata, not credentials.
 *
 * - devtools: local simulator only.
 * - preview: QR codes opened on a physical device (envVersion=develop).
 * - trial: WeChat experience version.
 * - release: audited production version.
 *
 * Cloud targets take precedence when configured. Otherwise device runtimes
 * require an HTTPS API origin registered in the Mini Program console.
 */
export const miniProgramApiOrigins: Record<MiniProgramRuntime, string> = {
  devtools: "http://127.0.0.1:18080",
  preview: "https://staging-api.cisme.cn",
  trial: "https://staging-api.cisme.cn",
  release: ""
};

export type RemoteDebugQuery = Record<string, string | undefined>;

export function isPrivateLanHttpOrigin(value: string): boolean {
  const match = /^http:\/\/(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?::([1-9]\d{0,4}))?$/.exec(value.trim());
  if (!match) return false;
  const octets = match.slice(1, 5).map(Number);
  if (octets.some((octet) => octet < 0 || octet > 255)) return false;
  const port = match[5] ? Number(match[5]) : 80;
  if (port > 65535) return false;
  const first = octets[0] ?? -1;
  const second = octets[1] ?? -1;
  return first === 10 || (first === 172 && second >= 16 && second <= 31) || (first === 192 && second === 168);
}

/**
 * Account-less temporary tunnels are accepted only for an explicitly requested
 * physical-device development launch. The strict origin-only host allowlist
 * prevents arbitrary HTTPS hosts, paths, queries or user-info from entering
 * runtime configuration. These origins never flow into trial or release.
 */
export function isTemporaryRemoteDebugHttpsOrigin(value: string): boolean {
  const origin = value.trim();
  return /^https:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.trycloudflare\.com(?::443)?$/.test(origin)
    || /^https:\/\/[a-f0-9]{8,32}\.lhr\.life(?::443)?$/.test(origin);
}

export function remoteDebugApiOrigin(envVersion: string, platform: string, query: RemoteDebugQuery): string {
  if (envVersion !== "develop" || platform === "devtools" || query.cisme_remote_debug !== "1") return "";
  let origin = query.api_origin?.trim() ?? "";
  try {
    // QR physical debugging preserves the URLSearchParams-encoded query value
    // on some DevTools/base-library combinations. Decode exactly once, then
    // apply the same strict origin-only allowlist below.
    origin = decodeURIComponent(origin);
  } catch {
    return "";
  }
  return isPrivateLanHttpOrigin(origin) || isTemporaryRemoteDebugHttpsOrigin(origin) ? origin : "";
}

export type LegalDocumentVersions = {
  crossBorder?: string;
  privacy: string;
  terms: string;
  localFixture: boolean;
};

/**
 * Compiled production legal versions stay fail-closed. Account may instead use
 * the active server-published terms and privacy versions returned by /v1/legal;
 * publication in the database still does not prove WeChat-console or legal
 * approval. Do not replace this null with a date-shaped placeholder.
 */
export const approvedLegalDocumentVersions: LegalDocumentVersions | null = null;

const localLegalFixture: LegalDocumentVersions = {
  privacy: "local-visual-fixture-2026-08-16",
  terms: "local-visual-fixture-2026-08-16",
  localFixture: true
};

export function shouldUseDevelopmentIdentity(envVersion: string, platform: string, remoteDebugMode = false, cloudTransport = false): boolean {
  return !cloudTransport && envVersion === "develop" && (platform === "devtools" || remoteDebugMode);
}

export function legalDocumentVersions(envVersion: string, platform: string, remoteDebugMode = false, cloudTransport = false): LegalDocumentVersions | null {
  return shouldUseDevelopmentIdentity(envVersion, platform, remoteDebugMode, cloudTransport) ? localLegalFixture : approvedLegalDocumentVersions;
}
