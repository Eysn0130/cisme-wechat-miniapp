BEGIN;

ALTER TABLE care_record
  ADD COLUMN self_assessment text
    CHECK (self_assessment IN ('comfortable','neutral','attention'));

CREATE TABLE care_record_step (
  record_id uuid NOT NULL REFERENCES care_record(id) ON DELETE CASCADE,
  step_code text NOT NULL CHECK (step_code IN ('00','01','02','03')),
  sequence smallint NOT NULL CHECK (sequence BETWEEN 0 AND 3),
  completed_at timestamptz NOT NULL,
  protocol_version text NOT NULL,
  PRIMARY KEY (record_id, step_code),
  UNIQUE (record_id, sequence)
);

COMMIT;

-- migrate:down
BEGIN;
DROP TABLE IF EXISTS care_record_step;
ALTER TABLE care_record DROP COLUMN IF EXISTS self_assessment;
COMMIT;
