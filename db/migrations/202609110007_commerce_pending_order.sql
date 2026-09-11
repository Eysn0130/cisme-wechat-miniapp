-- R4-B: first-party checkout quote and pending-payment order authority.
-- This slice deliberately has no payment intent, payment-success route,
-- fulfillment, refund, cart, merchant or settlement structures.

ALTER TABLE catalog_inventory_level
  ADD COLUMN reserved_quantity integer NOT NULL DEFAULT 0
    CHECK (reserved_quantity BETWEEN 0 AND 2000000000),
  ADD CONSTRAINT catalog_inventory_reserved_within_stock
    CHECK (reserved_quantity <= stock_on_hand);

CREATE TABLE commerce_checkout_quote (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id uuid NOT NULL REFERENCES member(id) ON DELETE RESTRICT,
  product_id uuid NOT NULL REFERENCES catalog_product(id) ON DELETE RESTRICT,
  sku_id uuid NOT NULL REFERENCES catalog_sku(id) ON DELETE RESTRICT,
  address_id uuid NOT NULL REFERENCES member_delivery_address(id) ON DELETE RESTRICT,
  address_version integer NOT NULL CHECK (address_version > 0),
  quantity integer NOT NULL CHECK (quantity BETWEEN 1 AND 99),
  currency text NOT NULL CHECK (currency = 'CNY'),
  unit_price_cents integer NOT NULL CHECK (unit_price_cents BETWEEN 1 AND 100000000),
  subtotal_cents bigint NOT NULL CHECK (subtotal_cents BETWEEN 0 AND 9900000000),
  member_discount_cents bigint NOT NULL DEFAULT 0 CHECK (member_discount_cents BETWEEN 0 AND 9900000000),
  shipping_cents bigint NOT NULL DEFAULT 0 CHECK (shipping_cents BETWEEN 0 AND 9900000000),
  total_cents bigint NOT NULL CHECK (total_cents BETWEEN 0 AND 9900000000),
  pricing_rule_version text NOT NULL CHECK (length(pricing_rule_version) BETWEEN 3 AND 100),
  product_version integer NOT NULL CHECK (product_version > 0),
  sku_version integer NOT NULL CHECK (sku_version > 0),
  price_version integer NOT NULL CHECK (price_version > 0),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','consumed','expired')),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 200),
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(member_id,idempotency_key),
  CHECK (subtotal_cents = unit_price_cents * quantity),
  CHECK (total_cents = subtotal_cents - member_discount_cents + shipping_cents),
  CHECK ((status='consumed') = (consumed_at IS NOT NULL))
);

CREATE TABLE commerce_order (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_number text NOT NULL UNIQUE CHECK (order_number ~ '^CM[0-9]{8}[A-Z0-9]{12}$'),
  member_id uuid NOT NULL REFERENCES member(id) ON DELETE RESTRICT,
  source_quote_id uuid NOT NULL UNIQUE REFERENCES commerce_checkout_quote(id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'pending_payment' CHECK (status IN ('pending_payment','cancelled','expired')),
  currency text NOT NULL CHECK (currency = 'CNY'),
  subtotal_cents bigint NOT NULL CHECK (subtotal_cents BETWEEN 0 AND 9900000000),
  member_discount_cents bigint NOT NULL DEFAULT 0 CHECK (member_discount_cents BETWEEN 0 AND 9900000000),
  shipping_cents bigint NOT NULL DEFAULT 0 CHECK (shipping_cents BETWEEN 0 AND 9900000000),
  total_cents bigint NOT NULL CHECK (total_cents BETWEEN 0 AND 9900000000),
  pricing_rule_version text NOT NULL CHECK (length(pricing_rule_version) BETWEEN 3 AND 100),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  expires_at timestamptz NOT NULL,
  cancelled_at timestamptz,
  expired_at timestamptz,
  terminal_reason text CHECK (terminal_reason IS NULL OR length(terminal_reason) BETWEEN 3 AND 500),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (total_cents = subtotal_cents - member_discount_cents + shipping_cents),
  CHECK ((status='cancelled') = (cancelled_at IS NOT NULL)),
  CHECK ((status='expired') = (expired_at IS NOT NULL)),
  CHECK (status='pending_payment' OR terminal_reason IS NOT NULL)
);

CREATE TABLE commerce_order_line (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES commerce_order(id) ON DELETE RESTRICT,
  line_number integer NOT NULL CHECK (line_number BETWEEN 1 AND 100),
  product_id uuid NOT NULL REFERENCES catalog_product(id) ON DELETE RESTRICT,
  sku_id uuid NOT NULL REFERENCES catalog_sku(id) ON DELETE RESTRICT,
  product_code text NOT NULL CHECK (length(product_code) BETWEEN 3 AND 64),
  product_name text NOT NULL CHECK (length(product_name) BETWEEN 1 AND 120),
  sku_code text NOT NULL CHECK (length(sku_code) BETWEEN 3 AND 64),
  sku_label text NOT NULL CHECK (length(sku_label) BETWEEN 1 AND 120),
  image_path text,
  quantity integer NOT NULL CHECK (quantity BETWEEN 1 AND 99),
  unit_price_cents integer NOT NULL CHECK (unit_price_cents BETWEEN 1 AND 100000000),
  line_subtotal_cents bigint NOT NULL CHECK (line_subtotal_cents BETWEEN 0 AND 9900000000),
  line_discount_cents bigint NOT NULL DEFAULT 0 CHECK (line_discount_cents BETWEEN 0 AND 9900000000),
  line_total_cents bigint NOT NULL CHECK (line_total_cents BETWEEN 0 AND 9900000000),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(order_id,line_number),
  CHECK (line_subtotal_cents = unit_price_cents * quantity),
  CHECK (line_total_cents = line_subtotal_cents - line_discount_cents)
);

CREATE TABLE commerce_order_address (
  order_id uuid PRIMARY KEY REFERENCES commerce_order(id) ON DELETE RESTRICT,
  encrypted_payload text NOT NULL,
  payload_hmac text NOT NULL CHECK (payload_hmac ~ '^[0-9a-f]{64}$'),
  key_version text NOT NULL,
  source_address_id uuid NOT NULL REFERENCES member_delivery_address(id) ON DELETE RESTRICT,
  source_address_version integer NOT NULL CHECK (source_address_version > 0),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE commerce_inventory_reservation (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES commerce_order(id) ON DELETE RESTRICT,
  sku_id uuid NOT NULL REFERENCES catalog_sku(id) ON DELETE RESTRICT,
  quantity integer NOT NULL CHECK (quantity BETWEEN 1 AND 99),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','released','consumed')),
  reserved_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  released_at timestamptz,
  release_reason text CHECK (release_reason IS NULL OR length(release_reason) BETWEEN 3 AND 500),
  consumed_at timestamptz,
  UNIQUE(order_id,sku_id),
  CHECK ((status='released') = (released_at IS NOT NULL)),
  CHECK ((status='consumed') = (consumed_at IS NOT NULL)),
  CHECK (status='active' OR release_reason IS NOT NULL OR status='consumed')
);

CREATE TABLE commerce_order_transition (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES commerce_order(id) ON DELETE RESTRICT,
  from_status text,
  to_status text NOT NULL CHECK (to_status IN ('pending_payment','cancelled','expired')),
  reason_code text NOT NULL CHECK (length(reason_code) BETWEEN 3 AND 100),
  actor_principal_id text NOT NULL,
  order_version integer NOT NULL CHECK (order_version > 0),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(order_id,order_version)
);

CREATE INDEX commerce_quote_member_page_idx ON commerce_checkout_quote(member_id,created_at DESC,id DESC);
CREATE INDEX commerce_quote_expiry_idx ON commerce_checkout_quote(expires_at,id) WHERE status='active';
CREATE INDEX commerce_order_member_page_idx ON commerce_order(member_id,created_at DESC,id DESC);
CREATE INDEX commerce_order_management_page_idx ON commerce_order(created_at DESC,id DESC);
CREATE INDEX commerce_order_management_status_idx ON commerce_order(status,updated_at DESC,id DESC);
CREATE INDEX commerce_order_expiry_idx ON commerce_order(expires_at,id) WHERE status='pending_payment';
CREATE INDEX commerce_reservation_active_expiry_idx ON commerce_inventory_reservation(expires_at,id) WHERE status='active';
CREATE INDEX commerce_reservation_active_sku_idx ON commerce_inventory_reservation(sku_id,order_id) WHERE status='active';
CREATE INDEX commerce_order_transition_history_idx ON commerce_order_transition(order_id,occurred_at,id);

CREATE FUNCTION protect_commerce_order_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'COMMERCE_ORDER_EVIDENCE_IMMUTABLE';
END $$;
CREATE TRIGGER commerce_order_line_immutable BEFORE UPDATE OR DELETE ON commerce_order_line
  FOR EACH ROW EXECUTE FUNCTION protect_commerce_order_evidence();
CREATE TRIGGER commerce_order_address_immutable BEFORE UPDATE OR DELETE ON commerce_order_address
  FOR EACH ROW EXECUTE FUNCTION protect_commerce_order_evidence();
CREATE TRIGGER commerce_order_transition_immutable BEFORE UPDATE OR DELETE ON commerce_order_transition
  FOR EACH ROW EXECUTE FUNCTION protect_commerce_order_evidence();

-- migrate:down
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM commerce_order) OR EXISTS(SELECT 1 FROM commerce_checkout_quote)
     OR EXISTS(SELECT 1 FROM catalog_inventory_level WHERE reserved_quantity <> 0) THEN
    RAISE EXCEPTION 'COMMERCE_ORDER_ROLLBACK_REQUIRES_DATA_PRESERVATION';
  END IF;
END $$;
DROP TRIGGER commerce_order_transition_immutable ON commerce_order_transition;
DROP TRIGGER commerce_order_address_immutable ON commerce_order_address;
DROP TRIGGER commerce_order_line_immutable ON commerce_order_line;
DROP FUNCTION protect_commerce_order_evidence();
DROP TABLE commerce_order_transition, commerce_inventory_reservation, commerce_order_address,
  commerce_order_line, commerce_order, commerce_checkout_quote;
ALTER TABLE catalog_inventory_level DROP CONSTRAINT catalog_inventory_reserved_within_stock;
ALTER TABLE catalog_inventory_level DROP COLUMN reserved_quantity;
