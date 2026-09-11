-- A human-readable WeChat handle is contact data, never a login identifier.
CREATE TABLE member_profile (
 member_id uuid PRIMARY KEY REFERENCES member(id),
 wechat_handle text CHECK (wechat_handle IS NULL OR wechat_handle ~ '^[A-Za-z][A-Za-z0-9_-]{5,19}$'),
 handle_source text NOT NULL CHECK(handle_source IN ('self_reported','operator_confirmed')),
 updated_at timestamptz NOT NULL DEFAULT now()
);
-- migrate:down
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM member_profile) THEN RAISE EXCEPTION 'PROFILE_ROLLBACK_REQUIRES_DATA_PRESERVATION'; END IF;
END $$;
DROP TABLE member_profile;
