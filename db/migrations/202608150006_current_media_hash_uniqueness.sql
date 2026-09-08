BEGIN;

DROP INDEX media_hash_unique;
CREATE UNIQUE INDEX media_hash_unique
  ON media_object(content_hash)
  WHERE content_hash IS NOT NULL AND upload_state='uploaded' AND is_current;

COMMIT;

-- migrate:down
BEGIN;

DROP INDEX media_hash_unique;
CREATE UNIQUE INDEX media_hash_unique
  ON media_object(content_hash)
  WHERE content_hash IS NOT NULL AND upload_state='uploaded';

COMMIT;
