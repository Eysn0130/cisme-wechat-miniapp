-- A verified WeChat member may request a private account-data copy through
-- the existing privacy request. Synthetic jobs retain their original guard.
ALTER TABLE privacy_export_artifact DROP CONSTRAINT privacy_export_artifact_ciphertext_check;
ALTER TABLE privacy_export_artifact ADD CONSTRAINT privacy_export_artifact_ciphertext_check
  CHECK (octet_length(ciphertext) BETWEEN 1 AND 67108864);

CREATE OR REPLACE FUNCTION guard_synthetic_privacy_execution() RETURNS trigger LANGUAGE plpgsql AS $$
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
    IF NEW.scope->>'syntheticOnly'='true' AND
      EXISTS (SELECT 1 FROM wechat_identity WHERE member_id=NEW.member_id AND provider='dev_test') THEN
      RETURN NEW;
    END IF;
    IF TG_TABLE_NAME='data_export_job' AND NEW.scope->>'formalSelfService'='true'
      AND NEW.scope->>'dataClass'='member_portable_copy_v1'
      AND NEW.requested_by='member:'||NEW.member_id::text
      AND NEW.approved_by='system:verified-self'
      AND EXISTS (SELECT 1 FROM wechat_identity WHERE member_id=NEW.member_id AND provider='wechat_miniprogram')
      AND EXISTS (SELECT 1 FROM privacy_request WHERE id=NEW.privacy_request_id
        AND member_id=NEW.member_id AND kind='access') THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'PRIVACY_EXECUTION_SCOPE_OR_IDENTITY_INVALID' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;

-- migrate:down
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM data_export_job WHERE scope->>'formalSelfService'='true') THEN
    RAISE EXCEPTION 'FORMAL_PRIVACY_EXPORT_ROLLBACK_REQUIRES_DATA_PRESERVATION';
  END IF;
END $$;
CREATE OR REPLACE FUNCTION guard_synthetic_privacy_execution() RETURNS trigger LANGUAGE plpgsql AS $$
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
  IF executable AND (NEW.scope->>'syntheticOnly' IS DISTINCT FROM 'true'
    OR NOT EXISTS (SELECT 1 FROM wechat_identity WHERE member_id=NEW.member_id AND provider='dev_test')) THEN
    RAISE EXCEPTION 'SYNTHETIC_PRIVACY_EXECUTION_ONLY' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
ALTER TABLE privacy_export_artifact DROP CONSTRAINT privacy_export_artifact_ciphertext_check;
ALTER TABLE privacy_export_artifact ADD CONSTRAINT privacy_export_artifact_ciphertext_check
  CHECK (octet_length(ciphertext) BETWEEN 1 AND 1048576);
