-- The transfer may have reached the provider even if the application dies
-- before it records a response. This fact is never reset by redrive.
ALTER TABLE commission_settlement_request
  ADD COLUMN first_dispatch_started_at timestamptz,
  ADD COLUMN lease_token uuid;
-- Existing unknown/processing records predate this durable marker. Treat them
-- conservatively as possibly sent; never infer unsent from an attempt counter.
UPDATE commission_settlement_request SET first_dispatch_started_at=created_at
  WHERE state IN ('unknown','processing');

CREATE FUNCTION guard_settlement_dispatch_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.first_dispatch_started_at IS NOT NULL AND
      NEW.first_dispatch_started_at IS DISTINCT FROM OLD.first_dispatch_started_at
    OR NEW.first_dispatch_started_at IS NOT NULL AND
      (NEW.out_bill_no IS NULL OR NEW.state NOT IN ('processing','succeeded','failed','cancelled'))
  THEN RAISE EXCEPTION 'SETTLEMENT_DISPATCH_HISTORY_IMMUTABLE' USING ERRCODE='55000'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER settlement_dispatch_history BEFORE UPDATE ON commission_settlement_request
FOR EACH ROW EXECUTE FUNCTION guard_settlement_dispatch_history();

ALTER TABLE commission_refund_intent
  ADD COLUMN first_dispatch_started_at timestamptz,
  ADD COLUMN submission_lease_token uuid;
UPDATE commission_refund_intent SET first_dispatch_started_at=created_at
  WHERE submission_state='unknown';
CREATE FUNCTION guard_refund_dispatch_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.first_dispatch_started_at IS NOT NULL AND
      NEW.first_dispatch_started_at IS DISTINCT FROM OLD.first_dispatch_started_at
  THEN RAISE EXCEPTION 'REFUND_DISPATCH_HISTORY_IMMUTABLE' USING ERRCODE='55000'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER refund_dispatch_history BEFORE UPDATE ON commission_refund_intent
FOR EACH ROW EXECUTE FUNCTION guard_refund_dispatch_history();

ALTER TABLE commerce_payment_attempt
  ADD COLUMN first_dispatch_started_at timestamptz,
  ADD COLUMN request_lease_token uuid;
UPDATE commerce_payment_attempt SET first_dispatch_started_at=updated_at WHERE state='unknown';
CREATE FUNCTION guard_payment_dispatch_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.first_dispatch_started_at IS NOT NULL AND
      NEW.first_dispatch_started_at IS DISTINCT FROM OLD.first_dispatch_started_at
  THEN RAISE EXCEPTION 'PAYMENT_DISPATCH_HISTORY_IMMUTABLE' USING ERRCODE='55000'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER payment_dispatch_history BEFORE UPDATE ON commerce_payment_attempt
FOR EACH ROW EXECUTE FUNCTION guard_payment_dispatch_history();

-- migrate:down
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM commission_settlement_request WHERE first_dispatch_started_at IS NOT NULL)
  THEN RAISE EXCEPTION 'SETTLEMENT_DISPATCH_ROLLBACK_REQUIRES_DATA_PRESERVATION'; END IF;
  IF EXISTS(SELECT 1 FROM commission_refund_intent WHERE first_dispatch_started_at IS NOT NULL)
  THEN RAISE EXCEPTION 'REFUND_DISPATCH_ROLLBACK_REQUIRES_DATA_PRESERVATION'; END IF;
  IF EXISTS(SELECT 1 FROM commerce_payment_attempt WHERE first_dispatch_started_at IS NOT NULL)
  THEN RAISE EXCEPTION 'PAYMENT_DISPATCH_ROLLBACK_REQUIRES_DATA_PRESERVATION'; END IF;
END $$;
DROP TRIGGER settlement_dispatch_history ON commission_settlement_request;
DROP FUNCTION guard_settlement_dispatch_history();
ALTER TABLE commission_settlement_request DROP COLUMN lease_token, DROP COLUMN first_dispatch_started_at;
DROP TRIGGER refund_dispatch_history ON commission_refund_intent;
DROP FUNCTION guard_refund_dispatch_history();
ALTER TABLE commission_refund_intent DROP COLUMN submission_lease_token, DROP COLUMN first_dispatch_started_at;
DROP TRIGGER payment_dispatch_history ON commerce_payment_attempt;
DROP FUNCTION guard_payment_dispatch_history();
ALTER TABLE commerce_payment_attempt DROP COLUMN request_lease_token, DROP COLUMN first_dispatch_started_at;
