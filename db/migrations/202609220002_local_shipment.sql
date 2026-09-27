-- PRD §8.2 / ORD-02 / ORD-03: physical shipment is independent of platform sync.
-- R0 ships every line in one parcel; no partial dispatch is silently accepted.
CREATE TABLE commerce_shipment (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL UNIQUE REFERENCES commerce_order(id) ON DELETE RESTRICT,
  shipping_sync_id uuid NOT NULL UNIQUE REFERENCES commerce_shipping_sync(id) ON DELETE RESTRICT,
  carrier_name text NOT NULL CHECK (char_length(carrier_name) BETWEEN 1 AND 80),
  logistics_state text NOT NULL DEFAULT 'shipped' CHECK (logistics_state IN ('shipped','delivered','exception')),
  version integer NOT NULL DEFAULT 1 CHECK (version>0),
  shipped_at timestamptz NOT NULL,
  delivered_at timestamptz,
  receipt_confirmed_at timestamptz,
  created_by_member_id uuid NOT NULL REFERENCES member(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (delivered_at IS NULL OR delivered_at>=shipped_at),
  CHECK (receipt_confirmed_at IS NULL OR receipt_confirmed_at>=shipped_at),
  CHECK ((logistics_state='delivered') = (delivered_at IS NOT NULL))
);
CREATE TABLE commerce_shipment_line (
  shipment_id uuid NOT NULL REFERENCES commerce_shipment(id) ON DELETE RESTRICT,
  order_line_id uuid NOT NULL UNIQUE REFERENCES commerce_order_line(id) ON DELETE RESTRICT,
  quantity integer NOT NULL CHECK (quantity>0),
  PRIMARY KEY(shipment_id,order_line_id)
);
CREATE TABLE commerce_shipment_event (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shipment_id uuid NOT NULL REFERENCES commerce_shipment(id) ON DELETE RESTRICT,
  event_key text NOT NULL UNIQUE CHECK(char_length(event_key) BETWEEN 8 AND 200),
  event_type text NOT NULL CHECK(event_type IN ('shipped','delivered','exception','receipt_confirmed')),
  actor_principal_id text NOT NULL,
  evidence_reference text NOT NULL CHECK(char_length(evidence_reference) BETWEEN 8 AND 120),
  occurred_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX commerce_shipment_events_order ON commerce_shipment_event(shipment_id,occurred_at,id);
CREATE FUNCTION guard_commerce_shipment() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' OR
    (NEW.id,NEW.order_id,NEW.shipping_sync_id,NEW.carrier_name,NEW.shipped_at,NEW.created_by_member_id,NEW.created_at)
    IS DISTINCT FROM
    (OLD.id,OLD.order_id,OLD.shipping_sync_id,OLD.carrier_name,OLD.shipped_at,OLD.created_by_member_id,OLD.created_at)
    OR (OLD.delivered_at IS NOT NULL AND NEW.delivered_at IS DISTINCT FROM OLD.delivered_at)
    OR (OLD.receipt_confirmed_at IS NOT NULL AND NEW.receipt_confirmed_at IS DISTINCT FROM OLD.receipt_confirmed_at)
    OR NEW.version<>OLD.version+1
  THEN RAISE EXCEPTION 'SHIPMENT_FACT_IMMUTABLE' USING ERRCODE='55000'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER commerce_shipment_guard BEFORE UPDATE OR DELETE ON commerce_shipment
  FOR EACH ROW EXECUTE FUNCTION guard_commerce_shipment();
CREATE TRIGGER commerce_shipment_line_immutable BEFORE UPDATE OR DELETE ON commerce_shipment_line
  FOR EACH ROW EXECUTE FUNCTION protect_commerce_order_evidence();
CREATE TRIGGER commerce_shipment_event_immutable BEFORE UPDATE OR DELETE ON commerce_shipment_event
  FOR EACH ROW EXECUTE FUNCTION protect_commerce_order_evidence();

-- Freeze the rules shown before purchase; NULL honestly denotes legacy orders.
ALTER TABLE commerce_checkout_quote ADD COLUMN fulfillment_policy jsonb;
ALTER TABLE commerce_order ADD COLUMN fulfillment_policy jsonb;
CREATE FUNCTION guard_fulfillment_policy_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.fulfillment_policy IS DISTINCT FROM OLD.fulfillment_policy THEN
    RAISE EXCEPTION 'FULFILLMENT_PROMISE_IMMUTABLE' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER quote_fulfillment_policy_guard BEFORE UPDATE ON commerce_checkout_quote
  FOR EACH ROW EXECUTE FUNCTION guard_fulfillment_policy_snapshot();
CREATE TRIGGER order_fulfillment_policy_guard BEFORE UPDATE ON commerce_order
  FOR EACH ROW EXECUTE FUNCTION guard_fulfillment_policy_snapshot();

-- migrate:down
DROP TRIGGER quote_fulfillment_policy_guard ON commerce_checkout_quote;
DROP TRIGGER order_fulfillment_policy_guard ON commerce_order;
DROP FUNCTION guard_fulfillment_policy_snapshot();
ALTER TABLE commerce_checkout_quote DROP COLUMN fulfillment_policy;
ALTER TABLE commerce_order DROP COLUMN fulfillment_policy;
DROP TABLE commerce_shipment_event,commerce_shipment_line,commerce_shipment;
DROP FUNCTION guard_commerce_shipment();
