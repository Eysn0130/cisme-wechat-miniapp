-- PRD §8.2: one immutable parcel proposal per paid order; platform sync is
-- independent from carrier delivery, receipt, refund and order completion.
CREATE TABLE commerce_shipping_sync (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL UNIQUE REFERENCES commerce_order(id) ON DELETE RESTRICT,
  created_by_member_id uuid NOT NULL REFERENCES member(id) ON DELETE RESTRICT,
  request_key text NOT NULL CHECK (char_length(request_key) BETWEEN 8 AND 200),
  request_hmac text NOT NULL CHECK (request_hmac ~ '^[0-9a-f]{64}$'),
  encrypted_parcel text NOT NULL,
  key_version text NOT NULL,
  evidence_reference text NOT NULL CHECK (char_length(evidence_reference) BETWEEN 8 AND 120),
  upload_time timestamptz NOT NULL DEFAULT clock_timestamp(),
  state text NOT NULL DEFAULT 'prepared'
    CHECK (state IN ('prepared','dispatching','verifying','synced','manual_review')),
  query_attempts integer NOT NULL DEFAULT 0 CHECK (query_attempts BETWEEN 0 AND 5),
  dispatched_at timestamptz,
  claim_token uuid,
  lease_until timestamptz,
  next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_code text,
  platform_order_state integer CHECK (platform_order_state BETWEEN 1 AND 6),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (created_by_member_id, request_key),
  CHECK ((claim_token IS NULL) = (lease_until IS NULL)),
  CHECK (state <> 'prepared' OR dispatched_at IS NULL),
  CHECK (state NOT IN ('dispatching','verifying') OR dispatched_at IS NOT NULL)
);
CREATE INDEX commerce_shipping_sync_due ON commerce_shipping_sync(next_attempt_at,id)
  WHERE state IN ('prepared','dispatching','verifying');
CREATE FUNCTION guard_commerce_shipping_sync() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' OR
    (NEW.id,NEW.order_id,NEW.created_by_member_id,NEW.request_key,NEW.request_hmac,
     NEW.encrypted_parcel,NEW.key_version,NEW.evidence_reference,NEW.upload_time,NEW.created_at)
    IS DISTINCT FROM
    (OLD.id,OLD.order_id,OLD.created_by_member_id,OLD.request_key,OLD.request_hmac,
     OLD.encrypted_parcel,OLD.key_version,OLD.evidence_reference,OLD.upload_time,OLD.created_at)
    OR (OLD.dispatched_at IS NOT NULL AND NEW.dispatched_at IS DISTINCT FROM OLD.dispatched_at)
    OR (OLD.state <> 'prepared' AND NEW.state='prepared')
    OR (OLD.state IN ('synced','manual_review') AND NEW IS DISTINCT FROM OLD)
    OR NEW.query_attempts < OLD.query_attempts
  THEN RAISE EXCEPTION 'SHIPPING_SYNC_HISTORY_IMMUTABLE' USING ERRCODE='55000'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER commerce_shipping_sync_history_guard BEFORE UPDATE OR DELETE ON commerce_shipping_sync
FOR EACH ROW EXECUTE FUNCTION guard_commerce_shipping_sync();

-- migrate:down
DROP TABLE commerce_shipping_sync;
DROP FUNCTION guard_commerce_shipping_sync();
