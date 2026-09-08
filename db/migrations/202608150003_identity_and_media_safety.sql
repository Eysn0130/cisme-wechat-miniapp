BEGIN;

ALTER TABLE wechat_identity ADD COLUMN app_id text;
UPDATE wechat_identity
SET app_id = CASE WHEN adapter = 'dev' THEN 'dev' ELSE 'legacy-wechat-app' END;
ALTER TABLE wechat_identity ALTER COLUMN app_id SET NOT NULL;
ALTER TABLE wechat_identity DROP CONSTRAINT wechat_identity_member_id_key;
ALTER TABLE wechat_identity DROP CONSTRAINT wechat_identity_openid_key;
ALTER TABLE wechat_identity ADD CONSTRAINT wechat_identity_app_openid_unique UNIQUE (app_id, openid);
CREATE INDEX wechat_identity_member_id_idx ON wechat_identity(member_id);

ALTER TABLE media_object ADD COLUMN is_current boolean NOT NULL DEFAULT true;
ALTER TABLE media_object DROP CONSTRAINT media_object_submission_id_kind_key;
CREATE UNIQUE INDEX media_object_current_kind_unique
  ON media_object(submission_id, kind)
  WHERE is_current;

CREATE TABLE media_cleanup_queue (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  media_id uuid NOT NULL REFERENCES media_object(id),
  object_key text NOT NULL,
  reason text NOT NULL CHECK (reason IN ('replaced','member_deleted','failed_verification')),
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  UNIQUE (media_id, reason)
);

COMMIT;
