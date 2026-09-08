-- Local development/test community interactions. Production remains closed in the service.
CREATE TABLE community_reaction (
  member_id uuid NOT NULL REFERENCES member(id),
  post_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('like','save')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (member_id, post_id, kind)
);
CREATE TABLE community_comment (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id text NOT NULL,
  member_id uuid NOT NULL REFERENCES member(id),
  parent_id uuid REFERENCES community_comment(id),
  reply_to_id uuid REFERENCES community_comment(id),
  body text NOT NULL CHECK (char_length(body) BETWEEN 2 AND 180),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','published','rejected','deleted')),
  was_public boolean NOT NULL DEFAULT false,
  operation_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (member_id, operation_id)
);
CREATE INDEX community_comment_post ON community_comment(post_id, created_at, id);
CREATE TABLE community_comment_like (
  member_id uuid NOT NULL REFERENCES member(id),
  comment_id uuid NOT NULL REFERENCES community_comment(id),
  PRIMARY KEY(member_id, comment_id)
);
-- migrate:down
-- Refuse data loss after any preview interaction has been recorded.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM community_comment) OR EXISTS (SELECT 1 FROM community_reaction) OR EXISTS (SELECT 1 FROM community_comment_like) THEN
    RAISE EXCEPTION 'COMMUNITY_ROLLBACK_REQUIRES_DATA_PRESERVATION';
  END IF;
END $$;
DROP TABLE community_comment_like;
DROP TABLE community_comment;
DROP TABLE community_reaction;
