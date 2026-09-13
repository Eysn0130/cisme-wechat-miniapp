-- Test-only 1:1 conversion of released, source-attributed commission. This is
-- neither stored value nor a production tax decision. Cash, credit and points
-- remain distinct; no real conversion endpoint is enabled outside APP_ENV=test.
ALTER TABLE commission_ledger_entry DROP CONSTRAINT commission_ledger_entry_kind_check;
ALTER TABLE commission_ledger_entry ADD CONSTRAINT commission_ledger_entry_kind_check
  CHECK (kind IN ('accrual','refund_reversal','release','settlement','recovery',
    'credit_conversion','credit_conversion_reversal'));
ALTER TABLE commission_ledger_entry ADD CONSTRAINT commission_credit_conversion_sign_check
  CHECK ((kind<>'credit_conversion' OR amount_cents>0) AND
    (kind<>'credit_conversion_reversal' OR amount_cents<0));

CREATE TABLE commission_credit_conversion (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id uuid NOT NULL REFERENCES member(id) ON DELETE RESTRICT,
  idempotency_key text NOT NULL CHECK (char_length(idempotency_key) BETWEEN 8 AND 200),
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  gross_cents bigint NOT NULL CHECK (gross_cents BETWEEN 1 AND 9900000000),
  withholding_cents bigint NOT NULL DEFAULT 0 CHECK (withholding_cents=0),
  credit_cents bigint NOT NULL CHECK (credit_cents BETWEEN 1 AND 9900000000),
  tax_policy_version text NOT NULL CHECK (tax_policy_version='isolated-synthetic-zero-withholding-v1'),
  state text NOT NULL DEFAULT 'available' CHECK (state IN ('available','cancelled')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  cancelled_at timestamptz,
  cancel_key text CHECK (cancel_key IS NULL OR char_length(cancel_key) BETWEEN 8 AND 200),
  cancel_hash text CHECK (cancel_hash IS NULL OR cancel_hash ~ '^[0-9a-f]{64}$'),
  UNIQUE(member_id,idempotency_key),
  UNIQUE(member_id,cancel_key),
  CHECK (gross_cents=withholding_cents+credit_cents),
  CHECK ((state='cancelled')=(cancelled_at IS NOT NULL)),
  CHECK ((state='cancelled')=(cancel_key IS NOT NULL AND cancel_hash IS NOT NULL))
);

CREATE TABLE commission_credit_source (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversion_id uuid NOT NULL REFERENCES commission_credit_conversion(id) ON DELETE RESTRICT,
  order_id uuid NOT NULL REFERENCES commission_order_snapshot(order_id) ON DELETE RESTRICT,
  amount_cents bigint NOT NULL CHECK (amount_cents BETWEEN 1 AND 9900000000),
  ledger_entry_id uuid NOT NULL UNIQUE REFERENCES commission_ledger_entry(id) ON DELETE RESTRICT,
  UNIQUE(conversion_id,order_id)
);
CREATE INDEX commission_credit_source_order ON commission_credit_source(order_id);

CREATE TABLE commission_credit_entry (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id uuid NOT NULL REFERENCES commission_credit_source(id) ON DELETE RESTRICT,
  event_key text NOT NULL UNIQUE CHECK (char_length(event_key) BETWEEN 8 AND 200),
  kind text NOT NULL CHECK (kind IN ('issue','spend','refund_return','cancel','freeze','unfreeze')),
  amount_cents bigint NOT NULL CHECK (amount_cents<>0 AND abs(amount_cents)<=9900000000),
  purchase_order_id uuid REFERENCES commerce_order(id) ON DELETE RESTRICT,
  actor_principal_id text NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((kind IN ('issue','refund_return','unfreeze'))=(amount_cents>0)),
  CHECK ((kind IN ('spend','refund_return'))=(purchase_order_id IS NOT NULL))
);
CREATE INDEX commission_credit_entry_source ON commission_credit_entry(source_id,occurred_at,id);
CREATE INDEX commission_credit_entry_purchase ON commission_credit_entry(purchase_order_id)
  WHERE purchase_order_id IS NOT NULL;
CREATE TRIGGER commission_credit_source_immutable BEFORE UPDATE OR DELETE ON commission_credit_source
  FOR EACH ROW EXECUTE FUNCTION commercial_evidence_immutable();
CREATE TRIGGER commission_credit_entry_immutable BEFORE UPDATE OR DELETE ON commission_credit_entry
  FOR EACH ROW EXECUTE FUNCTION commercial_evidence_immutable();
CREATE FUNCTION guard_credit_conversion_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' OR
    (NEW.member_id,NEW.idempotency_key,NEW.request_hash,NEW.gross_cents,NEW.withholding_cents,
      NEW.credit_cents,NEW.tax_policy_version,NEW.created_at) IS DISTINCT FROM
    (OLD.member_id,OLD.idempotency_key,OLD.request_hash,OLD.gross_cents,OLD.withholding_cents,
      OLD.credit_cents,OLD.tax_policy_version,OLD.created_at) OR
    OLD.state<>'available' OR NEW.state<>'cancelled'
  THEN RAISE EXCEPTION 'CREDIT_CONVERSION_IDENTITY_IMMUTABLE' USING ERRCODE='55000'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER commission_credit_conversion_guard BEFORE UPDATE OR DELETE ON commission_credit_conversion
  FOR EACH ROW EXECUTE FUNCTION guard_credit_conversion_identity();

-- migrate:down
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM commission_credit_conversion) OR
    EXISTS (SELECT 1 FROM commission_ledger_entry WHERE kind IN ('credit_conversion','credit_conversion_reversal'))
  THEN RAISE EXCEPTION 'CREDIT_CONVERSION_ROLLBACK_REQUIRES_DATA_PRESERVATION'; END IF;
END $$;
DROP TRIGGER commission_credit_conversion_guard ON commission_credit_conversion;
DROP FUNCTION guard_credit_conversion_identity();
DROP TRIGGER commission_credit_entry_immutable ON commission_credit_entry;
DROP TRIGGER commission_credit_source_immutable ON commission_credit_source;
DROP TABLE commission_credit_entry;
DROP TABLE commission_credit_source;
DROP TABLE commission_credit_conversion;
ALTER TABLE commission_ledger_entry DROP CONSTRAINT commission_credit_conversion_sign_check;
ALTER TABLE commission_ledger_entry DROP CONSTRAINT commission_ledger_entry_kind_check;
ALTER TABLE commission_ledger_entry ADD CONSTRAINT commission_ledger_entry_kind_check
  CHECK (kind IN ('accrual','refund_reversal','release','settlement','recovery'));
