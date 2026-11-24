-- migrate:up
-- Keep the original relation event and expiry for a reversible removal. Orders
-- already carry their own immutable referral snapshot.
ALTER TABLE sharing_customer_relation
  ADD COLUMN removed_at timestamptz,
  ADD COLUMN control_version integer NOT NULL DEFAULT 1 CHECK (control_version > 0);
CREATE INDEX sharing_customer_relation_officer ON sharing_customer_relation(officer_id, effective_at DESC, buyer_id DESC);

-- migrate:down
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM sharing_customer_relation WHERE control_version > 1 OR removed_at IS NOT NULL)
    OR EXISTS (SELECT 1 FROM audit_log WHERE action IN ('sharing.customer.remove','sharing.customer.restore')) THEN
    RAISE EXCEPTION 'SHARING_CUSTOMER_CONTROL_EVIDENCE_EXISTS';
  END IF;
END $$;
DROP INDEX sharing_customer_relation_officer;
ALTER TABLE sharing_customer_relation DROP COLUMN removed_at, DROP COLUMN control_version;
