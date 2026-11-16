-- Placement belongs to the exact, already-public revision. The original
-- author, publication intent and immutable one-time points source stay intact.
ALTER TABLE ugc_post
  ADD COLUMN featured_revision integer,
  ADD COLUMN featured_at timestamptz,
  ADD COLUMN featured_by uuid REFERENCES member(id),
  ADD CONSTRAINT ugc_post_featured_revision_fk FOREIGN KEY(id,featured_revision)
    REFERENCES ugc_post_revision(post_id,revision) DEFERRABLE INITIALLY DEFERRED,
  ADD CONSTRAINT ugc_post_featured_complete CHECK (
    (featured_revision IS NULL AND featured_at IS NULL AND featured_by IS NULL)
    OR (featured_revision IS NOT NULL AND featured_at IS NOT NULL AND featured_by IS NOT NULL));

CREATE INDEX ugc_post_featured_feed ON ugc_post(featured_at DESC,id DESC)
  WHERE state='published' AND visibility='public' AND featured_revision=published_revision AND featured_at IS NOT NULL;

-- migrate:down
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM ugc_post WHERE featured_at IS NOT NULL)
  THEN RAISE EXCEPTION 'COMMUNITY_CURATION_ROLLBACK_REQUIRES_DATA_PRESERVATION'; END IF;
END $$;
DROP INDEX ugc_post_featured_feed;
ALTER TABLE ugc_post DROP CONSTRAINT ugc_post_featured_complete,
  DROP CONSTRAINT ugc_post_featured_revision_fk,
  DROP COLUMN featured_by,DROP COLUMN featured_at,DROP COLUMN featured_revision;
