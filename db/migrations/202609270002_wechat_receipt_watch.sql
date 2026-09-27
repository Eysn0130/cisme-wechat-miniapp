-- A receipt observation may be scheduled before its first get_order result.
-- The existing local receipt and shipping journals remain independent facts.
ALTER TABLE commerce_wechat_receipt_observation
  ALTER COLUMN query_id DROP NOT NULL,
  ALTER COLUMN query_started_at DROP NOT NULL,
  ADD COLUMN watch_state text NOT NULL DEFAULT 'active'
    CHECK (watch_state IN ('active','complete','manual_review')),
  ADD COLUMN watch_next_attempt_at timestamptz DEFAULT clock_timestamp(),
  ADD COLUMN watch_lease_token uuid,
  ADD COLUMN watch_lease_until timestamptz,
  ADD COLUMN watch_failures integer NOT NULL DEFAULT 0 CHECK (watch_failures>=0),
  ADD COLUMN watch_last_error_code text CHECK (watch_last_error_code IS NULL OR char_length(watch_last_error_code)<=80),
  ADD CONSTRAINT commerce_wechat_receipt_watch_schedule
    CHECK ((watch_state='active')=(watch_next_attempt_at IS NOT NULL)),
  ADD CONSTRAINT commerce_wechat_receipt_watch_lease
    CHECK ((watch_lease_token IS NULL)=(watch_lease_until IS NULL));

-- Existing verified observations are not reinterpreted as new receipt facts.
UPDATE commerce_wechat_receipt_observation
SET watch_state=CASE WHEN platform_order_state IN (4,5) THEN 'complete' ELSE 'active' END,
    watch_next_attempt_at=CASE WHEN platform_order_state IN (4,5) THEN NULL ELSE clock_timestamp() END;

CREATE INDEX commerce_wechat_receipt_watch_due
  ON commerce_wechat_receipt_observation(watch_next_attempt_at,order_id)
  WHERE watch_state='active';
CREATE INDEX commerce_shipping_sync_receipt_seed
  ON commerce_shipping_sync(order_id) WHERE state='synced';

-- Provider/authorization outages cool the whole read-only lane across restarts.
CREATE TABLE commerce_wechat_receipt_watch_control (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  cooldown_until timestamptz NOT NULL DEFAULT '-infinity'::timestamptz,
  last_error_code text CHECK (last_error_code IS NULL OR char_length(last_error_code)<=80)
);
INSERT INTO commerce_wechat_receipt_watch_control(singleton) VALUES(true);

-- migrate:down
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM commerce_wechat_receipt_observation)
  THEN RAISE EXCEPTION 'WECHAT_RECEIPT_WATCH_ROLLBACK_REQUIRES_DATA_PRESERVATION'; END IF;
END $$;
DROP TABLE commerce_wechat_receipt_watch_control;
DROP INDEX commerce_shipping_sync_receipt_seed;
DROP INDEX commerce_wechat_receipt_watch_due;
ALTER TABLE commerce_wechat_receipt_observation
  DROP CONSTRAINT commerce_wechat_receipt_watch_lease,
  DROP CONSTRAINT commerce_wechat_receipt_watch_schedule,
  DROP COLUMN watch_last_error_code,
  DROP COLUMN watch_failures,
  DROP COLUMN watch_lease_until,
  DROP COLUMN watch_lease_token,
  DROP COLUMN watch_next_attempt_at,
  DROP COLUMN watch_state,
  ALTER COLUMN query_id SET NOT NULL,
  ALTER COLUMN query_started_at SET NOT NULL;
