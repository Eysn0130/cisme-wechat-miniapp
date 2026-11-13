-- Dedicated brand-award entitlements, component inventory and receipt coupons.
-- No award, live stock, published campaign or member entitlement is seeded.
CREATE TABLE reward_activity (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), code text NOT NULL UNIQUE CHECK(code ~ '^[a-z0-9][a-z0-9-]{2,63}$'),
 title text NOT NULL CHECK(char_length(title) BETWEEN 1 AND 80),
 state text NOT NULL DEFAULT 'draft' CHECK(state IN ('draft','published','paused')),
 version integer NOT NULL DEFAULT 1 CHECK(version>0), terms jsonb,
 created_by uuid NOT NULL REFERENCES member(id), updated_by uuid NOT NULL REFERENCES member(id),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK(state='draft' OR terms IS NOT NULL)
);
CREATE TABLE reward_component_inventory (
 code text PRIMARY KEY CHECK(code IN ('moisture100','dandruff50','conditioner100')),
 stock_on_hand integer NOT NULL DEFAULT 0 CHECK(stock_on_hand BETWEEN 0 AND 2000000000),
 reserved_quantity integer NOT NULL DEFAULT 0 CHECK(reserved_quantity BETWEEN 0 AND stock_on_hand),
 confirmed boolean NOT NULL DEFAULT false, version integer NOT NULL DEFAULT 1 CHECK(version>0),
 updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO reward_component_inventory(code) VALUES('moisture100'),('dandruff50'),('conditioner100');
CREATE TABLE reward_award (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), activity_id uuid NOT NULL REFERENCES reward_activity(id),
 source_record_id text NOT NULL CHECK(char_length(source_record_id) BETWEEN 1 AND 120),
 member_id uuid NOT NULL UNIQUE REFERENCES member(id), batch_id text NOT NULL CHECK(char_length(batch_id) BETWEEN 1 AND 80),
 created_by uuid NOT NULL REFERENCES member(id), created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(activity_id,source_record_id)
);
CREATE TABLE reward_voucher (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), activity_id uuid NOT NULL REFERENCES reward_activity(id),
 award_id uuid NOT NULL UNIQUE REFERENCES reward_award(id), member_id uuid NOT NULL UNIQUE REFERENCES member(id),
 state text NOT NULL DEFAULT 'unused' CHECK(state IN ('unused','locked','used','expired','revoked')),
 terms_snapshot jsonb NOT NULL, activity_version integer NOT NULL CHECK(activity_version>0),
 expires_at timestamptz NOT NULL, issued_at timestamptz NOT NULL DEFAULT now(),
 version integer NOT NULL DEFAULT 1 CHECK(version>0), claim_id uuid,
 CHECK((state IN ('locked','used'))=(claim_id IS NOT NULL))
);
CREATE TABLE reward_quote (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), member_id uuid NOT NULL REFERENCES member(id),
 voucher_id uuid NOT NULL REFERENCES reward_voucher(id), voucher_version integer NOT NULL CHECK(voucher_version>0),
 bundle_code text NOT NULL CHECK(bundle_code IN ('moisture','dandruff')), item_snapshot jsonb NOT NULL,
 survey_version integer NOT NULL CHECK(survey_version>0), questionnaire_version text NOT NULL, recommendation text,
 address_id uuid NOT NULL REFERENCES member_delivery_address(id), address_version integer NOT NULL CHECK(address_version>0),
 shipping_cents integer NOT NULL CHECK(shipping_cents=0),
 expires_at timestamptz NOT NULL, consumed_at timestamptz,
 operation_id text NOT NULL CHECK(char_length(operation_id) BETWEEN 8 AND 200), request_sha256 text NOT NULL CHECK(request_sha256 ~ '^[0-9a-f]{64}$'),
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(member_id,operation_id)
);
CREATE TABLE activity_reward_claim (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), claim_number text NOT NULL UNIQUE,
 member_id uuid NOT NULL REFERENCES member(id), voucher_id uuid NOT NULL REFERENCES reward_voucher(id),
 quote_id uuid NOT NULL UNIQUE REFERENCES reward_quote(id),
 state text NOT NULL CHECK(state IN ('placed','shipped','received','cancelled','aftersale_requested','closed')),
 version integer NOT NULL DEFAULT 1 CHECK(version>0), bundle_code text NOT NULL CHECK(bundle_code IN ('moisture','dandruff')),
 item_snapshot jsonb NOT NULL, terms_snapshot jsonb NOT NULL,
 survey_version integer NOT NULL CHECK(survey_version>0), questionnaire_version text NOT NULL, recommendation text,
 shipping_cents integer NOT NULL CHECK(shipping_cents=0),
 encrypted_address text NOT NULL, address_hmac text NOT NULL, key_version text NOT NULL,
 shipment_encrypted text, carrier_name text, shipped_at timestamptz, received_at timestamptz,
 aftersale_reason text, previous_state text,
 operation_id text NOT NULL CHECK(char_length(operation_id) BETWEEN 8 AND 200), request_sha256 text NOT NULL CHECK(request_sha256 ~ '^[0-9a-f]{64}$'),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(member_id,operation_id),
 CHECK(received_at IS NULL OR shipped_at IS NOT NULL)
);
ALTER TABLE reward_voucher ADD CONSTRAINT reward_voucher_claim_fk FOREIGN KEY(claim_id) REFERENCES activity_reward_claim(id);
CREATE UNIQUE INDEX activity_reward_claim_one_active_voucher ON activity_reward_claim(voucher_id) WHERE state<>'cancelled';
CREATE TABLE reward_stock_reservation (
 claim_id uuid NOT NULL REFERENCES activity_reward_claim(id), component_code text NOT NULL REFERENCES reward_component_inventory(code),
 quantity integer NOT NULL DEFAULT 1 CHECK(quantity=1), state text NOT NULL CHECK(state IN ('active','consumed','released')),
 PRIMARY KEY(claim_id,component_code)
);
CREATE TABLE reward_event (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), actor_member_id uuid REFERENCES member(id),
 action text NOT NULL, object_id text NOT NULL,
 operation_id text NOT NULL, request_sha256 text NOT NULL CHECK(request_sha256 ~ '^[0-9a-f]{64}$'),
 details jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(actor_member_id,operation_id)
);
CREATE TABLE member_purchase_coupon (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), member_id uuid NOT NULL REFERENCES member(id),
 template_code text NOT NULL DEFAULT 'travel-receipt-20-v1' CHECK(template_code='travel-receipt-20-v1'),
 source_claim_id uuid NOT NULL UNIQUE REFERENCES activity_reward_claim(id),
 state text NOT NULL DEFAULT 'available' CHECK(state IN ('available','locked','used','expired','revoked')),
 threshold_cents integer NOT NULL DEFAULT 19800 CHECK(threshold_cents=19800),
 discount_cents integer NOT NULL DEFAULT 2000 CHECK(discount_cents=2000),
 eligible_product_ids uuid[] NOT NULL CHECK(cardinality(eligible_product_ids)>0),
 issued_at timestamptz NOT NULL, expires_at timestamptz NOT NULL,
 order_id uuid REFERENCES commerce_order(id), version integer NOT NULL DEFAULT 1 CHECK(version>0),
 UNIQUE(member_id,template_code), CHECK(expires_at=issued_at+interval '30 days'),
 CHECK((state IN ('locked','used'))=(order_id IS NOT NULL))
);
ALTER TABLE commerce_checkout_quote
 ADD COLUMN coupon_id uuid REFERENCES member_purchase_coupon(id),
 ADD COLUMN coupon_discount_cents integer NOT NULL DEFAULT 0 CHECK(coupon_discount_cents IN (0,2000)),
 ADD COLUMN coupon_version integer,
 ADD CONSTRAINT commerce_quote_coupon_amount CHECK((coupon_id IS NULL AND coupon_discount_cents=0 AND coupon_version IS NULL) OR
  (coupon_id IS NOT NULL AND coupon_discount_cents=2000 AND coupon_version>0 AND subtotal_cents>=19800 AND member_discount_cents>=coupon_discount_cents));
ALTER TABLE commerce_order
 ADD COLUMN coupon_id uuid REFERENCES member_purchase_coupon(id),
 ADD COLUMN coupon_discount_cents integer NOT NULL DEFAULT 0 CHECK(coupon_discount_cents IN (0,2000)),
 ADD CONSTRAINT commerce_order_coupon_amount CHECK((coupon_id IS NULL AND coupon_discount_cents=0) OR (coupon_id IS NOT NULL AND coupon_discount_cents=2000 AND member_discount_cents>=coupon_discount_cents));
CREATE INDEX reward_voucher_member ON reward_voucher(member_id,issued_at DESC,id DESC);
CREATE INDEX activity_reward_claim_member ON activity_reward_claim(member_id,created_at DESC,id DESC);
CREATE INDEX activity_reward_claim_fulfillment ON activity_reward_claim(state,created_at,id);
CREATE INDEX reward_award_activity ON reward_award(activity_id,created_at,id);
CREATE INDEX member_purchase_coupon_member ON member_purchase_coupon(member_id,issued_at DESC,id DESC);
CREATE UNIQUE INDEX member_purchase_coupon_order ON member_purchase_coupon(order_id) WHERE order_id IS NOT NULL;
CREATE FUNCTION protect_reward_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 RAISE EXCEPTION 'REWARD_EVIDENCE_IMMUTABLE'; END $$;
CREATE TRIGGER reward_event_immutable BEFORE UPDATE OR DELETE ON reward_event FOR EACH ROW EXECUTE FUNCTION protect_reward_event();

-- migrate:down
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM reward_activity) OR EXISTS(SELECT 1 FROM reward_event)
 OR EXISTS(SELECT 1 FROM reward_component_inventory WHERE confirmed OR stock_on_hand<>0 OR reserved_quantity<>0)
 THEN RAISE EXCEPTION 'REWARD_ROLLBACK_REQUIRES_DATA_PRESERVATION'; END IF;
END $$;
DROP TRIGGER reward_event_immutable ON reward_event;
DROP FUNCTION protect_reward_event();
ALTER TABLE commerce_order DROP CONSTRAINT commerce_order_coupon_amount, DROP COLUMN coupon_id, DROP COLUMN coupon_discount_cents;
ALTER TABLE commerce_checkout_quote DROP CONSTRAINT commerce_quote_coupon_amount, DROP COLUMN coupon_id, DROP COLUMN coupon_discount_cents, DROP COLUMN coupon_version;
DROP TABLE member_purchase_coupon;
ALTER TABLE reward_voucher DROP CONSTRAINT reward_voucher_claim_fk;
DROP TABLE reward_event,reward_stock_reservation,activity_reward_claim,reward_quote,reward_voucher,reward_award,reward_component_inventory,reward_activity;
