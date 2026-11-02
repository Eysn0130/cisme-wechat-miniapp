-- migrate:up
-- The explicit authenticated submit action creates a new immutable snapshot
-- with public consent. Legacy rights checkboxes are historical facts, not a
-- publication prerequisite. No existing revision, audit or switch is changed.
CREATE OR REPLACE FUNCTION guard_ugc_post_update() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE revision_state text; author_state text; unsafe_media integer; media_count integer;
  revision_body text; consent_ok boolean;
BEGIN
  IF TG_OP='UPDATE' AND (NEW.author_member_id,NEW.client_request_key)
    IS DISTINCT FROM (OLD.author_member_id,OLD.client_request_key)
  THEN RAISE EXCEPTION 'UGC_POST_IDENTITY_IMMUTABLE' USING ERRCODE='55000'; END IF;
  IF NEW.state='pending_review' THEN
    SELECT moderation_state,body,public_consent_confirmed
      INTO revision_state,revision_body,consent_ok FROM ugc_post_revision
      WHERE post_id=NEW.id AND revision=NEW.current_revision;
    SELECT count(*) INTO media_count FROM ugc_post_media WHERE post_id=NEW.id AND revision=NEW.current_revision;
    IF revision_state IS NULL OR (coalesce(length(btrim(revision_body)),0)=0 AND media_count=0)
       OR media_count>9 OR consent_ok IS DISTINCT FROM true
    THEN RAISE EXCEPTION 'UGC_POST_CONTENT_OR_DECLARATION_REQUIRED' USING ERRCODE='23514'; END IF;
  END IF;
  IF NEW.state='published' THEN
    SELECT moderation_state,body,public_consent_confirmed
      INTO revision_state,revision_body,consent_ok FROM ugc_post_revision
      WHERE post_id=NEW.id AND revision=NEW.published_revision;
    SELECT count(*) INTO media_count FROM ugc_post_media WHERE post_id=NEW.id AND revision=NEW.published_revision;
    SELECT status INTO author_state FROM member WHERE id=NEW.author_member_id;
    SELECT count(*) INTO unsafe_media FROM ugc_post_media binding
      JOIN ugc_media_asset asset ON asset.id=binding.media_asset_id
      WHERE binding.post_id=NEW.id AND binding.revision=NEW.published_revision AND asset.state<>'approved';
    IF (coalesce(length(btrim(revision_body)),0)=0 AND media_count=0)
       OR media_count>9 OR consent_ok IS DISTINCT FROM true
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

-- migrate:down
-- Do not make already accepted publish-action snapshots incompatible or
-- rewrite their immutable intent. Recovery after such facts is forward-only.
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM audit_log WHERE action='ugc.post_submitted'
    AND after_state->>'publicConsentSource'='publish_action')
    OR EXISTS(SELECT 1 FROM ugc_post p JOIN ugc_post_revision r ON r.post_id=p.id
      AND (r.revision=p.current_revision OR r.revision=p.published_revision)
      WHERE p.state IN ('pending_review','published') AND r.rights_confirmed IS DISTINCT FROM true)
  THEN RAISE EXCEPTION 'UGC_PUBLISH_INTENT_ROLLBACK_REQUIRES_DATA_PRESERVATION'; END IF;
END $$;
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
