-- A payment callback belongs to the payer and quote captured before prepay.
-- Changing a member's later WeChat identity cannot rebind this attempt.
CREATE TABLE commerce_payment_attempt (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL UNIQUE REFERENCES commerce_order(id) ON DELETE RESTRICT,
  out_trade_no text NOT NULL UNIQUE CHECK (out_trade_no ~ '^CM[0-9]{8}[A-Z0-9]{12}$'),
  member_id uuid NOT NULL REFERENCES member(id) ON DELETE RESTRICT,
  payer_openid text NOT NULL CHECK (char_length(payer_openid) BETWEEN 6 AND 128),
  app_id text NOT NULL CHECK (char_length(app_id) BETWEEN 6 AND 128),
  merchant_id text NOT NULL CHECK (char_length(merchant_id) BETWEEN 6 AND 64),
  amount_cents bigint NOT NULL CHECK (amount_cents BETWEEN 1 AND 9900000000),
  currency text NOT NULL CHECK (currency='CNY'),
  quote_id uuid NOT NULL REFERENCES commerce_checkout_quote(id) ON DELETE RESTRICT,
  pricing_rule_version text NOT NULL,
  quote_price_version integer NOT NULL CHECK (quote_price_version>0),
  expires_at timestamptz NOT NULL,
  state text NOT NULL DEFAULT 'prepared'
    CHECK (state IN ('prepared','prepay_ready','unknown','closed','paid')),
  prepay_id text,
  request_lease_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((state='prepay_ready' AND prepay_id IS NOT NULL)
    OR (state<>'prepay_ready' AND (prepay_id IS NULL OR state IN ('unknown','closed','paid')))),
  CHECK (request_lease_until IS NULL OR state='unknown')
);
CREATE INDEX commerce_payment_attempt_state ON commerce_payment_attempt(state,updated_at);
CREATE FUNCTION guard_commerce_payment_attempt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' OR
    (NEW.order_id,NEW.out_trade_no,NEW.member_id,NEW.payer_openid,NEW.app_id,
      NEW.merchant_id,NEW.amount_cents,NEW.currency,NEW.quote_id,
      NEW.pricing_rule_version,NEW.quote_price_version,NEW.expires_at,NEW.created_at)
    IS DISTINCT FROM
    (OLD.order_id,OLD.out_trade_no,OLD.member_id,OLD.payer_openid,OLD.app_id,
      OLD.merchant_id,OLD.amount_cents,OLD.currency,OLD.quote_id,
      OLD.pricing_rule_version,OLD.quote_price_version,OLD.expires_at,OLD.created_at)
    OR OLD.state IN ('closed','paid') AND NEW IS DISTINCT FROM OLD
  THEN RAISE EXCEPTION 'PAYMENT_ATTEMPT_BINDING_IMMUTABLE' USING ERRCODE='55000'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER commerce_payment_attempt_guard BEFORE UPDATE OR DELETE ON commerce_payment_attempt
FOR EACH ROW EXECUTE FUNCTION guard_commerce_payment_attempt();

-- migrate:down
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM commerce_payment_attempt)
  THEN RAISE EXCEPTION 'PAYMENT_ATTEMPT_ROLLBACK_REQUIRES_DATA_PRESERVATION'; END IF;
END $$;
DROP TRIGGER commerce_payment_attempt_guard ON commerce_payment_attempt;
DROP FUNCTION guard_commerce_payment_attempt();
DROP TABLE commerce_payment_attempt;
