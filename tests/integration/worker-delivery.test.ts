import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { loadConfig } from "@cisme/config";
import { TEST_DATABASE_URL, resetDatabase, testPool } from "@cisme/testkit";
import { createApp } from "../../services/api/src/server";
import type { ObjectStorage } from "../../services/api/src/storage";
import { processMediaCleanup, processOutboxBatch, sweepExpired, WORKER_MAX_ATTEMPTS } from "../../services/worker/src/main";
import { operatorHeaders } from "./operator-session";

const pool = testPool();
const config = loadConfig({
  APP_ENV: "test",
  DATABASE_URL: TEST_DATABASE_URL,
  ALLOW_DEV_ADAPTERS: "true",
  APP_SESSION_SECRET: "test-session-secret",
  ADMIN_API_TOKEN: "test-admin-token",
  UPLOAD_TOKEN_SECRET: "test-upload-secret",
  OBJECT_STORAGE_DRIVER: "api_gateway"
});
let deleteShouldFail = true;
const privateFailureMarker = "SYNTHETIC_PRIVATE_SIGNED_URL_PHONE_ADDRESS";
const storage: ObjectStorage = {
  acceptsGatewayUpload: false,
  async ensureReady() {},
  async authorize() { throw new Error("NOT_USED"); },
  async verify() { throw new Error("NOT_USED"); },
  async read() { throw new Error("NOT_USED"); },
  async writeDerivedImage() { throw new Error("NOT_USED"); },
  async delete() { if (deleteShouldFail) throw new Error(`DELETE_TEMPORARILY_UNAVAILABLE:${privateFailureMarker}`); }
};
let app: FastifyInstance;
let operatorMemberId = "";

function adminHeaders(principal: string, key?: string) {
  return operatorHeaders(config, principal, operatorMemberId, {
    "x-dev-clock": "2026-08-15T03:00:00Z",
    ...(key ? { "idempotency-key": key } : {})
  });
}

async function insertPublicationSource(businessKey: string, now: Date) {
  const member = await pool.query<{ id: string }>("INSERT INTO member(display_name) VALUES ($1) RETURNING id", [`publication-${businessKey}`]);
  const submission = await pool.query<{ id: string }>(`INSERT INTO submission(member_id,status,post_url,platform_account,disclosure)
    VALUES ($1,'approved',$2,'小红书@真实投稿','本次内容可能获得 CISME 积分奖励') RETURNING id`, [member.rows[0]!.id, `https://example.test/${businessKey}`]);
  await pool.query(`INSERT INTO consent_grant(submission_id,member_id,purpose,granted_at,active)
    VALUES ($1,$2,'feed_readonly',$3,true)`, [submission.rows[0]!.id, member.rows[0]!.id, now]);
  await pool.query(`INSERT INTO media_object(submission_id,kind,object_key,mime_type,upload_state,is_current,uploaded_at)
    VALUES ($1,'screenshot',$2,'image/png','uploaded',true,$3)`, [submission.rows[0]!.id, `worker/${businessKey}.png`, now]);
  const event = await pool.query<{ id: string }>(`INSERT INTO outbox_event
    (event_type, aggregate_type, aggregate_id, aggregate_version, business_key, payload, occurred_at, next_attempt_at)
    VALUES ('submission.publication.approved.v1','submission',$1,1,$2,$3,$4,$4) RETURNING id`, [submission.rows[0]!.id, businessKey, {
      submissionId: submission.rows[0]!.id,
      title: "真实审核投稿",
      excerpt: "仅在有效展示许可下进入品牌精选。",
      aiUsage: "none",
      publishedBy: "worker-lead",
      reasonCode: "PUBLICATION_CLEAR",
      evidence: { reviewed: true }
    }, now]);
  return { memberId: member.rows[0]!.id, submissionId: submission.rows[0]!.id, eventId: event.rows[0]!.id };
}

beforeAll(async () => {
  await resetDatabase(pool);
  operatorMemberId = (await pool.query<{ id: string }>("INSERT INTO member(display_name) VALUES ('synthetic-worker-operator') RETURNING id")).rows[0]!.id;
  await pool.query("INSERT INTO principal_role(principal_id,role) VALUES ('worker-lead','review_lead'),('worker-auditor','auditor')");
  app = await createApp({ config, pool, storage });
});

afterAll(async () => {
  await app?.close();
  await pool.end();
});

describe("worker delivery controls", () => {
  it("queues expired upload authorizations for object cleanup", async () => {
    const member = await pool.query<{ id: string }>("INSERT INTO member(display_name) VALUES ('expired-upload') RETURNING id");
    const submission = await pool.query<{ id: string }>("INSERT INTO submission(member_id,created_at) VALUES ($1,$2) RETURNING id", [member.rows[0]!.id, new Date("2026-08-12T00:00:00Z")]);
    const media = await pool.query<{ id: string }>(`INSERT INTO media_object
      (submission_id,kind,object_key,mime_type,upload_state,is_current)
      VALUES ($1,'original','expired/authorization.jpg','image/jpeg','authorized',true) RETURNING id`, [submission.rows[0]!.id]);
    await sweepExpired(pool, new Date("2026-08-15T00:00:00Z"));
    expect((await pool.query("SELECT upload_state FROM media_object WHERE id=$1", [media.rows[0]!.id])).rows[0].upload_state).toBe("failed");
    expect((await pool.query("SELECT reason, processed_at FROM media_cleanup_queue WHERE media_id=$1", [media.rows[0]!.id])).rows[0])
      .toMatchObject({ reason: "authorization_expired", processed_at: null });
  });

  it("backs off, dead-letters and explicitly redrives outbox delivery", async () => {
    const publication = await insertPublicationSource("worker-test-outbox", new Date("2026-08-15T00:00:00Z"));
    const itemId = publication.eventId;
    const unhandled = await pool.query<{ id: string }>(`INSERT INTO outbox_event
      (event_type, aggregate_type, aggregate_id, aggregate_version, business_key, payload, occurred_at, next_attempt_at)
      VALUES ('identity.accepted.v1','member',gen_random_uuid(),1,'worker-test-unhandled','{}'::jsonb,$1,$1) RETURNING id`, [new Date("2026-08-15T00:00:00Z")]);
    const start = Date.parse("2026-08-15T00:00:00Z");

    expect(await processOutboxBatch(pool, new Date(start), 10, { ugcGoLiveGate: false })).toBe(1);
    expect(await processOutboxBatch(pool, new Date(start + 1_000), 10, { ugcGoLiveGate: false })).toBe(0);
    expect((await pool.query("SELECT attempts FROM outbox_event WHERE id=$1", [itemId])).rows[0].attempts).toBe(1);
    expect((await pool.query("SELECT attempts, processed_at, processing_outcome FROM outbox_event WHERE id=$1", [unhandled.rows[0]!.id])).rows[0])
      .toMatchObject({ attempts: 1, processing_outcome: "audit_only" });
    const backlog = await app.inject({ method: "GET", url: "/v1/admin/worker-backlog", headers: adminHeaders("worker-auditor") });
    expect(backlog.statusCode).toBe(200);
    expect(backlog.json()).not.toEqual(expect.arrayContaining([expect.objectContaining({ event_type: "identity.accepted.v1" })]));
    for (let attempt = 1; attempt < WORKER_MAX_ATTEMPTS; attempt += 1) {
      await processOutboxBatch(pool, new Date(start + attempt * 10 * 60_000), 10, { ugcGoLiveGate: false });
    }
    const dead = (await pool.query("SELECT attempts, dead_letter_reason, dead_lettered_at FROM outbox_event WHERE id=$1", [itemId])).rows[0];
    expect(dead).toMatchObject({ attempts: WORKER_MAX_ATTEMPTS, dead_letter_reason: "MAX_ATTEMPTS_EXCEEDED" });
    expect(dead.dead_lettered_at).toBeTruthy();
    expect(await processOutboxBatch(pool, new Date(start + 60 * 60_000), 10, { ugcGoLiveGate: true })).toBe(0);

    const visible = await app.inject({ method: "GET", url: "/v1/admin/worker-failures", headers: adminHeaders("worker-auditor") });
    expect(visible.statusCode).toBe(200);
    expect(visible.json()).toEqual(expect.arrayContaining([expect.objectContaining({ queue_name: "outbox", id: itemId, attempts: WORKER_MAX_ATTEMPTS })]));

    const denied = await app.inject({
      method: "POST", url: `/v1/admin/worker-failures/outbox/${itemId}/redrive`, headers: adminHeaders("worker-auditor", "worker-redrive-denied"),
      payload: { reason: "INCIDENT_REPAIRED", expectedAttempts: WORKER_MAX_ATTEMPTS }
    });
    expect(denied.statusCode).toBe(403);

    const headers = adminHeaders("worker-lead", "worker-redrive-outbox-001");
    const payload = { reason: "INCIDENT_REPAIRED", expectedAttempts: WORKER_MAX_ATTEMPTS };
    const redriven = await app.inject({ method: "POST", url: `/v1/admin/worker-failures/outbox/${itemId}/redrive`, headers, payload });
    const replay = await app.inject({ method: "POST", url: `/v1/admin/worker-failures/outbox/${itemId}/redrive`, headers, payload });
    expect(redriven.statusCode).toBe(200);
    expect(replay.json()).toEqual(redriven.json());
    expect(redriven.json()).toMatchObject({ status: "queued", redriveCount: 1, attempts: WORKER_MAX_ATTEMPTS });

    expect(await processOutboxBatch(pool, new Date(start + 4 * 60 * 60_000), 10, { ugcGoLiveGate: true })).toBe(1);
    const recovered = (await pool.query("SELECT processed_at, redrive_count, processing_outcome FROM outbox_event WHERE id=$1", [itemId])).rows[0];
    expect(recovered.processed_at).toBeTruthy();
    expect(recovered.redrive_count).toBe(1);
    expect(recovered.processing_outcome).toBe("applied");
    expect((await pool.query("SELECT submission_id, member_id, visible FROM feed_item WHERE submission_id=$1", [publication.submissionId])).rows[0])
      .toMatchObject({ submission_id: publication.submissionId, member_id: publication.memberId, visible: true });
    expect((await pool.query("SELECT count(*)::int count FROM audit_log WHERE action='worker_failure.redrive' AND object_id=$1", [itemId])).rows[0].count).toBe(1);
  });

  it("isolates a database statement failure and continues the batch", async () => {
    const now = new Date("2026-08-15T01:00:00Z");
    const missingSource = await pool.query<{ id: string }>(`INSERT INTO outbox_event
      (event_type, aggregate_type, aggregate_id, aggregate_version, business_key, payload, occurred_at, next_attempt_at)
      VALUES ('submission.publication.approved.v1','submission','00000000-0000-4000-8000-000000000002',1,'worker-missing-source',
        '{"submissionId":"00000000-0000-4000-8000-000000000002"}'::jsonb,$1,$1) RETURNING id`, [now]);
    const malformed = await pool.query<{ id: string }>(`INSERT INTO outbox_event
      (event_type, aggregate_type, aggregate_id, aggregate_version, business_key, payload, occurred_at, next_attempt_at)
      VALUES ('submission.publication.approved.v1','submission',gen_random_uuid(),1,'worker-malformed-source',
        '{"submissionId":"not-a-uuid"}'::jsonb,$1,$1) RETURNING id`, [now]);
    const valid = await insertPublicationSource("worker-savepoint-valid", now);

    expect(await processOutboxBatch(pool, now, 10, { ugcGoLiveGate: true })).toBe(1);
    const failed = (await pool.query("SELECT attempts, processed_at, last_error FROM outbox_event WHERE id=$1", [malformed.rows[0]!.id])).rows[0];
    expect(failed.attempts).toBe(1);
    expect(failed.processed_at).toBeNull();
    expect(failed.last_error).toBe("22P02");
    const missing = (await pool.query("SELECT attempts, processed_at, last_error FROM outbox_event WHERE id=$1", [missingSource.rows[0]!.id])).rows[0];
    expect(missing.attempts).toBe(1);
    expect(missing.processed_at).toBeNull();
    expect(missing.last_error).toContain("PUBLICATION_SOURCE_NOT_FOUND");
    const delivered = (await pool.query("SELECT processed_at, processing_outcome FROM outbox_event WHERE id=$1", [valid.eventId])).rows[0];
    expect(delivered.processed_at).toBeTruthy();
    expect(delivered.processing_outcome).toBe("applied");
    expect((await pool.query("SELECT count(*)::int count FROM feed_item WHERE submission_id=$1 AND visible=true", [valid.submissionId])).rows[0].count).toBe(1);
  });

  it("records consent withdrawal as a safe suppression instead of a false delivery", async () => {
    const now = new Date("2026-08-15T01:30:00Z");
    const publication = await insertPublicationSource("worker-consent-suppressed", now);
    const grant = await pool.query<{ id: string }>("UPDATE consent_grant SET active=false, version=version+1 WHERE submission_id=$1 AND purpose='feed_readonly' RETURNING id", [publication.submissionId]);
    await pool.query(`INSERT INTO revocation_request(consent_grant_id,requested_by,reason,requested_at,processed_at)
      VALUES ($1,$2,'MEMBER_REQUEST',$3,$3)`, [grant.rows[0]!.id, publication.memberId, now]);

    expect(await processOutboxBatch(pool, now, 10, { ugcGoLiveGate: true })).toBe(1);
    expect((await pool.query("SELECT processed_at, processing_outcome FROM outbox_event WHERE id=$1", [publication.eventId])).rows[0])
      .toMatchObject({ processing_outcome: "suppressed" });
    expect((await pool.query("SELECT count(*)::int count FROM feed_item WHERE submission_id=$1 AND visible=true", [publication.submissionId])).rows[0].count).toBe(0);
  });

  it("dead-letters and safely redrives object cleanup", async () => {
    const member = await pool.query<{ id: string }>("INSERT INTO member(display_name) VALUES ('cleanup-test') RETURNING id");
    const submission = await pool.query<{ id: string }>("INSERT INTO submission(member_id) VALUES ($1) RETURNING id", [member.rows[0]!.id]);
    const media = await pool.query<{ id: string }>(`INSERT INTO media_object
      (submission_id,kind,object_key,mime_type,upload_state,is_current)
      VALUES ($1,'original','cleanup/test.jpg','image/jpeg','deleted',false) RETURNING id`, [submission.rows[0]!.id]);
    const queued = await pool.query<{ id: string }>(`INSERT INTO media_cleanup_queue(media_id,object_key,reason,next_attempt_at)
      VALUES ($1,'cleanup/test.jpg','replaced',$2) RETURNING id`, [media.rows[0]!.id, new Date("2026-08-15T02:00:00Z")]);
    const itemId = queued.rows[0]!.id;
    const start = Date.parse("2026-08-15T02:00:00Z");
    for (let attempt = 0; attempt < WORKER_MAX_ATTEMPTS; attempt += 1) {
      await processMediaCleanup(pool, storage, new Date(start + attempt * 10 * 60_000), 10);
    }
    const storedFailure = (await pool.query("SELECT last_error FROM media_cleanup_queue WHERE id=$1", [itemId])).rows[0].last_error;
    expect(storedFailure).toBe("runtime");
    expect(storedFailure).not.toContain(privateFailureMarker);
    expect((await pool.query("SELECT attempts, dead_letter_reason FROM media_cleanup_queue WHERE id=$1", [itemId])).rows[0])
      .toMatchObject({ attempts: WORKER_MAX_ATTEMPTS, dead_letter_reason: "MAX_ATTEMPTS_EXCEEDED" });
    const operatorQueue = await app.inject({ url: "/v1/admin/worker-failures", headers: adminHeaders("worker-lead") });
    expect(operatorQueue.statusCode).toBe(200);
    expect(operatorQueue.body).not.toContain(privateFailureMarker);

    const redrive = await app.inject({
      method: "POST", url: `/v1/admin/worker-failures/media_cleanup/${itemId}/redrive`, headers: adminHeaders("worker-lead", "worker-redrive-cleanup-001"),
      payload: { reason: "OBJECT_STORE_RECOVERED", expectedAttempts: WORKER_MAX_ATTEMPTS }
    });
    expect(redrive.statusCode).toBe(200);
    const redriveAudit = await pool.query("SELECT before_state FROM audit_log WHERE action='worker_failure.redrive' AND object_id=$1", [itemId]);
    expect(JSON.stringify(redriveAudit.rows)).not.toContain(privateFailureMarker);
    deleteShouldFail = false;
    expect(await processMediaCleanup(pool, storage, new Date(start + 60 * 60_000), 10)).toBe(1);
    const recovered = (await pool.query("SELECT processed_at, redrive_count FROM media_cleanup_queue WHERE id=$1", [itemId])).rows[0];
    expect(recovered.processed_at).toBeTruthy();
    expect(recovered.redrive_count).toBe(1);
  });

  it("reclaims an expired cleanup lease after a worker crash", async () => {
    deleteShouldFail = false;
    const member = await pool.query<{ id: string }>("INSERT INTO member(display_name) VALUES ('lease-recovery') RETURNING id");
    const submission = await pool.query<{ id: string }>("INSERT INTO submission(member_id) VALUES ($1) RETURNING id", [member.rows[0]!.id]);
    const media = await pool.query<{ id: string }>(`INSERT INTO media_object(submission_id,kind,object_key,mime_type,upload_state,is_current)
      VALUES ($1,'original','cleanup/expired-lease.jpg','image/jpeg','deleted',false) RETURNING id`, [submission.rows[0]!.id]);
    const now = new Date("2026-08-15T05:00:00Z");
    const queued = await pool.query<{ id: string }>(`INSERT INTO media_cleanup_queue(media_id,object_key,reason,next_attempt_at,lease_token,leased_until)
      VALUES ($1,'cleanup/expired-lease.jpg','replaced',$2,gen_random_uuid(),$3) RETURNING id`, [media.rows[0]!.id, new Date(now.getTime() - 120_000), new Date(now.getTime() - 1)]);
    expect(await processMediaCleanup(pool, storage, now, 10)).toBe(1);
    expect((await pool.query("SELECT processed_at,lease_token,leased_until FROM media_cleanup_queue WHERE id=$1", [queued.rows[0]!.id])).rows[0])
      .toMatchObject({ lease_token: null, leased_until: null });
  });
});
