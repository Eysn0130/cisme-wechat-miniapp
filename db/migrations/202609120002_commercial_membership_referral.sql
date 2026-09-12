-- Commercial qualification is separate from a signed-in member account and
-- from operational authority. This migration grants nobody a qualification.
ALTER TABLE authority_grant DROP CONSTRAINT authority_grant_capability_check;
ALTER TABLE authority_grant ADD CONSTRAINT authority_grant_capability_check CHECK (capability IN (
  'support.read','support.reply','support.assign',
  'commerce.product.manage','commerce.qualification.manage','commerce.inventory.manage','commerce.order.read',
  'commerce.fulfillment.manage','commerce.refund.approve',
  'community.moderate','member.support_view','member.profile.read','member.manage',
  'commission.read','commission.rate.manage','commission.rate.approve','privacy.request.manage'
));

CREATE TABLE commercial_membership (
  member_id uuid PRIMARY KEY REFERENCES member(id) ON DELETE RESTRICT,
  state text NOT NULL CHECK (state IN ('active','suspended','expired')),
  effective_at timestamptz NOT NULL,
  expires_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  changed_by text NOT NULL,
  change_reason text NOT NULL CHECK (char_length(btrim(change_reason)) BETWEEN 4 AND 300),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (expires_at IS NULL OR expires_at > effective_at)
);
CREATE INDEX commercial_membership_active ON commercial_membership(state,expires_at,member_id);

CREATE TABLE commercial_membership_event (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id uuid NOT NULL REFERENCES member(id) ON DELETE RESTRICT,
  version integer NOT NULL CHECK (version > 0),
  from_state text,
  to_state text NOT NULL CHECK (to_state IN ('active','suspended','expired')),
  effective_at timestamptz NOT NULL,
  expires_at timestamptz,
  actor_principal_id text NOT NULL,
  reason text NOT NULL CHECK (char_length(btrim(reason)) BETWEEN 4 AND 300),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(member_id,version)
);

CREATE TABLE commercial_referral_code (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id uuid NOT NULL UNIQUE REFERENCES member(id) ON DELETE RESTRICT,
  code text NOT NULL UNIQUE CHECK (code ~ '^CM[A-HJ-NP-Z2-9]{10}$'),
  state text NOT NULL DEFAULT 'active' CHECK (state IN ('active','disabled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  disabled_at timestamptz,
  disabled_by text,
  disable_reason text,
  CHECK ((state='disabled') = (disabled_at IS NOT NULL)),
  CHECK ((state='disabled') = (disabled_by IS NOT NULL)),
  CHECK ((state='disabled') = (disable_reason IS NOT NULL))
);
CREATE INDEX commercial_referral_code_owner ON commercial_referral_code(member_id,state);

CREATE TABLE commercial_referral_relation (
  referred_member_id uuid PRIMARY KEY REFERENCES member(id) ON DELETE RESTRICT,
  referrer_member_id uuid NOT NULL REFERENCES member(id) ON DELETE RESTRICT,
  referral_code_id uuid NOT NULL REFERENCES commercial_referral_code(id) ON DELETE RESTRICT,
  confirmation_key text NOT NULL UNIQUE CHECK (char_length(confirmation_key) BETWEEN 8 AND 200),
  confirmed_by text NOT NULL,
  confirmed_at timestamptz NOT NULL DEFAULT now(),
  CHECK (referred_member_id <> referrer_member_id)
);
CREATE INDEX commercial_referral_relation_referrer ON commercial_referral_relation(referrer_member_id,confirmed_at DESC);

CREATE FUNCTION guard_commercial_referral_relation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE owner uuid; code_state text; membership_state text; membership_effective timestamptz; membership_expiry timestamptz;
BEGIN
  SELECT member_id,state INTO owner,code_state FROM commercial_referral_code WHERE id=NEW.referral_code_id FOR SHARE;
  SELECT state,effective_at,expires_at INTO membership_state,membership_effective,membership_expiry
    FROM commercial_membership WHERE member_id=NEW.referrer_member_id FOR SHARE;
  IF owner IS DISTINCT FROM NEW.referrer_member_id OR code_state IS DISTINCT FROM 'active'
     OR membership_state IS DISTINCT FROM 'active' OR membership_effective>NEW.confirmed_at
     OR (membership_expiry IS NOT NULL AND membership_expiry<=NEW.confirmed_at)
  THEN RAISE EXCEPTION 'REFERRER_NOT_ELIGIBLE' USING ERRCODE='23514'; END IF;
  IF EXISTS(SELECT 1 FROM commercial_referral_relation WHERE referred_member_id=NEW.referrer_member_id AND referrer_member_id=NEW.referred_member_id)
  THEN RAISE EXCEPTION 'RECIPROCAL_REFERRAL_FORBIDDEN' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER commercial_referral_relation_guard BEFORE INSERT ON commercial_referral_relation
FOR EACH ROW EXECUTE FUNCTION guard_commercial_referral_relation();

CREATE TABLE commission_rate_rule (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id uuid REFERENCES member(id) ON DELETE RESTRICT,
  basis_points integer NOT NULL CHECK (basis_points BETWEEN 2000 AND 3500),
  state text NOT NULL CHECK (state IN ('proposed','active','rejected')),
  effective_at timestamptz NOT NULL,
  created_by text NOT NULL,
  approved_by text,
  reason text NOT NULL CHECK (char_length(btrim(reason)) BETWEEN 4 AND 300),
  created_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz,
  CHECK ((state='proposed' AND approved_by IS NULL AND decided_at IS NULL)
    OR (state<>'proposed' AND approved_by IS NOT NULL AND decided_at IS NOT NULL)),
  CHECK (state='proposed' OR created_by<>approved_by)
);
CREATE INDEX commission_rate_global_current ON commission_rate_rule(effective_at DESC,created_at DESC) WHERE member_id IS NULL AND state='active';
CREATE INDEX commission_rate_member_current ON commission_rate_rule(member_id,effective_at DESC,created_at DESC) WHERE member_id IS NOT NULL AND state='active';
INSERT INTO commission_rate_rule(member_id,basis_points,state,effective_at,created_by,approved_by,reason,decided_at)
VALUES(NULL,2000,'active','2026-09-12T00:00:00+08:00','migration','engineering-default','Engineering default only; payout gate remains closed',now());

-- A pending synthetic order can retain a reproducible attribution/rate
-- snapshot, but the snapshot is never a payment or a payable commission.
CREATE TABLE commission_order_snapshot (
  order_id uuid PRIMARY KEY REFERENCES commerce_order(id) ON DELETE RESTRICT,
  buyer_member_id uuid NOT NULL REFERENCES member(id) ON DELETE RESTRICT,
  referrer_member_id uuid NOT NULL REFERENCES member(id) ON DELETE RESTRICT,
  referral_code_id uuid NOT NULL REFERENCES commercial_referral_code(id) ON DELETE RESTRICT,
  rate_rule_id uuid NOT NULL REFERENCES commission_rate_rule(id) ON DELETE RESTRICT,
  basis_points integer NOT NULL CHECK (basis_points BETWEEN 2000 AND 3500),
  cash_merchandise_cents bigint NOT NULL CHECK (cash_merchandise_cents BETWEEN 0 AND 9900000000),
  source_kind text NOT NULL CHECK (source_kind IN ('synthetic_nonproduction','verified_commerce')),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (buyer_member_id<>referrer_member_id)
);
CREATE INDEX commission_order_snapshot_referrer ON commission_order_snapshot(referrer_member_id,created_at DESC);

-- Append-only cash ledger; points have their own existing ledger. No endpoint
-- in this release inserts an accrual without independently verified payment.
CREATE TABLE commission_ledger_entry (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES commission_order_snapshot(order_id) ON DELETE RESTRICT,
  referrer_member_id uuid NOT NULL REFERENCES member(id) ON DELETE RESTRICT,
  event_key text NOT NULL UNIQUE CHECK (char_length(event_key) BETWEEN 8 AND 200),
  kind text NOT NULL CHECK (kind IN ('accrual','refund_reversal','release','settlement','recovery')),
  amount_cents bigint NOT NULL CHECK (amount_cents <> 0 AND abs(amount_cents) <= 9900000000),
  reverse_of uuid REFERENCES commission_ledger_entry(id) ON DELETE RESTRICT,
  source_fact_id uuid NOT NULL,
  actor_principal_id text NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind='refund_reversal') = (reverse_of IS NOT NULL))
);
CREATE INDEX commission_ledger_referrer ON commission_ledger_entry(referrer_member_id,occurred_at DESC,id DESC);
CREATE INDEX commission_ledger_order ON commission_ledger_entry(order_id,occurred_at,id);

CREATE FUNCTION guard_commercial_referral_code() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' OR (NEW.member_id,NEW.code,NEW.created_at) IS DISTINCT FROM (OLD.member_id,OLD.code,OLD.created_at)
    OR OLD.state='disabled' AND NEW IS DISTINCT FROM OLD
  THEN RAISE EXCEPTION 'REFERRAL_CODE_IDENTITY_IMMUTABLE' USING ERRCODE='55000'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER commercial_referral_code_guard BEFORE UPDATE OR DELETE ON commercial_referral_code
FOR EACH ROW EXECUTE FUNCTION guard_commercial_referral_code();

CREATE FUNCTION guard_commission_rate_rule() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' OR (NEW.member_id,NEW.basis_points,NEW.effective_at,NEW.created_by,NEW.reason,NEW.created_at)
     IS DISTINCT FROM (OLD.member_id,OLD.basis_points,OLD.effective_at,OLD.created_by,OLD.reason,OLD.created_at)
     OR OLD.state<>'proposed' AND NEW IS DISTINCT FROM OLD
     OR OLD.state='proposed' AND NEW.state NOT IN ('active','rejected')
  THEN RAISE EXCEPTION 'COMMISSION_RATE_RULE_IMMUTABLE' USING ERRCODE='55000'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER commission_rate_rule_guard BEFORE UPDATE OR DELETE ON commission_rate_rule
FOR EACH ROW EXECUTE FUNCTION guard_commission_rate_rule();

CREATE FUNCTION commercial_evidence_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'COMMERCIAL_EVIDENCE_IMMUTABLE' USING ERRCODE='55000'; END $$;
CREATE TRIGGER commercial_membership_event_immutable BEFORE UPDATE OR DELETE ON commercial_membership_event FOR EACH ROW EXECUTE FUNCTION commercial_evidence_immutable();
CREATE TRIGGER commercial_referral_relation_immutable BEFORE UPDATE OR DELETE ON commercial_referral_relation FOR EACH ROW EXECUTE FUNCTION commercial_evidence_immutable();
CREATE TRIGGER commission_order_snapshot_immutable BEFORE UPDATE OR DELETE ON commission_order_snapshot FOR EACH ROW EXECUTE FUNCTION commercial_evidence_immutable();
CREATE TRIGGER commission_ledger_entry_immutable BEFORE UPDATE OR DELETE ON commission_ledger_entry FOR EACH ROW EXECUTE FUNCTION commercial_evidence_immutable();

-- migrate:down
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM commercial_membership) OR EXISTS(SELECT 1 FROM commercial_referral_code)
    OR EXISTS(SELECT 1 FROM commercial_referral_relation) OR EXISTS(SELECT 1 FROM commission_order_snapshot)
    OR EXISTS(SELECT 1 FROM commission_ledger_entry) OR EXISTS(SELECT 1 FROM commission_rate_rule WHERE created_by<>'migration')
  THEN RAISE EXCEPTION 'COMMERCIAL_ROLLBACK_REQUIRES_DATA_PRESERVATION'; END IF;
END $$;
DROP TRIGGER commission_ledger_entry_immutable ON commission_ledger_entry;
DROP TRIGGER commission_order_snapshot_immutable ON commission_order_snapshot;
DROP TRIGGER commercial_referral_relation_immutable ON commercial_referral_relation;
DROP TRIGGER commercial_membership_event_immutable ON commercial_membership_event;
DROP TRIGGER commission_rate_rule_guard ON commission_rate_rule;
DROP FUNCTION guard_commission_rate_rule();
DROP TRIGGER commercial_referral_code_guard ON commercial_referral_code;
DROP FUNCTION guard_commercial_referral_code();
DROP TRIGGER commercial_referral_relation_guard ON commercial_referral_relation;
DROP FUNCTION guard_commercial_referral_relation();
DROP FUNCTION commercial_evidence_immutable();
DROP TABLE commission_ledger_entry,commission_order_snapshot,commission_rate_rule,commercial_referral_relation,commercial_referral_code,commercial_membership_event,commercial_membership;
ALTER TABLE authority_grant DROP CONSTRAINT authority_grant_capability_check;
ALTER TABLE authority_grant ADD CONSTRAINT authority_grant_capability_check CHECK (capability IN (
  'support.read','support.reply','support.assign',
  'commerce.product.manage','commerce.qualification.manage','commerce.inventory.manage','commerce.order.read',
  'commerce.fulfillment.manage','commerce.refund.approve',
  'community.moderate','member.support_view','privacy.request.manage'
));
