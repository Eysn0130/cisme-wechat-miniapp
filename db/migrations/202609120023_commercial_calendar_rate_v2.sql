-- New engineering policy is scoped to new proposals. Historical 20-35%
-- snapshots and 365-day qualifications retain their original facts.
ALTER TABLE commission_rate_rule
  ADD COLUMN rule_version text NOT NULL DEFAULT 'legacy-v1'
    CHECK (rule_version IN ('legacy-v1','commercial-rate-v2')),
  ADD COLUMN proposed_effective_at timestamptz,
  ADD COLUMN version integer NOT NULL DEFAULT 1 CHECK (version>0),
  ADD COLUMN decision_key text,
  ADD COLUMN decision_hash text,
  ADD COLUMN decision_reason text;
ALTER TABLE commission_rate_rule DISABLE TRIGGER commission_rate_rule_guard;
UPDATE commission_rate_rule SET proposed_effective_at=effective_at;
ALTER TABLE commission_rate_rule ENABLE TRIGGER commission_rate_rule_guard;
ALTER TABLE commission_rate_rule ALTER COLUMN proposed_effective_at SET NOT NULL;
-- The version attached to pre-existing rows remains legacy-v1; omitted
-- versions on every future insert must take the restricted engineering rule.
ALTER TABLE commission_rate_rule ALTER COLUMN rule_version SET DEFAULT 'commercial-rate-v2';
ALTER TABLE commission_rate_rule ADD CONSTRAINT commission_rate_v2_enum_check CHECK (
  rule_version<>'commercial-rate-v2' OR action='inherit' OR basis_points IN (2000,2500,3000,3500));
ALTER TABLE commission_rate_rule ADD CONSTRAINT commission_rate_decision_pair_check CHECK (
  (decision_key IS NULL AND decision_hash IS NULL) OR
  (decision_key ~ '^[A-Za-z0-9._:-]{8,200}$' AND decision_hash ~ '^[0-9a-f]{64}$'));
ALTER TABLE commission_rate_rule ADD CONSTRAINT commission_rate_decision_reason_check CHECK (
  decision_reason IS NULL OR char_length(btrim(decision_reason)) BETWEEN 4 AND 300);
CREATE OR REPLACE FUNCTION guard_commission_rate_rule() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' OR
    (NEW.member_id,NEW.basis_points,NEW.action,NEW.proposed_effective_at,NEW.rule_version,
      NEW.created_by,NEW.reason,NEW.created_at,NEW.request_key,NEW.request_fingerprint)
    IS DISTINCT FROM
    (OLD.member_id,OLD.basis_points,OLD.action,OLD.proposed_effective_at,OLD.rule_version,
      OLD.created_by,OLD.reason,OLD.created_at,OLD.request_key,OLD.request_fingerprint)
    OR OLD.state<>'proposed' AND NEW IS DISTINCT FROM OLD
    OR OLD.state='proposed' AND NEW.state NOT IN ('active','rejected')
    OR NEW.version<>OLD.version+1
    OR NEW.effective_at IS DISTINCT FROM OLD.effective_at AND
      (NEW.state<>'active' OR NEW.effective_at<NEW.proposed_effective_at)
  THEN RAISE EXCEPTION 'COMMISSION_RATE_RULE_IMMUTABLE' USING ERRCODE='55000'; END IF;
  RETURN NEW;
END $$;

-- migrate:down
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM commission_rate_rule WHERE rule_version='commercial-rate-v2')
  THEN RAISE EXCEPTION 'COMMERCIAL_RATE_V2_ROLLBACK_REQUIRES_DATA_PRESERVATION'; END IF;
END $$;
CREATE OR REPLACE FUNCTION guard_commission_rate_rule() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' OR (NEW.member_id,NEW.basis_points,NEW.action,NEW.effective_at,NEW.created_by,NEW.reason,NEW.created_at)
     IS DISTINCT FROM (OLD.member_id,OLD.basis_points,OLD.action,OLD.effective_at,OLD.created_by,OLD.reason,OLD.created_at)
     OR OLD.state<>'proposed' AND NEW IS DISTINCT FROM OLD
     OR OLD.state='proposed' AND NEW.state NOT IN ('active','rejected')
  THEN RAISE EXCEPTION 'COMMISSION_RATE_RULE_IMMUTABLE' USING ERRCODE='55000'; END IF;
  RETURN NEW;
END $$;
ALTER TABLE commission_rate_rule DROP CONSTRAINT commission_rate_decision_pair_check;
ALTER TABLE commission_rate_rule DROP CONSTRAINT commission_rate_decision_reason_check;
ALTER TABLE commission_rate_rule DROP CONSTRAINT commission_rate_v2_enum_check;
ALTER TABLE commission_rate_rule DROP COLUMN decision_reason,DROP COLUMN decision_hash, DROP COLUMN decision_key,
  DROP COLUMN version, DROP COLUMN proposed_effective_at, DROP COLUMN rule_version;
