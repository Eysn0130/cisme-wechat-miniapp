-- P08 formal UGC editor. The migration never enables public publication.
-- An explicit, expiring governance approval and the runtime feature gate are
-- required in addition to the emergency switch before public reads/writes.
CREATE TABLE ugc_go_live_approval (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  approval_reference text NOT NULL UNIQUE CHECK (char_length(approval_reference) BETWEEN 8 AND 120),
  signed_by text NOT NULL CHECK (char_length(signed_by) BETWEEN 3 AND 200),
  evidence jsonb NOT NULL CHECK (jsonb_typeof(evidence)='object' AND evidence<>'{}'::jsonb),
  signed_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  CHECK (expires_at>signed_at)
);
CREATE INDEX ugc_go_live_approval_current ON ugc_go_live_approval(expires_at DESC) WHERE revoked_at IS NULL;

ALTER TABLE emergency_switch DROP CONSTRAINT emergency_switch_formal_ugc_closed;
CREATE FUNCTION require_ugc_approval_for_switch() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.key='community' AND NEW.enabled AND NOT EXISTS(
    SELECT 1 FROM ugc_go_live_approval WHERE revoked_at IS NULL AND signed_at<=now() AND expires_at>now())
  THEN RAISE EXCEPTION 'UGC_GO_LIVE_APPROVAL_REQUIRED' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER emergency_switch_ugc_approval BEFORE INSERT OR UPDATE OF enabled ON emergency_switch
FOR EACH ROW EXECUTE FUNCTION require_ugc_approval_for_switch();

ALTER TABLE ugc_post_revision ALTER COLUMN body DROP NOT NULL;
ALTER TABLE ugc_post_revision DROP CONSTRAINT ugc_post_revision_body_check;
ALTER TABLE ugc_post_revision ADD CONSTRAINT ugc_post_revision_body_check
  CHECK (body IS NULL OR char_length(body) BETWEEN 1 AND 5000);
ALTER TABLE ugc_post_revision ADD COLUMN ai_usage text NOT NULL DEFAULT 'unknown'
  CHECK (ai_usage IN ('none','assisted','generated','unknown')),
  ADD COLUMN rights_confirmed boolean NOT NULL DEFAULT false,
  ADD COLUMN public_consent_confirmed boolean NOT NULL DEFAULT false;

ALTER TABLE ugc_post ADD COLUMN published_revision integer;
UPDATE ugc_post SET published_revision=current_revision WHERE state='published';
ALTER TABLE ugc_post ADD CONSTRAINT ugc_post_published_revision_fk
  FOREIGN KEY(id,published_revision) REFERENCES ugc_post_revision(post_id,revision) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE ugc_post ADD CONSTRAINT ugc_post_published_pointer_check
  CHECK (state<>'published' OR published_revision IS NOT NULL);

CREATE OR REPLACE FUNCTION guard_ugc_revision_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'UGC_POST_REVISION_IMMUTABLE' USING ERRCODE='55000';
  END IF;
  IF (NEW.post_id,NEW.revision,NEW.created_by_member_id,NEW.title,NEW.body,NEW.content_warning,
      NEW.ai_usage,NEW.rights_confirmed,NEW.public_consent_confirmed,NEW.created_at)
    IS DISTINCT FROM
    (OLD.post_id,OLD.revision,OLD.created_by_member_id,OLD.title,OLD.body,OLD.content_warning,
      OLD.ai_usage,OLD.rights_confirmed,OLD.public_consent_confirmed,OLD.created_at)
  THEN RAISE EXCEPTION 'UGC_POST_REVISION_CONTENT_IMMUTABLE' USING ERRCODE='55000'; END IF;
  IF NOT (
    NEW.moderation_state=OLD.moderation_state
    OR (OLD.moderation_state='unreviewed' AND NEW.moderation_state='pending')
    OR (OLD.moderation_state='pending' AND NEW.moderation_state IN ('approved','rejected'))
  ) THEN RAISE EXCEPTION 'UGC_POST_REVISION_MODERATION_TRANSITION_INVALID' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;

ALTER TABLE ugc_media_asset ADD COLUMN bound_post_id uuid REFERENCES ugc_post(id) ON DELETE RESTRICT,
  ADD COLUMN authorized_max_bytes integer CHECK (authorized_max_bytes BETWEEN 1 AND 10485760),
  ADD COLUMN public_object_key text UNIQUE,
  ADD COLUMN thumbnail_object_key text UNIQUE,
  ADD COLUMN derived_at timestamptz;
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM ugc_media_asset WHERE state='approved')
  THEN RAISE EXCEPTION 'UGC_APPROVED_MEDIA_DERIVATIVE_BACKFILL_REQUIRED'; END IF;
END $$;
ALTER TABLE ugc_media_asset ADD CONSTRAINT ugc_media_approved_derivatives
  CHECK (state<>'approved' OR (public_object_key IS NOT NULL AND thumbnail_object_key IS NOT NULL AND derived_at IS NOT NULL));
UPDATE ugc_media_asset a SET bound_post_id=b.post_id FROM ugc_post_media b WHERE b.media_asset_id=a.id;
ALTER TABLE ugc_post_media DROP CONSTRAINT ugc_post_media_media_asset_id_key;
ALTER TABLE ugc_post_media ADD CONSTRAINT ugc_post_media_revision_asset_unique UNIQUE(post_id,revision,media_asset_id);
CREATE OR REPLACE FUNCTION enforce_ugc_media_owner() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE post_owner uuid; media_owner uuid; bound_id uuid;
BEGIN
  SELECT author_member_id INTO post_owner FROM ugc_post WHERE id=NEW.post_id FOR SHARE;
  SELECT owner_member_id,bound_post_id INTO media_owner,bound_id FROM ugc_media_asset WHERE id=NEW.media_asset_id FOR UPDATE;
  IF post_owner IS NULL OR media_owner IS NULL OR post_owner<>media_owner OR (bound_id IS NOT NULL AND bound_id<>NEW.post_id)
  THEN RAISE EXCEPTION 'UGC_POST_MEDIA_OWNER_MISMATCH' USING ERRCODE='23514'; END IF;
  UPDATE ugc_media_asset SET bound_post_id=NEW.post_id WHERE id=NEW.media_asset_id AND bound_post_id IS NULL;
  RETURN NEW;
END $$;

ALTER TABLE ugc_post DROP CONSTRAINT ugc_post_state_check;
ALTER TABLE ugc_post ADD CONSTRAINT ugc_post_state_check
  CHECK (state IN ('draft','pending_review','published','rejected','hidden','deleted'));
CREATE OR REPLACE FUNCTION guard_ugc_post_update() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE revision_state text; author_state text; unsafe_media integer; media_count integer;
  revision_body text; rights_ok boolean; consent_ok boolean;
BEGIN
  IF TG_OP='UPDATE' AND (NEW.author_member_id,NEW.client_request_key)
    IS DISTINCT FROM (OLD.author_member_id,OLD.client_request_key)
  THEN RAISE EXCEPTION 'UGC_POST_IDENTITY_IMMUTABLE' USING ERRCODE='55000'; END IF;
  IF NEW.state='pending_review' THEN
    SELECT moderation_state,body,rights_confirmed,public_consent_confirmed
      INTO revision_state,revision_body,rights_ok,consent_ok FROM ugc_post_revision
      WHERE post_id=NEW.id AND revision=NEW.current_revision;
    SELECT count(*) INTO media_count FROM ugc_post_media WHERE post_id=NEW.id AND revision=NEW.current_revision;
    IF revision_state IS NULL OR (coalesce(length(btrim(revision_body)),0)=0 AND media_count=0)
       OR media_count>9 OR rights_ok IS DISTINCT FROM true OR consent_ok IS DISTINCT FROM true
    THEN RAISE EXCEPTION 'UGC_POST_CONTENT_OR_DECLARATION_REQUIRED' USING ERRCODE='23514'; END IF;
  END IF;
  IF NEW.state='published' THEN
    SELECT moderation_state,body,rights_confirmed,public_consent_confirmed
      INTO revision_state,revision_body,rights_ok,consent_ok FROM ugc_post_revision
      WHERE post_id=NEW.id AND revision=NEW.published_revision;
    SELECT count(*) INTO media_count FROM ugc_post_media WHERE post_id=NEW.id AND revision=NEW.published_revision;
    SELECT status INTO author_state FROM member WHERE id=NEW.author_member_id;
    SELECT count(*) INTO unsafe_media FROM ugc_post_media binding
      JOIN ugc_media_asset asset ON asset.id=binding.media_asset_id
      WHERE binding.post_id=NEW.id AND binding.revision=NEW.published_revision AND asset.state<>'approved';
    IF (coalesce(length(btrim(revision_body)),0)=0 AND media_count=0)
       OR media_count>9 OR rights_ok IS DISTINCT FROM true OR consent_ok IS DISTINCT FROM true
    THEN RAISE EXCEPTION 'UGC_PUBLIC_CONTENT_OR_DECLARATION_REQUIRED' USING ERRCODE='23514'; END IF;
    IF revision_state IS DISTINCT FROM 'approved' THEN
      RAISE EXCEPTION 'UGC_POST_REVISION_NOT_APPROVED' USING ERRCODE='23514'; END IF;
    IF author_state IS DISTINCT FROM 'active' THEN
      RAISE EXCEPTION 'UGC_POST_AUTHOR_NOT_ACTIVE' USING ERRCODE='23514'; END IF;
    IF unsafe_media<>0 THEN
      RAISE EXCEPTION 'UGC_POST_MEDIA_NOT_APPROVED' USING ERRCODE='23514'; END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER ugc_post_update_guard ON ugc_post;
CREATE TRIGGER ugc_post_update_guard BEFORE INSERT OR UPDATE OF author_member_id,client_request_key,state,current_revision,published_revision ON ugc_post
FOR EACH ROW EXECUTE FUNCTION guard_ugc_post_update();

CREATE TABLE ugc_post_reaction (
  post_id uuid NOT NULL REFERENCES ugc_post(id) ON DELETE RESTRICT,
  member_id uuid NOT NULL REFERENCES member(id) ON DELETE RESTRICT,
  kind text NOT NULL CHECK (kind IN ('like','save')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(post_id,member_id,kind)
);
CREATE INDEX ugc_post_reaction_owner ON ugc_post_reaction(member_id,kind,created_at DESC);

CREATE TABLE ugc_post_review_action (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id uuid NOT NULL REFERENCES ugc_post(id) ON DELETE RESTRICT,
  revision integer NOT NULL,
  reviewer_member_id uuid NOT NULL REFERENCES member(id) ON DELETE RESTRICT,
  decision text NOT NULL CHECK (decision IN ('approve','reject','publish','hide')),
  reason text NOT NULL CHECK (char_length(btrim(reason)) BETWEEN 4 AND 500),
  rule_version text NOT NULL CHECK (char_length(rule_version) BETWEEN 3 AND 100),
  evidence jsonb NOT NULL CHECK (jsonb_typeof(evidence)='object' AND evidence<>'{}'::jsonb),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(post_id,revision) REFERENCES ugc_post_revision(post_id,revision)
);
CREATE INDEX ugc_post_review_action_history ON ugc_post_review_action(post_id,revision,created_at,id);

CREATE TABLE ugc_block_relation (
  blocker_member_id uuid NOT NULL REFERENCES member(id) ON DELETE RESTRICT,
  blocked_member_id uuid NOT NULL REFERENCES member(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(blocker_member_id,blocked_member_id),
  CHECK (blocker_member_id<>blocked_member_id)
);
CREATE INDEX ugc_block_relation_blocked ON ugc_block_relation(blocked_member_id,blocker_member_id);

CREATE TABLE ugc_upload_chunk (
  media_id uuid NOT NULL REFERENCES ugc_media_asset(id) ON DELETE RESTRICT,
  chunk_index integer NOT NULL CHECK (chunk_index BETWEEN 0 AND 19),
  token_hash text NOT NULL,
  total_bytes integer NOT NULL CHECK (total_bytes BETWEEN 1 AND 10485760),
  bytes bytea NOT NULL CHECK (octet_length(bytes) BETWEEN 1 AND 524288),
  expires_at timestamptz NOT NULL,
  PRIMARY KEY(media_id,chunk_index)
);
CREATE INDEX ugc_upload_chunk_expiry ON ugc_upload_chunk(expires_at);

CREATE FUNCTION ugc_editor_evidence_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'UGC_EDITOR_EVIDENCE_IMMUTABLE' USING ERRCODE='55000'; END $$;
CREATE TRIGGER ugc_post_review_action_immutable BEFORE UPDATE OR DELETE ON ugc_post_review_action
FOR EACH ROW EXECUTE FUNCTION ugc_editor_evidence_immutable();

-- migrate:down
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM ugc_go_live_approval) OR EXISTS(SELECT 1 FROM ugc_post_reaction)
    OR EXISTS(SELECT 1 FROM ugc_post) OR EXISTS(SELECT 1 FROM ugc_media_asset)
    OR EXISTS(SELECT 1 FROM ugc_post_review_action) OR EXISTS(SELECT 1 FROM ugc_block_relation)
    OR EXISTS(SELECT 1 FROM ugc_upload_chunk)
  THEN RAISE EXCEPTION 'FORMAL_UGC_EDITOR_ROLLBACK_REQUIRES_DATA_PRESERVATION'; END IF;
END $$;
DROP TRIGGER ugc_post_review_action_immutable ON ugc_post_review_action;
DROP FUNCTION ugc_editor_evidence_immutable();
DROP TABLE ugc_upload_chunk,ugc_block_relation,ugc_post_review_action,ugc_post_reaction;
DROP TRIGGER ugc_post_update_guard ON ugc_post;
CREATE TRIGGER ugc_post_update_guard BEFORE INSERT OR UPDATE OF author_member_id,client_request_key,state,current_revision ON ugc_post
FOR EACH ROW EXECUTE FUNCTION guard_ugc_post_update();
ALTER TABLE ugc_post DROP CONSTRAINT ugc_post_published_pointer_check;
ALTER TABLE ugc_post DROP CONSTRAINT ugc_post_published_revision_fk;
ALTER TABLE ugc_post DROP COLUMN published_revision;
CREATE OR REPLACE FUNCTION guard_ugc_post_update() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE revision_state text; author_state text; unsafe_media integer;
BEGIN
  IF TG_OP='UPDATE' AND (NEW.author_member_id,NEW.client_request_key)
    IS DISTINCT FROM (OLD.author_member_id,OLD.client_request_key)
  THEN RAISE EXCEPTION 'UGC_POST_IDENTITY_IMMUTABLE' USING ERRCODE='55000'; END IF;
  IF NEW.state='published' THEN
    SELECT moderation_state INTO revision_state FROM ugc_post_revision WHERE post_id=NEW.id AND revision=NEW.current_revision;
    SELECT status INTO author_state FROM member WHERE id=NEW.author_member_id;
    SELECT count(*) INTO unsafe_media FROM ugc_post_media binding JOIN ugc_media_asset asset ON asset.id=binding.media_asset_id
      WHERE binding.post_id=NEW.id AND binding.revision=NEW.current_revision AND asset.state<>'approved';
    IF revision_state IS DISTINCT FROM 'approved' OR author_state IS DISTINCT FROM 'active' OR unsafe_media<>0
    THEN RAISE EXCEPTION 'UGC_PUBLICATION_INVALID' USING ERRCODE='23514'; END IF;
  END IF;
  RETURN NEW;
END $$;
ALTER TABLE ugc_post DROP CONSTRAINT ugc_post_state_check;
ALTER TABLE ugc_post ADD CONSTRAINT ugc_post_state_check CHECK (state IN ('draft','pending_review','published','rejected','deleted'));
CREATE OR REPLACE FUNCTION enforce_ugc_media_owner() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE post_owner uuid; media_owner uuid;
BEGIN
  SELECT author_member_id INTO post_owner FROM ugc_post WHERE id=NEW.post_id FOR SHARE;
  SELECT owner_member_id INTO media_owner FROM ugc_media_asset WHERE id=NEW.media_asset_id FOR SHARE;
  IF post_owner IS NULL OR media_owner IS NULL OR post_owner<>media_owner
  THEN RAISE EXCEPTION 'UGC_POST_MEDIA_OWNER_MISMATCH' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
ALTER TABLE ugc_post_media DROP CONSTRAINT ugc_post_media_revision_asset_unique;
ALTER TABLE ugc_post_media ADD CONSTRAINT ugc_post_media_media_asset_id_key UNIQUE(media_asset_id);
ALTER TABLE ugc_media_asset DROP CONSTRAINT ugc_media_approved_derivatives;
ALTER TABLE ugc_media_asset DROP COLUMN bound_post_id,DROP COLUMN authorized_max_bytes,
  DROP COLUMN public_object_key,DROP COLUMN thumbnail_object_key,DROP COLUMN derived_at;
CREATE OR REPLACE FUNCTION guard_ugc_revision_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'UGC_POST_REVISION_IMMUTABLE' USING ERRCODE='55000'; END IF;
  IF (NEW.post_id,NEW.revision,NEW.created_by_member_id,NEW.title,NEW.body,NEW.content_warning,NEW.created_at)
    IS DISTINCT FROM (OLD.post_id,OLD.revision,OLD.created_by_member_id,OLD.title,OLD.body,OLD.content_warning,OLD.created_at)
  THEN RAISE EXCEPTION 'UGC_POST_REVISION_CONTENT_IMMUTABLE' USING ERRCODE='55000'; END IF;
  IF NOT (NEW.moderation_state=OLD.moderation_state OR (OLD.moderation_state='unreviewed' AND NEW.moderation_state='pending')
    OR (OLD.moderation_state='pending' AND NEW.moderation_state IN ('approved','rejected')))
  THEN RAISE EXCEPTION 'UGC_POST_REVISION_MODERATION_TRANSITION_INVALID' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
ALTER TABLE ugc_post_revision DROP COLUMN public_consent_confirmed,DROP COLUMN rights_confirmed,DROP COLUMN ai_usage;
ALTER TABLE ugc_post_revision DROP CONSTRAINT ugc_post_revision_body_check;
ALTER TABLE ugc_post_revision ADD CONSTRAINT ugc_post_revision_body_check CHECK (char_length(body) BETWEEN 1 AND 5000);
ALTER TABLE ugc_post_revision ALTER COLUMN body SET NOT NULL;
DROP TRIGGER emergency_switch_ugc_approval ON emergency_switch;
DROP FUNCTION require_ugc_approval_for_switch();
ALTER TABLE emergency_switch ADD CONSTRAINT emergency_switch_formal_ugc_closed CHECK (key<>'community' OR enabled=false);
DROP TABLE ugc_go_live_approval;
