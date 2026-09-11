-- PRODUCTION-ONLY operator script. Do not run through scripts/migrate.ts and do
-- not wrap in a transaction. Apply one statement at a time after Deployment Gate,
-- checking pg_stat_progress_create_index and connection headroom between steps.
-- This is the production replacement for migration 202609100003. Apply the
-- short metadata DDL first, then the concurrent indexes, validate every object,
-- and only then record that migration version in schema_migration.
ALTER TABLE media_cleanup_queue ADD COLUMN IF NOT EXISTS lease_token uuid;
ALTER TABLE media_cleanup_queue ADD COLUMN IF NOT EXISTS leased_until timestamptz;
ALTER TABLE media_object ADD COLUMN IF NOT EXISTS authorized_max_bytes integer NOT NULL DEFAULT 10485760;
ALTER TABLE media_object DROP CONSTRAINT IF EXISTS media_object_authorized_max_bytes_check_v2;
ALTER TABLE media_object ADD CONSTRAINT media_object_authorized_max_bytes_check_v2 CHECK (authorized_max_bytes BETWEEN 1 AND 10485760) NOT VALID;
ALTER TABLE media_object VALIDATE CONSTRAINT media_object_authorized_max_bytes_check_v2;
ALTER TABLE outbox_event DROP CONSTRAINT IF EXISTS outbox_event_processing_outcome_check_v2;
ALTER TABLE outbox_event ADD CONSTRAINT outbox_event_processing_outcome_check_v2 CHECK (processing_outcome IN ('applied','suppressed','audit_only')) NOT VALID;
ALTER TABLE outbox_event VALIDATE CONSTRAINT outbox_event_processing_outcome_check_v2;
CREATE INDEX CONCURRENTLY IF NOT EXISTS points_entry_member_page_idx ON points_entry(member_id, occurred_at DESC, id DESC);
CREATE INDEX CONCURRENTLY IF NOT EXISTS care_cycle_member_page_idx ON care_cycle(member_id, created_at DESC, id DESC);
CREATE INDEX CONCURRENTLY IF NOT EXISTS eligibility_task_member_page_idx ON eligibility_task(member_id, expires_at DESC, id DESC);
CREATE INDEX CONCURRENTLY IF NOT EXISTS consent_grant_member_page_idx ON consent_grant(member_id, granted_at DESC, id DESC);
CREATE INDEX CONCURRENTLY IF NOT EXISTS feed_item_visible_page_idx ON feed_item(published_at DESC, id DESC) WHERE visible=true;
CREATE INDEX CONCURRENTLY IF NOT EXISTS community_comment_like_comment_idx ON community_comment_like(comment_id, member_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS review_action_case_page_idx ON review_action(review_case_id, created_at DESC, id DESC);
CREATE INDEX CONCURRENTLY IF NOT EXISTS outbox_event_worker_ready_v2_idx ON outbox_event(next_attempt_at, occurred_at, id) INCLUDE(event_type) WHERE processed_at IS NULL AND dead_lettered_at IS NULL;
CREATE INDEX CONCURRENTLY IF NOT EXISTS media_cleanup_worker_ready_v2_idx ON media_cleanup_queue(next_attempt_at, created_at, id) INCLUDE(leased_until) WHERE processed_at IS NULL AND dead_lettered_at IS NULL;

-- After EXPLAIN/constraint validation and only as the final operator step:
-- INSERT INTO schema_migration(version) VALUES ('202609100003_performance_consistency.sql') ON CONFLICT DO NOTHING;
