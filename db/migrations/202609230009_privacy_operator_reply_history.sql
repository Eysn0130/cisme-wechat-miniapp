-- Preserve each operator response as a distinct private request fact.
CREATE TABLE privacy_request_operator_reply (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  privacy_request_id uuid NOT NULL REFERENCES privacy_request(id),
  actor_principal_id text NOT NULL,
  body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 4000),
  waiting_on text NOT NULL CHECK (waiting_on IN ('operator','member')),
  request_version integer NOT NULL CHECK (request_version > 0),
  historical_snapshot boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX privacy_operator_reply_timeline ON privacy_request_operator_reply(privacy_request_id,created_at,id);
CREATE TRIGGER privacy_operator_reply_immutable BEFORE UPDATE OR DELETE ON privacy_request_operator_reply
  FOR EACH ROW EXECUTE FUNCTION reject_privacy_event_mutation();
INSERT INTO privacy_request_operator_reply
  (privacy_request_id,actor_principal_id,body,waiting_on,request_version,historical_snapshot,created_at)
SELECT id,COALESCE(responded_by,'legacy:unattributed'),response,waiting_on,version,true,updated_at
FROM privacy_request WHERE response IS NOT NULL AND btrim(response)<>'';

-- migrate:down
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM privacy_request_operator_reply WHERE historical_snapshot=false)
    THEN RAISE EXCEPTION 'PRIVACY_OPERATOR_REPLY_ROLLBACK_REQUIRES_DATA_PRESERVATION';
  END IF;
END $$;
DROP TRIGGER privacy_operator_reply_immutable ON privacy_request_operator_reply;
DROP TABLE privacy_request_operator_reply;
