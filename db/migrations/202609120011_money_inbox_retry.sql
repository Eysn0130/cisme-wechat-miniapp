-- Durable retry scheduling for signed facts. An exhausted transient fact is
-- isolated as an exception with quarantined_at; its identity never changes.
ALTER TABLE commission_payment_inbox
  ADD COLUMN attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 1000),
  ADD COLUMN next_attempt_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN last_attempt_at timestamptz,
  ADD COLUMN last_error_code text,
  ADD COLUMN lease_until timestamptz,
  ADD COLUMN quarantined_at timestamptz;
ALTER TABLE commission_refund_inbox
  ADD COLUMN attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 1000),
  ADD COLUMN next_attempt_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN last_attempt_at timestamptz,
  ADD COLUMN last_error_code text,
  ADD COLUMN lease_until timestamptz,
  ADD COLUMN quarantined_at timestamptz;
ALTER TABLE commission_payment_inbox ADD CONSTRAINT payment_retry_quarantine_check
  CHECK (quarantined_at IS NULL OR state='exception');
ALTER TABLE commission_refund_inbox ADD CONSTRAINT refund_retry_quarantine_check
  CHECK (quarantined_at IS NULL OR state='exception');
CREATE INDEX commission_payment_inbox_due ON commission_payment_inbox(next_attempt_at,received_at,id)
  WHERE state='pending';
CREATE INDEX commission_refund_inbox_due ON commission_refund_inbox(next_attempt_at,received_at,id)
  WHERE state='pending';

CREATE OR REPLACE FUNCTION guard_commission_payment_inbox() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' OR
    (NEW.notification_id,NEW.provider_transaction_id,NEW.order_id,NEW.app_id,NEW.merchant_id,
      NEW.amount_cents,NEW.currency,NEW.verified_paid_at,NEW.raw_sha256,NEW.received_at) IS DISTINCT FROM
    (OLD.notification_id,OLD.provider_transaction_id,OLD.order_id,OLD.app_id,OLD.merchant_id,
      OLD.amount_cents,OLD.currency,OLD.verified_paid_at,OLD.raw_sha256,OLD.received_at)
    OR OLD.state='applied' AND NEW IS DISTINCT FROM OLD
    OR OLD.state='exception' AND (OLD.quarantined_at IS NULL OR NEW.state<>'pending')
    OR OLD.state='pending' AND NEW.state NOT IN ('pending','applied','exception')
  THEN RAISE EXCEPTION 'PAYMENT_INBOX_FACT_IMMUTABLE' USING ERRCODE='55000'; END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION guard_commission_refund_inbox() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' OR
    (NEW.notification_id,NEW.refund_intent_id,NEW.provider_refund_id,NEW.refund_status,NEW.merchant_id,
      NEW.out_trade_no,NEW.provider_transaction_id,NEW.refund_cents,NEW.payer_refund_cents,
      NEW.succeeded_at,NEW.raw_sha256,NEW.received_at) IS DISTINCT FROM
    (OLD.notification_id,OLD.refund_intent_id,OLD.provider_refund_id,OLD.refund_status,OLD.merchant_id,
      OLD.out_trade_no,OLD.provider_transaction_id,OLD.refund_cents,OLD.payer_refund_cents,
      OLD.succeeded_at,OLD.raw_sha256,OLD.received_at)
    OR OLD.state='applied' AND NEW IS DISTINCT FROM OLD
    OR OLD.state='exception' AND (OLD.quarantined_at IS NULL OR NEW.state<>'pending')
    OR OLD.state='pending' AND NEW.state NOT IN ('pending','applied','exception')
  THEN RAISE EXCEPTION 'REFUND_INBOX_FACT_IMMUTABLE' USING ERRCODE='55000'; END IF;
  RETURN NEW;
END $$;

-- migrate:down
DROP INDEX commission_payment_inbox_due;
DROP INDEX commission_refund_inbox_due;
ALTER TABLE commission_payment_inbox DROP CONSTRAINT payment_retry_quarantine_check;
ALTER TABLE commission_refund_inbox DROP CONSTRAINT refund_retry_quarantine_check;
CREATE OR REPLACE FUNCTION guard_commission_payment_inbox() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' OR
    (NEW.notification_id,NEW.provider_transaction_id,NEW.order_id,NEW.app_id,NEW.merchant_id,
      NEW.amount_cents,NEW.currency,NEW.verified_paid_at,NEW.raw_sha256,NEW.received_at) IS DISTINCT FROM
    (OLD.notification_id,OLD.provider_transaction_id,OLD.order_id,OLD.app_id,OLD.merchant_id,
      OLD.amount_cents,OLD.currency,OLD.verified_paid_at,OLD.raw_sha256,OLD.received_at)
    OR OLD.state<>'pending' AND NEW IS DISTINCT FROM OLD
    OR OLD.state='pending' AND NEW.state NOT IN ('applied','exception')
  THEN RAISE EXCEPTION 'PAYMENT_INBOX_FACT_IMMUTABLE' USING ERRCODE='55000'; END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION guard_commission_refund_inbox() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' OR
    (NEW.notification_id,NEW.refund_intent_id,NEW.provider_refund_id,NEW.refund_status,NEW.merchant_id,
      NEW.out_trade_no,NEW.provider_transaction_id,NEW.refund_cents,NEW.payer_refund_cents,
      NEW.succeeded_at,NEW.raw_sha256,NEW.received_at) IS DISTINCT FROM
    (OLD.notification_id,OLD.refund_intent_id,OLD.provider_refund_id,OLD.refund_status,OLD.merchant_id,
      OLD.out_trade_no,OLD.provider_transaction_id,OLD.refund_cents,OLD.payer_refund_cents,
      OLD.succeeded_at,OLD.raw_sha256,OLD.received_at)
    OR OLD.state<>'pending' AND NEW IS DISTINCT FROM OLD
    OR OLD.state='pending' AND NEW.state NOT IN ('applied','exception')
  THEN RAISE EXCEPTION 'REFUND_INBOX_FACT_IMMUTABLE' USING ERRCODE='55000'; END IF;
  RETURN NEW;
END $$;
ALTER TABLE commission_payment_inbox DROP COLUMN quarantined_at,DROP COLUMN lease_until,
  DROP COLUMN last_error_code,DROP COLUMN last_attempt_at,DROP COLUMN next_attempt_at,DROP COLUMN attempt_count;
ALTER TABLE commission_refund_inbox DROP COLUMN quarantined_at,DROP COLUMN lease_until,
  DROP COLUMN last_error_code,DROP COLUMN last_attempt_at,DROP COLUMN next_attempt_at,DROP COLUMN attempt_count;
