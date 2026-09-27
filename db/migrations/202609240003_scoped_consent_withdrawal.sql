-- Bind a self-verified privacy withdrawal to one owned submission consent.
-- Older free-text requests remain reviewable without inventing a target.
ALTER TABLE privacy_request ADD COLUMN target_ref uuid REFERENCES consent_grant(id) ON DELETE RESTRICT;
ALTER TABLE privacy_request ADD CONSTRAINT privacy_request_target_ref_scope CHECK (
  target_ref IS NULL OR kind='withdraw'
);
CREATE UNIQUE INDEX privacy_request_one_consent_withdrawal
  ON privacy_request(member_id,target_ref) WHERE target_ref IS NOT NULL;

CREATE FUNCTION guard_privacy_request_target_ref() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' AND NEW.target_ref IS DISTINCT FROM OLD.target_ref THEN
    RAISE EXCEPTION 'PRIVACY_REQUEST_TARGET_IMMUTABLE' USING ERRCODE='55000';
  END IF;
  IF NEW.target_ref IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM consent_grant WHERE id=NEW.target_ref AND member_id=NEW.member_id
  ) THEN RAISE EXCEPTION 'PRIVACY_REQUEST_TARGET_OWNER_MISMATCH' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER privacy_request_target_ref_guard BEFORE INSERT OR UPDATE OF target_ref,member_id
  ON privacy_request FOR EACH ROW EXECUTE FUNCTION guard_privacy_request_target_ref();

-- migrate:down
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM privacy_request WHERE target_ref IS NOT NULL) THEN
    RAISE EXCEPTION 'SCOPED_WITHDRAWAL_ROLLBACK_REQUIRES_DATA_PRESERVATION';
  END IF;
END $$;
DROP TRIGGER privacy_request_target_ref_guard ON privacy_request;
DROP FUNCTION guard_privacy_request_target_ref();
DROP INDEX privacy_request_one_consent_withdrawal;
ALTER TABLE privacy_request DROP CONSTRAINT privacy_request_target_ref_scope;
ALTER TABLE privacy_request DROP COLUMN target_ref;
