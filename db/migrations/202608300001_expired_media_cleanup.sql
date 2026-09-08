BEGIN;

ALTER TABLE media_cleanup_queue
  DROP CONSTRAINT media_cleanup_queue_reason_check;

ALTER TABLE media_cleanup_queue
  ADD CONSTRAINT media_cleanup_queue_reason_check
  CHECK (reason IN ('replaced','member_deleted','failed_verification','authorization_expired'));

COMMIT;

-- migrate:down
BEGIN;

UPDATE media_cleanup_queue
SET reason='failed_verification'
WHERE reason='authorization_expired';

ALTER TABLE media_cleanup_queue
  DROP CONSTRAINT media_cleanup_queue_reason_check;

ALTER TABLE media_cleanup_queue
  ADD CONSTRAINT media_cleanup_queue_reason_check
  CHECK (reason IN ('replaced','member_deleted','failed_verification'));

COMMIT;
