-- A monotonic subject revision closes the window between a portable-copy
-- snapshot and publication when an address-book deletion occurs meanwhile.
ALTER TABLE member ADD COLUMN privacy_erasure_revision bigint NOT NULL DEFAULT 0
  CHECK (privacy_erasure_revision >= 0);

-- migrate:down
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM member WHERE privacy_erasure_revision<>0) THEN
    RAISE EXCEPTION 'ADDRESS_ERASURE_REVISION_ROLLBACK_REQUIRES_DATA_PRESERVATION';
  END IF;
END $$;
ALTER TABLE member DROP COLUMN privacy_erasure_revision;
