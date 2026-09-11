-- Small, canonical avatar thumbnails are member data in the Shanghai database.
-- Care/post originals continue to use COS. No remote or temporary URL is stored.
ALTER TABLE member_profile
 ADD COLUMN avatar_data_url text CHECK (avatar_data_url IS NULL OR (avatar_data_url LIKE 'data:image/jpeg;base64,%' AND octet_length(avatar_data_url) <= 22000)),
 ADD COLUMN avatar_revision text,
 ADD COLUMN profile_revision integer NOT NULL DEFAULT 0 CHECK (profile_revision >= 0),
 ADD COLUMN completed_at timestamptz,
 ADD COLUMN community_visible boolean NOT NULL DEFAULT false,
 ADD COLUMN public_status text NOT NULL DEFAULT 'private' CHECK (public_status IN ('private','pending','approved','rejected')),
 ADD COLUMN public_review_note text,
 ADD COLUMN public_reviewed_by text,
 ADD COLUMN public_reviewed_at timestamptz,
 ADD CONSTRAINT member_profile_public_scope CHECK (community_visible OR public_status='private');
CREATE INDEX member_profile_pending_review ON member_profile(updated_at,member_id) WHERE public_status='pending';

-- migrate:down
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM member_profile WHERE profile_revision > 0 OR avatar_data_url IS NOT NULL) THEN
  RAISE EXCEPTION 'PROFILE_ROLLBACK_REQUIRES_DATA_PRESERVATION';
 END IF;
END $$;
DROP INDEX member_profile_pending_review;
ALTER TABLE member_profile DROP CONSTRAINT member_profile_public_scope,
 DROP COLUMN avatar_data_url, DROP COLUMN avatar_revision, DROP COLUMN profile_revision,
 DROP COLUMN completed_at, DROP COLUMN community_visible, DROP COLUMN public_status,
 DROP COLUMN public_review_note, DROP COLUMN public_reviewed_by, DROP COLUMN public_reviewed_at;
