-- Isolated command-side refund request and approval. Channel submission is
-- deliberately separate from the DB approval transaction.
CREATE TABLE commerce_refund_request (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES commerce_order(id) ON DELETE RESTRICT,
  requested_by_member_id uuid NOT NULL REFERENCES member(id) ON DELETE RESTRICT,
  idempotency_key text NOT NULL CHECK (char_length(idempotency_key) BETWEEN 8 AND 200),
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  amount_cents bigint NOT NULL CHECK (amount_cents BETWEEN 1 AND 9900000000),
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 3 AND 500),
  state text NOT NULL DEFAULT 'requested' CHECK (state IN ('requested','approved','rejected')),
  version integer NOT NULL DEFAULT 1 CHECK (version>0),
  decided_by_member_id uuid REFERENCES member(id) ON DELETE RESTRICT,
  decision_key text,
  decision_hash text,
  decision_reason text,
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(requested_by_member_id,idempotency_key),
  CHECK ((state='requested')=(decided_at IS NULL)),
  CHECK (state='requested' OR decided_by_member_id<>requested_by_member_id),
  CHECK ((state='requested')=(decision_key IS NULL AND decision_hash IS NULL)),
  CHECK (decision_key IS NULL OR char_length(decision_key) BETWEEN 8 AND 200),
  CHECK (decision_hash IS NULL OR decision_hash ~ '^[0-9a-f]{64}$'),
  CHECK (state='requested' OR char_length(decision_reason) BETWEEN 3 AND 500)
);
CREATE INDEX commerce_refund_request_order ON commerce_refund_request(order_id,created_at,id);
CREATE INDEX commerce_refund_request_queue ON commerce_refund_request(created_at,id) WHERE state='requested';
CREATE UNIQUE INDEX commerce_refund_decision_key ON commerce_refund_request(decided_by_member_id,decision_key)
  WHERE decision_key IS NOT NULL;
CREATE FUNCTION guard_commerce_refund_request() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' OR
    (NEW.order_id,NEW.requested_by_member_id,NEW.idempotency_key,NEW.request_hash,
      NEW.amount_cents,NEW.reason,NEW.created_at) IS DISTINCT FROM
    (OLD.order_id,OLD.requested_by_member_id,OLD.idempotency_key,OLD.request_hash,
      OLD.amount_cents,OLD.reason,OLD.created_at)
    OR OLD.state<>'requested' AND NEW IS DISTINCT FROM OLD
    OR OLD.state='requested' AND NEW.state NOT IN ('approved','rejected')
  THEN RAISE EXCEPTION 'REFUND_REQUEST_IMMUTABLE' USING ERRCODE='55000'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER commerce_refund_request_guard BEFORE UPDATE OR DELETE ON commerce_refund_request
FOR EACH ROW EXECUTE FUNCTION guard_commerce_refund_request();

ALTER TABLE commission_refund_intent ADD COLUMN request_id uuid UNIQUE
  REFERENCES commerce_refund_request(id) ON DELETE RESTRICT;
ALTER TABLE commission_refund_intent ADD COLUMN submission_state text NOT NULL DEFAULT 'prepared'
  CHECK (submission_state IN ('prepared','unknown','accepted','closed'));
ALTER TABLE commission_refund_intent ADD COLUMN submission_lease_until timestamptz;
ALTER TABLE commission_refund_intent ADD COLUMN reconcile_lease_until timestamptz;
ALTER TABLE commission_refund_intent ADD COLUMN submission_attempt_count integer NOT NULL DEFAULT 0
  CHECK (submission_attempt_count BETWEEN 0 AND 8);
ALTER TABLE commission_refund_intent ADD COLUMN submission_next_attempt_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE commission_refund_intent ADD COLUMN submission_quarantined_at timestamptz;
ALTER TABLE commission_refund_intent ADD COLUMN submission_last_error_code text;
ALTER TABLE commission_refund_intent ADD COLUMN reconcile_attempt_count integer NOT NULL DEFAULT 0
  CHECK (reconcile_attempt_count BETWEEN 0 AND 1000);
ALTER TABLE commission_refund_intent ADD COLUMN reconcile_last_error_code text;
ALTER TABLE commission_refund_intent ADD CONSTRAINT commission_refund_submission_lease_check
  CHECK (submission_lease_until IS NULL OR submission_state='unknown');
ALTER TABLE commission_refund_intent ADD CONSTRAINT commission_refund_reconcile_lease_check
  CHECK (reconcile_lease_until IS NULL OR submission_state='accepted');
CREATE OR REPLACE FUNCTION guard_commission_refund_intent() RETURNS trigger LANGUAGE plpgsql AS $$
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
    OR OLD.state='prepared' AND NEW.state NOT IN ('prepared','succeeded','closed','abnormal')
    OR OLD.state='abnormal' AND NEW.state NOT IN ('abnormal','succeeded','closed')
  THEN RAISE EXCEPTION 'REFUND_INTENT_IMMUTABLE' USING ERRCODE='55000'; END IF;
  RETURN NEW;
END $$;
CREATE INDEX commission_refund_intent_submission_due ON commission_refund_intent(submission_next_attempt_at,id)
  WHERE state='prepared' AND submission_quarantined_at IS NULL;
CREATE FUNCTION guard_commission_refund_submission() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.request_id IS DISTINCT FROM OLD.request_id OR
    (OLD.submission_state IN ('accepted','closed') AND NEW.submission_state<>OLD.submission_state)
    OR (OLD.submission_state='prepared' AND NEW.submission_state NOT IN ('prepared','unknown'))
    OR (OLD.submission_state='unknown' AND NEW.submission_state NOT IN ('unknown','accepted','closed'))
  THEN RAISE EXCEPTION 'REFUND_SUBMISSION_IMMUTABLE' USING ERRCODE='55000'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER commission_refund_submission_guard BEFORE UPDATE ON commission_refund_intent
FOR EACH ROW EXECUTE FUNCTION guard_commission_refund_submission();

-- migrate:down
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM commerce_refund_request)
  THEN RAISE EXCEPTION 'REFUND_COMMAND_ROLLBACK_REQUIRES_DATA_PRESERVATION'; END IF;
END $$;
DROP INDEX commission_refund_intent_submission_due;
DROP TRIGGER commission_refund_submission_guard ON commission_refund_intent;
DROP FUNCTION guard_commission_refund_submission();
ALTER TABLE commission_refund_intent DROP CONSTRAINT commission_refund_submission_lease_check;
ALTER TABLE commission_refund_intent DROP CONSTRAINT commission_refund_reconcile_lease_check;
ALTER TABLE commission_refund_intent DROP COLUMN submission_lease_until;
ALTER TABLE commission_refund_intent DROP COLUMN reconcile_lease_until;
ALTER TABLE commission_refund_intent DROP COLUMN submission_state;
ALTER TABLE commission_refund_intent DROP COLUMN submission_last_error_code;
ALTER TABLE commission_refund_intent DROP COLUMN submission_quarantined_at;
ALTER TABLE commission_refund_intent DROP COLUMN submission_next_attempt_at;
ALTER TABLE commission_refund_intent DROP COLUMN submission_attempt_count;
ALTER TABLE commission_refund_intent DROP COLUMN reconcile_last_error_code;
ALTER TABLE commission_refund_intent DROP COLUMN reconcile_attempt_count;
ALTER TABLE commission_refund_intent DROP COLUMN request_id;
CREATE OR REPLACE FUNCTION guard_commission_refund_intent() RETURNS trigger LANGUAGE plpgsql AS $$
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
DROP TRIGGER commerce_refund_request_guard ON commerce_refund_request;
DROP FUNCTION guard_commerce_refund_request();
DROP TABLE commerce_refund_request;
