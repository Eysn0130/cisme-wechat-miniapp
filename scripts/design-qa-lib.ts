import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { inspectMiniProgramPackage } from "./miniprogram-package-lib";

type Result = "passed" | "blocked";

interface DesignQaManifest {
  schemaVersion: number;
  packageSourceSha256: string;
  finalResult: Result;
  evidenceIndex: Record<string, EvidenceDescriptor>;
  devtools: null | {
    packageSourceSha256: string;
    compileErrors: number;
    consoleErrors: number | null;
    networkFailures: number | null;
    compileEvidenceFiles: string[];
    consoleEvidenceFiles: string[];
    networkEvidenceFiles: string[];
  };
  routeCoverage: Array<{
    route: string;
    matrixComplete: boolean;
    result: Result;
    evidenceFiles: string[];
    states?: Array<{
      state: string;
      applicability: "applicable" | "not_applicable";
      result: Result;
      reason?: string;
      evidenceFiles: string[];
    }>;
  }>;
  devices: Array<{
    platform: "ios" | "android";
    result: Result;
    evidenceFiles: string[];
  }>;
  findings: Array<{
    id: string;
    severity: "P0" | "P1" | "P2";
    status: "open" | "blocked" | "fixed";
  }>;
}

type EvidenceKind =
  | "devtools_compile"
  | "devtools_console"
  | "devtools_network"
  | "route_reference"
  | "route_native"
  | "route_comparison"
  | "device_ios"
  | "device_android";

interface EvidenceDescriptor {
  sha256: string;
  bytes: number;
  mimeType: "image/png" | "image/jpeg" | "application/json";
  widthPx?: number;
  heightPx?: number;
  kind: EvidenceKind;
  packageSourceSha256: string | null;
  route?: string;
  state?: string;
  viewport?: string;
  platform?: "ios" | "android";
  deviceModel?: string;
  osVersion?: string;
  hardware?: boolean;
}

const requiredRouteStates = [
  "default",
  "loading",
  "empty",
  "error",
  "unauthorized",
  "long-copy",
  "keyboard",
  "modal",
  "scroll-bottom",
  "back-restore"
] as const;

function detectMimeType(content: Buffer): EvidenceDescriptor["mimeType"] | null {
  if (content.length >= 8 && content.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (content.length >= 3 && content[0] === 0xff && content[1] === 0xd8 && content[2] === 0xff) return "image/jpeg";
  try { JSON.parse(content.toString("utf8")); return "application/json"; } catch { return null; }
}

function imageDimensions(content: Buffer, mimeType: EvidenceDescriptor["mimeType"]): { width: number; height: number } | null {
  if (mimeType === "image/png" && content.length >= 24) {
    return { width: content.readUInt32BE(16), height: content.readUInt32BE(20) };
  }
  if (mimeType === "image/jpeg") {
    let offset = 2;
    while (offset + 8 < content.length) {
      if (content[offset] !== 0xff) { offset += 1; continue; }
      const marker = content[offset + 1];
      if (marker === undefined) return null;
      const length = content.readUInt16BE(offset + 2);
      if (length < 2) return null;
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
        return { width: content.readUInt16BE(offset + 7), height: content.readUInt16BE(offset + 5) };
      }
      offset += 2 + length;
    }
  }
  return null;
}

function crc32(content: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of content) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function imageStructureValid(content: Buffer, mimeType: EvidenceDescriptor["mimeType"]): boolean {
  if (mimeType === "image/png") {
    let offset = 8;
    let chunks = 0;
    let hasHeader = false;
    let hasData = false;
    let hasEnd = false;
    while (offset + 12 <= content.length) {
      const length = content.readUInt32BE(offset);
      const end = offset + 12 + length;
      if (end > content.length) return false;
      const type = content.subarray(offset + 4, offset + 8).toString("ascii");
      const payload = content.subarray(offset + 8, offset + 8 + length);
      const expectedCrc = content.readUInt32BE(offset + 8 + length);
      if (crc32(content.subarray(offset + 4, offset + 8 + length)) !== expectedCrc) return false;
      chunks += 1;
      if (chunks === 1) hasHeader = type === "IHDR" && length === 13;
      if (type === "IDAT" && length > 0) hasData = true;
      if (type === "IEND") {
        hasEnd = length === 0 && end === content.length;
        offset = end;
        break;
      }
      if (type === "IHDR" && payload.length !== 13) return false;
      offset = end;
    }
    return hasHeader && hasData && hasEnd && offset === content.length;
  }
  if (mimeType === "image/jpeg") {
    return content.length >= 128
      && content[0] === 0xff
      && content[1] === 0xd8
      && content[content.length - 2] === 0xff
      && content[content.length - 1] === 0xd9
      && content.includes(Buffer.from([0xff, 0xda]));
  }
  return mimeType === "application/json";
}

async function evidenceFileErrors(
  root: string,
  paths: string[],
  index: Record<string, EvidenceDescriptor>,
  currentSourceSha256: string
): Promise<string[]> {
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const relativePath of paths) {
    if (seen.has(relativePath)) {
      errors.push(`DESIGN_QA_EVIDENCE_REUSED:${relativePath}`);
      continue;
    }
    seen.add(relativePath);
    const absolute = resolve(root, relativePath);
    if (!absolute.startsWith(`${root}${sep}`)) {
      errors.push(`DESIGN_QA_EVIDENCE_PATH_OUTSIDE_REPOSITORY:${relativePath}`);
      continue;
    }
    const descriptor = index[relativePath];
    if (!descriptor) {
      errors.push(`DESIGN_QA_EVIDENCE_METADATA_MISSING:${relativePath}`);
      continue;
    }
    try {
      const content = await readFile(absolute);
      const actualSha256 = createHash("sha256").update(content).digest("hex");
      const actualMimeType = detectMimeType(content);
      if (content.byteLength < 64) errors.push(`DESIGN_QA_EVIDENCE_FILE_TOO_SMALL:${relativePath}`);
      if (descriptor.bytes !== content.byteLength) errors.push(`DESIGN_QA_EVIDENCE_SIZE_MISMATCH:${relativePath}`);
      if (descriptor.sha256 !== actualSha256) errors.push(`DESIGN_QA_EVIDENCE_DIGEST_MISMATCH:${relativePath}`);
      if (!actualMimeType || descriptor.mimeType !== actualMimeType) errors.push(`DESIGN_QA_EVIDENCE_MIME_MISMATCH:${relativePath}`);
      if (actualMimeType === "image/png" || actualMimeType === "image/jpeg") {
        if (!imageStructureValid(content, actualMimeType)) errors.push(`DESIGN_QA_EVIDENCE_IMAGE_STRUCTURE_INVALID:${relativePath}`);
        const dimensions = imageDimensions(content, actualMimeType);
        if (!dimensions || dimensions.width < 320 || dimensions.height < 480) {
          errors.push(`DESIGN_QA_EVIDENCE_IMAGE_DIMENSIONS_INVALID:${relativePath}`);
        } else if (descriptor.widthPx !== dimensions.width || descriptor.heightPx !== dimensions.height) {
          errors.push(`DESIGN_QA_EVIDENCE_DIMENSIONS_MISMATCH:${relativePath}`);
        }
      }
      if (descriptor.kind !== "route_reference" && descriptor.packageSourceSha256 !== currentSourceSha256) {
        errors.push(`DESIGN_QA_EVIDENCE_SOURCE_MISMATCH:${relativePath}`);
      }
      if (descriptor.kind === "route_reference" && descriptor.packageSourceSha256 !== null) {
        errors.push(`DESIGN_QA_REFERENCE_MUST_BE_SOURCE_INDEPENDENT:${relativePath}`);
      }
    } catch {
      errors.push(`DESIGN_QA_EVIDENCE_FILE_MISSING:${relativePath}`);
    }
  }
  return errors;
}

function typedDevtoolsEvidenceErrors(manifest: DesignQaManifest, currentSourceSha256: string): string[] {
  if (!manifest.devtools) return [];
  const hashPrefix = currentSourceSha256.slice(0, 8);
  const hashMarker = new RegExp(`(?:^|[-_/])${hashPrefix}(?:[-_./]|$)`, "i");
  const categories: Array<[string, unknown, RegExp, EvidenceKind]> = [
    ["compile", manifest.devtools.compileEvidenceFiles, /compile/i, "devtools_compile"],
    ["console", manifest.devtools.consoleEvidenceFiles, /console/i, "devtools_console"],
    ["network", manifest.devtools.networkEvidenceFiles, /(?:network|\.har$)/i, "devtools_network"]
  ];
  return categories.flatMap(([category, files, marker, kind]) => {
    if (files === undefined || files === null) return [];
    if (!Array.isArray(files) || files.some((path) => typeof path !== "string")) {
      return [`DESIGN_QA_EVIDENCE_LIST_INVALID:${category}`];
    }
    return files.flatMap((path) => {
      const errors: string[] = [];
      if (!hashMarker.test(path)) errors.push(`DESIGN_QA_EVIDENCE_HASH_MISMATCH:${category}:${path}`);
      if (!marker.test(path)) errors.push(`DESIGN_QA_EVIDENCE_TYPE_MISMATCH:${category}:${path}`);
      if (manifest.evidenceIndex?.[path]?.kind !== kind) errors.push(`DESIGN_QA_EVIDENCE_KIND_MISMATCH:${category}:${path}`);
      return errors;
    });
  });
}

function routeMatrixErrors(manifest: DesignQaManifest, route: string, currentSourceSha256: string): string[] {
  const coverage = manifest.routeCoverage.find((entry) => entry.route === route);
  if (!coverage || coverage.result !== "passed" || !coverage.matrixComplete) return [`DESIGN_QA_ROUTE_MATRIX_INCOMPLETE:${route}`];
  const states = coverage.states ?? [];
  const errors: string[] = [];
  for (const stateName of requiredRouteStates) {
    const state = states.find((entry) => entry.state === stateName);
    if (!state) {
      errors.push(`DESIGN_QA_ROUTE_STATE_MISSING:${route}:${stateName}`);
      continue;
    }
    if (state.applicability === "not_applicable") {
      if (!state.reason || state.reason.trim().length < 20) errors.push(`DESIGN_QA_ROUTE_STATE_NA_REASON_REQUIRED:${route}:${stateName}`);
      continue;
    }
    if (state.result !== "passed") {
      errors.push(`DESIGN_QA_ROUTE_STATE_BLOCKED:${route}:${stateName}`);
      continue;
    }
    const descriptors = state.evidenceFiles
      .map((path) => manifest.evidenceIndex?.[path])
      .filter((entry): entry is EvidenceDescriptor => entry !== undefined);
    const hasReference = descriptors.some((entry) => entry.kind === "route_reference" && entry.route === route && entry.state === stateName);
    const hasNative = descriptors.some((entry) => entry.kind === "route_native" && entry.route === route && entry.state === stateName && entry.packageSourceSha256 === currentSourceSha256);
    const hasComparison = descriptors.some((entry) => entry.kind === "route_comparison" && entry.route === route && entry.state === stateName && entry.packageSourceSha256 === currentSourceSha256);
    if (!hasReference || !hasNative || !hasComparison) errors.push(`DESIGN_QA_ROUTE_STATE_EVIDENCE_INCOMPLETE:${route}:${stateName}`);
  }
  return errors;
}

function deviceEvidenceErrors(manifest: DesignQaManifest, platform: "ios" | "android", currentSourceSha256: string): string[] {
  const evidence = manifest.devices.find((entry) => entry.platform === platform);
  if (!evidence || evidence.result !== "passed" || evidence.evidenceFiles.length === 0) return [`DESIGN_QA_DEVICE_EVIDENCE_REQUIRED:${platform}`];
  const expectedKind: EvidenceKind = platform === "ios" ? "device_ios" : "device_android";
  const valid = evidence.evidenceFiles.some((path) => {
    const descriptor = manifest.evidenceIndex?.[path];
    return descriptor?.kind === expectedKind
      && descriptor.platform === platform
      && descriptor.packageSourceSha256 === currentSourceSha256
      && descriptor.hardware === true
      && Boolean(descriptor.deviceModel && descriptor.osVersion && descriptor.viewport && descriptor.state);
  });
  return valid ? [] : [`DESIGN_QA_DEVICE_EVIDENCE_REQUIRED:${platform}`];
}

export async function evaluateDesignQaEvidence(root = resolve(import.meta.dirname, "..")) {
  const manifestPath = resolve(root, "docs/evidence/visual/current-source-acceptance.json");
  const packageResult = await inspectMiniProgramPackage(resolve(root, "apps/miniprogram"));
  const structuralErrors: string[] = [];
  let manifest: DesignQaManifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8")) as DesignQaManifest;
  } catch {
    return {
      ok: false,
      releaseReady: false,
      packageSourceSha256: packageResult.actual.sourceSha256,
      structuralErrors: ["DESIGN_QA_MANIFEST_MISSING_OR_INVALID"],
      releaseErrors: ["DESIGN_QA_CURRENT_SOURCE_EVIDENCE_REQUIRED"]
    };
  }

  if (manifest.schemaVersion !== 2) structuralErrors.push("DESIGN_QA_MANIFEST_SCHEMA_UNSUPPORTED");
  if (manifest.packageSourceSha256 !== packageResult.actual.sourceSha256) structuralErrors.push("DESIGN_QA_PACKAGE_HASH_MISMATCH");
  if (!Array.isArray(manifest.routeCoverage) || !Array.isArray(manifest.devices) || !Array.isArray(manifest.findings) || !manifest.evidenceIndex) {
    structuralErrors.push("DESIGN_QA_MANIFEST_COLLECTIONS_INVALID");
  }
  const evidencePaths = [
    ...(manifest.devtools?.compileEvidenceFiles ?? []),
    ...(manifest.devtools?.consoleEvidenceFiles ?? []),
    ...(manifest.devtools?.networkEvidenceFiles ?? []),
    ...((manifest.routeCoverage ?? []).flatMap((entry) => entry.states?.length
      ? entry.states.flatMap((state) => state.evidenceFiles ?? [])
      : entry.evidenceFiles ?? [])),
    ...((manifest.devices ?? []).flatMap((entry) => entry.evidenceFiles ?? []))
  ];
  const referencedEvidence = new Set(evidencePaths);
  for (const indexedPath of Object.keys(manifest.evidenceIndex ?? {})) {
    if (!referencedEvidence.has(indexedPath)) structuralErrors.push(`DESIGN_QA_EVIDENCE_UNREFERENCED:${indexedPath}`);
  }
  structuralErrors.push(...await evidenceFileErrors(root, evidencePaths, manifest.evidenceIndex ?? {}, packageResult.actual.sourceSha256));
  structuralErrors.push(...typedDevtoolsEvidenceErrors(manifest, packageResult.actual.sourceSha256));

  const releaseErrors: string[] = [];
  if (manifest.finalResult !== "passed") releaseErrors.push("DESIGN_QA_FINAL_RESULT_NOT_PASSED");
  if (!manifest.devtools) releaseErrors.push("DESIGN_QA_CURRENT_DEVTOOLS_EVIDENCE_REQUIRED");
  else {
    if (manifest.devtools.packageSourceSha256 !== packageResult.actual.sourceSha256) releaseErrors.push("DESIGN_QA_DEVTOOLS_HASH_MISMATCH");
    if (manifest.devtools.compileErrors !== 0) releaseErrors.push("DESIGN_QA_DEVTOOLS_COMPILE_ERRORS");
    if (!Array.isArray(manifest.devtools.compileEvidenceFiles) || manifest.devtools.compileEvidenceFiles.length === 0) {
      releaseErrors.push("DESIGN_QA_CURRENT_COMPILE_EVIDENCE_REQUIRED");
    }
    if (manifest.devtools.consoleErrors === null) releaseErrors.push("DESIGN_QA_CURRENT_CONSOLE_EVIDENCE_REQUIRED");
    else if (manifest.devtools.consoleErrors !== 0) releaseErrors.push("DESIGN_QA_CONSOLE_ERRORS");
    if (!Array.isArray(manifest.devtools.consoleEvidenceFiles) || manifest.devtools.consoleEvidenceFiles.length === 0) {
      releaseErrors.push("DESIGN_QA_CURRENT_CONSOLE_EVIDENCE_REQUIRED");
    }
    if (manifest.devtools.networkFailures === null) releaseErrors.push("DESIGN_QA_CURRENT_NETWORK_EVIDENCE_REQUIRED");
    else if (manifest.devtools.networkFailures !== 0) releaseErrors.push("DESIGN_QA_NETWORK_FAILURES");
    if (!Array.isArray(manifest.devtools.networkEvidenceFiles) || manifest.devtools.networkEvidenceFiles.length === 0) {
      releaseErrors.push("DESIGN_QA_CURRENT_NETWORK_EVIDENCE_REQUIRED");
    }
  }
  for (const route of packageResult.routes) releaseErrors.push(...routeMatrixErrors(manifest, route, packageResult.actual.sourceSha256));
  for (const platform of ["ios", "android"] as const) {
    releaseErrors.push(...deviceEvidenceErrors(manifest, platform, packageResult.actual.sourceSha256));
  }
  if (manifest.findings.some((finding) => (finding.severity === "P0" || finding.severity === "P1") && finding.status !== "fixed")) {
    releaseErrors.push("DESIGN_QA_OPEN_P0_OR_P1");
  }
  releaseErrors.push(...structuralErrors);
  releaseErrors.push(...packageResult.errors.map((error) => `MINIPROGRAM_PACKAGE:${error}`));

  return {
    ok: structuralErrors.length === 0,
    releaseReady: releaseErrors.length === 0,
    packageSourceSha256: packageResult.actual.sourceSha256,
    structuralErrors,
    releaseErrors: [...new Set(releaseErrors)]
  };
}
