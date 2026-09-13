-- A timed-out worker must not update a fact after another worker has claimed
-- it. Existing pending rows remain unclaimed and can be picked up normally.
ALTER TABLE commission_payment_inbox ADD COLUMN lease_token uuid;
ALTER TABLE commission_refund_inbox ADD COLUMN lease_token uuid;

-- migrate:down
ALTER TABLE commission_refund_inbox DROP COLUMN lease_token;
ALTER TABLE commission_payment_inbox DROP COLUMN lease_token;
