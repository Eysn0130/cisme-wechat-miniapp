ALTER TABLE emergency_switch DROP CONSTRAINT emergency_switch_key_check;
ALTER TABLE emergency_switch ADD CONSTRAINT emergency_switch_key_check
  CHECK (key IN ('identity','uploads','reviews','rewards','submissions','redemption','commerce'));

INSERT INTO emergency_switch(key, enabled, reason, updated_by) VALUES
  ('submissions', true, 'normal', 'migration'),
  ('redemption', false, 'points redemption is not enabled', 'migration'),
  ('commerce', false, 'transaction profile is not selected', 'migration')
ON CONFLICT (key) DO NOTHING;

-- migrate:down
DELETE FROM emergency_switch WHERE key IN ('submissions','redemption','commerce');
ALTER TABLE emergency_switch DROP CONSTRAINT emergency_switch_key_check;
ALTER TABLE emergency_switch ADD CONSTRAINT emergency_switch_key_check
  CHECK (key IN ('identity','uploads','reviews','rewards'));

