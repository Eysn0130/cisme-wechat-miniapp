-- Query-shape indexes and crash-safe media cleanup leases. Local/test migration
-- uses ordinary index creation inside the migration transaction; production uses
-- docs/deployment/202609100003-indexes-concurrently.sql after its preflight.
ALTER TABLE media_cleanup_queue
  ADD COLUMN lease_token uuid,
  ADD COLUMN leased_until timestamptz;
ALTER TABLE media_object ADD COLUMN authorized_max_bytes integer NOT NULL DEFAULT 10485760
  CHECK (authorized_max_bytes BETWEEN 1 AND 10485760);

CREATE INDEX points_entry_member_page_idx ON points_entry(member_id, occurred_at DESC, id DESC);
CREATE INDEX care_cycle_member_page_idx ON care_cycle(member_id, created_at DESC, id DESC);
CREATE INDEX eligibility_task_member_page_idx ON eligibility_task(member_id, expires_at DESC, id DESC);
CREATE INDEX consent_grant_member_page_idx ON consent_grant(member_id, granted_at DESC, id DESC);
CREATE INDEX feed_item_visible_page_idx ON feed_item(published_at DESC, id DESC) WHERE visible=true;
CREATE INDEX community_comment_like_comment_idx ON community_comment_like(comment_id, member_id);
CREATE INDEX review_action_case_page_idx ON review_action(review_case_id, created_at DESC, id DESC);
DROP INDEX IF EXISTS outbox_event_worker_ready_idx;
CREATE INDEX outbox_event_worker_ready_idx ON outbox_event(next_attempt_at, occurred_at, id) INCLUDE(event_type)
  WHERE processed_at IS NULL AND dead_lettered_at IS NULL;
DROP INDEX IF EXISTS media_cleanup_worker_ready_idx;
CREATE INDEX media_cleanup_worker_ready_idx ON media_cleanup_queue(next_attempt_at, created_at, id) INCLUDE(leased_until)
  WHERE processed_at IS NULL AND dead_lettered_at IS NULL;

ALTER TABLE outbox_event DROP CONSTRAINT IF EXISTS outbox_event_processing_outcome_check;
ALTER TABLE outbox_event ADD CONSTRAINT outbox_event_processing_outcome_check
  CHECK (processing_outcome IN ('applied','suppressed','audit_only'));

-- migrate:down
ALTER TABLE outbox_event DROP CONSTRAINT IF EXISTS outbox_event_processing_outcome_check;
ALTER TABLE outbox_event ADD CONSTRAINT outbox_event_processing_outcome_check CHECK (processing_outcome IN ('applied','suppressed'));
DROP INDEX IF EXISTS media_cleanup_worker_ready_idx;
DROP INDEX IF EXISTS outbox_event_worker_ready_idx;
DROP INDEX IF EXISTS review_action_case_page_idx;
DROP INDEX IF EXISTS community_comment_like_comment_idx;
DROP INDEX IF EXISTS feed_item_visible_page_idx;
DROP INDEX IF EXISTS consent_grant_member_page_idx;
DROP INDEX IF EXISTS eligibility_task_member_page_idx;
DROP INDEX IF EXISTS care_cycle_member_page_idx;
DROP INDEX IF EXISTS points_entry_member_page_idx;
CREATE INDEX outbox_event_worker_ready_idx ON outbox_event(next_attempt_at, occurred_at, id) WHERE processed_at IS NULL AND dead_lettered_at IS NULL;
CREATE INDEX media_cleanup_worker_ready_idx ON media_cleanup_queue(next_attempt_at, created_at, id) WHERE processed_at IS NULL AND dead_lettered_at IS NULL;
ALTER TABLE media_cleanup_queue DROP COLUMN IF EXISTS leased_until, DROP COLUMN IF EXISTS lease_token;
ALTER TABLE media_object DROP COLUMN IF EXISTS authorized_max_bytes;
