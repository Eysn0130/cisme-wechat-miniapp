-- A prepared candidate is not a payout. An isolated maker/checker decision
-- binds its immutable source snapshot and explicit synthetic tax fixture to
-- one transfer request. Existing pre-cycle requests remain historical intent.
ALTER TABLE commission_settlement_request
  ADD COLUMN cycle_id uuid REFERENCES commission_settlement_cycle(id) ON DELETE RESTRICT,
  ADD COLUMN gross_cents bigint CHECK (gross_cents BETWEEN 1 AND 9900000000),
  ADD COLUMN withholding_cents bigint CHECK (withholding_cents>=0),
  ADD COLUMN tax_policy_version text;
ALTER TABLE commission_settlement_request DROP CONSTRAINT commission_settlement_request_policy_version_check;
ALTER TABLE commission_settlement_request ADD CONSTRAINT commission_settlement_request_policy_version_check
  CHECK (policy_version IN ('isolated-settlement-v1','engineering-monthly-15-test-v1'));
ALTER TABLE commission_settlement_request DROP CONSTRAINT commission_settlement_request_check;
ALTER TABLE commission_settlement_request ADD CONSTRAINT commission_settlement_request_check
  CHECK ((cycle_id IS NULL AND member_id=requested_by_member_id AND
    policy_version='isolated-settlement-v1' AND gross_cents IS NULL AND
    withholding_cents IS NULL AND tax_policy_version IS NULL) OR
    (cycle_id IS NOT NULL AND member_id<>requested_by_member_id AND
    policy_version='engineering-monthly-15-test-v1' AND state<>'requested' AND
    gross_cents=amount_cents+withholding_cents AND withholding_cents=0 AND
    tax_policy_version='isolated-synthetic-zero-withholding-v1'));

CREATE TABLE commission_settlement_cycle_member (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cycle_id uuid NOT NULL REFERENCES commission_settlement_cycle(id) ON DELETE RESTRICT,
  member_id uuid NOT NULL REFERENCES member(id) ON DELETE RESTRICT,
  request_id uuid NOT NULL UNIQUE REFERENCES commission_settlement_request(id) ON DELETE RESTRICT,
  prepared_by_member_id uuid NOT NULL REFERENCES member(id) ON DELETE RESTRICT,
  approved_by_member_id uuid NOT NULL REFERENCES member(id) ON DELETE RESTRICT,
  decision_key text NOT NULL CHECK (char_length(decision_key) BETWEEN 8 AND 200),
  decision_hash text NOT NULL CHECK (decision_hash ~ '^[0-9a-f]{64}$'),
  decision_reason text NOT NULL CHECK (char_length(decision_reason) BETWEEN 4 AND 300),
  gross_cents bigint NOT NULL CHECK (gross_cents BETWEEN 10000 AND 9900000000),
  withholding_cents bigint NOT NULL CHECK (withholding_cents=0),
  net_cents bigint NOT NULL CHECK (net_cents=gross_cents-withholding_cents),
  tax_policy_version text NOT NULL CHECK (tax_policy_version='isolated-synthetic-zero-withholding-v1'),
  approved_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(cycle_id,member_id),
  UNIQUE(approved_by_member_id,decision_key),
  CHECK (prepared_by_member_id<>approved_by_member_id),
  CHECK (member_id<>prepared_by_member_id AND member_id<>approved_by_member_id)
);
CREATE INDEX commission_settlement_cycle_member_request ON commission_settlement_cycle_member(request_id,cycle_id);
CREATE TRIGGER commission_settlement_cycle_member_immutable BEFORE UPDATE OR DELETE
  ON commission_settlement_cycle_member FOR EACH ROW EXECUTE FUNCTION commercial_evidence_immutable();
CREATE FUNCTION guard_cycle_settlement_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.cycle_id,NEW.gross_cents,NEW.withholding_cents,NEW.tax_policy_version)
    IS DISTINCT FROM (OLD.cycle_id,OLD.gross_cents,OLD.withholding_cents,OLD.tax_policy_version)
  THEN RAISE EXCEPTION 'SETTLEMENT_CYCLE_IDENTITY_IMMUTABLE' USING ERRCODE='55000'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER commission_settlement_cycle_identity BEFORE UPDATE ON commission_settlement_request
  FOR EACH ROW EXECUTE FUNCTION guard_cycle_settlement_identity();

-- migrate:down
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM commission_settlement_cycle_member) OR
    EXISTS(SELECT 1 FROM commission_settlement_request WHERE cycle_id IS NOT NULL)
  THEN RAISE EXCEPTION 'SETTLEMENT_CYCLE_APPROVAL_ROLLBACK_REQUIRES_DATA_PRESERVATION'; END IF;
END $$;
DROP TRIGGER commission_settlement_cycle_identity ON commission_settlement_request;
DROP FUNCTION guard_cycle_settlement_identity();
DROP TRIGGER commission_settlement_cycle_member_immutable ON commission_settlement_cycle_member;
DROP TABLE commission_settlement_cycle_member;
ALTER TABLE commission_settlement_request DROP CONSTRAINT commission_settlement_request_check;
ALTER TABLE commission_settlement_request ADD CONSTRAINT commission_settlement_request_check
  CHECK (member_id=requested_by_member_id);
ALTER TABLE commission_settlement_request DROP CONSTRAINT commission_settlement_request_policy_version_check;
ALTER TABLE commission_settlement_request ADD CONSTRAINT commission_settlement_request_policy_version_check
  CHECK (policy_version='isolated-settlement-v1');
ALTER TABLE commission_settlement_request DROP COLUMN tax_policy_version,
  DROP COLUMN withholding_cents,DROP COLUMN gross_cents,DROP COLUMN cycle_id;
