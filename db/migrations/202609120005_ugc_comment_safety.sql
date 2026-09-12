-- Comment text needs its own immutable scan fact before human publication.
CREATE TABLE ugc_comment_safety_scan (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  comment_id uuid NOT NULL REFERENCES ugc_comment(id) ON DELETE RESTRICT,
  body_sha256 text NOT NULL CHECK (body_sha256 ~ '^[0-9a-f]{64}$'),
  provider text NOT NULL CHECK (provider IN ('wechat_v2','test_fixture')),
  state text NOT NULL CHECK (state IN ('safe','review','risky','error')),
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ugc_comment_safety_current ON ugc_comment_safety_scan(comment_id,created_at DESC);
CREATE TRIGGER ugc_comment_safety_immutable BEFORE UPDATE OR DELETE ON ugc_comment_safety_scan
FOR EACH ROW EXECUTE FUNCTION ugc_editor_evidence_immutable();

-- migrate:down
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM ugc_comment_safety_scan)
  THEN RAISE EXCEPTION 'UGC_COMMENT_SAFETY_ROLLBACK_REQUIRES_DATA_PRESERVATION'; END IF;
END $$;
DROP TRIGGER ugc_comment_safety_immutable ON ugc_comment_safety_scan;
DROP TABLE ugc_comment_safety_scan;
