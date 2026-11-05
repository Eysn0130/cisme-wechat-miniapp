-- Shared published-story detail supports comment likes for normal posts too.
CREATE TABLE ugc_comment_like (
  comment_id uuid NOT NULL REFERENCES ugc_comment(id) ON DELETE RESTRICT,
  member_id uuid NOT NULL REFERENCES member(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(comment_id,member_id)
);
CREATE INDEX ugc_comment_like_member ON ugc_comment_like(member_id,comment_id);

-- migrate:down
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM ugc_comment_like) THEN
    RAISE EXCEPTION 'UGC_COMMENT_LIKES_PRESENT';
  END IF;
END $$;
DROP TABLE ugc_comment_like;
