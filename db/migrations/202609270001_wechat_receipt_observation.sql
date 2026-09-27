-- The platform's get_order result is a separate, replaceable observation.
-- Local receipt_confirmed_at and immutable shipment events remain untouched.
CREATE TABLE commerce_wechat_receipt_observation (
  order_id uuid PRIMARY KEY REFERENCES commerce_order(id) ON DELETE RESTRICT,
  shipment_id uuid NOT NULL REFERENCES commerce_shipment(id) ON DELETE RESTRICT,
  payment_inbox_id uuid NOT NULL REFERENCES commission_payment_inbox(id) ON DELETE RESTRICT,
  query_id uuid NOT NULL,
  query_started_at timestamptz NOT NULL,
  source text NOT NULL DEFAULT 'wechat_get_order' CHECK (source='wechat_get_order'),
  platform_order_state integer CHECK (platform_order_state>0),
  in_complaint boolean,
  observed_at timestamptz,
  version integer NOT NULL DEFAULT 0 CHECK (version>=0),
  CHECK ((platform_order_state IS NULL AND in_complaint IS NULL AND observed_at IS NULL)
    OR (platform_order_state IS NOT NULL AND in_complaint IS NOT NULL AND observed_at IS NOT NULL))
);
CREATE UNIQUE INDEX commerce_wechat_receipt_shipment ON commerce_wechat_receipt_observation(shipment_id);

-- migrate:down
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM commerce_wechat_receipt_observation)
  THEN RAISE EXCEPTION 'WECHAT_RECEIPT_OBSERVATION_ROLLBACK_REQUIRES_DATA_PRESERVATION'; END IF;
END $$;
DROP TABLE commerce_wechat_receipt_observation;
