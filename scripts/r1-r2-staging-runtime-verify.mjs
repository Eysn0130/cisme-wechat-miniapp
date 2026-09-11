import { createHmac, randomUUID } from "node:crypto";
import { createRequire } from "node:module";

if (process.env.APP_ENV !== "staging") throw new Error("STAGING_ENV_REQUIRED");
for (const key of ["DATABASE_URL", "APP_SESSION_SECRET", "STAGING_ORIGIN"]) if (!process.env[key]) throw new Error(`${key}_REQUIRED`);
const require = createRequire(process.env.CISME_RUNTIME_REQUIRE_PATH ?? "/opt/cisme/current/index.js");
const pg = require("pg");
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 6 });
const origin = process.env.STAGING_ORIGIN.replace(/\/$/, "");
const runId = randomUUID();
const marker = `synthetic-r1r2-${runId}`;
const members = [];
const conversationIds = new Set();
const holdIds = new Set();

function assert(condition, code) { if (!condition) throw new Error(code); }
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
function token(memberId, suffix = "session") {
  const payload = Buffer.from(JSON.stringify({ principalId: `member:${memberId}:${suffix}`, memberId, adapter: "dev", expiresAt: Date.now() + 30 * 60_000 })).toString("base64url");
  return `${payload}.${createHmac("sha256", process.env.APP_SESSION_SECRET).update(payload).digest("base64url")}`;
}
async function api(path, { method = "GET", bearer, idempotencyKey, body, forged } = {}) {
  const started = performance.now();
  const response = await fetch(`${origin}${path}`, { method, headers: { "content-type": "application/json", "x-request-id": `r1r2-${randomUUID()}`,
    ...(bearer ? { authorization: `Bearer ${bearer}` } : {}), ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}), ...(forged ?? {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await response.text(); let payload = null; try { payload = JSON.parse(text); } catch {}
  return { status: response.status, body: payload, bytes: Buffer.byteLength(text), ms: performance.now() - started };
}
async function createMember(label) {
  const row = (await pool.query("INSERT INTO member(display_name) VALUES($1) RETURNING id", [`${marker}-${label}`])).rows[0];
  const value = { label, memberId: row.id, token: token(row.id) }; members.push(value); return value;
}
async function grant(who, capabilities) {
  for (const capability of capabilities) await pool.query(`INSERT INTO authority_grant(member_id,capability,granted_by,grant_reason)
    VALUES($1,$2,$3,'Synthetic R1 R2 staging verification')`, [who.memberId, capability, marker]);
}
async function expectPgMessage(sql, values, expected) {
  try { await pool.query(sql, values); } catch (error) { assert(String(error.message).includes(expected), `EXPECTED_${expected}_GOT_${error.message}`); return; }
  throw new Error(`EXPECTED_${expected}_BUT_SUCCEEDED`);
}

const before = (await pool.query(`SELECT jsonb_build_object('member',(SELECT count(*) FROM member),'grant',(SELECT count(*) FROM authority_grant),
  'conversation',(SELECT count(*) FROM support_conversation),'message',(SELECT count(*) FROM support_message),'hold',(SELECT count(*) FROM legal_hold),
  'audit',(SELECT count(*) FROM audit_log),'outbox',(SELECT count(*) FROM outbox_event),'idempotency',(SELECT count(*) FROM idempotency_operation)) AS value`)).rows[0].value;
for (const key of ["member", "grant", "conversation", "message", "hold"]) assert(Number(before[key]) === 0, `STAGING_${key.toUpperCase()}_BASELINE_NOT_EMPTY`);
assert(Number((await pool.query("SELECT count(*) AS count FROM schema_migration")).rows[0].count) === 31, "MIGRATION_LEDGER_NOT_31");
const result = { capability: {}, support: {}, race: {}, polling: {}, retention: {}, cleanup: {} };

try {
  const ordinary = await createMember("ordinary-user");
  const member = await createMember("member");
  const adminA = await createMember("support-admin-a");
  const adminB = await createMember("support-admin-b");
  const limited = await createMember("limited-admin");
  const revoked = await createMember("revoked-admin");
  const privacy = await createMember("privacy-admin");
  await pool.query("INSERT INTO member_team_access(member_id,role,granted_by) VALUES($1,'administrator',$2)", [member.memberId, marker]);
  await grant(adminA, ["support.read", "support.reply", "support.assign", "member.support_view"]);
  await grant(adminB, ["support.read", "support.reply", "support.assign"]);
  await grant(limited, ["support.read"]);
  await grant(revoked, ["support.read"]);
  await grant(privacy, ["privacy.request.manage"]);

  const ordinaryQueue = await api("/v1/management/support/conversations", { bearer: ordinary.token, forged: { "x-admin": "true", role: "support", "x-team-role": "administrator" } });
  const memberQueue = await api("/v1/management/support/conversations", { bearer: member.token, forged: { "x-admin": "true" } });
  const legacyAdmin = await api("/v1/admin/privacy-requests", { bearer: ordinary.token });
  const limitedClaim = await api(`/v1/management/support/conversations/${randomUUID()}/claim`, { method: "POST", bearer: limited.token, body: { expectedVersion: 1 } });
  assert(ordinaryQueue.status === 403 && memberQueue.status === 403 && legacyAdmin.status === 401 && limitedClaim.status === 403, "CAPABILITY_ISOLATION_FAILED");
  result.capability = { ordinaryUserForbidden: true, memberAndTeamRoleForbidden: true, clientFlagsIgnored: true, legacyAdminApiForbidden: true, limitedAdminForbidden: true };

  const firstKey = `${marker}-first-message`;
  const first = await api("/v1/me/support/messages", { method: "POST", bearer: ordinary.token, body: { body: "合成客服首条消息", clientMessageId: firstKey } });
  assert(first.status === 200 && first.body?.message?.sequence === 1, "FIRST_MESSAGE_FAILED");
  conversationIds.add(first.body.conversation.id);
  const retry = await api("/v1/me/support/messages", { method: "POST", bearer: ordinary.token, body: { body: "合成客服首条消息", clientMessageId: firstKey } });
  const conflict = await api("/v1/me/support/messages", { method: "POST", bearer: ordinary.token, body: { body: "不同正文", clientMessageId: firstKey } });
  assert(retry.status === 200 && retry.body?.message?.id === first.body.message.id && retry.body?.replayed === true && conflict.status === 409, "MESSAGE_IDEMPOTENCY_FAILED");
  const queue = await api("/v1/management/support/conversations", { bearer: adminA.token });
  assert(queue.status === 200 && queue.body.items.some(item => item.id === first.body.conversation.id), "QUEUE_VISIBILITY_FAILED");
  const queued = queue.body.items.find(item => item.id === first.body.conversation.id);
  const [claimA, claimB] = await Promise.all([adminA, adminB].map(admin => api(`/v1/management/support/conversations/${queued.id}/claim`, { method: "POST", bearer: admin.token, body: { expectedVersion: queued.version } })));
  assert([claimA.status, claimB.status].sort().join(",") === "200,409", "EXCLUSIVE_CLAIM_RACE_FAILED");
  const winner = claimA.status === 200 ? adminA : adminB;
  const loser = winner === adminA ? adminB : adminA;
  const loserReply = await api(`/v1/management/support/conversations/${queued.id}/messages`, { method: "POST", bearer: loser.token, body: { body: "错误处理人回复", clientMessageId: `${marker}-loser-reply` } });
  assert(loserReply.status === 409, "LOSING_OPERATOR_COULD_REPLY");
  await expectPgMessage(`INSERT INTO support_message(conversation_id,sequence,sender_type,sender_principal_id,body,client_message_id)
    SELECT id,next_sequence,'ai','ai:stale','stale automatic response',$2 FROM support_conversation WHERE id=$1`, [queued.id, `${marker}-stale-ai`], "SUPPORT_AI_REPLY_FORBIDDEN_AFTER_HANDOFF");
  const reply1 = await api(`/v1/management/support/conversations/${queued.id}/messages`, { method: "POST", bearer: winner.token, body: { body: "人工客服回复一", clientMessageId: `${marker}-reply-1` } });
  const reply2 = await api(`/v1/management/support/conversations/${queued.id}/messages`, { method: "POST", bearer: winner.token, body: { body: "人工客服回复二", clientMessageId: `${marker}-reply-2` } });
  assert(reply1.status === 200 && reply2.status === 200, "ADMIN_REPLY_FAILED");
  const incremental = await api("/v1/me/support/messages?after=1", { bearer: ordinary.token });
  assert(incremental.status === 200 && incremental.body.messages.map(item => item.sequence).join(",") === "2,3", "INCREMENTAL_POLL_GAP_OR_DUPLICATE");
  const stale = await api("/v1/me/support/messages?after=3", { bearer: ordinary.token });
  assert(stale.body.messages.length === 0 && stale.body.latestCursor === 3, "STALE_POLL_FAILED");
  await api("/v1/me/support/read", { method: "POST", bearer: ordinary.token, body: { lastSeenSequence: 2 } });
  assert((await api("/v1/me/support/summary", { bearer: ordinary.token })).body.unreadCount === 1, "PARTIAL_READ_CURSOR_FAILED");
  await api("/v1/me/support/read", { method: "POST", bearer: ordinary.token, body: { lastSeenSequence: 3 } });
  assert((await api("/v1/me/support/summary", { bearer: ordinary.token })).body.unreadCount === 0, "FULL_READ_CURSOR_FAILED");
  assert((await api("/v1/me/support/summary", { bearer: member.token })).body.conversation === null, "CROSS_ACCOUNT_READ_FAILED");
  assert((await api("/v1/me/support/summary", { bearer: token(ordinary.memberId, "new-session") })).body.conversation.id === queued.id, "NEW_SESSION_RECOVERY_FAILED");
  const current = (await api("/v1/management/support/conversations", { bearer: winner.token })).body.items.find(item => item.id === queued.id);
  const resolved = await api(`/v1/management/support/conversations/${queued.id}/resolve`, { method: "POST", bearer: winner.token, body: { expectedVersion: current.version } });
  assert(resolved.status === 200 && resolved.body.status === "resolved", "RESOLVE_FAILED");
  const reopened = await api("/v1/me/support/messages", { method: "POST", bearer: ordinary.token, body: { body: "解决后重新咨询", clientMessageId: `${marker}-reopen` } });
  assert(reopened.status === 200 && reopened.body.conversation.status === "waiting_human", "REOPEN_FAILED");
  result.support = { firstMessage: true, queue: true, handoffClaimReplyReceiveResolveReopen: true, unreadAndReadCursor: true, requestRetryAndDuplicate: true, sessionChangeAndCrossAccountIsolation: true };
  result.race = { oneOfTwoClaims: true, losingOperatorBlocked: true, staleAutomaticResponseBlocked: true, currentSemantics: "exclusive current handler via row lock and expectedVersion" };
  result.polling = { incrementalMonotonic: true, noDuplicateOrGap: true, stalePollEmpty: true, responseLossRetry: true, newSessionRecovery: true };

  assert((await api("/v1/management/support/conversations", { bearer: revoked.token })).status === 200, "REVOKED_ADMIN_PRECONDITION_FAILED");
  await pool.query("UPDATE authority_grant SET revoked_at=now(),revoked_by=$2,revoke_reason='Synthetic immediate revocation' WHERE member_id=$1 AND capability='support.read'", [revoked.memberId, marker]);
  assert((await api("/v1/management/support/conversations", { bearer: revoked.token })).status === 403, "REVOCATION_NOT_IMMEDIATE");
  result.capability.revocationImmediate = true;

  const retained = await api("/v1/me/support/messages", { method: "POST", bearer: member.token, body: { body: "需要保全验证的合成会话", clientMessageId: `${marker}-retention-target` } });
  assert(retained.status === 200, "RETENTION_TARGET_CREATE_FAILED"); conversationIds.add(retained.body.conversation.id);
  const pending = await api(`/v1/management/support/conversations/${retained.body.conversation.id}/retention`, { bearer: privacy.token });
  assert(pending.status === 200 && pending.body.reason === "policy_pending" && pending.body.eligible === false, "PENDING_POLICY_NOT_CLOSED");
  await pool.query(`UPDATE data_retention_policy SET duration_days=1,enforcement_state='enforced',active=true,version=version+1,updated_at=now()
    WHERE code='support_conversation_policy_pending'`);
  const target = (await pool.query(`UPDATE support_conversation SET status='resolved',current_handler_principal_id=NULL,resolved_at=now()-interval '2 days',
    version=version+1,updated_at=clock_timestamp() WHERE id=$1 RETURNING *`, [retained.body.conversation.id])).rows[0];
  const hold = (await pool.query(`INSERT INTO legal_hold(reason_code,legal_basis,approved_by,review_at,expires_at)
    VALUES('SYNTHETIC_SUPPORT_HOLD','Synthetic R1 R2 staging retention verification only',$1,now()+interval '1 day',now()+interval '2 days') RETURNING id`, [marker])).rows[0];
  holdIds.add(hold.id); await pool.query("INSERT INTO legal_hold_binding(hold_id,object_type,object_id) VALUES($1,'member',$2)", [hold.id, member.memberId]);
  const held = await api(`/v1/management/support/conversations/${target.id}/purge`, { method: "POST", bearer: privacy.token, idempotencyKey: `${marker}-held-purge`, body: { expectedVersion: target.version } });
  assert(held.status === 423 && held.body?.code === "SUPPORT_RETENTION_LEGAL_HOLD", "LEGAL_HOLD_DID_NOT_BLOCK_PURGE");
  await pool.query("UPDATE legal_hold SET status='released',released_by=$2,released_at=now() WHERE id=$1", [hold.id, marker]);
  const purgeKey = `${marker}-purge`;
  const purged = await api(`/v1/management/support/conversations/${target.id}/purge`, { method: "POST", bearer: privacy.token, idempotencyKey: purgeKey, body: { expectedVersion: target.version } });
  const purgeReplay = await api(`/v1/management/support/conversations/${target.id}/purge`, { method: "POST", bearer: privacy.token, idempotencyKey: purgeKey, body: { expectedVersion: target.version } });
  assert(purged.status === 200 && purgeReplay.status === 200 && JSON.stringify(canonical(purged.body)) === JSON.stringify(canonical(purgeReplay.body)), "PURGE_REPLAY_FAILED");
  assert(Number((await pool.query("SELECT count(*) AS count FROM support_conversation WHERE id=$1", [target.id])).rows[0].count) === 0, "PURGED_CONVERSATION_REMAINS");
  assert(Number((await pool.query("SELECT count(*) AS count FROM support_conversation WHERE id=$1", [queued.id])).rows[0].count) === 1, "PURGE_CROSSED_CONVERSATION_BOUNDARY");
  const tombstone = (await pool.query("SELECT before_state,after_state FROM audit_log WHERE action='support.retention.purge' AND object_id=$1", [target.id])).rows[0];
  assert(tombstone && !JSON.stringify(tombstone).includes(member.memberId) && !JSON.stringify(tombstone).includes("合成会话"), "PURGE_TOMBSTONE_CONTAINS_PII");
  result.retention = { policyPendingClosed: true, syntheticOneDayOnly: true, legalHoldBlocked: true, exactConversationOnly: true, idempotentReplay: true, minimalTombstone: true };
} finally {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM legal_hold_binding WHERE hold_id=ANY($1::uuid[])", [[...holdIds]]);
    await client.query("DELETE FROM legal_hold WHERE id=ANY($1::uuid[])", [[...holdIds]]);
    const rows = await client.query("SELECT id FROM support_conversation WHERE member_id=ANY($1::uuid[]) FOR UPDATE", [members.map(item => item.memberId)]);
    for (const row of rows.rows) {
      conversationIds.add(row.id);
      await client.query("SELECT set_config('cisme.support_purge_conversation_id',$1,true)", [row.id]);
      await client.query("DELETE FROM support_message WHERE conversation_id=$1", [row.id]);
      await client.query("DELETE FROM support_conversation WHERE id=$1", [row.id]);
    }
    const ids = [...conversationIds];
    if (ids.length) {
      await client.query("DELETE FROM outbox_event WHERE aggregate_type='support_conversation' AND aggregate_id=ANY($1::uuid[])", [ids]);
      await client.query("DELETE FROM audit_log WHERE object_id=ANY($1::uuid[])", [ids]);
    }
    await client.query("DELETE FROM idempotency_operation WHERE principal_id=ANY($1::text[]) OR business_key LIKE 'support-purge:%'", [members.map(item => `member:${item.memberId}:session`)]);
    await client.query("DELETE FROM member_team_access WHERE granted_by=$1", [marker]);
    await client.query("DELETE FROM audit_log WHERE principal_id=$1 OR (action IN ('authority.grant','authority.revoke') AND (before_state::text LIKE $2 OR after_state::text LIKE $2))", [marker, `%${marker}%`]);
    const grants = await client.query("SELECT count(*)::int AS total,count(*) FILTER(WHERE granted_by=$1)::int AS ours FROM authority_grant", [marker]);
    assert(grants.rows[0].total === grants.rows[0].ours, "NON_SYNTHETIC_AUTHORITY_GRANT_PRESENT_DURING_CLEANUP");
    await client.query("TRUNCATE authority_grant");
    await client.query(`UPDATE data_retention_policy SET duration_days=NULL,enforcement_state='declared',active=false,version=1,updated_at=created_at
      WHERE code='support_conversation_policy_pending'`);
    if (members.length) await client.query("DELETE FROM member WHERE id=ANY($1::uuid[])", [members.map(item => item.memberId)]);
    await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
}

const after = (await pool.query(`SELECT jsonb_build_object('member',(SELECT count(*) FROM member),'grant',(SELECT count(*) FROM authority_grant),
  'conversation',(SELECT count(*) FROM support_conversation),'message',(SELECT count(*) FROM support_message),'hold',(SELECT count(*) FROM legal_hold),
  'audit',(SELECT count(*) FROM audit_log),'outbox',(SELECT count(*) FROM outbox_event),'idempotency',(SELECT count(*) FROM idempotency_operation)) AS value`)).rows[0].value;
for (const key of Object.keys(before)) assert(Number(after[key]) === Number(before[key]), `SYNTHETIC_CLEANUP_DRIFT_${key}`);
result.cleanup = { exactBaselineCountsRestored: true, finalPolicyPending: true };
await pool.end();
console.log(JSON.stringify({ verified: true, runId, ...result }, null, 2));
