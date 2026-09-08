BEGIN;

ALTER TABLE outbox_event
  ADD COLUMN next_attempt_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN dead_lettered_at timestamptz,
  ADD COLUMN dead_letter_reason text,
  ADD COLUMN redrive_count integer NOT NULL DEFAULT 0 CHECK (redrive_count >= 0);

ALTER TABLE media_cleanup_queue
  ADD COLUMN next_attempt_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN dead_lettered_at timestamptz,
  ADD COLUMN dead_letter_reason text,
  ADD COLUMN redrive_count integer NOT NULL DEFAULT 0 CHECK (redrive_count >= 0);

UPDATE outbox_event SET next_attempt_at=occurred_at WHERE processed_at IS NULL;
UPDATE media_cleanup_queue SET next_attempt_at=created_at WHERE processed_at IS NULL;

CREATE INDEX outbox_event_worker_ready_idx
  ON outbox_event(next_attempt_at, occurred_at, id)
  WHERE processed_at IS NULL AND dead_lettered_at IS NULL;

CREATE INDEX media_cleanup_worker_ready_idx
  ON media_cleanup_queue(next_attempt_at, created_at, id)
  WHERE processed_at IS NULL AND dead_lettered_at IS NULL;

COMMIT;

-- migrate:down
BEGIN;

DROP INDEX IF EXISTS media_cleanup_worker_ready_idx;
DROP INDEX IF EXISTS outbox_event_worker_ready_idx;

ALTER TABLE media_cleanup_queue
  DROP COLUMN IF EXISTS redrive_count,
  DROP COLUMN IF EXISTS dead_letter_reason,
  DROP COLUMN IF EXISTS dead_lettered_at,
  DROP COLUMN IF EXISTS next_attempt_at;

ALTER TABLE outbox_event
  DROP COLUMN IF EXISTS redrive_count,
  DROP COLUMN IF EXISTS dead_letter_reason,
  DROP COLUMN IF EXISTS dead_lettered_at,
  DROP COLUMN IF EXISTS next_attempt_at;

COMMIT;
