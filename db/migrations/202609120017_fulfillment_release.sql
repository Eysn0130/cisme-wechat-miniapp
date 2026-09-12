-- Isolated test protocol for dual-reviewed delivery evidence. Formal carrier,
-- after-sales and settlement policy versions must be approved before activation.
CREATE TABLE commerce_fulfillment_attestation (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL UNIQUE REFERENCES commerce_order(id) ON DELETE RESTRICT,
  source_kind text NOT NULL CHECK (source_kind='isolated_manual_fixture'),
  source_reference text NOT NULL UNIQUE CHECK (char_length(source_reference) BETWEEN 8 AND 120),
  evidence_sha256 text NOT NULL CHECK (evidence_sha256 ~ '^[0-9a-f]{64}$'),
  request_key text NOT NULL CHECK (char_length(request_key) BETWEEN 8 AND 200),
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  delivered_at timestamptz NOT NULL,
  release_policy_version text NOT NULL CHECK (release_policy_version='isolated-delivery-v1'),
  proposed_by_member_id uuid NOT NULL REFERENCES member(id) ON DELETE RESTRICT,
  reviewed_by_member_id uuid REFERENCES member(id) ON DELETE RESTRICT,
  decision_key text CHECK (decision_key IS NULL OR char_length(decision_key) BETWEEN 8 AND 200),
  decision_hash text CHECK (decision_hash IS NULL OR decision_hash ~ '^[0-9a-f]{64}$'),
  decision_reason text CHECK (decision_reason IS NULL OR char_length(decision_reason) BETWEEN 4 AND 500),
  state text NOT NULL DEFAULT 'submitted' CHECK (state IN ('submitted','verified','rejected')),
  version integer NOT NULL DEFAULT 1 CHECK (version>0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  decided_at timestamptz,
  UNIQUE(proposed_by_member_id,request_key),
  CHECK ((state='submitted')=(decided_at IS NULL)),
  CHECK ((state='submitted')=(decision_key IS NULL AND decision_hash IS NULL)),
  CHECK (state='submitted' OR reviewed_by_member_id IS DISTINCT FROM proposed_by_member_id)
);
CREATE INDEX commerce_fulfillment_queue ON commerce_fulfillment_attestation(created_at,id)
  WHERE state='submitted';
CREATE UNIQUE INDEX commerce_fulfillment_decision_key ON commerce_fulfillment_attestation(reviewed_by_member_id,decision_key)
  WHERE decision_key IS NOT NULL;
CREATE FUNCTION guard_commerce_fulfillment_attestation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' OR
    (NEW.order_id,NEW.source_kind,NEW.source_reference,NEW.evidence_sha256,NEW.request_key,NEW.request_hash,NEW.delivered_at,
      NEW.release_policy_version,NEW.proposed_by_member_id,NEW.created_at) IS DISTINCT FROM
    (OLD.order_id,OLD.source_kind,OLD.source_reference,OLD.evidence_sha256,OLD.request_key,OLD.request_hash,OLD.delivered_at,
      OLD.release_policy_version,OLD.proposed_by_member_id,OLD.created_at)
    OR OLD.state<>'submitted' AND NEW IS DISTINCT FROM OLD
    OR OLD.state='submitted' AND NEW.state NOT IN ('verified','rejected')
    OR NEW.version<>OLD.version+1
  THEN RAISE EXCEPTION 'FULFILLMENT_ATTESTATION_IMMUTABLE' USING ERRCODE='55000'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER commerce_fulfillment_attestation_guard BEFORE UPDATE OR DELETE ON commerce_fulfillment_attestation
FOR EACH ROW EXECUTE FUNCTION guard_commerce_fulfillment_attestation();

CREATE UNIQUE INDEX commission_one_release_per_order ON commission_ledger_entry(order_id)
  WHERE kind='release';
ALTER TABLE commission_ledger_entry ADD CONSTRAINT commission_release_positive
  CHECK (kind<>'release' OR amount_cents>0);
CREATE FUNCTION guard_commission_release_source() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.kind='release' AND NOT EXISTS (
    SELECT 1 FROM commerce_fulfillment_attestation f
    JOIN commerce_order o ON o.id=f.order_id
    JOIN commission_order_snapshot s ON s.order_id=o.id
    WHERE f.id=NEW.source_fact_id AND f.state='verified' AND f.order_id=NEW.order_id
      AND o.status='paid' AND o.transaction_source_kind='verified_commerce'
      AND s.referrer_member_id=NEW.referrer_member_id
  ) THEN RAISE EXCEPTION 'COMMISSION_VERIFIED_FULFILLMENT_REQUIRED' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER commission_release_source BEFORE INSERT ON commission_ledger_entry
FOR EACH ROW EXECUTE FUNCTION guard_commission_release_source();

-- migrate:down
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM commerce_fulfillment_attestation) OR
    EXISTS(SELECT 1 FROM commission_ledger_entry WHERE kind='release')
  THEN RAISE EXCEPTION 'FULFILLMENT_ROLLBACK_REQUIRES_DATA_PRESERVATION'; END IF;
END $$;
DROP TRIGGER commission_release_source ON commission_ledger_entry;
DROP FUNCTION guard_commission_release_source();
ALTER TABLE commission_ledger_entry DROP CONSTRAINT commission_release_positive;
DROP INDEX commission_one_release_per_order;
DROP TRIGGER commerce_fulfillment_attestation_guard ON commerce_fulfillment_attestation;
DROP FUNCTION guard_commerce_fulfillment_attestation();
DROP INDEX commerce_fulfillment_decision_key;
DROP TABLE commerce_fulfillment_attestation;
