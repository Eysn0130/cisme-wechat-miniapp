-- Backward-compatible synthetic privacy execution. Existing plan-only jobs
-- remain unchanged; non-synthetic members cannot enter executable modes.
CREATE TABLE privacy_export_artifact (
  job_id uuid PRIMARY KEY REFERENCES data_export_job(id),
  member_id uuid NOT NULL REFERENCES member(id),
  ciphertext bytea NOT NULL CHECK (octet_length(ciphertext) BETWEEN 1 AND 1048576),
  iv bytea NOT NULL CHECK (octet_length(iv) = 12),
  auth_tag bytea NOT NULL CHECK (octet_length(auth_tag) = 16),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (expires_at > created_at)
);
CREATE INDEX privacy_export_artifact_expiry ON privacy_export_artifact(expires_at) WHERE revoked_at IS NULL;

ALTER TABLE data_erasure_job DROP CONSTRAINT data_erasure_job_dry_run_only;
ALTER TABLE data_erasure_job ADD CONSTRAINT data_erasure_job_synthetic_execution CHECK (
  (dry_run AND status IN ('planned','canceled') AND approved_by IS NULL AND attempts=0
    AND lease_token IS NULL AND leased_until IS NULL AND completed_at IS NULL AND result_sha256 IS NULL)
  OR (NOT dry_run AND scope->>'syntheticOnly'='true' AND erasure_mode IN ('delete_scope','withdraw_purpose'))
);

CREATE FUNCTION guard_synthetic_privacy_execution() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE executable boolean := false;
BEGIN
  IF TG_OP='UPDATE' AND OLD.status<>'planned' AND NEW.scope IS DISTINCT FROM OLD.scope THEN
    RAISE EXCEPTION 'PRIVACY_EXECUTION_SCOPE_IMMUTABLE' USING ERRCODE='55000';
  END IF;
  IF TG_TABLE_NAME='data_export_job' THEN
    executable := NEW.execution_mode='generate_archive';
  ELSIF TG_TABLE_NAME='data_erasure_job' THEN
    executable := NOT NEW.dry_run;
  END IF;
  IF executable THEN
    IF NEW.scope->>'syntheticOnly' IS DISTINCT FROM 'true'
      OR NOT EXISTS (SELECT 1 FROM wechat_identity WHERE member_id=NEW.member_id AND provider='dev_test') THEN
      RAISE EXCEPTION 'SYNTHETIC_PRIVACY_EXECUTION_ONLY' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER data_export_job_synthetic_guard BEFORE INSERT OR UPDATE ON data_export_job
FOR EACH ROW EXECUTE FUNCTION guard_synthetic_privacy_execution();
CREATE TRIGGER data_erasure_job_synthetic_guard BEFORE INSERT OR UPDATE ON data_erasure_job
FOR EACH ROW EXECUTE FUNCTION guard_synthetic_privacy_execution();

-- migrate:down
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM privacy_export_artifact)
    OR EXISTS(SELECT 1 FROM data_export_job WHERE execution_mode<>'plan_only')
    OR EXISTS(SELECT 1 FROM data_erasure_job WHERE NOT dry_run)
  THEN RAISE EXCEPTION 'SYNTHETIC_PRIVACY_EXECUTION_ROLLBACK_REQUIRES_DATA_PRESERVATION'; END IF;
END $$;
DROP TRIGGER data_export_job_synthetic_guard ON data_export_job;
DROP TRIGGER data_erasure_job_synthetic_guard ON data_erasure_job;
DROP FUNCTION guard_synthetic_privacy_execution();
ALTER TABLE data_erasure_job DROP CONSTRAINT data_erasure_job_synthetic_execution;
ALTER TABLE data_erasure_job ADD CONSTRAINT data_erasure_job_dry_run_only CHECK (
  dry_run AND status IN ('planned','canceled') AND approved_by IS NULL AND attempts=0
  AND lease_token IS NULL AND leased_until IS NULL AND completed_at IS NULL AND result_sha256 IS NULL
);
DROP TABLE privacy_export_artifact;
