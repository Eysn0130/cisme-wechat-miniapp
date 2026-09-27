-- Enabling a finite policy for supervised/manual purge does not authorize
-- unattended deletion of existing support history. This separate gate is
-- false on upgrade and each change is included in the policy audit receipt.
ALTER TABLE data_retention_policy ADD COLUMN automatic_purge_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE data_retention_policy ADD CONSTRAINT retention_automatic_purge_requires_active
  CHECK (NOT automatic_purge_enabled OR
    active AND enforcement_state='enforced' AND
    (duration_days IS NOT NULL OR duration_months IS NOT NULL));

CREATE OR REPLACE FUNCTION audit_retention_policy_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO audit_log(principal_id,action,object_type,object_id,reason_code,before_state,after_state,trace_id)
  VALUES(
    COALESCE(NULLIF(current_setting('cisme.operator_principal',true),''),'database:'||current_user),
    'privacy.retention_policy.change','data_retention_policy',NULL,'RETENTION_CONFIGURATION',
    jsonb_build_object('code',OLD.code,'days',OLD.duration_days,'months',OLD.duration_months,
      'state',OLD.enforcement_state,'active',OLD.active,'automaticPurge',OLD.automatic_purge_enabled,'version',OLD.version),
    jsonb_build_object('code',NEW.code,'days',NEW.duration_days,'months',NEW.duration_months,
      'state',NEW.enforcement_state,'active',NEW.active,'automaticPurge',NEW.automatic_purge_enabled,'version',NEW.version),
    gen_random_uuid()::text);
  RETURN NEW;
END $$;

-- migrate:down
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM data_retention_policy WHERE automatic_purge_enabled)
  THEN RAISE EXCEPTION 'AUTOMATIC_RETENTION_ROLLBACK_REQUIRES_REVIEW'; END IF;
END $$;
ALTER TABLE data_retention_policy DROP CONSTRAINT retention_automatic_purge_requires_active;
ALTER TABLE data_retention_policy DROP COLUMN automatic_purge_enabled;
CREATE OR REPLACE FUNCTION audit_retention_policy_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO audit_log(principal_id,action,object_type,object_id,reason_code,before_state,after_state,trace_id)
  VALUES(
    COALESCE(NULLIF(current_setting('cisme.operator_principal',true),''),'database:'||current_user),
    'privacy.retention_policy.change','data_retention_policy',NULL,'RETENTION_CONFIGURATION',
    jsonb_build_object('code',OLD.code,'days',OLD.duration_days,'months',OLD.duration_months,
      'state',OLD.enforcement_state,'active',OLD.active,'version',OLD.version),
    jsonb_build_object('code',NEW.code,'days',NEW.duration_days,'months',NEW.duration_months,
      'state',NEW.enforcement_state,'active',NEW.active,'version',NEW.version),
    gen_random_uuid()::text);
  RETURN NEW;
END $$;
