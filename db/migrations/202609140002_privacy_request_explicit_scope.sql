-- A free-text deletion request cannot authorize an automatic data class.
-- Existing requests remain unscoped and non-executable.
ALTER TABLE privacy_request ADD COLUMN scope_code text;
ALTER TABLE privacy_request ADD CONSTRAINT privacy_request_synthetic_scope CHECK (
  scope_code IS NULL OR (kind='delete' AND scope_code='member_profile_handle_v1')
);

CREATE FUNCTION guard_privacy_request_synthetic_scope() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' THEN
    IF NEW.scope_code IS DISTINCT FROM OLD.scope_code THEN
      RAISE EXCEPTION 'PRIVACY_REQUEST_SCOPE_IMMUTABLE' USING ERRCODE='55000';
    END IF;
  END IF;
  IF NEW.scope_code IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM wechat_identity WHERE member_id=NEW.member_id AND provider='dev_test'
  ) THEN
    RAISE EXCEPTION 'PRIVACY_REQUEST_SYNTHETIC_SCOPE_ONLY' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER privacy_request_synthetic_scope_guard BEFORE INSERT OR UPDATE OF scope_code ON privacy_request
FOR EACH ROW EXECUTE FUNCTION guard_privacy_request_synthetic_scope();

-- migrate:down
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM privacy_request WHERE scope_code IS NOT NULL) THEN
    RAISE EXCEPTION 'PRIVACY_REQUEST_SCOPE_ROLLBACK_REQUIRES_DATA_PRESERVATION';
  END IF;
END $$;
DROP TRIGGER privacy_request_synthetic_scope_guard ON privacy_request;
DROP FUNCTION guard_privacy_request_synthetic_scope();
ALTER TABLE privacy_request DROP CONSTRAINT privacy_request_synthetic_scope;
ALTER TABLE privacy_request DROP COLUMN scope_code;
