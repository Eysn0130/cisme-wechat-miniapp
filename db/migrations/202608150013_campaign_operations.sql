BEGIN;

ALTER TABLE eligibility_campaign
  ADD COLUMN version integer NOT NULL DEFAULT 1,
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN updated_by text,
  ADD COLUMN update_reason_code text,
  ADD COLUMN update_evidence jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMIT;

-- migrate:down
ALTER TABLE eligibility_campaign
  DROP COLUMN IF EXISTS update_evidence,
  DROP COLUMN IF EXISTS update_reason_code,
  DROP COLUMN IF EXISTS updated_by,
  DROP COLUMN IF EXISTS updated_at,
  DROP COLUMN IF EXISTS version;
