-- A trade bill is evidence for reconciliation, never a payment/refund success command.
-- Source bytes are hashed and discarded; only minimal matched identifiers remain.
CREATE TABLE commerce_trade_bill_batch (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bill_date date NOT NULL,
  bill_type text NOT NULL CHECK (bill_type IN ('SUCCESS','REFUND')),
  merchant_id text NOT NULL,
  source_sha1 text NOT NULL CHECK (source_sha1 ~ '^[0-9a-f]{40}$'),
  source_sha256 text NOT NULL CHECK (source_sha256 ~ '^[0-9a-f]{64}$'),
  row_count integer NOT NULL CHECK (row_count BETWEEN 0 AND 10000),
  matched_count integer NOT NULL CHECK (matched_count BETWEEN 0 AND row_count),
  exception_count integer NOT NULL CHECK (exception_count BETWEEN 0 AND row_count),
  imported_by uuid NOT NULL REFERENCES member(id) ON DELETE RESTRICT,
  imported_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (bill_date,bill_type,merchant_id),
  CHECK (matched_count+exception_count=row_count)
);
CREATE TABLE commerce_trade_bill_row (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id uuid NOT NULL REFERENCES commerce_trade_bill_batch(id) ON DELETE RESTRICT,
  row_number integer NOT NULL CHECK (row_number BETWEEN 1 AND 10000),
  out_trade_no text NOT NULL,
  out_refund_no text,
  provider_no text NOT NULL,
  amount_cents bigint NOT NULL CHECK (amount_cents BETWEEN 1 AND 9900000000),
  status text NOT NULL CHECK (status IN ('matched','exception')),
  exception_code text,
  related_id uuid,
  UNIQUE (batch_id,row_number),
  CHECK ((status='exception')=(exception_code IS NOT NULL))
);
CREATE INDEX commerce_trade_bill_row_exception ON commerce_trade_bill_row(status,batch_id,row_number)
  WHERE status='exception';
CREATE FUNCTION guard_commerce_trade_bill_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'TRADE_BILL_EVIDENCE_IMMUTABLE' USING ERRCODE='55000';
END $$;
CREATE TRIGGER commerce_trade_bill_batch_immutable BEFORE UPDATE OR DELETE ON commerce_trade_bill_batch
  FOR EACH ROW EXECUTE FUNCTION guard_commerce_trade_bill_evidence();
CREATE TRIGGER commerce_trade_bill_row_immutable BEFORE UPDATE OR DELETE ON commerce_trade_bill_row
  FOR EACH ROW EXECUTE FUNCTION guard_commerce_trade_bill_evidence();

-- migrate:down
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM commerce_trade_bill_batch) THEN
    RAISE EXCEPTION 'TRADE_BILL_ROLLBACK_REQUIRES_DATA_PRESERVATION';
  END IF;
END $$;
DROP TRIGGER commerce_trade_bill_row_immutable ON commerce_trade_bill_row;
DROP TRIGGER commerce_trade_bill_batch_immutable ON commerce_trade_bill_batch;
DROP FUNCTION guard_commerce_trade_bill_evidence();
DROP TABLE commerce_trade_bill_row;
DROP TABLE commerce_trade_bill_batch;
