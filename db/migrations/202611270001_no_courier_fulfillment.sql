-- PRD §8 / SHIP-HANDOFF-01: preserve the actual method of physical handoff.
ALTER TABLE commerce_shipment ADD COLUMN delivery_method text NOT NULL DEFAULT 'express'
  CHECK (delivery_method IN ('express','local_delivery','pickup'));

CREATE INDEX commerce_shipment_auto_receipt_due ON commerce_shipment(shipped_at,id)
  WHERE delivery_method IN ('local_delivery','pickup') AND logistics_state='shipped' AND receipt_confirmed_at IS NULL;

CREATE OR REPLACE FUNCTION guard_commerce_shipment() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' OR
    (NEW.id,NEW.order_id,NEW.shipping_sync_id,NEW.carrier_name,NEW.delivery_method,NEW.shipped_at,NEW.created_by_member_id,NEW.created_at)
    IS DISTINCT FROM
    (OLD.id,OLD.order_id,OLD.shipping_sync_id,OLD.carrier_name,OLD.delivery_method,OLD.shipped_at,OLD.created_by_member_id,OLD.created_at)
    OR (OLD.delivered_at IS NOT NULL AND NEW.delivered_at IS DISTINCT FROM OLD.delivered_at)
    OR (OLD.receipt_confirmed_at IS NOT NULL AND NEW.receipt_confirmed_at IS DISTINCT FROM OLD.receipt_confirmed_at)
    OR NEW.version<>OLD.version+1
  THEN RAISE EXCEPTION 'SHIPMENT_FACT_IMMUTABLE' USING ERRCODE='55000'; END IF;
  RETURN NEW;
END $$;

-- migrate:down
DO $$
BEGIN
  LOCK TABLE commerce_shipment IN ACCESS EXCLUSIVE MODE;
  IF EXISTS (SELECT 1 FROM commerce_shipment WHERE delivery_method <> 'express') THEN
    RAISE EXCEPTION 'NO_COURIER_SHIPMENT_FACTS_PRESENT' USING ERRCODE='55000';
  END IF;
END $$;

DROP INDEX commerce_shipment_auto_receipt_due;
CREATE OR REPLACE FUNCTION guard_commerce_shipment() RETURNS trigger LANGUAGE plpgsql AS $$
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
ALTER TABLE commerce_shipment DROP COLUMN delivery_method;
