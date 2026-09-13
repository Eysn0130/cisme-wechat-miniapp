-- Serialize writes per source lot even when an inbox worker and a checkout
-- operate on different purchase orders. No append may create negative or
-- over-issued credit, and purchase entries must belong to the source owner.
CREATE FUNCTION guard_credit_entry_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE lot RECORD; previous bigint; reserved bigint; released bigint; spent bigint; returned bigint;
BEGIN
  SELECT s.amount_cents,c.member_id,c.state INTO lot
    FROM commission_credit_source s JOIN commission_credit_conversion c ON c.id=s.conversion_id
    WHERE s.id=NEW.source_id FOR UPDATE OF s;
  IF NOT FOUND THEN RAISE EXCEPTION 'CREDIT_SOURCE_NOT_FOUND' USING ERRCODE='23514'; END IF;
  IF NEW.purchase_order_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM commerce_order o WHERE o.id=NEW.purchase_order_id
      AND o.member_id=lot.member_id AND o.credit_tender_cents>0
      AND (o.status='pending_payment' OR NEW.kind='refund_return' AND o.status='paid'))
  THEN RAISE EXCEPTION 'CREDIT_PURCHASE_OWNER_OR_STATE_INVALID' USING ERRCODE='23514'; END IF;
  SELECT COALESCE(sum(amount_cents),0) INTO previous FROM commission_credit_entry WHERE source_id=NEW.source_id;
  IF previous+NEW.amount_cents<0 OR previous+NEW.amount_cents>lot.amount_cents
  THEN RAISE EXCEPTION 'CREDIT_SOURCE_OVERDRAW' USING ERRCODE='23514'; END IF;
  IF NEW.kind='issue' AND (NEW.amount_cents<>lot.amount_cents OR previous<>0 OR
    EXISTS(SELECT 1 FROM commission_credit_entry WHERE source_id=NEW.source_id))
  THEN RAISE EXCEPTION 'CREDIT_ISSUE_DUPLICATE' USING ERRCODE='23514'; END IF;
  IF lot.state<>'available' THEN RAISE EXCEPTION 'CREDIT_CONVERSION_TERMINAL' USING ERRCODE='23514'; END IF;
  IF NEW.kind IN ('reserve_release','spend') THEN
    SELECT COALESCE(-sum(amount_cents) FILTER(WHERE kind='reserve'),0),
      COALESCE(sum(amount_cents) FILTER(WHERE kind='reserve_release'),0),
      COALESCE(-sum(amount_cents) FILTER(WHERE kind='spend'),0)
      INTO reserved,released,spent FROM commission_credit_entry
      WHERE source_id=NEW.source_id AND purchase_order_id=NEW.purchase_order_id;
    IF NOT EXISTS(SELECT 1 FROM commission_credit_checkout_allocation a
      WHERE a.source_id=NEW.source_id AND a.order_id=NEW.purchase_order_id AND a.amount_cents=reserved)
      OR NEW.kind='reserve_release' AND released+NEW.amount_cents>reserved
      OR NEW.kind='spend' AND spent-NEW.amount_cents>released
    THEN RAISE EXCEPTION 'CREDIT_PURCHASE_ALLOCATION_INVALID' USING ERRCODE='23514'; END IF;
  END IF;
  IF NEW.kind='refund_return' THEN
    SELECT COALESCE(sum(amount_cents),0) INTO returned FROM commission_credit_entry
      WHERE source_id=NEW.source_id AND purchase_order_id=NEW.purchase_order_id AND kind='refund_return';
    IF NOT EXISTS(SELECT 1 FROM commission_credit_checkout_allocation a
      WHERE a.source_id=NEW.source_id AND a.order_id=NEW.purchase_order_id)
      OR returned+NEW.amount_cents>(SELECT COALESCE(sum(a.amount_cents),0)
        FROM commission_credit_refund_allocation a JOIN commission_refund_intent i ON i.id=a.refund_intent_id
        WHERE a.source_id=NEW.source_id AND i.order_id=NEW.purchase_order_id)
    THEN RAISE EXCEPTION 'CREDIT_REFUND_ORIGINAL_ALLOCATION_INVALID' USING ERRCODE='23514'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER commission_credit_entry_guard BEFORE INSERT ON commission_credit_entry
  FOR EACH ROW EXECUTE FUNCTION guard_credit_entry_insert();

-- migrate:down
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM commission_credit_entry)
  THEN RAISE EXCEPTION 'CREDIT_ENTRY_GUARD_ROLLBACK_REQUIRES_DATA_PRESERVATION'; END IF;
END $$;
DROP TRIGGER commission_credit_entry_guard ON commission_credit_entry;
DROP FUNCTION guard_credit_entry_insert();
