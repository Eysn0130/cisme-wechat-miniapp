-- A biography is explicitly published by its owner after a synchronous safety
-- check. It has its own version and never changes avatar/nickname approval.
ALTER TABLE member_profile
  ADD COLUMN community_bio text NOT NULL DEFAULT '' CHECK (char_length(community_bio)<=120),
  ADD COLUMN community_bio_revision integer NOT NULL DEFAULT 0 CHECK (community_bio_revision>=0);

-- migrate:down
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM member_profile WHERE community_bio_revision>0)
  THEN RAISE EXCEPTION 'COMMUNITY_BIO_ROLLBACK_REQUIRES_DATA_PRESERVATION'; END IF;
END $$;
ALTER TABLE member_profile DROP COLUMN community_bio_revision,DROP COLUMN community_bio;
