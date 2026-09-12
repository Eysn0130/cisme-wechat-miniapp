-- Content takedown appeals are separate from personal-data rights requests.
CREATE TABLE ugc_post_appeal (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id uuid NOT NULL REFERENCES ugc_post(id) ON DELETE RESTRICT,
  author_member_id uuid NOT NULL REFERENCES member(id) ON DELETE RESTRICT,
  post_version integer NOT NULL CHECK (post_version > 0),
  published_revision integer NOT NULL CHECK (published_revision > 0),
  reason text NOT NULL CHECK (char_length(btrim(reason)) BETWEEN 4 AND 1000),
  state text NOT NULL DEFAULT 'received' CHECK (state IN ('received','resolved','rejected')),
  decision_code text CHECK (decision_code IN ('restore','uphold')),
  decision_reason text CHECK (decision_reason IS NULL OR char_length(btrim(decision_reason)) BETWEEN 4 AND 500),
  decided_by_member_id uuid REFERENCES member(id) ON DELETE RESTRICT,
  decided_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(post_id,post_version),
  CHECK (decided_by_member_id IS NULL OR decided_by_member_id<>author_member_id),
  CONSTRAINT ugc_appeal_decision_complete CHECK (
    (state='received' AND decision_code IS NULL AND decision_reason IS NULL AND decided_by_member_id IS NULL AND decided_at IS NULL)
    OR (state='resolved' AND decision_code='restore' AND decision_reason IS NOT NULL AND decided_by_member_id IS NOT NULL AND decided_at IS NOT NULL)
    OR (state='rejected' AND decision_code='uphold' AND decision_reason IS NOT NULL AND decided_by_member_id IS NOT NULL AND decided_at IS NOT NULL)
  )
);
CREATE INDEX ugc_post_appeal_queue ON ugc_post_appeal(created_at,id) WHERE state='received';
CREATE INDEX ugc_post_appeal_owner ON ugc_post_appeal(author_member_id,created_at DESC,id DESC);

CREATE FUNCTION guard_ugc_appeal_terminal() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.state IN ('resolved','rejected') AND NEW IS DISTINCT FROM OLD
  THEN RAISE EXCEPTION 'UGC_APPEAL_DECISION_IMMUTABLE' USING ERRCODE='55000'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER ugc_post_appeal_terminal_guard BEFORE UPDATE ON ugc_post_appeal
FOR EACH ROW EXECUTE FUNCTION guard_ugc_appeal_terminal();

-- migrate:down
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM ugc_post_appeal)
  THEN RAISE EXCEPTION 'UGC_CONTENT_APPEAL_ROLLBACK_REQUIRES_DATA_PRESERVATION'; END IF;
END $$;
DROP TRIGGER ugc_post_appeal_terminal_guard ON ugc_post_appeal;
DROP FUNCTION guard_ugc_appeal_terminal();
DROP TABLE ugc_post_appeal;
