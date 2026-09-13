-- An engineering-only, non-payable monthly candidate snapshot. This table
-- does not reserve funds or authorize a transfer. Formal tax, withholding,
-- identity and payout policy must be approved before a separate release path.
CREATE TABLE commission_settlement_cycle (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  period_end date NOT NULL UNIQUE,
  cutoff_at timestamptz NOT NULL,
  policy_version text NOT NULL CHECK (policy_version='engineering-monthly-15-v1'),
  threshold_cents bigint NOT NULL CHECK (threshold_cents=10000),
  state text NOT NULL CHECK (state='blocked_tax_and_payout_policy'),
  withholding_policy_version text,
  prepared_by_member_id uuid NOT NULL REFERENCES member(id) ON DELETE RESTRICT,
  prepared_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (withholding_policy_version IS NULL)
);
CREATE TABLE commission_settlement_cycle_candidate (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cycle_id uuid NOT NULL REFERENCES commission_settlement_cycle(id) ON DELETE RESTRICT,
  member_id uuid NOT NULL REFERENCES member(id) ON DELETE RESTRICT,
  order_id uuid NOT NULL REFERENCES commerce_order(id) ON DELETE RESTRICT,
  gross_cents bigint NOT NULL CHECK (gross_cents BETWEEN 1 AND 9900000000),
  withholding_cents bigint,
  net_cents bigint,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(cycle_id,order_id),
  CHECK (withholding_cents IS NULL AND net_cents IS NULL)
);
CREATE INDEX commission_settlement_cycle_candidate_member ON commission_settlement_cycle_candidate(cycle_id,member_id);
CREATE TRIGGER commission_settlement_cycle_immutable BEFORE UPDATE OR DELETE ON commission_settlement_cycle
  FOR EACH ROW EXECUTE FUNCTION commercial_evidence_immutable();
CREATE TRIGGER commission_settlement_cycle_candidate_immutable BEFORE UPDATE OR DELETE ON commission_settlement_cycle_candidate
  FOR EACH ROW EXECUTE FUNCTION commercial_evidence_immutable();

-- migrate:down
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM commission_settlement_cycle)
  THEN RAISE EXCEPTION 'SETTLEMENT_CYCLE_ROLLBACK_REQUIRES_DATA_PRESERVATION'; END IF;
END $$;
DROP TRIGGER commission_settlement_cycle_candidate_immutable ON commission_settlement_cycle_candidate;
DROP TRIGGER commission_settlement_cycle_immutable ON commission_settlement_cycle;
DROP TABLE commission_settlement_cycle_candidate;
DROP TABLE commission_settlement_cycle;
