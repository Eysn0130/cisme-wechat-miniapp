-- A selected after-sale line can have no cash tender even when the paid order
-- has cash on other lines. Keep the refund in the existing budget and source
-- allocation tables, but never dispatch a zero-cent request to WeChat.
ALTER TABLE commission_refund_intent ADD COLUMN execution_kind text NOT NULL DEFAULT 'wechat'
  CHECK (execution_kind IN ('wechat','local_credit'));
ALTER TABLE commission_refund_intent DROP CONSTRAINT commission_refund_intent_refund_cents_check;
ALTER TABLE commission_refund_intent DROP CONSTRAINT commission_refund_intent_payer_refund_cents_check;
ALTER TABLE commission_refund_intent ADD CONSTRAINT commission_refund_intent_tender_kind_check CHECK (
  (execution_kind='wechat' AND refund_cents BETWEEN 1 AND 9900000000
    AND payer_refund_cents BETWEEN 1 AND 9900000000)
  OR (execution_kind='local_credit' AND refund_cents=0 AND payer_refund_cents=0
    AND eligible_merchandise_refund_cents=0 AND other_merchandise_refund_cents=0
    AND shipping_cash_refund_cents=0 AND line_allocation='[]'::jsonb
    AND request_id IS NOT NULL AND submission_state='closed'
    AND submission_lease_until IS NULL AND reconcile_lease_until IS NULL)
);

CREATE FUNCTION guard_local_credit_refund_success() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE approved_amount bigint; allocated_amount bigint;
BEGIN
  IF NEW.execution_kind<>'local_credit' THEN RETURN NEW; END IF;
  IF TG_OP='INSERT' AND NEW.state<>'prepared' THEN
    RAISE EXCEPTION 'LOCAL_CREDIT_REFUND_MUST_BE_PREPARED' USING ERRCODE='23514';
  END IF;
  IF TG_OP='UPDATE' AND OLD.state IS DISTINCT FROM NEW.state AND NEW.state='succeeded' THEN
    SELECT r.amount_cents INTO approved_amount FROM commerce_refund_request r
      WHERE r.id=NEW.request_id AND r.order_id=NEW.order_id AND r.state='approved';
    SELECT COALESCE(sum(a.amount_cents),0) INTO allocated_amount
      FROM commission_credit_refund_allocation a WHERE a.refund_intent_id=NEW.id;
    IF approved_amount IS NULL OR approved_amount<1 OR approved_amount<>allocated_amount THEN
      RAISE EXCEPTION 'LOCAL_CREDIT_REFUND_ALLOCATION_INVALID' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER commission_local_credit_refund_success BEFORE INSERT OR UPDATE ON commission_refund_intent
  FOR EACH ROW EXECUTE FUNCTION guard_local_credit_refund_success();

CREATE OR REPLACE FUNCTION guard_credit_refund_signed_fact() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE approved_success bigint; previously_returned bigint;
BEGIN
  IF NEW.kind <> 'refund_return' THEN RETURN NEW; END IF;
  SELECT COALESCE(sum(a.amount_cents),0) INTO approved_success
    FROM commission_credit_refund_allocation a
    JOIN commission_refund_intent i ON i.id=a.refund_intent_id
    WHERE a.source_id=NEW.source_id AND i.order_id=NEW.purchase_order_id
      AND (i.execution_kind='local_credit' AND i.state='succeeded'
        OR i.execution_kind='wechat' AND EXISTS (SELECT 1 FROM commission_refund_inbox f
          WHERE f.refund_intent_id=i.id AND f.state='applied' AND f.refund_status='SUCCESS'));
  SELECT COALESCE(sum(amount_cents),0) INTO previously_returned
    FROM commission_credit_entry WHERE source_id=NEW.source_id
      AND purchase_order_id=NEW.purchase_order_id AND kind='refund_return';
  IF previously_returned+NEW.amount_cents>approved_success
  THEN RAISE EXCEPTION 'CREDIT_REFUND_SIGNED_SUCCESS_REQUIRED' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;

-- migrate:down
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM commission_refund_intent WHERE execution_kind='local_credit')
  THEN RAISE EXCEPTION 'LOCAL_CREDIT_REFUND_ROLLBACK_REQUIRES_DATA_PRESERVATION'; END IF;
END $$;
CREATE OR REPLACE FUNCTION guard_credit_refund_signed_fact() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE approved_success bigint; previously_returned bigint;
BEGIN
  IF NEW.kind <> 'refund_return' THEN RETURN NEW; END IF;
  SELECT COALESCE(sum(a.amount_cents),0) INTO approved_success
    FROM commission_credit_refund_allocation a
    JOIN commission_refund_intent i ON i.id=a.refund_intent_id
    WHERE a.source_id=NEW.source_id AND i.order_id=NEW.purchase_order_id
      AND EXISTS (SELECT 1 FROM commission_refund_inbox f
        WHERE f.refund_intent_id=i.id AND f.state='applied' AND f.refund_status='SUCCESS');
  SELECT COALESCE(sum(amount_cents),0) INTO previously_returned
    FROM commission_credit_entry WHERE source_id=NEW.source_id
      AND purchase_order_id=NEW.purchase_order_id AND kind='refund_return';
  IF previously_returned+NEW.amount_cents>approved_success
  THEN RAISE EXCEPTION 'CREDIT_REFUND_SIGNED_SUCCESS_REQUIRED' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER commission_local_credit_refund_success ON commission_refund_intent;
DROP FUNCTION guard_local_credit_refund_success();
ALTER TABLE commission_refund_intent DROP CONSTRAINT commission_refund_intent_tender_kind_check;
ALTER TABLE commission_refund_intent ADD CONSTRAINT commission_refund_intent_refund_cents_check
  CHECK (refund_cents BETWEEN 1 AND 9900000000);
ALTER TABLE commission_refund_intent ADD CONSTRAINT commission_refund_intent_payer_refund_cents_check
  CHECK (payer_refund_cents BETWEEN 1 AND 9900000000);
ALTER TABLE commission_refund_intent DROP COLUMN execution_kind;
