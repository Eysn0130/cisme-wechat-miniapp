-- A succeeded refund remains an immutable aftersale record, but no longer
-- occupies the single in-flight slot for the unrefunded order quantities.
DROP INDEX commerce_aftersale_one_active_order;
CREATE UNIQUE INDEX commerce_aftersale_one_active_order ON commerce_aftersale_case(order_id)
  WHERE state NOT IN ('rejected','cancelled','refund_pending');

-- migrate:down
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM commerce_aftersale_case c JOIN commission_refund_intent i
    ON i.request_id=c.refund_request_id WHERE i.state='succeeded')
  THEN RAISE EXCEPTION 'AFTERSALE_REMAINING_CLAIMS_ROLLBACK_REQUIRES_DATA_PRESERVATION'; END IF;
END $$;
DROP INDEX commerce_aftersale_one_active_order;
CREATE UNIQUE INDEX commerce_aftersale_one_active_order ON commerce_aftersale_case(order_id)
  WHERE state NOT IN ('rejected','cancelled');
