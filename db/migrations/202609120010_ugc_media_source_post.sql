-- An authorized upload belongs to the post that requested it even before a
-- saved revision binds the image. This supports safe interrupted uploads.
ALTER TABLE ugc_media_asset ADD COLUMN source_post_id uuid REFERENCES ugc_post(id) ON DELETE RESTRICT;
UPDATE ugc_media_asset a SET source_post_id=p.id
FROM ugc_post p WHERE a.owner_member_id=p.author_member_id
  AND a.object_key=('ugc/'||a.owner_member_id::text||'/'||p.id::text||'/'||a.id::text);
CREATE INDEX ugc_media_source_post ON ugc_media_asset(source_post_id,state,id);

-- migrate:down
DROP INDEX ugc_media_source_post;
ALTER TABLE ugc_media_asset DROP COLUMN source_post_id;
