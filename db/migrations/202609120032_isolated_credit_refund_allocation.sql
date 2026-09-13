-- Cash refunds continue through the authenticated channel; noncash credit
-- returns are source-lot allocations appended only with its SUCCESS fact.
CREATE TABLE commission_credit_refund_allocation (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  refund_intent_id uuid NOT NULL REFERENCES commission_refund_intent(id) ON DELETE RESTRICT,
  source_id uuid NOT NULL REFERENCES commission_credit_source(id) ON DELETE RESTRICT,
  amount_cents bigint NOT NULL CHECK (amount_cents BETWEEN 1 AND 9900000000),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(refund_intent_id,source_id)
);
CREATE INDEX commission_credit_refund_source ON commission_credit_refund_allocation(source_id,refund_intent_id);
CREATE TRIGGER commission_credit_refund_immutable BEFORE UPDATE OR DELETE ON commission_credit_refund_allocation
  FOR EACH ROW EXECUTE FUNCTION commercial_evidence_immutable();

-- migrate:down
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM commission_credit_refund_allocation) OR
    EXISTS (SELECT 1 FROM commission_credit_entry WHERE kind='refund_return')
  THEN RAISE EXCEPTION 'CREDIT_REFUND_ROLLBACK_REQUIRES_DATA_PRESERVATION'; END IF;
END $$;
DROP TRIGGER commission_credit_refund_immutable ON commission_credit_refund_allocation;
DROP TABLE commission_credit_refund_allocation;
