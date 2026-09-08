BEGIN;

ALTER TABLE reward_claim ALTER COLUMN state SET DEFAULT 'pending';
ALTER TABLE reward_claim DROP CONSTRAINT reward_claim_state_check;
ALTER TABLE reward_claim ADD CONSTRAINT reward_claim_state_check CHECK (state IN ('pending','approved','voided'));

COMMIT;
