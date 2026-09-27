-- A fixed, explicit self-service scope may remove optional live account data.
-- Free-text deletion requests remain non-executable until their scope is set.
ALTER TABLE privacy_request DROP CONSTRAINT privacy_request_synthetic_scope;
ALTER TABLE privacy_request ADD CONSTRAINT privacy_request_supported_scope CHECK (
  scope_code IS NULL OR (kind='delete' AND scope_code IN
    ('member_profile_handle_v1','member_optional_profile_v1'))
);
CREATE OR REPLACE FUNCTION guard_privacy_request_synthetic_scope() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' AND NEW.scope_code IS DISTINCT FROM OLD.scope_code THEN
    RAISE EXCEPTION 'PRIVACY_REQUEST_SCOPE_IMMUTABLE' USING ERRCODE='55000';
  END IF;
  IF NEW.scope_code='member_profile_handle_v1' AND NOT EXISTS (
    SELECT 1 FROM wechat_identity WHERE member_id=NEW.member_id AND provider='dev_test'
  ) THEN RAISE EXCEPTION 'PRIVACY_REQUEST_SYNTHETIC_SCOPE_ONLY' USING ERRCODE='23514'; END IF;
  IF NEW.scope_code='member_optional_profile_v1' AND NOT EXISTS (
    SELECT 1 FROM wechat_identity WHERE member_id=NEW.member_id AND provider='wechat_miniprogram'
  ) THEN RAISE EXCEPTION 'PRIVACY_REQUEST_FORMAL_IDENTITY_REQUIRED' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;

-- migrate:down
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM privacy_request WHERE scope_code='member_optional_profile_v1') THEN
    RAISE EXCEPTION 'FORMAL_PROFILE_ERASURE_ROLLBACK_REQUIRES_DATA_PRESERVATION';
  END IF;
END $$;
CREATE OR REPLACE FUNCTION guard_privacy_request_synthetic_scope() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' AND NEW.scope_code IS DISTINCT FROM OLD.scope_code THEN
    RAISE EXCEPTION 'PRIVACY_REQUEST_SCOPE_IMMUTABLE' USING ERRCODE='55000';
  END IF;
  IF NEW.scope_code IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM wechat_identity WHERE member_id=NEW.member_id AND provider='dev_test'
  ) THEN RAISE EXCEPTION 'PRIVACY_REQUEST_SYNTHETIC_SCOPE_ONLY' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
ALTER TABLE privacy_request DROP CONSTRAINT privacy_request_supported_scope;
ALTER TABLE privacy_request ADD CONSTRAINT privacy_request_synthetic_scope CHECK (
  scope_code IS NULL OR (kind='delete' AND scope_code='member_profile_handle_v1')
);
