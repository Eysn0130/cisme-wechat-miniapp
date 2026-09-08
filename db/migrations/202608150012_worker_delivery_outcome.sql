BEGIN;

ALTER TABLE outbox_event
  ADD COLUMN processing_outcome text
  CHECK (processing_outcome IN ('applied','suppressed'));

COMMIT;

-- migrate:down
ALTER TABLE outbox_event DROP COLUMN IF EXISTS processing_outcome;
