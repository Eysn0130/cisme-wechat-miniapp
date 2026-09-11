CREATE TABLE community_follow (
  member_id uuid NOT NULL REFERENCES member(id),
  author_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(member_id, author_id)
);
CREATE TABLE member_team_access (
  member_id uuid PRIMARY KEY REFERENCES member(id),
  role text NOT NULL CHECK(role IN ('administrator','developer')),
  granted_by text NOT NULL,
  granted_at timestamptz NOT NULL DEFAULT now()
);
-- migrate:down
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM community_follow) OR EXISTS(SELECT 1 FROM member_team_access) THEN
    RAISE EXCEPTION 'COMMUNITY_TEAM_ROLLBACK_REQUIRES_DATA_PRESERVATION';
  END IF;
END $$;
DROP TABLE member_team_access;
DROP TABLE community_follow;
