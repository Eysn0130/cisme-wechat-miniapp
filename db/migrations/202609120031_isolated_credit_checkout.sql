-- Test-only split tender. Merchandise gross stays distinct from the signed
-- WeChat cash amount; credit is never a discount, cash or an accrual source.
ALTER TABLE commerce_checkout_quote ADD COLUMN credit_tender_cents bigint NOT NULL DEFAULT 0
  CHECK (credit_tender_cents BETWEEN 0 AND 9900000000);
ALTER TABLE commerce_checkout_quote ADD CONSTRAINT quote_credit_cash_positive
  CHECK (credit_tender_cents=0 OR credit_tender_cents<total_cents);
ALTER TABLE commerce_order ADD COLUMN credit_tender_cents bigint NOT NULL DEFAULT 0
  CHECK (credit_tender_cents BETWEEN 0 AND 9900000000);
ALTER TABLE commerce_order ADD CONSTRAINT order_credit_cash_positive
  CHECK (credit_tender_cents=0 OR credit_tender_cents<total_cents);
ALTER TABLE commerce_order_line ADD COLUMN credit_tender_cents bigint NOT NULL DEFAULT 0
  CHECK (credit_tender_cents BETWEEN 0 AND 9900000000);
ALTER TABLE commerce_order_line ADD CONSTRAINT order_line_credit_within_merchandise
  CHECK (credit_tender_cents<=line_total_cents);

ALTER TABLE commission_credit_entry DROP CONSTRAINT commission_credit_entry_kind_check;
ALTER TABLE commission_credit_entry ADD CONSTRAINT commission_credit_entry_kind_check
  CHECK (kind IN ('issue','reserve','reserve_release','spend','refund_return','cancel','freeze','unfreeze'));
ALTER TABLE commission_credit_entry DROP CONSTRAINT commission_credit_entry_check;
ALTER TABLE commission_credit_entry ADD CONSTRAINT commission_credit_entry_check
  CHECK ((kind IN ('issue','reserve_release','refund_return','unfreeze'))=(amount_cents>0));
ALTER TABLE commission_credit_entry DROP CONSTRAINT commission_credit_entry_check1;
ALTER TABLE commission_credit_entry ADD CONSTRAINT commission_credit_entry_check1
  CHECK ((kind IN ('reserve','reserve_release','spend','refund_return'))=(purchase_order_id IS NOT NULL));

CREATE TABLE commission_credit_checkout_allocation (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id uuid NOT NULL REFERENCES commission_credit_source(id) ON DELETE RESTRICT,
  order_id uuid NOT NULL REFERENCES commerce_order(id) ON DELETE RESTRICT,
  amount_cents bigint NOT NULL CHECK (amount_cents BETWEEN 1 AND 9900000000),
  reserve_entry_id uuid NOT NULL UNIQUE REFERENCES commission_credit_entry(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(source_id,order_id)
);
CREATE INDEX commission_credit_checkout_order ON commission_credit_checkout_allocation(order_id,source_id);
CREATE TRIGGER commission_credit_checkout_immutable BEFORE UPDATE OR DELETE ON commission_credit_checkout_allocation
  FOR EACH ROW EXECUTE FUNCTION commercial_evidence_immutable();

-- migrate:down
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM commission_credit_checkout_allocation) OR
    EXISTS (SELECT 1 FROM commerce_order WHERE credit_tender_cents<>0) OR
    EXISTS (SELECT 1 FROM commission_credit_entry WHERE kind IN ('reserve','reserve_release'))
  THEN RAISE EXCEPTION 'CREDIT_CHECKOUT_ROLLBACK_REQUIRES_DATA_PRESERVATION'; END IF;
END $$;
DROP TRIGGER commission_credit_checkout_immutable ON commission_credit_checkout_allocation;
DROP TABLE commission_credit_checkout_allocation;
ALTER TABLE commission_credit_entry DROP CONSTRAINT commission_credit_entry_check1;
ALTER TABLE commission_credit_entry ADD CONSTRAINT commission_credit_entry_check1
  CHECK ((kind IN ('spend','refund_return'))=(purchase_order_id IS NOT NULL));
ALTER TABLE commission_credit_entry DROP CONSTRAINT commission_credit_entry_check;
ALTER TABLE commission_credit_entry ADD CONSTRAINT commission_credit_entry_check
  CHECK ((kind IN ('issue','refund_return','unfreeze'))=(amount_cents>0));
ALTER TABLE commission_credit_entry DROP CONSTRAINT commission_credit_entry_kind_check;
ALTER TABLE commission_credit_entry ADD CONSTRAINT commission_credit_entry_kind_check
  CHECK (kind IN ('issue','spend','refund_return','cancel','freeze','unfreeze'));
ALTER TABLE commerce_order_line DROP CONSTRAINT order_line_credit_within_merchandise;
ALTER TABLE commerce_order_line DROP COLUMN credit_tender_cents;
ALTER TABLE commerce_order DROP CONSTRAINT order_credit_cash_positive;
ALTER TABLE commerce_order DROP COLUMN credit_tender_cents;
ALTER TABLE commerce_checkout_quote DROP CONSTRAINT quote_credit_cash_positive;
ALTER TABLE commerce_checkout_quote DROP COLUMN credit_tender_cents;
