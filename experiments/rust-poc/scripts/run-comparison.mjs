import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const fastifyUrl = process.env.FASTIFY_URL ?? "http://127.0.0.1:3110";
const rustUrl = process.env.RUST_URL ?? "http://127.0.0.1:3210";
const rounds = Number(process.env.ROUNDS ?? 5);
const samples = process.env.SAMPLES ?? "300";
const concurrency = process.env.CONCURRENCY ?? "10";
const warmup = process.env.WARMUP ?? "50";
if (!Number.isInteger(rounds) || rounds < 1 || rounds > 20) throw new Error("ROUNDS_INVALID");

const identityResponse = await fetch(`${fastifyUrl}/v1/identity/dev`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    externalUserId: process.env.BENCHMARK_EXTERNAL_USER_ID ?? "rust-poc-benchmark",
    displayName: "Rust PoC benchmark",
    consents: [
      { documentType: "privacy", version: "rust-poc" },
      { documentType: "terms", version: "rust-poc" },
    ],
  }),
});
const identity = await identityResponse.json();
if (!identityResponse.ok || typeof identity.sessionToken !== "string") {
  throw new Error(`Fastify fixture identity failed with ${identityResponse.status}`);
}

const benchmark = join(dirname(fileURLToPath(import.meta.url)), "benchmark.mjs");
for (let round = 1; round <= rounds; round += 1) {
  const targets = round % 2 === 1
    ? [["fastify", fastifyUrl], ["rust", rustUrl]]
    : [["rust", rustUrl], ["fastify", fastifyUrl]];
  for (const [target, targetUrl] of targets) {
    for (const route of ["/v1/capabilities", "/v1/bootstrap/settings"]) {
      const result = spawnSync(process.execPath, [benchmark], {
        encoding: "utf8",
        env: {
          ...process.env,
          TARGET_NAME: target,
          TARGET_URL: targetUrl,
          ROUTE: route,
          ROUND: String(round),
          SAMPLES: samples,
          CONCURRENCY: concurrency,
          WARMUP: warmup,
          ...(route.startsWith("/v1/bootstrap/") ? { AUTH_TOKEN: identity.sessionToken } : {}),
        },
      });
      if (result.status !== 0) throw new Error(result.stderr || `benchmark failed for ${target} ${route}`);
      process.stdout.write(result.stdout);
    }
  }
}

