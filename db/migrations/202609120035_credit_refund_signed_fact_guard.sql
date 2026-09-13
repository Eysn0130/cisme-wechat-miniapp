-- A reserved refund allocation is not a returned benefit. The source credit
-- can be restored only after a verified SUCCESS inbox has been applied. Sum
-- by intent, not by inbox row, so notification/query duplicates cannot mint
-- extra credit and another still-pending partial refund cannot be borrowed.
CREATE FUNCTION guard_credit_refund_signed_fact() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE approved_success bigint; previously_returned bigint;
BEGIN
  IF NEW.kind <> 'refund_return' THEN RETURN NEW; END IF;
  SELECT COALESCE(sum(a.amount_cents),0) INTO approved_success
    FROM commission_credit_refund_allocation a
    JOIN commission_refund_intent i ON i.id=a.refund_intent_id
    WHERE a.source_id=NEW.source_id AND i.order_id=NEW.purchase_order_id
      AND EXISTS (SELECT 1 FROM commission_refund_inbox f
        WHERE f.refund_intent_id=i.id AND f.state='applied'
          AND f.refund_status='SUCCESS');
  SELECT COALESCE(sum(amount_cents),0) INTO previously_returned
    FROM commission_credit_entry WHERE source_id=NEW.source_id
      AND purchase_order_id=NEW.purchase_order_id AND kind='refund_return';
  IF previously_returned+NEW.amount_cents>approved_success
  THEN RAISE EXCEPTION 'CREDIT_REFUND_SIGNED_SUCCESS_REQUIRED' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER commission_credit_refund_signed_fact BEFORE INSERT ON commission_credit_entry
  FOR EACH ROW EXECUTE FUNCTION guard_credit_refund_signed_fact();

-- migrate:down
DROP TRIGGER commission_credit_refund_signed_fact ON commission_credit_entry;
DROP FUNCTION guard_credit_refund_signed_fact();
