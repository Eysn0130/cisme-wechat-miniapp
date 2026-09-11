CREATE TABLE upload_chunk (
  media_id uuid NOT NULL REFERENCES media_object(id),
  chunk_index integer NOT NULL CHECK(chunk_index BETWEEN 0 AND 19),
  token_hash text NOT NULL,
  total_bytes integer NOT NULL CHECK(total_bytes BETWEEN 1 AND 10485760),
  bytes bytea NOT NULL CHECK(octet_length(bytes) BETWEEN 1 AND 524288),
  expires_at timestamptz NOT NULL,
  PRIMARY KEY(media_id, chunk_index)
);
CREATE INDEX upload_chunk_expiry ON upload_chunk(expires_at);
-- migrate:down
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM upload_chunk) THEN RAISE EXCEPTION 'UPLOAD_CHUNKS_ROLLBACK_REQUIRES_DRAIN'; END IF;
END $$;
DROP TABLE upload_chunk;
