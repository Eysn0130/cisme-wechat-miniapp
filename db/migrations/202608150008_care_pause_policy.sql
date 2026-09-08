BEGIN;

ALTER TABLE care_cycle
  ADD COLUMN schedule_offset_days integer NOT NULL DEFAULT 0 CHECK (schedule_offset_days >= 0);

CREATE TABLE care_cycle_pause (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cycle_id uuid NOT NULL REFERENCES care_cycle(id),
  reason_code text NOT NULL,
  policy_version text NOT NULL,
  paused_at timestamptz NOT NULL,
  paused_on date NOT NULL,
  ended_at timestamptz,
  ended_on date,
  end_action text CHECK (end_action IN ('resume','terminate')),
  duration_days integer CHECK (duration_days >= 0),
  CHECK ((ended_at IS NULL AND ended_on IS NULL AND end_action IS NULL AND duration_days IS NULL)
    OR (ended_at IS NOT NULL AND ended_on IS NOT NULL AND end_action IS NOT NULL AND duration_days IS NOT NULL))
);
CREATE UNIQUE INDEX care_cycle_pause_open_unique ON care_cycle_pause(cycle_id) WHERE ended_at IS NULL;

COMMIT;

-- migrate:down
BEGIN;
DROP TABLE IF EXISTS care_cycle_pause;
ALTER TABLE care_cycle DROP COLUMN schedule_offset_days;
COMMIT;
