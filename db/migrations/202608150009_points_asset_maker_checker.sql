BEGIN;

ALTER TABLE principal_role DROP CONSTRAINT principal_role_role_check;
ALTER TABLE principal_role ADD CONSTRAINT principal_role_role_check
  CHECK (role IN ('reviewer','review_lead','auditor','support','finance_operator','finance_approver'));

ALTER TABLE points_grant
  ADD COLUMN version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  ADD COLUMN available_after timestamptz,
  ADD COLUMN expires_at timestamptz;

ALTER TABLE points_lot DROP CONSTRAINT points_lot_check;
ALTER TABLE points_lot
  ADD COLUMN expired_amount integer NOT NULL DEFAULT 0,
  ADD COLUMN reversed_amount integer NOT NULL DEFAULT 0,
  ADD CONSTRAINT points_lot_conservation_check
    CHECK (original_amount = frozen_amount + available_amount + expired_amount + reversed_amount),
  ADD CONSTRAINT points_lot_bucket_nonnegative_check
    CHECK (frozen_amount >= 0 AND available_amount >= 0 AND expired_amount >= 0 AND reversed_amount >= 0);

CREATE TABLE points_action_request (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  grant_id uuid NOT NULL REFERENCES points_grant(id),
  action text NOT NULL CHECK (action IN ('unfreeze','expire','reverse_remaining')),
  amount integer NOT NULL CHECK (amount > 0),
  expected_grant_version integer NOT NULL CHECK (expected_grant_version > 0),
  reason_code text NOT NULL,
  evidence jsonb NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','approved','rejected')),
  requested_by text NOT NULL,
  requested_at timestamptz NOT NULL,
  decided_by text,
  decided_at timestamptz,
  decision_reason_code text,
  CHECK (jsonb_typeof(evidence) = 'object' AND evidence <> '{}'::jsonb),
  CHECK ((state = 'pending' AND decided_by IS NULL AND decided_at IS NULL)
    OR (state IN ('approved','rejected') AND decided_by IS NOT NULL AND decided_at IS NOT NULL))
);
CREATE UNIQUE INDEX points_action_request_one_pending_per_grant
  ON points_action_request(grant_id) WHERE state='pending';

COMMIT;

-- migrate:down
BEGIN;
DROP TABLE IF EXISTS points_action_request;
ALTER TABLE points_lot DROP CONSTRAINT points_lot_conservation_check;
ALTER TABLE points_lot DROP CONSTRAINT points_lot_bucket_nonnegative_check;
ALTER TABLE points_lot DROP COLUMN expired_amount;
ALTER TABLE points_lot DROP COLUMN reversed_amount;
ALTER TABLE points_lot ADD CONSTRAINT points_lot_check CHECK (original_amount = frozen_amount + available_amount);
ALTER TABLE points_grant DROP COLUMN version;
ALTER TABLE points_grant DROP COLUMN available_after;
ALTER TABLE points_grant DROP COLUMN expires_at;
ALTER TABLE principal_role DROP CONSTRAINT principal_role_role_check;
ALTER TABLE principal_role ADD CONSTRAINT principal_role_role_check
  CHECK (role IN ('reviewer','review_lead','auditor','support'));
COMMIT;
