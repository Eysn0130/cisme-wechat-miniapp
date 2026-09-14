import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

if (process.env.CISME_PR3_LOCAL_STACK !== "true") throw new Error("PR3_LOCAL_STACK_EXPLICIT_OPT_IN_REQUIRED");
const origin = process.env.CISME_PR3_API_ORIGIN ?? "";
if (!/^http:\/\/127\.0\.0\.1:\d{2,5}$/.test(origin)) throw new Error("PR3_LOCAL_LOOPBACK_ORIGIN_REQUIRED");

const runId = randomUUID();
const bytes = Buffer.from([0xff, 0xd8, 0xff, 0x00]);

async function call(path: string, init: RequestInit = {}, expected = 200): Promise<Response> {
  const response = await fetch(`${origin}${path}`, init);
  assert.equal(response.status, expected, `${init.method ?? "GET"} ${path}: ${response.status}`);
  return response;
}

async function json(path: string, init: RequestInit = {}, expected = 200): Promise<Record<string, any>> {
  return (await call(path, init, expected)).json() as Promise<Record<string, any>>;
}

function payload(body: unknown, token?: string): RequestInit {
  return { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) };
}

async function identity(label: string) {
  const result = await json("/v1/identity/dev", payload({ externalUserId: `pr3-stack-${runId}-${label}`,
    displayName: `PR3 Synthetic ${label}`, consents: [{ documentType: "privacy", version: "synthetic" }, { documentType: "terms", version: "synthetic" }] }));
  assert.equal(typeof result.sessionToken, "string");
  assert.equal(typeof result.memberId, "string");
  return result as { sessionToken: string; memberId: string };
}

async function uploadSupportImage(token: string): Promise<string> {
  const authorization = await json("/v1/me/support/media/authorize", payload({ mimeType: "image/jpeg", maxBytes: bytes.length }, token));
  assert.equal(authorization.method, "POST");
  assert.equal(typeof authorization.fields.token, "string");
  const mediaId = String(authorization.mediaId);
  await json(`/v1/uploads/${mediaId}/chunks`, payload({ token: authorization.fields.token, index: 0,
    totalBytes: bytes.length, base64: bytes.toString("base64") }));
  await json(`/v1/uploads/${mediaId}/assemble`, payload({ token: authorization.fields.token }));
  await json(`/v1/me/support/media/${mediaId}/complete`, payload({}, token));
  return mediaId;
}

await json("/health/live");
await json("/health/ready");
const member = await identity("owner");
const other = await identity("other");
const me = await json("/v1/me", { headers: { authorization: `Bearer ${member.sessionToken}` } });
assert.equal(me.id, member.memberId);
const profile = await json("/v1/me/profile", { method: "PUT", headers: { authorization: `Bearer ${member.sessionToken}`, "content-type": "application/json" },
  body: JSON.stringify({ displayName: "PR3 Local Smoke Member", expectedVersion: 0 }) });
assert.equal(profile.display_name, "PR3 Local Smoke Member");

const readable = await uploadSupportImage(member.sessionToken);
const sent = await json("/v1/me/support/messages", payload({ body: "", mediaIds: [readable], clientMessageId: `pr3-stack-${runId}-message` }, member.sessionToken));
assert.equal(sent.message.attachments[0].id, readable);
const ownRead = await call(`/v1/me/support/media/${readable}`, { headers: { authorization: `Bearer ${member.sessionToken}` } });
assert.deepEqual(Buffer.from(await ownRead.arrayBuffer()), bytes);
await call(`/v1/me/support/media/${readable}`, { headers: { authorization: `Bearer ${other.sessionToken}` } }, 404);

const removable = await uploadSupportImage(member.sessionToken);
await json(`/v1/me/support/media/${removable}`, { method: "DELETE", headers: { authorization: `Bearer ${member.sessionToken}` } });
await call(`/v1/me/support/media/${removable}`, { headers: { authorization: `Bearer ${member.sessionToken}` } }, 404);

console.log(JSON.stringify({ localStack: "LOCAL_STACK_SMOKE", runId, memberId: member.memberId,
  profileRevision: profile.profile_revision, ownMediaRead: true, crossMemberMediaDenied: true,
  cleanupQueuedMediaId: removable }));
