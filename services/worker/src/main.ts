import type pg from "pg";
import { loadConfig } from "@cisme/config";
import { createPool, transaction } from "../../api/src/db.js";
import { createObjectStorage, type ObjectStorage } from "../../api/src/storage.js";

interface EventRow {
  id: string;
  event_type: string;
  aggregate_id: string;
  payload: Record<string, unknown>;
  attempts: number;
}

interface WorkerGates { ugcGoLiveGate: boolean }
type DeliveryOutcome = "applied" | "suppressed";

export const WORKER_MAX_ATTEMPTS = 5;
const WORKER_BACKOFF_BASE_MS = 5_000;
const WORKER_BACKOFF_CAP_MS = 5 * 60_000;
const WORKER_EVENT_TYPES = ["submission.publication.approved.v1"] as const;

function failureSchedule(now: Date, previousAttempts: number) {
  const attempts = previousAttempts + 1;
  const deadLettered = attempts >= WORKER_MAX_ATTEMPTS;
  const delay = Math.min(WORKER_BACKOFF_CAP_MS, WORKER_BACKOFF_BASE_MS * (2 ** previousAttempts));
  return {
    attempts,
    deadLetteredAt: deadLettered ? now : null,
    deadLetterReason: deadLettered ? "MAX_ATTEMPTS_EXCEEDED" : null,
    nextAttemptAt: new Date(now.getTime() + delay)
  };
}

async function applyEvent(client: pg.PoolClient, event: EventRow, now: Date, gates: WorkerGates): Promise<DeliveryOutcome> {
  if (event.event_type === "submission.publication.approved.v1") {
    if (!gates.ugcGoLiveGate) throw new Error("UGC_GO_LIVE_GATE_CLOSED");
    const submissionId = String(event.payload.submissionId);
    const source = await client.query<{ member_id: string; status: string; cover_object_key: string | null; has_active_consent: boolean; has_revocation: boolean }>(`
      SELECT s.member_id, s.status, m.object_key AS cover_object_key,
        EXISTS (
          SELECT 1 FROM consent_grant cg
          WHERE cg.submission_id=s.id AND cg.purpose='feed_readonly' AND cg.active=true
        ) AS has_active_consent,
        EXISTS (
          SELECT 1 FROM consent_grant cg JOIN revocation_request rr ON rr.consent_grant_id=cg.id
          WHERE cg.submission_id=s.id AND cg.purpose='feed_readonly'
        ) AS has_revocation
      FROM submission s
      LEFT JOIN media_object m ON m.submission_id=s.id AND m.kind='screenshot' AND m.upload_state='uploaded' AND m.is_current=true
      WHERE s.id=$1
    `, [submissionId]);
    const row = source.rows[0];
    if (!row) throw new Error("PUBLICATION_SOURCE_NOT_FOUND");
    if (row.status !== "approved") throw new Error("PUBLICATION_SOURCE_NOT_APPROVED");
    if (!row.has_active_consent || row.has_revocation) {
      await client.query("UPDATE feed_item SET visible=false WHERE submission_id=$1", [submissionId]);
      return "suppressed";
    }
    await client.query(`INSERT INTO feed_item(submission_id, member_id, title, excerpt, cover_object_key, ai_usage, published_by, publication_reason_code, publication_evidence, published_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      ON CONFLICT (submission_id) DO UPDATE SET title=EXCLUDED.title, excerpt=EXCLUDED.excerpt, cover_object_key=EXCLUDED.cover_object_key,
        ai_usage=EXCLUDED.ai_usage, published_by=EXCLUDED.published_by, publication_reason_code=EXCLUDED.publication_reason_code,
        publication_evidence=EXCLUDED.publication_evidence, published_at=EXCLUDED.published_at, visible=true`,
      [submissionId, row.member_id, String(event.payload.title), String(event.payload.excerpt), row.cover_object_key,
        String(event.payload.aiUsage), String(event.payload.publishedBy), String(event.payload.reasonCode), event.payload.evidence ?? {}, now]);
    return "applied";
  }
  throw new Error("WORKER_EVENT_NOT_SUPPORTED");
}

export async function processOutboxBatch(pool: pg.Pool, now = new Date(), limit = 50, gates: WorkerGates = { ugcGoLiveGate: false }): Promise<number> {
  return transaction(pool, async (client) => {
    const events = await client.query<EventRow>(`
      SELECT id, event_type, aggregate_id, payload, attempts FROM outbox_event
      WHERE processed_at IS NULL AND dead_lettered_at IS NULL AND next_attempt_at <= $1
        AND event_type = ANY($2::text[])
      ORDER BY next_attempt_at, occurred_at, id LIMIT $3 FOR UPDATE SKIP LOCKED
    `, [now, [...WORKER_EVENT_TYPES], limit]);
    let processed = 0;
    for (const event of events.rows) {
      await client.query("SAVEPOINT worker_event_attempt");
      try {
        const outcome = await applyEvent(client, event, now, gates);
        await client.query("UPDATE outbox_event SET processed_at=$1, attempts=attempts+1, last_error=NULL, dead_letter_reason=NULL, processing_outcome=$2 WHERE id=$3", [now, outcome, event.id]);
        await client.query("RELEASE SAVEPOINT worker_event_attempt");
        processed += 1;
      } catch (error) {
        await client.query("ROLLBACK TO SAVEPOINT worker_event_attempt");
        await client.query("RELEASE SAVEPOINT worker_event_attempt");
        const failure = failureSchedule(now, event.attempts);
        await client.query(`UPDATE outbox_event
          SET attempts=$1, last_error=$2, next_attempt_at=$3, dead_lettered_at=$4, dead_letter_reason=$5, processing_outcome=NULL
          WHERE id=$6`, [failure.attempts, String(error), failure.nextAttemptAt, failure.deadLetteredAt, failure.deadLetterReason, event.id]);
      }
    }
    return processed;
  });
}

export async function processMediaCleanup(pool: pg.Pool, storage: ObjectStorage, now = new Date(), limit = 50): Promise<number> {
  return transaction(pool, async (client) => {
    const rows = await client.query<{ id: string; object_key: string; attempts: number }>(`
      SELECT id, object_key, attempts FROM media_cleanup_queue
      WHERE processed_at IS NULL AND dead_lettered_at IS NULL AND next_attempt_at <= $1
      ORDER BY next_attempt_at, created_at, id LIMIT $2 FOR UPDATE SKIP LOCKED
    `, [now, limit]);
    let processed = 0;
    for (const row of rows.rows) {
      await client.query("SAVEPOINT worker_cleanup_attempt");
      try {
        await storage.delete(row.object_key);
        await client.query("UPDATE media_cleanup_queue SET processed_at=$1, attempts=attempts+1, last_error=NULL, dead_letter_reason=NULL WHERE id=$2", [now, row.id]);
        await client.query("RELEASE SAVEPOINT worker_cleanup_attempt");
        processed += 1;
      } catch (error) {
        await client.query("ROLLBACK TO SAVEPOINT worker_cleanup_attempt");
        await client.query("RELEASE SAVEPOINT worker_cleanup_attempt");
        const failure = failureSchedule(now, row.attempts);
        await client.query(`UPDATE media_cleanup_queue
          SET attempts=$1, last_error=$2, next_attempt_at=$3, dead_lettered_at=$4, dead_letter_reason=$5
          WHERE id=$6`, [failure.attempts, String(error), failure.nextAttemptAt, failure.deadLetteredAt, failure.deadLetterReason, row.id]);
      }
    }
    return processed;
  });
}

export async function sweepExpired(pool: pg.Pool, now = new Date()): Promise<void> {
  await pool.query("UPDATE eligibility_task SET state='expired', version=version+1 WHERE state='available' AND expires_at <= $1", [now]);
  await pool.query(`WITH expired AS (
    UPDATE media_object m SET upload_state='failed'
    WHERE m.upload_state='authorized' AND m.uploaded_at IS NULL AND m.deleted_at IS NULL
      AND EXISTS (
        SELECT 1 FROM submission s
        WHERE s.id=m.submission_id AND s.created_at < $1::timestamptz - interval '24 hours'
      )
    RETURNING m.id, m.object_key
  )
  INSERT INTO media_cleanup_queue(media_id, object_key, reason, next_attempt_at)
  SELECT id, object_key, 'authorization_expired', $1 FROM expired
  ON CONFLICT DO NOTHING`, [now]);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const config = loadConfig();
  const pool = createPool(config.databaseUrl);
  const storage = createObjectStorage(config);
  const run = async () => {
    await processOutboxBatch(pool, new Date(), 50, { ugcGoLiveGate: config.ugcGoLiveGate });
    await processMediaCleanup(pool, storage);
    await sweepExpired(pool);
  };
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try { await run(); }
    catch (error) { console.error("CISME_WORKER_TICK_FAILED", error); }
    finally { running = false; }
  };
  await tick();
  setInterval(() => void tick(), 2_000).unref();
  process.on("SIGTERM", () => void pool.end().then(() => process.exit(0)));
}
