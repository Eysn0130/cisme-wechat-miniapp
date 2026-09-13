-- PAY-MAKE protocol slice. A verified, bound WeChat notification is durable
-- before acknowledgement; no current checkout can initiate a real payment.
ALTER TABLE commerce_order DROP CONSTRAINT commerce_order_status_check;
ALTER TABLE commerce_order ADD CONSTRAINT commerce_order_status_check
  CHECK (status IN ('pending_payment','cancelled','expired','paid'));
ALTER TABLE commerce_order ADD COLUMN paid_at timestamptz;
ALTER TABLE commerce_order ADD COLUMN transaction_source_kind text NOT NULL DEFAULT 'synthetic_nonproduction'
  CHECK (transaction_source_kind IN ('synthetic_nonproduction','verified_commerce'));
ALTER TABLE commerce_order ADD CONSTRAINT commerce_order_paid_at_check
  CHECK ((status='paid')=(paid_at IS NOT NULL));
ALTER TABLE commerce_order_transition DROP CONSTRAINT commerce_order_transition_to_status_check;
ALTER TABLE commerce_order_transition ADD CONSTRAINT commerce_order_transition_to_status_check
  CHECK (to_status IN ('pending_payment','cancelled','expired','paid'));
CREATE FUNCTION guard_commerce_order_transaction_source() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.transaction_source_kind<>OLD.transaction_source_kind
  THEN RAISE EXCEPTION 'ORDER_TRANSACTION_SOURCE_IMMUTABLE' USING ERRCODE='55000'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER commerce_order_transaction_source_guard BEFORE UPDATE ON commerce_order
FOR EACH ROW EXECUTE FUNCTION guard_commerce_order_transaction_source();

CREATE TABLE commission_payment_inbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  notification_id text NOT NULL UNIQUE CHECK (char_length(notification_id) BETWEEN 8 AND 200),
  provider_transaction_id text NOT NULL UNIQUE CHECK (char_length(provider_transaction_id) BETWEEN 8 AND 200),
  order_id uuid NOT NULL REFERENCES commerce_order(id) ON DELETE RESTRICT,
  app_id text NOT NULL,
  merchant_id text NOT NULL,
  amount_cents bigint NOT NULL CHECK (amount_cents BETWEEN 1 AND 9900000000),
  currency text NOT NULL CHECK (currency='CNY'),
  verified_paid_at timestamptz NOT NULL,
  raw_sha256 text NOT NULL CHECK (raw_sha256 ~ '^[0-9a-f]{64}$'),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','applied','exception')),
  exception_code text,
  received_at timestamptz NOT NULL DEFAULT now(),
  applied_at timestamptz,
  CHECK ((state='pending' AND applied_at IS NULL AND exception_code IS NULL)
    OR (state='applied' AND applied_at IS NOT NULL AND exception_code IS NULL)
    OR (state='exception' AND applied_at IS NULL AND exception_code IS NOT NULL))
);
CREATE INDEX commission_payment_inbox_pending ON commission_payment_inbox(received_at,id) WHERE state='pending';
CREATE INDEX commission_payment_inbox_order ON commission_payment_inbox(order_id,received_at);
CREATE UNIQUE INDEX commission_one_accrual_per_order ON commission_ledger_entry(order_id) WHERE kind='accrual';
ALTER TABLE commission_ledger_entry ADD CONSTRAINT commission_accrual_positive CHECK (kind<>'accrual' OR amount_cents>0);
ALTER TABLE commission_ledger_entry ADD CONSTRAINT commission_refund_negative CHECK (kind<>'refund_reversal' OR amount_cents<0);

CREATE FUNCTION guard_commission_payment_inbox() RETURNS trigger LANGUAGE plpgsql AS $$
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
CREATE TRIGGER commission_payment_inbox_guard BEFORE UPDATE OR DELETE ON commission_payment_inbox
FOR EACH ROW EXECUTE FUNCTION guard_commission_payment_inbox();

CREATE FUNCTION guard_commission_accrual_source() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.kind='accrual' AND NOT EXISTS(SELECT 1 FROM commission_payment_inbox p
    WHERE p.id=NEW.source_fact_id AND p.order_id=NEW.order_id AND p.state='applied')
  THEN RAISE EXCEPTION 'COMMISSION_VERIFIED_PAYMENT_REQUIRED' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER commission_accrual_source BEFORE INSERT ON commission_ledger_entry
FOR EACH ROW EXECUTE FUNCTION guard_commission_accrual_source();

-- migrate:down
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM commission_payment_inbox) OR EXISTS(SELECT 1 FROM commerce_order WHERE paid_at IS NOT NULL)
  THEN RAISE EXCEPTION 'PAYMENT_INBOX_ROLLBACK_REQUIRES_DATA_PRESERVATION'; END IF;
END $$;
DROP TRIGGER commission_accrual_source ON commission_ledger_entry;
DROP FUNCTION guard_commission_accrual_source();
DROP TRIGGER commission_payment_inbox_guard ON commission_payment_inbox;
DROP FUNCTION guard_commission_payment_inbox();
DROP TABLE commission_payment_inbox;
DROP INDEX commission_one_accrual_per_order;
ALTER TABLE commission_ledger_entry DROP CONSTRAINT commission_refund_negative;
ALTER TABLE commission_ledger_entry DROP CONSTRAINT commission_accrual_positive;
ALTER TABLE commerce_order_transition DROP CONSTRAINT commerce_order_transition_to_status_check;
ALTER TABLE commerce_order_transition ADD CONSTRAINT commerce_order_transition_to_status_check
  CHECK (to_status IN ('pending_payment','cancelled','expired'));
DROP TRIGGER commerce_order_transaction_source_guard ON commerce_order;
DROP FUNCTION guard_commerce_order_transaction_source();
ALTER TABLE commerce_order DROP CONSTRAINT commerce_order_paid_at_check;
ALTER TABLE commerce_order DROP COLUMN paid_at;
ALTER TABLE commerce_order DROP COLUMN transaction_source_kind;
ALTER TABLE commerce_order DROP CONSTRAINT commerce_order_status_check;
ALTER TABLE commerce_order ADD CONSTRAINT commerce_order_status_check
  CHECK (status IN ('pending_payment','cancelled','expired'));
