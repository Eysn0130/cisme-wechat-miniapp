import { createHmac } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

const fastifyUrl = process.env.FASTIFY_URL ?? "http://127.0.0.1:3110";
const rustUrl = process.env.RUST_URL ?? "http://127.0.0.1:3210";
const secret = process.env.APP_SESSION_SECRET;
if (!secret) throw new Error("APP_SESSION_SECRET is required");

async function response(base, path, init) {
  const value = await fetch(`${base}${path}`, init);
  const body = await value.json();
  return { status: value.status, contentType: value.headers.get("content-type")?.split(";", 1)[0] ?? null, body };
}

function normalize(value, key = "") {
  if (key === "asOf" || key === "trace_id") return undefined;
  if (Array.isArray(value)) return value.map((item) => normalize(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).flatMap(([childKey, child]) => {
      const normalized = normalize(child, childKey);
      return normalized === undefined ? [] : [[childKey, normalized]];
    }));
  }
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value)) {
    const timestamp = Date.parse(value);
    if (Number.isFinite(timestamp)) return new Date(timestamp).toISOString();
  }
  return value;
}

function assertSame(label, left, right) {
  if (!isDeepStrictEqual(normalize(left), normalize(right))) {
    throw new Error(`${label} mismatch:\nFastify=${JSON.stringify(left)}\nRust=${JSON.stringify(right)}`);
  }
}

function resign(token, expiresAt) {
  const [encoded] = token.split(".");
  const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  const updated = Buffer.from(JSON.stringify({ ...payload, expiresAt })).toString("base64url");
  const signature = createHmac("sha256", secret).update(updated).digest("base64url");
  return `${updated}.${signature}`;
}

const capabilities = await Promise.all([
  response(fastifyUrl, "/v1/capabilities"),
  response(rustUrl, "/v1/capabilities"),
]);
assertSame("capabilities", capabilities[0], capabilities[1]);

const identity = await response(fastifyUrl, "/v1/identity/dev", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    externalUserId: process.env.PARITY_EXTERNAL_USER_ID ?? "rust-poc-parity",
    displayName: "Rust PoC parity member",
    consents: [
      { documentType: "privacy", version: "rust-poc" },
      { documentType: "terms", version: "rust-poc" },
    ],
  }),
});
if (identity.status !== 200 || typeof identity.body.sessionToken !== "string") {
  throw new Error(`Fastify fixture identity failed with ${identity.status}`);
}
const token = identity.body.sessionToken;
const authorizedHeaders = { authorization: `Bearer ${token}` };
const settings = await Promise.all([
  response(fastifyUrl, "/v1/bootstrap/settings", { headers: authorizedHeaders }),
  response(rustUrl, "/v1/bootstrap/settings", { headers: authorizedHeaders }),
]);
assertSame("settings bootstrap", settings[0], settings[1]);

const errorCases = [
  ["missing", undefined],
  ["tampered", `${token.slice(0, -1)}${token.endsWith("a") ? "b" : "a"}`],
  ["expired", resign(token, 0)],
];
for (const [label, candidate] of errorCases) {
  const init = candidate ? { headers: { authorization: `Bearer ${candidate}` } } : undefined;
  const pair = await Promise.all([
    response(fastifyUrl, "/v1/bootstrap/settings", init),
    response(rustUrl, "/v1/bootstrap/settings", init),
  ]);
  if (!pair.every((item) => item.contentType?.startsWith("application/problem+json"))) {
    throw new Error(`${label} did not return application/problem+json from both candidates`);
  }
  assertSame(label, pair[0], pair[1]);
}

process.stdout.write(`${JSON.stringify({
  passed: true,
  checks: ["capabilities", "settings_bootstrap", "auth_missing", "auth_tampered", "auth_expired"],
  volatileFieldsIgnored: ["asOf", "trace_id"],
  timestampStringsComparedByInstant: true,
})}\n`);
