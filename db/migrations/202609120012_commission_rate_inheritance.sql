-- A member can explicitly return to the current global rate after a separate
-- approval. The historical override and all order snapshots remain immutable.
ALTER TABLE commission_rate_rule DROP CONSTRAINT commission_rate_rule_basis_points_check;
ALTER TABLE commission_rate_rule ALTER COLUMN basis_points DROP NOT NULL;
ALTER TABLE commission_rate_rule ADD COLUMN action text NOT NULL DEFAULT 'override';
ALTER TABLE commission_rate_rule ADD CONSTRAINT commission_rate_action_basis_check
  CHECK ((action='override' AND basis_points BETWEEN 2000 AND 3500)
    OR (action='inherit' AND member_id IS NOT NULL AND basis_points IS NULL));

CREATE OR REPLACE FUNCTION guard_commission_rate_rule() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' OR (NEW.member_id,NEW.basis_points,NEW.action,NEW.effective_at,NEW.created_by,NEW.reason,NEW.created_at)
     IS DISTINCT FROM (OLD.member_id,OLD.basis_points,OLD.action,OLD.effective_at,OLD.created_by,OLD.reason,OLD.created_at)
     OR OLD.state<>'proposed' AND NEW IS DISTINCT FROM OLD
     OR OLD.state='proposed' AND NEW.state NOT IN ('active','rejected')
  THEN RAISE EXCEPTION 'COMMISSION_RATE_RULE_IMMUTABLE' USING ERRCODE='55000'; END IF;
  RETURN NEW;
END $$;

-- migrate:down
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM commission_rate_rule WHERE action='inherit') THEN
    RAISE EXCEPTION 'COMMISSION_RATE_INHERITANCE_ROLLBACK_REQUIRES_DATA_PRESERVATION';
  END IF;
END $$;
CREATE OR REPLACE FUNCTION guard_commission_rate_rule() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' OR (NEW.member_id,NEW.basis_points,NEW.effective_at,NEW.created_by,NEW.reason,NEW.created_at)
     IS DISTINCT FROM (OLD.member_id,OLD.basis_points,OLD.effective_at,OLD.created_by,OLD.reason,OLD.created_at)
     OR OLD.state<>'proposed' AND NEW IS DISTINCT FROM OLD
     OR OLD.state='proposed' AND NEW.state NOT IN ('active','rejected')
  THEN RAISE EXCEPTION 'COMMISSION_RATE_RULE_IMMUTABLE' USING ERRCODE='55000'; END IF;
  RETURN NEW;
END $$;
ALTER TABLE commission_rate_rule DROP CONSTRAINT commission_rate_action_basis_check;
ALTER TABLE commission_rate_rule DROP COLUMN action;
ALTER TABLE commission_rate_rule ALTER COLUMN basis_points SET NOT NULL;
ALTER TABLE commission_rate_rule ADD CONSTRAINT commission_rate_rule_basis_points_check CHECK (basis_points BETWEEN 2000 AND 3500);
