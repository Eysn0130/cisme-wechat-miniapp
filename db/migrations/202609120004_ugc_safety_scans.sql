-- Safety facts are separate from immutable post revisions. This migration does
-- not enable public UGC; scanner results remain subject to human review.
CREATE TABLE ugc_safety_scan (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id uuid NOT NULL REFERENCES ugc_post(id) ON DELETE RESTRICT,
  revision integer NOT NULL,
  media_asset_id uuid REFERENCES ugc_media_asset(id) ON DELETE RESTRICT,
  kind text NOT NULL CHECK (kind IN ('text','image')),
  content_sha256 text NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
  provider text NOT NULL CHECK (provider IN ('wechat_v2','test_fixture')),
  trace_id text UNIQUE,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','safe','review','risky','error')),
  result jsonb,
  requested_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  FOREIGN KEY(post_id,revision) REFERENCES ugc_post_revision(post_id,revision),
  CHECK ((kind='text' AND media_asset_id IS NULL) OR (kind='image' AND media_asset_id IS NOT NULL)),
  CHECK ((state='pending' AND resolved_at IS NULL) OR (state<>'pending' AND resolved_at IS NOT NULL))
);
CREATE INDEX ugc_safety_scan_current ON ugc_safety_scan(post_id,revision,kind,requested_at DESC);
CREATE INDEX ugc_safety_scan_media ON ugc_safety_scan(media_asset_id,requested_at DESC) WHERE media_asset_id IS NOT NULL;

CREATE TABLE ugc_safety_callback_inbox (
  trace_id text PRIMARY KEY,
  app_id text NOT NULL,
  payload jsonb NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  applied_at timestamptz
);

CREATE FUNCTION ugc_safety_evidence_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'UGC_SAFETY_EVIDENCE_IMMUTABLE' USING ERRCODE='55000'; END IF;
  IF (NEW.post_id,NEW.revision,NEW.media_asset_id,NEW.kind,NEW.content_sha256,NEW.provider,NEW.requested_at)
    IS DISTINCT FROM (OLD.post_id,OLD.revision,OLD.media_asset_id,OLD.kind,OLD.content_sha256,OLD.provider,OLD.requested_at)
  THEN RAISE EXCEPTION 'UGC_SAFETY_IDENTITY_IMMUTABLE' USING ERRCODE='55000'; END IF;
  IF OLD.state<>'pending' AND NEW IS DISTINCT FROM OLD
  THEN RAISE EXCEPTION 'UGC_SAFETY_RESULT_IMMUTABLE' USING ERRCODE='55000'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER ugc_safety_scan_guard BEFORE UPDATE OR DELETE ON ugc_safety_scan
FOR EACH ROW EXECUTE FUNCTION ugc_safety_evidence_guard();

-- migrate:down
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM ugc_safety_scan) OR EXISTS(SELECT 1 FROM ugc_safety_callback_inbox)
  THEN RAISE EXCEPTION 'UGC_SAFETY_ROLLBACK_REQUIRES_DATA_PRESERVATION'; END IF;
END $$;
DROP TRIGGER ugc_safety_scan_guard ON ugc_safety_scan;
DROP FUNCTION ugc_safety_evidence_guard();
DROP TABLE ugc_safety_callback_inbox,ugc_safety_scan;
