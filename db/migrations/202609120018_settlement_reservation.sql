-- Isolated transfer protocol only. No formally approved scene, tax, payout
-- cadence or merchant authorization is installed by this migration.
ALTER TABLE authority_grant DROP CONSTRAINT authority_grant_capability_check;
ALTER TABLE authority_grant ADD CONSTRAINT authority_grant_capability_check CHECK (capability IN (
  'support.read','support.reply','support.assign',
  'commerce.product.manage','commerce.qualification.manage','commerce.inventory.manage','commerce.order.read',
  'commerce.fulfillment.manage','commerce.refund.approve','commerce.money.reconcile',
  'community.moderate','member.support_view','member.profile.read','member.manage',
  'commission.read','commission.rate.manage','commission.rate.approve',
  'commission.settlement.approve','privacy.request.manage'
));

CREATE TABLE commission_settlement_request (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id uuid NOT NULL REFERENCES member(id) ON DELETE RESTRICT,
  requested_by_member_id uuid NOT NULL REFERENCES member(id) ON DELETE RESTRICT,
  idempotency_key text NOT NULL CHECK (char_length(idempotency_key) BETWEEN 8 AND 200),
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  amount_cents bigint NOT NULL CHECK (amount_cents BETWEEN 1 AND 9900000000),
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 4 AND 300),
  policy_version text NOT NULL CHECK (policy_version='isolated-settlement-v1'),
  state text NOT NULL DEFAULT 'requested' CHECK (state IN
    ('requested','reserved','unknown','processing','succeeded','failed','cancelled','rejected')),
  version integer NOT NULL DEFAULT 1 CHECK (version>0),
  approved_by_member_id uuid REFERENCES member(id) ON DELETE RESTRICT,
  decision_key text CHECK (decision_key IS NULL OR char_length(decision_key) BETWEEN 8 AND 200),
  decision_hash text CHECK (decision_hash IS NULL OR decision_hash ~ '^[0-9a-f]{64}$'),
  decision_reason text CHECK (decision_reason IS NULL OR char_length(decision_reason) BETWEEN 4 AND 300),
  app_id text,
  merchant_id text,
  payee_openid text,
  out_bill_no text UNIQUE CHECK (out_bill_no IS NULL OR out_bill_no ~ '^[A-Za-z0-9]{8,32}$'),
  scene_id text,
  transfer_remark text,
  provider_bill_no text,
  channel_state text,
  package_info text,
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 1000),
  quarantined_at timestamptz,
  next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  lease_until timestamptz,
  last_error_code text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  decided_at timestamptz,
  finalized_at timestamptz,
  UNIQUE(requested_by_member_id,idempotency_key),
  CHECK (member_id=requested_by_member_id),
  CHECK (state='requested' OR approved_by_member_id IS DISTINCT FROM requested_by_member_id),
  CHECK ((state='requested')=(decided_at IS NULL)),
  CHECK ((state='requested')=(decision_key IS NULL AND decision_hash IS NULL)),
  CHECK (state='requested' OR state='rejected' OR
    (app_id IS NOT NULL AND merchant_id IS NOT NULL AND payee_openid IS NOT NULL
      AND out_bill_no IS NOT NULL AND scene_id IS NOT NULL AND transfer_remark IS NOT NULL)),
  CHECK ((state IN ('succeeded','failed','cancelled','rejected'))=(finalized_at IS NOT NULL))
);
CREATE INDEX commission_settlement_queue ON commission_settlement_request(created_at,id)
  WHERE state='requested';
CREATE INDEX commission_settlement_due ON commission_settlement_request(next_attempt_at,id)
  WHERE state IN ('reserved','unknown','processing');
CREATE INDEX commission_settlement_member ON commission_settlement_request(member_id,created_at DESC,id DESC);
CREATE UNIQUE INDEX commission_settlement_decision_key ON commission_settlement_request(approved_by_member_id,decision_key)
  WHERE decision_key IS NOT NULL;
CREATE FUNCTION guard_commission_settlement_request() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' OR
    (NEW.member_id,NEW.requested_by_member_id,NEW.idempotency_key,NEW.request_hash,NEW.amount_cents,
      NEW.reason,NEW.policy_version,NEW.created_at) IS DISTINCT FROM
    (OLD.member_id,OLD.requested_by_member_id,OLD.idempotency_key,OLD.request_hash,OLD.amount_cents,
      OLD.reason,OLD.policy_version,OLD.created_at)
    OR OLD.state IN ('succeeded','failed','cancelled','rejected') AND NEW IS DISTINCT FROM OLD
    OR OLD.state='requested' AND NEW.state NOT IN ('reserved','rejected')
    OR OLD.state='reserved' AND NEW.state NOT IN ('unknown','cancelled')
    OR OLD.state='unknown' AND NEW.state NOT IN ('unknown','processing','succeeded','failed','cancelled')
    OR OLD.state='processing' AND NEW.state NOT IN ('processing','succeeded','failed','cancelled')
    OR OLD.state<>'requested' AND
      (NEW.approved_by_member_id,NEW.decision_key,NEW.decision_hash,NEW.decision_reason,
        NEW.app_id,NEW.merchant_id,NEW.payee_openid,NEW.out_bill_no,NEW.scene_id,NEW.transfer_remark)
      IS DISTINCT FROM
      (OLD.approved_by_member_id,OLD.decision_key,OLD.decision_hash,OLD.decision_reason,
        OLD.app_id,OLD.merchant_id,OLD.payee_openid,OLD.out_bill_no,OLD.scene_id,OLD.transfer_remark)
  THEN RAISE EXCEPTION 'SETTLEMENT_REQUEST_IMMUTABLE' USING ERRCODE='55000'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER commission_settlement_request_guard BEFORE UPDATE OR DELETE ON commission_settlement_request
FOR EACH ROW EXECUTE FUNCTION guard_commission_settlement_request();

CREATE TABLE commission_settlement_allocation (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL REFERENCES commission_settlement_request(id) ON DELETE RESTRICT,
  order_id uuid NOT NULL REFERENCES commerce_order(id) ON DELETE RESTRICT,
  amount_cents bigint NOT NULL CHECK (amount_cents BETWEEN 1 AND 9900000000),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(request_id,order_id)
);
CREATE INDEX commission_settlement_allocation_order ON commission_settlement_allocation(order_id,request_id);
CREATE TRIGGER commission_settlement_allocation_immutable BEFORE UPDATE OR DELETE ON commission_settlement_allocation
FOR EACH ROW EXECUTE FUNCTION commercial_evidence_immutable();

CREATE TABLE commission_transfer_fact (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL REFERENCES commission_settlement_request(id) ON DELETE RESTRICT,
  source_kind text NOT NULL CHECK (source_kind='signed_query'),
  raw_sha256 text NOT NULL CHECK (raw_sha256 ~ '^[0-9a-f]{64}$'),
  provider_bill_no text NOT NULL,
  state text NOT NULL CHECK (state IN
    ('ACCEPTED','PROCESSING','WAIT_USER_CONFIRM','TRANSFERING','SUCCESS','FAIL','CANCELING','CANCELLED')),
  observed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(request_id,raw_sha256)
);
CREATE INDEX commission_transfer_fact_request ON commission_transfer_fact(request_id,observed_at,id);
CREATE TRIGGER commission_transfer_fact_immutable BEFORE UPDATE OR DELETE ON commission_transfer_fact
FOR EACH ROW EXECUTE FUNCTION commercial_evidence_immutable();
ALTER TABLE commission_ledger_entry ADD CONSTRAINT commission_settlement_positive
  CHECK (kind<>'settlement' OR amount_cents>0);
CREATE UNIQUE INDEX commission_settlement_fact_order ON commission_ledger_entry(source_fact_id,order_id)
  WHERE kind='settlement';
CREATE FUNCTION guard_commission_settlement_source() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.kind='settlement' AND NOT EXISTS(
    SELECT 1 FROM commission_transfer_fact f
    JOIN commission_settlement_request r ON r.id=f.request_id
    JOIN commission_settlement_allocation a ON a.request_id=r.id AND a.order_id=NEW.order_id
    WHERE f.id=NEW.source_fact_id AND f.state='SUCCESS' AND r.member_id=NEW.referrer_member_id
      AND a.amount_cents=NEW.amount_cents
  ) THEN RAISE EXCEPTION 'SETTLEMENT_VERIFIED_TRANSFER_REQUIRED' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER commission_settlement_source BEFORE INSERT ON commission_ledger_entry
FOR EACH ROW EXECUTE FUNCTION guard_commission_settlement_source();

-- migrate:down
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM commission_settlement_request) OR
    EXISTS(SELECT 1 FROM commission_ledger_entry WHERE kind='settlement')
  THEN RAISE EXCEPTION 'SETTLEMENT_ROLLBACK_REQUIRES_DATA_PRESERVATION'; END IF;
END $$;
DROP TRIGGER commission_settlement_source ON commission_ledger_entry;
DROP FUNCTION guard_commission_settlement_source();
DROP INDEX commission_settlement_fact_order;
ALTER TABLE commission_ledger_entry DROP CONSTRAINT commission_settlement_positive;
DROP TRIGGER commission_transfer_fact_immutable ON commission_transfer_fact;
DROP TABLE commission_transfer_fact;
DROP TRIGGER commission_settlement_allocation_immutable ON commission_settlement_allocation;
DROP TABLE commission_settlement_allocation;
DROP TRIGGER commission_settlement_request_guard ON commission_settlement_request;
DROP FUNCTION guard_commission_settlement_request();
DROP TABLE commission_settlement_request;
ALTER TABLE authority_grant DROP CONSTRAINT authority_grant_capability_check;
ALTER TABLE authority_grant ADD CONSTRAINT authority_grant_capability_check CHECK (capability IN (
  'support.read','support.reply','support.assign',
  'commerce.product.manage','commerce.qualification.manage','commerce.inventory.manage','commerce.order.read',
  'commerce.fulfillment.manage','commerce.refund.approve',
  'community.moderate','member.support_view','member.profile.read','member.manage',
  'commission.read','commission.rate.manage','commission.rate.approve','privacy.request.manage'
));
