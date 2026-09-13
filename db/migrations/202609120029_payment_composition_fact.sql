-- A signed channel payment can exist even when its cash/coupon allocation is
-- not supported by the current one-SKU checkout. Preserve that channel fact,
-- then quarantine its internal order/commission effects for reconciliation.
ALTER TABLE commission_payment_inbox
  ADD COLUMN payer_total_cents bigint CHECK (payer_total_cents IS NULL OR
    payer_total_cents BETWEEN 0 AND 9900000000),
  ADD COLUMN composition_status text NOT NULL DEFAULT 'legacy_unverified'
    CHECK (composition_status IN ('legacy_unverified','full_cash','unknown_or_discounted'));

-- Old rows had no persisted payer_total. Do not fabricate one from total.
-- A historical applied row is immutable; this metadata records the limit of
-- its original verification and must be reconciled independently.
CREATE FUNCTION guard_payment_composition_fact() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' OR
    (NEW.payer_total_cents,NEW.composition_status) IS DISTINCT FROM
    (OLD.payer_total_cents,OLD.composition_status)
  THEN RAISE EXCEPTION 'PAYMENT_COMPOSITION_FACT_IMMUTABLE' USING ERRCODE='55000'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER commission_payment_composition_guard BEFORE UPDATE OR DELETE
  ON commission_payment_inbox FOR EACH ROW EXECUTE FUNCTION guard_payment_composition_fact();

CREATE TABLE commission_payment_composition_observation (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  notification_id text NOT NULL UNIQUE CHECK (char_length(notification_id) BETWEEN 8 AND 200),
  provider_transaction_id text NOT NULL CHECK (char_length(provider_transaction_id) BETWEEN 8 AND 200),
  order_id uuid NOT NULL REFERENCES commerce_order(id) ON DELETE RESTRICT,
  raw_sha256 text NOT NULL CHECK (raw_sha256 ~ '^[0-9a-f]{64}$'),
  payer_total_cents bigint CHECK (payer_total_cents IS NULL OR payer_total_cents BETWEEN 0 AND 9900000000),
  composition_status text NOT NULL CHECK (composition_status IN ('full_cash','unknown_or_discounted')),
  observed_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX commission_payment_composition_transaction ON commission_payment_composition_observation(provider_transaction_id,order_id);
CREATE TRIGGER commission_payment_composition_observation_immutable BEFORE UPDATE OR DELETE
  ON commission_payment_composition_observation FOR EACH ROW EXECUTE FUNCTION commercial_evidence_immutable();

-- migrate:down
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM commission_payment_inbox WHERE composition_status<>'legacy_unverified') OR
    EXISTS (SELECT 1 FROM commission_payment_composition_observation)
  THEN RAISE EXCEPTION 'PAYMENT_COMPOSITION_ROLLBACK_REQUIRES_DATA_PRESERVATION'; END IF;
END $$;
DROP TRIGGER commission_payment_composition_observation_immutable ON commission_payment_composition_observation;
DROP TABLE commission_payment_composition_observation;
DROP TRIGGER commission_payment_composition_guard ON commission_payment_inbox;
DROP FUNCTION guard_payment_composition_fact();
ALTER TABLE commission_payment_inbox DROP COLUMN payer_total_cents,DROP COLUMN composition_status;
