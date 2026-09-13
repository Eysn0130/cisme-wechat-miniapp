-- Internal refund fact boundary. No current route can issue a real refund.
-- The intent is an immutable merchant refund number plus approved cash
-- allocation; only a signed WeChat fact may finalize it.
CREATE TABLE commission_refund_intent (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES commerce_order(id) ON DELETE RESTRICT,
  payment_inbox_id uuid NOT NULL REFERENCES commission_payment_inbox(id) ON DELETE RESTRICT,
  out_refund_no text NOT NULL UNIQUE CHECK (char_length(out_refund_no) BETWEEN 8 AND 64),
  refund_cents bigint NOT NULL CHECK (refund_cents BETWEEN 1 AND 9900000000),
  payer_refund_cents bigint NOT NULL CHECK (payer_refund_cents BETWEEN 1 AND 9900000000),
  eligible_merchandise_refund_cents bigint NOT NULL CHECK (eligible_merchandise_refund_cents BETWEEN 0 AND 9900000000),
  other_merchandise_refund_cents bigint NOT NULL CHECK (other_merchandise_refund_cents BETWEEN 0 AND 9900000000),
  shipping_cash_refund_cents bigint NOT NULL CHECK (shipping_cash_refund_cents BETWEEN 0 AND 9900000000),
  line_allocation jsonb NOT NULL CHECK (jsonb_typeof(line_allocation)='array'),
  allocation_policy_version text NOT NULL CHECK (char_length(allocation_policy_version) BETWEEN 3 AND 100),
  created_by text NOT NULL,
  state text NOT NULL DEFAULT 'prepared' CHECK (state IN ('prepared','succeeded','closed','abnormal')),
  created_at timestamptz NOT NULL DEFAULT now(),
  finalized_at timestamptz,
  CHECK (payer_refund_cents<=refund_cents),
  CHECK (eligible_merchandise_refund_cents+other_merchandise_refund_cents+shipping_cash_refund_cents=payer_refund_cents),
  CHECK ((state='prepared')=(finalized_at IS NULL))
);
CREATE INDEX commission_refund_intent_order ON commission_refund_intent(order_id,created_at,id);
CREATE FUNCTION guard_commission_refund_intent() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' OR
    (NEW.order_id,NEW.payment_inbox_id,NEW.out_refund_no,NEW.refund_cents,NEW.payer_refund_cents,
      NEW.eligible_merchandise_refund_cents,NEW.other_merchandise_refund_cents,
      NEW.shipping_cash_refund_cents,NEW.line_allocation,NEW.allocation_policy_version,NEW.created_by,NEW.created_at)
    IS DISTINCT FROM
    (OLD.order_id,OLD.payment_inbox_id,OLD.out_refund_no,OLD.refund_cents,OLD.payer_refund_cents,
      OLD.eligible_merchandise_refund_cents,OLD.other_merchandise_refund_cents,
      OLD.shipping_cash_refund_cents,OLD.line_allocation,OLD.allocation_policy_version,OLD.created_by,OLD.created_at)
    OR OLD.state IN ('succeeded','closed') AND NEW IS DISTINCT FROM OLD
    OR OLD.state='prepared' AND NEW.state NOT IN ('succeeded','closed','abnormal')
    OR OLD.state='abnormal' AND NEW IS DISTINCT FROM OLD AND NEW.state NOT IN ('succeeded','closed')
  THEN RAISE EXCEPTION 'REFUND_INTENT_IMMUTABLE' USING ERRCODE='55000'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER commission_refund_intent_guard BEFORE UPDATE OR DELETE ON commission_refund_intent
FOR EACH ROW EXECUTE FUNCTION guard_commission_refund_intent();
CREATE FUNCTION guard_commission_refund_intent_source() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM commerce_order o JOIN commission_payment_inbox p
    ON p.order_id=o.id AND p.id=NEW.payment_inbox_id
    WHERE o.id=NEW.order_id AND o.status='paid' AND o.transaction_source_kind='verified_commerce'
      AND p.state='applied')
  THEN RAISE EXCEPTION 'REFUND_VERIFIED_PAYMENT_REQUIRED' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER commission_refund_intent_source BEFORE INSERT ON commission_refund_intent
FOR EACH ROW EXECUTE FUNCTION guard_commission_refund_intent_source();

CREATE TABLE commission_refund_inbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  notification_id text NOT NULL UNIQUE CHECK (char_length(notification_id) BETWEEN 8 AND 200),
  refund_intent_id uuid NOT NULL REFERENCES commission_refund_intent(id) ON DELETE RESTRICT,
  provider_refund_id text NOT NULL CHECK (char_length(provider_refund_id) BETWEEN 8 AND 200),
  refund_status text NOT NULL CHECK (refund_status IN ('SUCCESS','CLOSED','ABNORMAL')),
  merchant_id text NOT NULL,
  out_trade_no text NOT NULL,
  provider_transaction_id text NOT NULL,
  refund_cents bigint NOT NULL CHECK (refund_cents BETWEEN 1 AND 9900000000),
  payer_refund_cents bigint NOT NULL CHECK (payer_refund_cents BETWEEN 1 AND 9900000000),
  succeeded_at timestamptz,
  raw_sha256 text NOT NULL CHECK (raw_sha256 ~ '^[0-9a-f]{64}$'),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','applied','exception')),
  exception_code text,
  received_at timestamptz NOT NULL DEFAULT now(),
  applied_at timestamptz,
  CHECK ((refund_status='SUCCESS')=(succeeded_at IS NOT NULL)),
  CHECK ((state='pending' AND applied_at IS NULL AND exception_code IS NULL)
    OR (state='applied' AND applied_at IS NOT NULL AND exception_code IS NULL)
    OR (state='exception' AND applied_at IS NULL AND exception_code IS NOT NULL))
);
CREATE INDEX commission_refund_inbox_pending ON commission_refund_inbox(received_at,id) WHERE state='pending';
CREATE UNIQUE INDEX commission_refund_one_applied_success ON commission_refund_inbox(refund_intent_id)
  WHERE state='applied' AND refund_status='SUCCESS';
CREATE UNIQUE INDEX commission_refund_provider_success_once ON commission_refund_inbox(provider_refund_id)
  WHERE state='applied' AND refund_status='SUCCESS';
CREATE UNIQUE INDEX commission_one_reversal_per_refund_fact ON commission_ledger_entry(source_fact_id)
  WHERE kind='refund_reversal';
CREATE FUNCTION guard_commission_refund_inbox() RETURNS trigger LANGUAGE plpgsql AS $$
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
CREATE TRIGGER commission_refund_inbox_guard BEFORE UPDATE OR DELETE ON commission_refund_inbox
FOR EACH ROW EXECUTE FUNCTION guard_commission_refund_inbox();
CREATE FUNCTION guard_commission_refund_reversal_source() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.kind='refund_reversal' AND NOT EXISTS(SELECT 1 FROM commission_refund_inbox r
    JOIN commission_refund_intent i ON i.id=r.refund_intent_id
    JOIN commission_ledger_entry a ON a.id=NEW.reverse_of AND a.kind='accrual'
      AND a.order_id=NEW.order_id AND a.referrer_member_id=NEW.referrer_member_id
    WHERE r.id=NEW.source_fact_id AND i.order_id=NEW.order_id AND r.state='applied' AND r.refund_status='SUCCESS')
  THEN RAISE EXCEPTION 'COMMISSION_VERIFIED_REFUND_REQUIRED' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER commission_refund_reversal_source BEFORE INSERT ON commission_ledger_entry
FOR EACH ROW EXECUTE FUNCTION guard_commission_refund_reversal_source();

-- migrate:down
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM commission_refund_inbox) OR EXISTS(SELECT 1 FROM commission_refund_intent)
  THEN RAISE EXCEPTION 'REFUND_INBOX_ROLLBACK_REQUIRES_DATA_PRESERVATION'; END IF;
END $$;
DROP TRIGGER commission_refund_reversal_source ON commission_ledger_entry;
DROP FUNCTION guard_commission_refund_reversal_source();
DROP INDEX commission_one_reversal_per_refund_fact;
DROP INDEX commission_refund_provider_success_once;
DROP TRIGGER commission_refund_inbox_guard ON commission_refund_inbox;
DROP FUNCTION guard_commission_refund_inbox();
DROP TABLE commission_refund_inbox;
DROP TRIGGER commission_refund_intent_guard ON commission_refund_intent;
DROP FUNCTION guard_commission_refund_intent();
DROP TRIGGER commission_refund_intent_source ON commission_refund_intent;
DROP FUNCTION guard_commission_refund_intent_source();
DROP TABLE commission_refund_intent;
