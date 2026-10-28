-- Comments belong to an actual authorized editorial article, never a synthetic
-- UGC post. Ordinary member publishing and its existing gate are unchanged.
CREATE TABLE editorial_comment_policy (
  article_id uuid PRIMARY KEY REFERENCES editorial_article(id),
  enabled boolean NOT NULL DEFAULT true,
  version integer NOT NULL DEFAULT 1 CHECK (version>0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE editorial_comment (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  article_id uuid NOT NULL REFERENCES editorial_article(id),
  author_member_id uuid NOT NULL REFERENCES member(id),
  parent_id uuid REFERENCES editorial_comment(id),
  reply_to_id uuid REFERENCES editorial_comment(id),
  body text,
  state text NOT NULL DEFAULT 'pending_review' CHECK (state IN ('pending_review','published','rejected','hidden','deleted')),
  operation_id text NOT NULL CHECK (length(operation_id) BETWEEN 8 AND 200),
  request_sha256 text NOT NULL CHECK (request_sha256 ~ '^[0-9a-f]{64}$'),
  version integer NOT NULL DEFAULT 1 CHECK (version>0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  UNIQUE(author_member_id,operation_id),
  CHECK ((state='deleted' AND body IS NULL AND deleted_at IS NOT NULL) OR
    (state<>'deleted' AND body IS NOT NULL AND char_length(body) BETWEEN 2 AND 180)),
  CHECK ((parent_id IS NULL)=(reply_to_id IS NULL))
);
CREATE INDEX editorial_comment_article_page ON editorial_comment(article_id,created_at,id);
CREATE INDEX editorial_comment_author ON editorial_comment(author_member_id,created_at,id);
CREATE FUNCTION enforce_editorial_comment_thread() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parent editorial_comment; target editorial_comment;
BEGIN
  IF NEW.parent_id IS NOT NULL THEN
    SELECT * INTO parent FROM editorial_comment WHERE id=NEW.parent_id;
    SELECT * INTO target FROM editorial_comment WHERE id=NEW.reply_to_id;
    IF parent.id IS NULL OR target.id IS NULL OR parent.article_id<>NEW.article_id OR target.article_id<>NEW.article_id
      OR parent.parent_id IS NOT NULL OR COALESCE(target.parent_id,target.id)<>parent.id
      OR NEW.id IN (NEW.parent_id,NEW.reply_to_id)
    THEN RAISE EXCEPTION 'EDITORIAL_COMMENT_THREAD_MISMATCH' USING ERRCODE='23514'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER editorial_comment_thread BEFORE INSERT OR UPDATE OF article_id,parent_id,reply_to_id ON editorial_comment
FOR EACH ROW EXECUTE FUNCTION enforce_editorial_comment_thread();

CREATE TABLE editorial_comment_like (
  member_id uuid NOT NULL REFERENCES member(id),
  comment_id uuid NOT NULL REFERENCES editorial_comment(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(member_id,comment_id)
);
CREATE INDEX editorial_comment_like_target ON editorial_comment_like(comment_id);
CREATE TABLE editorial_comment_report (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  comment_id uuid NOT NULL REFERENCES editorial_comment(id),
  reporter_member_id uuid NOT NULL REFERENCES member(id),
  category text NOT NULL CHECK (category IN ('spam','abuse','privacy','misinformation','rights','other')),
  description text CHECK (length(description)<=500),
  state text NOT NULL DEFAULT 'open' CHECK (state IN ('open','resolved')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(comment_id,reporter_member_id)
);
CREATE TABLE editorial_comment_safety_scan (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  comment_id uuid NOT NULL REFERENCES editorial_comment(id),
  body_sha256 text NOT NULL CHECK (body_sha256 ~ '^[0-9a-f]{64}$'),
  provider text NOT NULL CHECK (provider='wechat_v2'),
  state text NOT NULL CHECK (state IN ('safe','review','risky','error')),
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX editorial_comment_safety_current ON editorial_comment_safety_scan(comment_id,created_at DESC,id DESC);
CREATE TRIGGER editorial_comment_safety_immutable BEFORE UPDATE OR DELETE ON editorial_comment_safety_scan
FOR EACH ROW EXECUTE FUNCTION ugc_editor_evidence_immutable();
CREATE TABLE editorial_comment_scan_claim (
  comment_id uuid PRIMARY KEY REFERENCES editorial_comment(id),
  body_sha256 text NOT NULL CHECK (body_sha256 ~ '^[0-9a-f]{64}$'),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','completed','quarantined','obsolete')),
  lease_token uuid NOT NULL DEFAULT gen_random_uuid(),
  lease_until timestamptz NOT NULL DEFAULT clock_timestamp()+interval '30 seconds',
  next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  attempt_count integer NOT NULL DEFAULT 1 CHECK (attempt_count BETWEEN 1 AND 7),
  last_error text,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX editorial_comment_scan_due ON editorial_comment_scan_claim(next_attempt_at,lease_until) WHERE state='pending';

-- migrate:down
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM editorial_comment) THEN
    RAISE EXCEPTION 'EDITORIAL_COMMENT_ROLLBACK_REQUIRES_DATA_PRESERVATION';
  END IF;
END $$;
DROP TABLE editorial_comment_scan_claim;
DROP TRIGGER editorial_comment_safety_immutable ON editorial_comment_safety_scan;
DROP TABLE editorial_comment_safety_scan,editorial_comment_report,editorial_comment_like;
DROP TRIGGER editorial_comment_thread ON editorial_comment;
DROP FUNCTION enforce_editorial_comment_thread();
DROP TABLE editorial_comment,editorial_comment_policy;
