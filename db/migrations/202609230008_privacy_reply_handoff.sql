-- A reply is not a completion. Record whose action is next, and retain each
-- member supplement without rewriting the original request or audit event.
ALTER TABLE privacy_request ADD COLUMN waiting_on text NOT NULL DEFAULT 'operator'
  CHECK (waiting_on IN ('operator','member'))
  CHECK (waiting_on='operator' OR status='responded');

CREATE TABLE privacy_request_member_reply (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  privacy_request_id uuid NOT NULL REFERENCES privacy_request(id),
  member_id uuid NOT NULL REFERENCES member(id),
  body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 2000),
  idempotency_key text NOT NULL CHECK (char_length(idempotency_key) BETWEEN 8 AND 128),
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  request_version integer NOT NULL CHECK (request_version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (member_id,idempotency_key)
);
CREATE INDEX privacy_member_reply_timeline ON privacy_request_member_reply(privacy_request_id,created_at,id);
CREATE FUNCTION check_privacy_member_reply_owner() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM privacy_request WHERE id=NEW.privacy_request_id AND member_id=NEW.member_id) THEN
    RAISE EXCEPTION 'PRIVACY_REPLY_OWNER_MISMATCH';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER privacy_member_reply_owner BEFORE INSERT ON privacy_request_member_reply
  FOR EACH ROW EXECUTE FUNCTION check_privacy_member_reply_owner();
CREATE TRIGGER privacy_member_reply_immutable BEFORE UPDATE OR DELETE ON privacy_request_member_reply
  FOR EACH ROW EXECUTE FUNCTION reject_privacy_event_mutation();

-- migrate:down
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM privacy_request_member_reply)
    OR EXISTS(SELECT 1 FROM privacy_request WHERE waiting_on='member')
  THEN RAISE EXCEPTION 'PRIVACY_REPLY_HANDOFF_ROLLBACK_REQUIRES_DATA_PRESERVATION'; END IF;
END $$;
DROP TRIGGER privacy_member_reply_immutable ON privacy_request_member_reply;
DROP TRIGGER privacy_member_reply_owner ON privacy_request_member_reply;
DROP TABLE privacy_request_member_reply;
DROP FUNCTION check_privacy_member_reply_owner();
ALTER TABLE privacy_request DROP COLUMN waiting_on;
