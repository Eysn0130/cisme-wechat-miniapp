-- A signed, decrypted and bound transfer callback is durable before 204.
-- The callback only schedules original-number query; it never pays a ledger.
CREATE TABLE commission_transfer_callback_inbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  notification_id text NOT NULL UNIQUE CHECK (char_length(notification_id) BETWEEN 8 AND 200),
  request_id uuid NOT NULL REFERENCES commission_settlement_request(id) ON DELETE RESTRICT,
  out_bill_no text NOT NULL,
  provider_bill_no text NOT NULL,
  transfer_state text NOT NULL CHECK (transfer_state IN ('SUCCESS','FAIL','CANCELLED')),
  merchant_id text NOT NULL,
  payee_openid text NOT NULL,
  amount_cents bigint NOT NULL CHECK (amount_cents BETWEEN 1 AND 9900000000),
  raw_sha256 text NOT NULL CHECK (raw_sha256 ~ '^[0-9a-f]{64}$'),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','applied','exception')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 8),
  next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  lease_until timestamptz,
  last_error_code text,
  exception_code text,
  received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  applied_at timestamptz,
  CHECK ((state='applied')=(applied_at IS NOT NULL)),
  CHECK ((state='exception')=(exception_code IS NOT NULL))
);
CREATE INDEX commission_transfer_callback_due ON commission_transfer_callback_inbox(next_attempt_at,id)
  WHERE state='pending';
CREATE FUNCTION guard_commission_transfer_callback_inbox() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' OR
    (NEW.notification_id,NEW.request_id,NEW.out_bill_no,NEW.provider_bill_no,
      NEW.transfer_state,NEW.merchant_id,NEW.payee_openid,NEW.amount_cents,
      NEW.raw_sha256,NEW.received_at) IS DISTINCT FROM
    (OLD.notification_id,OLD.request_id,OLD.out_bill_no,OLD.provider_bill_no,
      OLD.transfer_state,OLD.merchant_id,OLD.payee_openid,OLD.amount_cents,
      OLD.raw_sha256,OLD.received_at)
    OR OLD.state<>'pending' AND NEW IS DISTINCT FROM OLD
    OR OLD.state='pending' AND NEW.state NOT IN ('pending','applied','exception')
  THEN RAISE EXCEPTION 'TRANSFER_CALLBACK_IMMUTABLE' USING ERRCODE='55000'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER commission_transfer_callback_guard BEFORE UPDATE OR DELETE ON commission_transfer_callback_inbox
FOR EACH ROW EXECUTE FUNCTION guard_commission_transfer_callback_inbox();

-- migrate:down
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM commission_transfer_callback_inbox)
  THEN RAISE EXCEPTION 'TRANSFER_CALLBACK_ROLLBACK_REQUIRES_DATA_PRESERVATION'; END IF;
END $$;
DROP TRIGGER commission_transfer_callback_guard ON commission_transfer_callback_inbox;
DROP FUNCTION guard_commission_transfer_callback_inbox();
DROP TABLE commission_transfer_callback_inbox;
