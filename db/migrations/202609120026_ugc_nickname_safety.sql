-- A profile name pending public review has its own version-bound provider
-- result; manual approval cannot stand in for content-safety detection.
CREATE TABLE ugc_nickname_safety_scan (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id uuid NOT NULL REFERENCES member(id) ON DELETE RESTRICT,
  profile_revision integer NOT NULL CHECK (profile_revision>0),
  name_sha256 text NOT NULL CHECK (name_sha256 ~ '^[0-9a-f]{64}$'),
  provider text NOT NULL DEFAULT 'wechat_v2' CHECK (provider='wechat_v2'),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','safe','review','risky','quarantined','obsolete')),
  result jsonb,
  lease_token uuid NOT NULL DEFAULT gen_random_uuid(),
  lease_until timestamptz NOT NULL DEFAULT clock_timestamp()+interval '30 seconds',
  next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  attempt_count integer NOT NULL DEFAULT 1 CHECK (attempt_count BETWEEN 1 AND 7),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  resolved_at timestamptz,
  UNIQUE(member_id,profile_revision),
  CHECK ((state IN ('safe','review','risky','quarantined','obsolete')) = (resolved_at IS NOT NULL))
);
CREATE INDEX ugc_nickname_safety_due ON ugc_nickname_safety_scan(next_attempt_at,lease_until)
  WHERE state='pending';
CREATE FUNCTION guard_ugc_nickname_safety() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' OR
    (NEW.id,NEW.member_id,NEW.profile_revision,NEW.name_sha256,NEW.provider,NEW.created_at)
      IS DISTINCT FROM (OLD.id,OLD.member_id,OLD.profile_revision,OLD.name_sha256,OLD.provider,OLD.created_at)
    OR OLD.state<>'pending' AND NEW IS DISTINCT FROM OLD
  THEN RAISE EXCEPTION 'UGC_NICKNAME_SAFETY_IMMUTABLE' USING ERRCODE='55000'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER ugc_nickname_safety_guard BEFORE UPDATE OR DELETE ON ugc_nickname_safety_scan
FOR EACH ROW EXECUTE FUNCTION guard_ugc_nickname_safety();

-- migrate:down
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM ugc_nickname_safety_scan)
  THEN RAISE EXCEPTION 'UGC_NICKNAME_SAFETY_ROLLBACK_REQUIRES_DATA_PRESERVATION'; END IF;
END $$;
DROP TRIGGER ugc_nickname_safety_guard ON ugc_nickname_safety_scan;
DROP FUNCTION guard_ugc_nickname_safety();
DROP TABLE ugc_nickname_safety_scan;
