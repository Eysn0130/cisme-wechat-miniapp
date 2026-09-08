BEGIN;
ALTER TABLE emergency_switch ADD COLUMN version integer NOT NULL DEFAULT 1 CHECK (version > 0);
COMMIT;

-- migrate:down
BEGIN;
ALTER TABLE emergency_switch DROP COLUMN version;
COMMIT;
