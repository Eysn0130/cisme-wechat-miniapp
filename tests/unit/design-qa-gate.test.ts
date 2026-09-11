import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import { deflateSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { evaluateDesignQaEvidence } from "../../scripts/design-qa-lib";

const exec = promisify(execFile);
const temporaryRoots: string[] = [];

function crc32(content: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of content) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, payload: Buffer): Buffer {
  const typeBytes = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(payload.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBytes, payload])));
  return Buffer.concat([length, typeBytes, payload, crc]);
}

function validPng(width = 1200, height = 768): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const scanlines = Buffer.alloc((width * 4 + 1) * height);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(scanlines)),
    pngChunk("IEND", Buffer.alloc(0))
  ]);
}

async function createEvidenceFixture(
  mutator: (manifest: Record<string, any>) => void,
  metadataMutator?: (manifest: Record<string, any>) => void
): Promise<string> {
  const fixtureRoot = await mkdtemp(resolve(tmpdir(), "cisme-design-qa-"));
  temporaryRoots.push(fixtureRoot);
  const sourceRoot = resolve(import.meta.dirname, "../..");
  await cp(resolve(sourceRoot, "apps/miniprogram"), resolve(fixtureRoot, "apps/miniprogram"), { recursive: true });
  const packageResult = await evaluateDesignQaEvidence(sourceRoot);
  // Synthetic evidence exists only in this disposable test root. Production
  // screenshots and their completeness must never define the test fixture.
  const app = JSON.parse(await readFile(resolve(sourceRoot, "apps/miniprogram/app.json"), "utf8"));
  const hash = packageResult.packageSourceSha256.slice(0, 8);
  const currentManifest: Record<string, any> = {
    schemaVersion: 2,
    packageSourceSha256: packageResult.packageSourceSha256,
    finalResult: "blocked",
    evidenceIndex: {},
    devtools: {
      packageSourceSha256: packageResult.packageSourceSha256,
      compileErrors: 0,
      consoleErrors: 0,
      networkFailures: null,
      compileEvidenceFiles: [`docs/evidence/fixture-${hash}-compile.png`],
      consoleEvidenceFiles: [`docs/evidence/fixture-${hash}-console.png`],
      networkEvidenceFiles: []
    },
    routeCoverage: app.pages.map((route: string) => ({ route, matrixComplete: false, result: "blocked", evidenceFiles: [] })),
    devices: [],
    findings: [{ id: "SYNTHETIC_TEST_FIXTURE", severity: "P1", status: "open" }]
  };
  mutator(currentManifest);
  const manifestPath = resolve(fixtureRoot, "docs/evidence/visual/current-source-acceptance.json");
  await mkdir(dirname(manifestPath), { recursive: true });
  const evidencePaths = [
    ...currentManifest.devtools.compileEvidenceFiles,
    ...currentManifest.devtools.consoleEvidenceFiles,
    ...currentManifest.devtools.networkEvidenceFiles,
    ...currentManifest.routeCoverage.flatMap((entry: Record<string, any>) => entry.states?.length
      ? entry.states.flatMap((state: Record<string, any>) => state.evidenceFiles)
      : entry.evidenceFiles),
    ...currentManifest.devices.flatMap((entry: Record<string, any>) => entry.evidenceFiles)
  ].filter((path: unknown): path is string => typeof path === "string");
  for (const path of evidencePaths) {
    const target = resolve(fixtureRoot, path);
    await mkdir(dirname(target), { recursive: true });
    const content = validPng();
    await writeFile(target, content);
    const devtoolsKind = currentManifest.devtools.compileEvidenceFiles.includes(path) ? "devtools_compile"
      : currentManifest.devtools.consoleEvidenceFiles.includes(path) ? "devtools_console"
        : currentManifest.devtools.networkEvidenceFiles.includes(path) ? "devtools_network" : null;
    const routeEntry = currentManifest.routeCoverage.find((entry: Record<string, any>) =>
      entry.evidenceFiles?.includes(path) || entry.states?.some((state: Record<string, any>) => state.evidenceFiles.includes(path)));
    const stateEntry = routeEntry?.states?.find((state: Record<string, any>) => state.evidenceFiles.includes(path));
    const deviceEntry = currentManifest.devices.find((entry: Record<string, any>) => entry.evidenceFiles.includes(path));
    const routeKind = path.includes("/web/") ? "route_reference"
      : path.includes("/comparisons/") ? "route_comparison" : "route_native";
    const kind = devtoolsKind ?? (deviceEntry ? `device_${deviceEntry.platform}` : routeKind);
    currentManifest.evidenceIndex[path] = {
      sha256: createHash("sha256").update(content).digest("hex"),
      bytes: content.byteLength,
      mimeType: "image/png",
      widthPx: 1200,
      heightPx: 768,
      kind,
      packageSourceSha256: kind === "route_reference" ? null : packageResult.packageSourceSha256,
      ...(routeEntry ? { route: routeEntry.route, state: stateEntry?.state ?? "default", viewport: "375x812@2x" } : {}),
      ...(deviceEntry ? {
        platform: deviceEntry.platform,
        state: "device-smoke",
        viewport: "390x844@3x",
        deviceModel: "fixture-device",
        osVersion: "fixture-os",
        hardware: true
      } : {})
    };
  }
  metadataMutator?.(currentManifest);
  await writeFile(manifestPath, JSON.stringify(currentManifest));
  return fixtureRoot;
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("design QA evidence gate", () => {
  it("binds the honest blocked manifest to the current mini-program hash", async () => {
    const status = await evaluateDesignQaEvidence();
    expect(status.ok).toBe(true);
    expect(status.releaseReady).toBe(false);
    expect(status.structuralErrors).toEqual([]);
    expect(status.releaseErrors).toContain("DESIGN_QA_ROUTE_MATRIX_INCOMPLETE:pages/home/index");
    expect(status.releaseErrors).toContain("DESIGN_QA_OPEN_P0_OR_P1");
    expect(status.releaseErrors).toContain("DESIGN_QA_DEVICE_EVIDENCE_REQUIRED:ios");
    expect(status.releaseErrors).toContain("DESIGN_QA_DEVICE_EVIDENCE_REQUIRED:android");
  });

  it("fails the strict release gate while current-source evidence is incomplete", async () => {
    await expect(exec("./node_modules/.bin/tsx", ["scripts/check-design-qa.ts", "--require-passed"]))
      .rejects.toMatchObject({ code: 1 });
  });

  it("rejects evidence filed under the wrong DevTools category", async () => {
    const root = await createEvidenceFixture((manifest) => {
      const hash = manifest.packageSourceSha256.slice(0, 8);
      manifest.devtools.consoleEvidenceFiles = [`docs/evidence/devtools-package-${hash}-compile.png`];
    });
    const status = await evaluateDesignQaEvidence(root);
    expect(status.ok).toBe(false);
    expect(status.structuralErrors).toEqual(expect.arrayContaining([
      expect.stringContaining("DESIGN_QA_EVIDENCE_TYPE_MISMATCH:console:")
    ]));
  });

  it("rejects evidence metadata whose category contradicts the manifest list", async () => {
    const root = await createEvidenceFixture(() => {}, (manifest) => {
      const path = manifest.devtools.consoleEvidenceFiles[0];
      manifest.evidenceIndex[path].kind = "devtools_compile";
    });
    const status = await evaluateDesignQaEvidence(root);
    expect(status.ok).toBe(false);
    expect(status.structuralErrors).toEqual(expect.arrayContaining([
      expect.stringContaining("DESIGN_QA_EVIDENCE_KIND_MISMATCH:console:")
    ]));
  });

  it("rejects renamed or mutated evidence whose digest no longer matches", async () => {
    const root = await createEvidenceFixture(() => {}, (manifest) => {
      const path = manifest.devtools.compileEvidenceFiles[0];
      manifest.evidenceIndex[path].sha256 = "0".repeat(64);
    });
    const status = await evaluateDesignQaEvidence(root);
    expect(status.ok).toBe(false);
    expect(status.structuralErrors).toEqual(expect.arrayContaining([
      expect.stringContaining("DESIGN_QA_EVIDENCE_DIGEST_MISMATCH:")
    ]));
  });

  it("rejects a header-only fake image even when its digest and dimensions metadata match", async () => {
    const root = await createEvidenceFixture(() => {});
    const manifestPath = resolve(root, "docs/evidence/visual/current-source-acceptance.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, any>;
    const path = manifest.devtools.compileEvidenceFiles[0] as string;
    const fake = Buffer.alloc(128);
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(fake, 0);
    fake.writeUInt32BE(1200, 16);
    fake.writeUInt32BE(768, 20);
    await writeFile(resolve(root, path), fake);
    manifest.evidenceIndex[path].sha256 = createHash("sha256").update(fake).digest("hex");
    manifest.evidenceIndex[path].bytes = fake.length;
    await writeFile(manifestPath, JSON.stringify(manifest));

    const status = await evaluateDesignQaEvidence(root);
    expect(status.ok).toBe(false);
    expect(status.structuralErrors).toContain(`DESIGN_QA_EVIDENCE_IMAGE_STRUCTURE_INVALID:${path}`);
  });

  it("rejects unreferenced entries left in the current evidence index", async () => {
    const root = await createEvidenceFixture(() => {}, (manifest) => {
      const exemplar = Object.values(manifest.evidenceIndex)[0] as Record<string, unknown>;
      manifest.evidenceIndex["docs/evidence/visual/current-run/native/orphan.png"] = {
        ...exemplar,
        sha256: "0".repeat(64)
      };
    });
    const status = await evaluateDesignQaEvidence(root);
    expect(status.ok).toBe(false);
    expect(status.structuralErrors).toContain("DESIGN_QA_EVIDENCE_UNREFERENCED:docs/evidence/visual/current-run/native/orphan.png");
  });

  it("rejects typed DevTools evidence from a different source hash", async () => {
    const root = await createEvidenceFixture((manifest) => {
      manifest.devtools.networkEvidenceFiles = ["docs/evidence/devtools-package-deadbeef-network.har"];
    });
    const status = await evaluateDesignQaEvidence(root);
    expect(status.ok).toBe(false);
    expect(status.structuralErrors).toEqual(expect.arrayContaining([
      expect.stringContaining("DESIGN_QA_EVIDENCE_HASH_MISMATCH:network:")
    ]));
  });

  it("does not accept compile or route screenshots in place of a missing Console category", async () => {
    const root = await createEvidenceFixture((manifest) => {
      manifest.devtools.consoleEvidenceFiles = [];
    });
    const status = await evaluateDesignQaEvidence(root);
    expect(status.ok).toBe(true);
    expect(status.releaseReady).toBe(false);
    expect(status.releaseErrors).toContain("DESIGN_QA_CURRENT_CONSOLE_EVIDENCE_REQUIRED");
  });

  it("does not accept a three-file route count without the required state matrix", async () => {
    const root = await createEvidenceFixture((manifest) => {
      const route = manifest.routeCoverage.find((entry: Record<string, any>) => entry.route === "pages/home/index");
      route.result = "passed";
      route.matrixComplete = true;
      route.evidenceFiles = [
        "docs/evidence/visual/current-run/web/home-default-375x812.png",
        `docs/evidence/visual/current-run/native/home-default-${manifest.packageSourceSha256.slice(0, 8)}-375x812.png`,
        `docs/evidence/visual/current-run/comparisons/home-default-${manifest.packageSourceSha256.slice(0, 8)}.png`
      ];
      delete route.states;
    });
    const status = await evaluateDesignQaEvidence(root);
    expect(status.releaseReady).toBe(false);
    expect(status.releaseErrors).toContain("DESIGN_QA_ROUTE_STATE_MISSING:pages/home/index:default");
  });
});
