-- Enterprise AppID reconciliation follow-up. External identity authority is the
-- provider + AppID + OpenID tuple. UnionID remains optional metadata and never
-- drives an automatic account merge.

ALTER TABLE wechat_identity ADD COLUMN provider text;
UPDATE wechat_identity SET provider=CASE adapter WHEN 'wechat' THEN 'wechat_miniprogram' ELSE 'dev_test' END;
ALTER TABLE wechat_identity ALTER COLUMN provider SET NOT NULL;
ALTER TABLE wechat_identity ADD CONSTRAINT wechat_identity_provider_check
  CHECK (provider IN ('wechat_miniprogram','dev_test'));
ALTER TABLE wechat_identity ADD CONSTRAINT wechat_identity_provider_adapter_check
  CHECK ((provider='wechat_miniprogram' AND adapter='wechat') OR (provider='dev_test' AND adapter='dev'));
ALTER TABLE wechat_identity DROP CONSTRAINT wechat_identity_app_openid_unique;
ALTER TABLE wechat_identity ADD CONSTRAINT wechat_identity_provider_app_openid_unique
  UNIQUE(provider,app_id,openid);
CREATE INDEX wechat_identity_provider_member_idx ON wechat_identity(provider,app_id,member_id);

ALTER TABLE authority_grant ADD COLUMN environment text NOT NULL DEFAULT 'legacy_unspecified';
ALTER TABLE authority_grant ADD COLUMN grant_source text NOT NULL DEFAULT 'legacy_migration';
ALTER TABLE authority_grant ADD COLUMN expires_at timestamptz;
ALTER TABLE authority_grant ADD CONSTRAINT authority_grant_environment_check
  CHECK (environment IN ('development','test','staging','production','legacy_unspecified'));
ALTER TABLE authority_grant ADD CONSTRAINT authority_grant_source_check
  CHECK (length(btrim(grant_source)) BETWEEN 3 AND 200);
ALTER TABLE authority_grant ADD CONSTRAINT authority_grant_expiry_check
  CHECK (expires_at IS NULL OR expires_at > granted_at);
CREATE INDEX authority_grant_environment_active_idx
  ON authority_grant(environment,member_id,capability,expires_at)
  WHERE revoked_at IS NULL;
DROP INDEX authority_grant_one_active_capability;
CREATE UNIQUE INDEX authority_grant_one_active_capability
  ON authority_grant(member_id,capability,environment) WHERE revoked_at IS NULL;

CREATE OR REPLACE FUNCTION protect_authority_grant_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'AUTHORITY_GRANT_EVIDENCE_IMMUTABLE';
  END IF;
  IF NEW.member_id <> OLD.member_id OR NEW.capability <> OLD.capability OR
     NEW.granted_by <> OLD.granted_by OR NEW.grant_reason <> OLD.grant_reason OR
     NEW.granted_at <> OLD.granted_at OR NEW.environment <> OLD.environment OR
     NEW.grant_source <> OLD.grant_source OR NEW.expires_at IS DISTINCT FROM OLD.expires_at THEN
    RAISE EXCEPTION 'AUTHORITY_GRANT_EVIDENCE_IMMUTABLE';
  END IF;
  IF OLD.revoked_at IS NOT NULL AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'AUTHORITY_GRANT_REVOCATION_IMMUTABLE';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION audit_authority_grant_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    INSERT INTO audit_log(principal_id,action,object_type,object_id,reason_code,before_state,after_state,trace_id)
    VALUES(NEW.granted_by,'authority.grant','authority_grant',NEW.id,NEW.grant_reason,NULL,
      jsonb_build_object('memberId',NEW.member_id,'capability',NEW.capability,'environment',NEW.environment,
        'grantSource',NEW.grant_source,'expiresAt',NEW.expires_at),'authority-grant:'||NEW.id::text);
  ELSIF OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL THEN
    INSERT INTO audit_log(principal_id,action,object_type,object_id,reason_code,before_state,after_state,trace_id)
    VALUES(NEW.revoked_by,'authority.revoke','authority_grant',NEW.id,NEW.revoke_reason,
      jsonb_build_object('memberId',OLD.member_id,'capability',OLD.capability,'environment',OLD.environment,'active',true),
      jsonb_build_object('memberId',NEW.member_id,'capability',NEW.capability,'environment',NEW.environment,'active',false),
      'authority-revoke:'||NEW.id::text);
  END IF;
  RETURN NEW;
END $$;

-- migrate:down
DO $$ BEGIN
  IF EXISTS(
    SELECT 1 FROM wechat_identity GROUP BY app_id,openid HAVING count(*) > 1
  ) OR EXISTS(
    SELECT 1 FROM authority_grant
    WHERE environment <> 'legacy_unspecified' OR grant_source <> 'legacy_migration' OR expires_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'ENTERPRISE_IDENTITY_ROLLBACK_REQUIRES_DATA_PRESERVATION';
  END IF;
END $$;
DROP INDEX authority_grant_environment_active_idx;
DROP INDEX authority_grant_one_active_capability;
CREATE UNIQUE INDEX authority_grant_one_active_capability
  ON authority_grant(member_id,capability) WHERE revoked_at IS NULL;
ALTER TABLE authority_grant DROP CONSTRAINT authority_grant_expiry_check;
ALTER TABLE authority_grant DROP CONSTRAINT authority_grant_source_check;
ALTER TABLE authority_grant DROP CONSTRAINT authority_grant_environment_check;
ALTER TABLE authority_grant DROP COLUMN expires_at;
ALTER TABLE authority_grant DROP COLUMN grant_source;
ALTER TABLE authority_grant DROP COLUMN environment;
CREATE OR REPLACE FUNCTION protect_authority_grant_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'AUTHORITY_GRANT_EVIDENCE_IMMUTABLE';
  END IF;
  IF NEW.member_id <> OLD.member_id OR NEW.capability <> OLD.capability OR
     NEW.granted_by <> OLD.granted_by OR NEW.grant_reason <> OLD.grant_reason OR
     NEW.granted_at <> OLD.granted_at THEN
    RAISE EXCEPTION 'AUTHORITY_GRANT_EVIDENCE_IMMUTABLE';
  END IF;
  IF OLD.revoked_at IS NOT NULL AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'AUTHORITY_GRANT_REVOCATION_IMMUTABLE';
  END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION audit_authority_grant_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    INSERT INTO audit_log(principal_id,action,object_type,object_id,reason_code,before_state,after_state,trace_id)
    VALUES(NEW.granted_by,'authority.grant','authority_grant',NEW.id,NEW.grant_reason,NULL,
      jsonb_build_object('memberId',NEW.member_id,'capability',NEW.capability),'authority-grant:'||NEW.id::text);
  ELSIF OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL THEN
    INSERT INTO audit_log(principal_id,action,object_type,object_id,reason_code,before_state,after_state,trace_id)
    VALUES(NEW.revoked_by,'authority.revoke','authority_grant',NEW.id,NEW.revoke_reason,
      jsonb_build_object('memberId',OLD.member_id,'capability',OLD.capability,'active',true),
      jsonb_build_object('memberId',NEW.member_id,'capability',NEW.capability,'active',false),'authority-revoke:'||NEW.id::text);
  END IF;
  RETURN NEW;
END $$;
DROP INDEX wechat_identity_provider_member_idx;
ALTER TABLE wechat_identity DROP CONSTRAINT wechat_identity_provider_app_openid_unique;
ALTER TABLE wechat_identity ADD CONSTRAINT wechat_identity_app_openid_unique UNIQUE(app_id,openid);
ALTER TABLE wechat_identity DROP CONSTRAINT wechat_identity_provider_adapter_check;
ALTER TABLE wechat_identity DROP CONSTRAINT wechat_identity_provider_check;
ALTER TABLE wechat_identity DROP COLUMN provider;
