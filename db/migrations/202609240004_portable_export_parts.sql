-- Encrypted, bounded parts for a member-owned formal export job. The existing
-- artifact remains the single revocation/expiry authority for every part.
CREATE TABLE privacy_export_part (
  job_id uuid NOT NULL REFERENCES data_export_job(id) ON DELETE RESTRICT,
  part_number integer NOT NULL CHECK (part_number >= 1),
  ciphertext bytea NOT NULL CHECK (octet_length(ciphertext) BETWEEN 1 AND 8388608),
  iv bytea NOT NULL CHECK (octet_length(iv) = 12),
  auth_tag bytea NOT NULL CHECK (octet_length(auth_tag) = 16),
  plain_bytes integer NOT NULL CHECK (plain_bytes BETWEEN 1 AND 8388608),
  plain_sha256 text NOT NULL CHECK (plain_sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(job_id,part_number)
);

-- migrate:down
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM privacy_export_part) THEN
    RAISE EXCEPTION 'PORTABLE_EXPORT_PART_ROLLBACK_REQUIRES_DATA_PRESERVATION';
  END IF;
END $$;
DROP TABLE privacy_export_part;
