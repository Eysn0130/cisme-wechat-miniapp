-- The immutable result ledger alone cannot prevent two workers sending the
-- same comment to the provider before either result is committed.
CREATE TABLE ugc_comment_scan_claim (
  comment_id uuid PRIMARY KEY REFERENCES ugc_comment(id) ON DELETE RESTRICT,
  body_sha256 text NOT NULL CHECK (body_sha256 ~ '^[0-9a-f]{64}$'),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','completed','quarantined','obsolete')),
  lease_token uuid NOT NULL DEFAULT gen_random_uuid(),
  lease_until timestamptz NOT NULL DEFAULT clock_timestamp()+interval '30 seconds',
  next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  attempt_count integer NOT NULL DEFAULT 1 CHECK (attempt_count BETWEEN 1 AND 7),
  last_error text,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX ugc_comment_scan_claim_due ON ugc_comment_scan_claim(next_attempt_at,lease_until)
  WHERE state='pending';

-- migrate:down
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM ugc_comment_scan_claim)
  THEN RAISE EXCEPTION 'UGC_COMMENT_SCAN_CLAIM_ROLLBACK_REQUIRES_DATA_PRESERVATION'; END IF;
END $$;
DROP TABLE ugc_comment_scan_claim;
