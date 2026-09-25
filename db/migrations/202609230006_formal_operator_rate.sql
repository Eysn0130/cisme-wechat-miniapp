-- Formal rates are explicit operator decisions. Keep the old engineering and
-- legacy rows in their original 20%-35% ranges; a new version records the
-- reviewed operating rule used by future order snapshots.
ALTER TABLE commission_rate_rule DROP CONSTRAINT commission_rate_action_basis_check;
ALTER TABLE commission_rate_rule DROP CONSTRAINT commission_rate_rule_rule_version_check;
ALTER TABLE commission_rate_rule ADD CONSTRAINT commission_rate_rule_rule_version_check
  CHECK (rule_version IN ('legacy-v1','commercial-rate-v2','operator-rate-v1'));
ALTER TABLE commission_rate_rule ADD CONSTRAINT commission_rate_action_basis_check
  CHECK ((action='override' AND basis_points BETWEEN 0 AND 10000
      AND (rule_version='operator-rate-v1' OR basis_points BETWEEN 2000 AND 3500))
    OR (action='inherit' AND member_id IS NOT NULL AND basis_points IS NULL));
ALTER TABLE commission_order_snapshot DROP CONSTRAINT commission_order_snapshot_basis_points_check;
ALTER TABLE commission_order_snapshot ADD CONSTRAINT commission_order_snapshot_basis_points_check
  CHECK (basis_points BETWEEN 0 AND 10000);

-- migrate:down
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM commission_rate_rule WHERE rule_version='operator-rate-v1')
    OR EXISTS(SELECT 1 FROM commission_order_snapshot WHERE basis_points NOT BETWEEN 2000 AND 3500)
  THEN RAISE EXCEPTION 'FORMAL_RATE_ROLLBACK_REQUIRES_DATA_PRESERVATION'; END IF;
END $$;
ALTER TABLE commission_order_snapshot DROP CONSTRAINT commission_order_snapshot_basis_points_check;
ALTER TABLE commission_order_snapshot ADD CONSTRAINT commission_order_snapshot_basis_points_check
  CHECK (basis_points BETWEEN 2000 AND 3500);
ALTER TABLE commission_rate_rule DROP CONSTRAINT commission_rate_action_basis_check;
ALTER TABLE commission_rate_rule ADD CONSTRAINT commission_rate_action_basis_check
  CHECK ((action='override' AND basis_points BETWEEN 2000 AND 3500)
    OR (action='inherit' AND member_id IS NOT NULL AND basis_points IS NULL));
ALTER TABLE commission_rate_rule DROP CONSTRAINT commission_rate_rule_rule_version_check;
ALTER TABLE commission_rate_rule ADD CONSTRAINT commission_rate_rule_rule_version_check
  CHECK (rule_version IN ('legacy-v1','commercial-rate-v2'));
