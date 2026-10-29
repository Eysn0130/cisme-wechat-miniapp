BEGIN;

CREATE TABLE daily_care_record (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id uuid NOT NULL REFERENCES member(id),
  operation_id text NOT NULL CHECK (length(operation_id) BETWEEN 8 AND 200),
  request_sha256 text NOT NULL CHECK (request_sha256 ~ '^[0-9a-f]{64}$'),
  completed_at timestamptz NOT NULL DEFAULT now(),
  timezone text NOT NULL DEFAULT 'Asia/Shanghai' CHECK (timezone = 'Asia/Shanghai'),
  protocol_version text NOT NULL CHECK (length(protocol_version) BETWEEN 1 AND 80),
  step_codes text[] NOT NULL CHECK (step_codes = ARRAY['00','01','02','03']::text[]),
  self_assessment text NOT NULL CHECK (self_assessment IN ('comfortable','neutral','attention')),
  suppressed_at timestamptz,
  UNIQUE (member_id, operation_id)
);
CREATE INDEX daily_care_record_owner_page ON daily_care_record(member_id, completed_at DESC, id DESC)
  WHERE suppressed_at IS NULL;

COMMIT;

-- migrate:down
BEGIN;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM daily_care_record) THEN
    RAISE EXCEPTION 'DAILY_CARE_RECORDS_EXIST: preserve saved care facts; application rollback must retain this schema';
  END IF;
END $$;
DROP TABLE daily_care_record;
COMMIT;
