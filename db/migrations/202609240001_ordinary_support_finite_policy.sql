-- Ordinary consultations are a separate class from order/aftersale evidence.
-- Three calendar months after resolution is the initial configurable service
-- window. Leave unattended purge gated until the deployed data is previewed.
-- Do not overwrite a policy already changed by operations.
UPDATE data_retention_policy SET
  duration_months=3,
  enforcement_state='enforced',
  active=true,
  legal_basis='Ordinary consultation: service handling, quality follow-up and necessary dispute review for three calendar months after resolution; active disputes and legal holds suspend deletion',
  version=version+1,
  updated_at=now()
WHERE code='support_conversation_policy_pending' AND version=1
  AND duration_days IS NULL AND duration_months IS NULL
  AND enforcement_state='declared' AND active=false
  AND automatic_purge_enabled=false;

-- migrate:down
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM data_retention_policy
    WHERE code='support_conversation_policy_pending' AND automatic_purge_enabled)
    THEN RAISE EXCEPTION 'ORDINARY_SUPPORT_RETENTION_ROLLBACK_REQUIRES_REVIEW';
  END IF;
END $$;
UPDATE data_retention_policy SET
  duration_months=NULL,enforcement_state='declared',active=false,
  legal_basis='POLICY PENDING: operations and legal must approve a duration based on service necessity, after-sales disputes, legal duties, and user rights before activation',
  version=1,updated_at=now()
WHERE code='support_conversation_policy_pending' AND version=2
  AND duration_months=3 AND duration_days IS NULL
  AND enforcement_state='enforced' AND active=true
  AND automatic_purge_enabled=false;
