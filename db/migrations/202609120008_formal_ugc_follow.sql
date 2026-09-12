-- Formal author follows use immutable member IDs, never a display name or
-- the legacy preview community's text author_id.
CREATE TABLE ugc_author_follow (
  follower_member_id uuid NOT NULL REFERENCES member(id) ON DELETE RESTRICT,
  followed_member_id uuid NOT NULL REFERENCES member(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(follower_member_id,followed_member_id),
  CHECK (follower_member_id<>followed_member_id)
);
CREATE INDEX ugc_author_follow_author ON ugc_author_follow(followed_member_id,created_at);

-- migrate:down
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM ugc_author_follow)
  THEN RAISE EXCEPTION 'UGC_FOLLOW_ROLLBACK_REQUIRES_DATA_PRESERVATION'; END IF;
END $$;
DROP TABLE ugc_author_follow;
