-- Calendar years avoid representing the confirmed three-year transaction
-- baseline as an approximate number of days. These declarations do not
-- enable automatic deletion of transaction or mixed support evidence.
ALTER TABLE data_retention_policy ADD COLUMN duration_months integer
  CHECK (duration_months IS NULL OR duration_months > 0);
ALTER TABLE data_retention_policy ADD CONSTRAINT retention_one_duration_unit
  CHECK (duration_days IS NULL OR duration_months IS NULL);
INSERT INTO data_retention_policy
  (code,data_class,trigger_event,duration_months,disposition,legal_basis,enforcement_state,active)
VALUES
  ('commerce_transaction_three_years','order, payment, refund and aftersale facts',
   'transaction complete or aftersale closed',36,'restrict_then_delete',
   'Confirmed operator policy 2026-09-23: three years from completion, subject to longer applicable legal duties and unresolved disputes',
   'declared',false),
  ('support_transaction_three_years','support records linked to an order or aftersale',
   'later of transaction completion and aftersale closure',36,'restrict_then_delete',
   'Confirmed operator policy 2026-09-23: three years after transaction or aftersale closure, with dispute and legal-duty exceptions',
   'declared',false);

CREATE FUNCTION audit_retention_policy_change() RETURNS trigger LANGUAGE plpgsql AS $$
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
CREATE TRIGGER data_retention_policy_audit AFTER UPDATE ON data_retention_policy
  FOR EACH ROW EXECUTE FUNCTION audit_retention_policy_change();

-- migrate:down
DROP TRIGGER data_retention_policy_audit ON data_retention_policy;
DROP FUNCTION audit_retention_policy_change();
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM data_retention_policy WHERE code IN
    ('commerce_transaction_three_years','support_transaction_three_years')
    AND (active OR enforcement_state<>'declared' OR version<>1 OR duration_months<>36))
    THEN RAISE EXCEPTION 'RETENTION_CLASS_ROLLBACK_REQUIRES_REVIEW';
  END IF;
END $$;
DELETE FROM data_retention_policy WHERE code IN
  ('commerce_transaction_three_years','support_transaction_three_years');
ALTER TABLE data_retention_policy DROP CONSTRAINT retention_one_duration_unit;
ALTER TABLE data_retention_policy DROP COLUMN duration_months;
