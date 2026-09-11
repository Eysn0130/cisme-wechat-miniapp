-- Formal UGC is intentionally isolated from the existing development/test-only
-- community_* preview tables, whose post_id values are fixed brand slugs.
-- This migration creates no routes and leaves the formal community switch off.

ALTER TABLE emergency_switch DROP CONSTRAINT emergency_switch_key_check;
ALTER TABLE emergency_switch ADD CONSTRAINT emergency_switch_key_check
  CHECK (key IN ('identity','uploads','reviews','rewards','submissions','redemption','commerce','community'));
INSERT INTO emergency_switch(key,enabled,reason,updated_by)
VALUES('community',false,'formal UGC is not implemented or approved','migration')
ON CONFLICT(key) DO NOTHING;
ALTER TABLE emergency_switch ADD CONSTRAINT emergency_switch_formal_ugc_closed
  CHECK (key<>'community' OR enabled=false);

CREATE TABLE ugc_post (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  author_member_id uuid NOT NULL REFERENCES member(id),
  state text NOT NULL DEFAULT 'draft' CHECK (state IN ('draft','pending_review','published','rejected','deleted')),
  visibility text NOT NULL DEFAULT 'private' CHECK (visibility IN ('private','public')),
  current_revision integer NOT NULL DEFAULT 1 CHECK (current_revision > 0),
  client_request_key text NOT NULL CHECK (length(client_request_key) BETWEEN 8 AND 200),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  published_at timestamptz,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(author_member_id,client_request_key),
  CHECK ((state='published' AND published_at IS NOT NULL AND visibility='public') OR state<>'published'),
  CHECK ((state='deleted' AND deleted_at IS NOT NULL AND visibility='private') OR state<>'deleted')
);
CREATE INDEX ugc_post_public_page ON ugc_post(published_at DESC,id DESC) WHERE state='published' AND visibility='public';
CREATE INDEX ugc_post_author_page ON ugc_post(author_member_id,updated_at DESC,id DESC);

CREATE TABLE ugc_post_revision (
  post_id uuid NOT NULL REFERENCES ugc_post(id),
  revision integer NOT NULL CHECK (revision > 0),
  created_by_member_id uuid NOT NULL REFERENCES member(id),
  title text CHECK (title IS NULL OR char_length(title) BETWEEN 1 AND 120),
  body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 5000),
  content_warning text CHECK (content_warning IS NULL OR char_length(content_warning) BETWEEN 1 AND 200),
  moderation_state text NOT NULL DEFAULT 'unreviewed' CHECK (moderation_state IN ('unreviewed','pending','approved','rejected')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(post_id,revision)
);
ALTER TABLE ugc_post ADD CONSTRAINT ugc_post_current_revision_fk
  FOREIGN KEY(id,current_revision) REFERENCES ugc_post_revision(post_id,revision)
  DEFERRABLE INITIALLY DEFERRED;

CREATE FUNCTION enforce_ugc_revision_owner() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE post_owner uuid;
BEGIN
  SELECT author_member_id INTO post_owner FROM ugc_post WHERE id=NEW.post_id FOR SHARE;
  IF post_owner IS NULL OR post_owner<>NEW.created_by_member_id THEN
    RAISE EXCEPTION 'UGC_POST_REVISION_OWNER_MISMATCH' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER ugc_post_revision_owner BEFORE INSERT OR UPDATE OF post_id,created_by_member_id ON ugc_post_revision
FOR EACH ROW EXECUTE FUNCTION enforce_ugc_revision_owner();

CREATE FUNCTION guard_ugc_revision_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'UGC_POST_REVISION_IMMUTABLE' USING ERRCODE='55000';
  END IF;
  IF (NEW.post_id,NEW.revision,NEW.created_by_member_id,NEW.title,NEW.body,NEW.content_warning,NEW.created_at)
    IS DISTINCT FROM
    (OLD.post_id,OLD.revision,OLD.created_by_member_id,OLD.title,OLD.body,OLD.content_warning,OLD.created_at)
  THEN RAISE EXCEPTION 'UGC_POST_REVISION_CONTENT_IMMUTABLE' USING ERRCODE='55000'; END IF;
  IF NOT (
    NEW.moderation_state=OLD.moderation_state
    OR (OLD.moderation_state='unreviewed' AND NEW.moderation_state='pending')
    OR (OLD.moderation_state='pending' AND NEW.moderation_state IN ('approved','rejected'))
  ) THEN RAISE EXCEPTION 'UGC_POST_REVISION_MODERATION_TRANSITION_INVALID' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER ugc_post_revision_mutation BEFORE UPDATE OR DELETE ON ugc_post_revision
FOR EACH ROW EXECUTE FUNCTION guard_ugc_revision_mutation();

CREATE FUNCTION guard_ugc_post_update() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE revision_state text; author_state text; unsafe_media integer;
BEGIN
  IF TG_OP='UPDATE' AND (NEW.author_member_id,NEW.client_request_key)
    IS DISTINCT FROM (OLD.author_member_id,OLD.client_request_key)
  THEN RAISE EXCEPTION 'UGC_POST_IDENTITY_IMMUTABLE' USING ERRCODE='55000'; END IF;
  IF NEW.state='published' THEN
    SELECT moderation_state INTO revision_state FROM ugc_post_revision
      WHERE post_id=NEW.id AND revision=NEW.current_revision;
    SELECT status INTO author_state FROM member WHERE id=NEW.author_member_id;
    SELECT count(*) INTO unsafe_media FROM ugc_post_media binding
      JOIN ugc_media_asset asset ON asset.id=binding.media_asset_id
      WHERE binding.post_id=NEW.id AND binding.revision=NEW.current_revision AND asset.state<>'approved';
    IF revision_state IS DISTINCT FROM 'approved' THEN
      RAISE EXCEPTION 'UGC_POST_REVISION_NOT_APPROVED' USING ERRCODE='23514';
    END IF;
    IF author_state IS DISTINCT FROM 'active' THEN
      RAISE EXCEPTION 'UGC_POST_AUTHOR_NOT_ACTIVE' USING ERRCODE='23514';
    END IF;
    IF unsafe_media<>0 THEN
      RAISE EXCEPTION 'UGC_POST_MEDIA_NOT_APPROVED' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER ugc_post_update_guard BEFORE INSERT OR UPDATE OF author_member_id,client_request_key,state,current_revision ON ugc_post
FOR EACH ROW EXECUTE FUNCTION guard_ugc_post_update();

CREATE TABLE ugc_media_asset (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_member_id uuid NOT NULL REFERENCES member(id),
  kind text NOT NULL CHECK (kind IN ('image','video')),
  object_key text NOT NULL UNIQUE,
  mime_type text NOT NULL CHECK (mime_type IN ('image/jpeg','image/png','image/webp','video/mp4')),
  size_bytes bigint CHECK (size_bytes IS NULL OR size_bytes BETWEEN 1 AND 104857600),
  sha256 text CHECK (sha256 IS NULL OR sha256 ~ '^[0-9a-f]{64}$'),
  width_px integer CHECK (width_px IS NULL OR width_px > 0),
  height_px integer CHECK (height_px IS NULL OR height_px > 0),
  duration_ms integer CHECK (duration_ms IS NULL OR duration_ms BETWEEN 1 AND 600000),
  state text NOT NULL DEFAULT 'authorized' CHECK (state IN ('authorized','uploaded','scanning','approved','rejected','deleting','deleted')),
  scan_result jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(scan_result)='object'),
  authorization_expires_at timestamptz NOT NULL,
  uploaded_at timestamptz,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((state IN ('uploaded','scanning','approved','rejected','deleting') AND uploaded_at IS NOT NULL) OR state IN ('authorized','deleted')),
  CHECK ((state='deleted' AND deleted_at IS NOT NULL) OR state<>'deleted')
);
CREATE INDEX ugc_media_asset_owner_state ON ugc_media_asset(owner_member_id,state,created_at DESC);
CREATE INDEX ugc_media_asset_expiry ON ugc_media_asset(authorization_expires_at) WHERE state='authorized';

CREATE TABLE ugc_post_media (
  post_id uuid NOT NULL,
  revision integer NOT NULL,
  media_asset_id uuid NOT NULL UNIQUE REFERENCES ugc_media_asset(id),
  position smallint NOT NULL CHECK (position BETWEEN 0 AND 8),
  alt_text text CHECK (alt_text IS NULL OR char_length(alt_text) BETWEEN 1 AND 300),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(post_id,revision,position),
  FOREIGN KEY(post_id,revision) REFERENCES ugc_post_revision(post_id,revision)
);

CREATE FUNCTION enforce_ugc_media_owner() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE post_owner uuid; media_owner uuid;
BEGIN
  SELECT author_member_id INTO post_owner FROM ugc_post WHERE id=NEW.post_id FOR SHARE;
  SELECT owner_member_id INTO media_owner FROM ugc_media_asset WHERE id=NEW.media_asset_id FOR SHARE;
  IF post_owner IS NULL OR media_owner IS NULL OR post_owner<>media_owner THEN
    RAISE EXCEPTION 'UGC_POST_MEDIA_OWNER_MISMATCH' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER ugc_post_media_owner BEFORE INSERT OR UPDATE OF post_id,media_asset_id ON ugc_post_media
FOR EACH ROW EXECUTE FUNCTION enforce_ugc_media_owner();

CREATE TABLE ugc_comment (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id uuid NOT NULL REFERENCES ugc_post(id),
  author_member_id uuid NOT NULL REFERENCES member(id),
  parent_id uuid REFERENCES ugc_comment(id),
  reply_to_id uuid REFERENCES ugc_comment(id),
  body text,
  state text NOT NULL DEFAULT 'pending_review' CHECK (state IN ('pending_review','published','rejected','deleted')),
  was_public boolean NOT NULL DEFAULT false,
  operation_id text NOT NULL CHECK (length(operation_id) BETWEEN 8 AND 200),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  UNIQUE(author_member_id,operation_id),
  CHECK ((state='deleted' AND body IS NULL AND deleted_at IS NOT NULL) OR (state<>'deleted' AND body IS NOT NULL AND char_length(body) BETWEEN 1 AND 1000)),
  CHECK (NOT was_public OR state IN ('published','deleted'))
);
CREATE INDEX ugc_comment_post_page ON ugc_comment(post_id,created_at,id);

CREATE FUNCTION enforce_ugc_comment_thread() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parent_post uuid; reply_post uuid;
BEGIN
  IF NEW.parent_id IS NOT NULL THEN
    SELECT post_id INTO parent_post FROM ugc_comment WHERE id=NEW.parent_id;
    IF parent_post IS NULL OR parent_post<>NEW.post_id THEN RAISE EXCEPTION 'UGC_COMMENT_PARENT_POST_MISMATCH' USING ERRCODE='23514'; END IF;
  END IF;
  IF NEW.reply_to_id IS NOT NULL THEN
    SELECT post_id INTO reply_post FROM ugc_comment WHERE id=NEW.reply_to_id;
    IF reply_post IS NULL OR reply_post<>NEW.post_id THEN RAISE EXCEPTION 'UGC_COMMENT_REPLY_POST_MISMATCH' USING ERRCODE='23514'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER ugc_comment_thread BEFORE INSERT OR UPDATE OF post_id,parent_id,reply_to_id ON ugc_comment
FOR EACH ROW EXECUTE FUNCTION enforce_ugc_comment_thread();

CREATE TABLE ugc_report (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reporter_member_id uuid NOT NULL REFERENCES member(id),
  target_type text NOT NULL CHECK (target_type IN ('post','comment','member')),
  target_id uuid NOT NULL,
  category text NOT NULL CHECK (category IN ('spam','harassment','unsafe_advice','illegal','intellectual_property','privacy','other')),
  description text CHECK (description IS NULL OR char_length(description) BETWEEN 1 AND 1000),
  state text NOT NULL DEFAULT 'received' CHECK (state IN ('received','triaged','resolved','rejected','withdrawn')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX ugc_report_one_open_category ON ugc_report(reporter_member_id,target_type,target_id,category)
  WHERE state IN ('received','triaged');
CREATE INDEX ugc_report_queue ON ugc_report(created_at,id) WHERE state IN ('received','triaged');

CREATE TABLE moderation_case (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_report_id uuid REFERENCES ugc_report(id),
  target_type text NOT NULL CHECK (target_type IN ('post','comment','media','member')),
  target_id uuid NOT NULL,
  state text NOT NULL DEFAULT 'open' CHECK (state IN ('open','reviewing','resolved','appealed','closed')),
  severity text NOT NULL CHECK (severity IN ('low','medium','high','critical')),
  policy_version text NOT NULL,
  assigned_to text,
  decision_code text,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  CHECK ((state IN ('resolved','closed') AND resolved_at IS NOT NULL AND decision_code IS NOT NULL) OR state NOT IN ('resolved','closed'))
);
CREATE UNIQUE INDEX moderation_case_one_active_target ON moderation_case(target_type,target_id)
  WHERE state IN ('open','reviewing','appealed');
CREATE INDEX moderation_case_queue ON moderation_case(severity,created_at,id) WHERE state IN ('open','reviewing','appealed');

CREATE TABLE moderation_action (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  moderation_case_id uuid NOT NULL REFERENCES moderation_case(id),
  principal_id text NOT NULL,
  action text NOT NULL CHECK (action IN ('allow','reject','hide','delete','restrict_member','restore','request_changes')),
  reason_code text NOT NULL CHECK (reason_code ~ '^[A-Z][A-Z0-9_]{2,79}$'),
  evidence jsonb NOT NULL CHECK (jsonb_typeof(evidence)='object' AND evidence<>'{}'::jsonb),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX moderation_action_case_timeline ON moderation_action(moderation_case_id,created_at,id);

CREATE FUNCTION reject_moderation_action_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'MODERATION_ACTION_IMMUTABLE' USING ERRCODE='55000'; END $$;
CREATE TRIGGER moderation_action_immutable BEFORE UPDATE OR DELETE ON moderation_action
FOR EACH ROW EXECUTE FUNCTION reject_moderation_action_mutation();

-- migrate:down
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM ugc_post)
    OR EXISTS(SELECT 1 FROM ugc_media_asset)
    OR EXISTS(SELECT 1 FROM ugc_comment)
    OR EXISTS(SELECT 1 FROM ugc_report)
    OR EXISTS(SELECT 1 FROM moderation_case)
    OR EXISTS(SELECT 1 FROM emergency_switch WHERE key='community' AND (enabled OR version<>1 OR updated_by<>'migration'))
  THEN RAISE EXCEPTION 'FORMAL_UGC_ROLLBACK_REQUIRES_DATA_PRESERVATION'; END IF;
END $$;
DROP TRIGGER moderation_action_immutable ON moderation_action;
DROP FUNCTION reject_moderation_action_mutation();
DROP TABLE moderation_action,moderation_case,ugc_report;
DROP TRIGGER ugc_comment_thread ON ugc_comment;
DROP FUNCTION enforce_ugc_comment_thread();
DROP TABLE ugc_comment;
DROP TRIGGER ugc_post_media_owner ON ugc_post_media;
DROP FUNCTION enforce_ugc_media_owner();
DROP TABLE ugc_post_media,ugc_media_asset;
DROP TRIGGER ugc_post_update_guard ON ugc_post;
DROP FUNCTION guard_ugc_post_update();
DROP TRIGGER ugc_post_revision_mutation ON ugc_post_revision;
DROP FUNCTION guard_ugc_revision_mutation();
DROP TRIGGER ugc_post_revision_owner ON ugc_post_revision;
DROP FUNCTION enforce_ugc_revision_owner();
DROP TABLE ugc_post_revision,ugc_post;
ALTER TABLE emergency_switch DROP CONSTRAINT emergency_switch_formal_ugc_closed;
DELETE FROM emergency_switch WHERE key='community';
ALTER TABLE emergency_switch DROP CONSTRAINT emergency_switch_key_check;
ALTER TABLE emergency_switch ADD CONSTRAINT emergency_switch_key_check
  CHECK (key IN ('identity','uploads','reviews','rewards','submissions','redemption','commerce'));
