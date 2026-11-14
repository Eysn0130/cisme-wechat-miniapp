-- Free, reviewed sharing officers. No qualifications, money, unapproved
-- commercial rules, tax rates, or operator grants are seeded by this migration.
CREATE TABLE sharing_policy (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), version integer GENERATED ALWAYS AS IDENTITY UNIQUE,
 enabled boolean NOT NULL, attribution_days integer CHECK(attribution_days BETWEEN 1 AND 36500),
 priority text NOT NULL CHECK(priority IN ('first','last')), self_purchase boolean NOT NULL CHECK(self_purchase=false),
 basis_points integer NOT NULL CHECK(basis_points BETWEEN 0 AND 10000),
 release_days integer NOT NULL CHECK(release_days BETWEEN 0 AND 3650),
 reason text NOT NULL CHECK(char_length(btrim(reason)) BETWEEN 2 AND 300),
 created_by uuid REFERENCES member(id), created_principal text NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE sharing_officer (
 member_id uuid PRIMARY KEY REFERENCES member(id),
 referral_code text NOT NULL UNIQUE CHECK(referral_code ~ '^SO[A-Z0-9]{10}$'),
 state text NOT NULL CHECK(state IN ('pending','rejected','active','suspended','terminated')),
 application_note text NOT NULL DEFAULT '' CHECK(char_length(application_note)<=500),
 review_reason text NOT NULL DEFAULT '' CHECK(char_length(review_reason)<=300),
 version integer NOT NULL DEFAULT 1 CHECK(version>0),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE sharing_officer_event (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), member_id uuid NOT NULL REFERENCES sharing_officer(member_id),
 version integer NOT NULL, from_state text, to_state text NOT NULL, actor_id uuid NOT NULL REFERENCES member(id),
 reason text NOT NULL, occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(), UNIQUE(member_id,version)
);
CREATE TABLE sharing_link (
 share_id text PRIMARY KEY CHECK(share_id ~ '^[0-9a-f]{32}$'),
 officer_id uuid NOT NULL REFERENCES sharing_officer(member_id), product_code text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), UNIQUE(officer_id,product_code)
);
CREATE TABLE sharing_visit (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), share_id text NOT NULL REFERENCES sharing_link(share_id),
 visit_key text NOT NULL CHECK(char_length(visit_key) BETWEEN 16 AND 160),
 token_hash text NOT NULL UNIQUE, token_ciphertext text NOT NULL,
 visitor_id uuid REFERENCES member(id), visited_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 bound_at timestamptz, UNIQUE(share_id,visit_key)
);
CREATE INDEX sharing_visit_buyer ON sharing_visit(visitor_id,visited_at DESC,id);
CREATE TABLE sharing_customer_relation (
 buyer_id uuid PRIMARY KEY REFERENCES member(id), officer_id uuid NOT NULL REFERENCES sharing_officer(member_id),
 visit_id uuid REFERENCES sharing_visit(id), source text NOT NULL CHECK(source IN ('first_touch','last_touch','member_choice')),
 effective_at timestamptz NOT NULL, expires_at timestamptz, policy_id uuid NOT NULL REFERENCES sharing_policy(id),
 version integer NOT NULL DEFAULT 1, CHECK(buyer_id<>officer_id)
);
CREATE TABLE sharing_relation_event (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), buyer_id uuid NOT NULL REFERENCES member(id),
 version integer NOT NULL, from_officer_id uuid REFERENCES sharing_officer(member_id), to_officer_id uuid NOT NULL REFERENCES sharing_officer(member_id),
 visit_id uuid REFERENCES sharing_visit(id), source text NOT NULL, occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(), UNIQUE(buyer_id,version)
);
CREATE TABLE sharing_asset (
 share_id text PRIMARY KEY REFERENCES sharing_link(share_id), qr_png bytea, url_link text,
 url_expires_at timestamptz, updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE commission_order_snapshot ADD COLUMN program text NOT NULL DEFAULT 'legacy' CHECK(program IN ('legacy','sharing_officer'));
ALTER TABLE commission_order_snapshot ADD COLUMN sharing_policy_id uuid REFERENCES sharing_policy(id);
ALTER TABLE commission_order_snapshot ADD COLUMN sharing_visit_id uuid REFERENCES sharing_visit(id);
ALTER TABLE commission_order_snapshot ADD COLUMN sharing_relation_event_id uuid REFERENCES sharing_relation_event(id);

ALTER TABLE commission_order_snapshot ALTER COLUMN referral_code_id DROP NOT NULL;
ALTER TABLE commission_order_snapshot ALTER COLUMN rate_rule_id DROP NOT NULL;
ALTER TABLE commission_order_snapshot DROP CONSTRAINT commission_order_snapshot_check;
ALTER TABLE commission_order_snapshot ADD CONSTRAINT commission_program_shape CHECK(
 (program='legacy' AND referral_code_id IS NOT NULL AND rate_rule_id IS NOT NULL AND buyer_member_id<>referrer_member_id
  AND sharing_policy_id IS NULL AND sharing_visit_id IS NULL AND sharing_relation_event_id IS NULL)
 OR (program='sharing_officer' AND referral_code_id IS NULL AND rate_rule_id IS NULL
  AND sharing_policy_id IS NOT NULL AND sharing_relation_event_id IS NOT NULL));
CREATE TABLE sharing_payee (
 member_id uuid PRIMARY KEY REFERENCES sharing_officer(member_id), encrypted_payload text NOT NULL,
 version integer NOT NULL DEFAULT 1, updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE sharing_settlement_batch (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), period text NOT NULL UNIQUE CHECK(period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
 cutoff_at timestamptz NOT NULL, created_by uuid NOT NULL REFERENCES member(id), created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE sharing_settlement_line (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), batch_id uuid NOT NULL REFERENCES sharing_settlement_batch(id),
 member_id uuid NOT NULL REFERENCES sharing_officer(member_id),
 state text NOT NULL DEFAULT 'prepared' CHECK(state IN ('prepared','reviewed','paid','voided')),
 gross_cents bigint NOT NULL CHECK(gross_cents BETWEEN 1 AND 9900000000),
 tax_cents bigint CHECK(tax_cents>=0 AND tax_cents<=gross_cents),
 net_cents bigint GENERATED ALWAYS AS (gross_cents-tax_cents) STORED,
 tax_note text CHECK(char_length(tax_note) BETWEEN 1 AND 500),
 payee_version integer, payee_snapshot text,
 reviewed_by uuid REFERENCES member(id), reviewed_at timestamptz,
 paid_by uuid REFERENCES member(id), paid_at timestamptz, payment_reference text UNIQUE,
 payment_note text CHECK(char_length(payment_note)<=500),
 version integer NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK(state NOT IN ('reviewed','paid') OR (tax_cents IS NOT NULL AND tax_note IS NOT NULL AND reviewed_by IS NOT NULL)),
 CHECK(state<>'paid' OR (paid_by IS NOT NULL AND paid_at IS NOT NULL AND payment_reference IS NOT NULL))
);
CREATE UNIQUE INDEX sharing_settlement_active_member ON sharing_settlement_line(batch_id,member_id) WHERE state<>'voided';
CREATE TABLE sharing_settlement_allocation (
 line_id uuid NOT NULL REFERENCES sharing_settlement_line(id), order_id uuid NOT NULL REFERENCES commission_order_snapshot(order_id),
 amount_cents bigint NOT NULL CHECK(amount_cents BETWEEN 1 AND 9900000000), PRIMARY KEY(line_id,order_id)
);
CREATE TABLE sharing_recovery (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), order_id uuid NOT NULL REFERENCES commission_order_snapshot(order_id),
 amount_cents bigint NOT NULL CHECK(amount_cents BETWEEN 1 AND 9900000000),
 received_cents bigint NOT NULL CHECK(received_cents BETWEEN 0 AND 9900000000),
 tax_adjustment_cents bigint NOT NULL, note text NOT NULL CHECK(char_length(note) BETWEEN 2 AND 500),
 reference text NOT NULL UNIQUE CHECK(char_length(reference) BETWEEN 4 AND 160),
 actor_id uuid NOT NULL REFERENCES member(id), recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK(received_cents+tax_adjustment_cents=amount_cents)
);
CREATE TABLE sharing_command (
 actor_id uuid NOT NULL REFERENCES member(id), request_key text NOT NULL CHECK(char_length(request_key) BETWEEN 8 AND 160),
 required_capability text, request_hash text NOT NULL, response jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(actor_id,request_key)
);
-- Ordinary payout/credit paths must never allocate an officer's manual-only sources.
CREATE FUNCTION guard_sharing_manual_sources() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM commission_order_snapshot WHERE order_id=NEW.order_id AND program='sharing_officer') THEN
  RAISE EXCEPTION 'SHARING_MANUAL_SETTLEMENT_ONLY' USING ERRCODE='23514';
 END IF; RETURN NEW;
END $$;
CREATE TRIGGER sharing_no_legacy_payout BEFORE INSERT ON commission_settlement_allocation FOR EACH ROW EXECUTE FUNCTION guard_sharing_manual_sources();
CREATE TRIGGER sharing_no_credit_conversion BEFORE INSERT ON commission_credit_source FOR EACH ROW EXECUTE FUNCTION guard_sharing_manual_sources();
CREATE TRIGGER sharing_policy_immutable BEFORE UPDATE OR DELETE ON sharing_policy FOR EACH ROW EXECUTE FUNCTION commercial_evidence_immutable();
CREATE TRIGGER sharing_relation_event_immutable BEFORE UPDATE OR DELETE ON sharing_relation_event FOR EACH ROW EXECUTE FUNCTION commercial_evidence_immutable();
CREATE TRIGGER sharing_event_immutable BEFORE UPDATE OR DELETE ON sharing_officer_event FOR EACH ROW EXECUTE FUNCTION commercial_evidence_immutable();
CREATE TRIGGER sharing_recovery_immutable BEFORE UPDATE OR DELETE ON sharing_recovery FOR EACH ROW EXECUTE FUNCTION commercial_evidence_immutable();
CREATE TRIGGER sharing_allocation_immutable BEFORE UPDATE OR DELETE ON sharing_settlement_allocation FOR EACH ROW EXECUTE FUNCTION commercial_evidence_immutable();
CREATE TRIGGER sharing_command_immutable BEFORE UPDATE OR DELETE ON sharing_command FOR EACH ROW EXECUTE FUNCTION commercial_evidence_immutable();

CREATE FUNCTION guard_sharing_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.program='sharing_officer' AND NOT EXISTS(
  SELECT 1 FROM sharing_relation_event e JOIN sharing_policy p ON p.id=NEW.sharing_policy_id
  WHERE e.id=NEW.sharing_relation_event_id AND e.buyer_id=NEW.buyer_member_id AND e.to_officer_id=NEW.referrer_member_id
   AND e.visit_id IS NOT DISTINCT FROM NEW.sharing_visit_id AND p.basis_points=NEW.basis_points
   AND NEW.referrer_member_id<>NEW.buyer_member_id
 ) THEN RAISE EXCEPTION 'SHARING_SNAPSHOT_SOURCE_MISMATCH' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER sharing_snapshot_guard BEFORE INSERT ON commission_order_snapshot FOR EACH ROW EXECUTE FUNCTION guard_sharing_snapshot();

CREATE OR REPLACE FUNCTION guard_commission_release_source() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE program_kind text;
BEGIN
 IF NEW.kind<>'release' THEN RETURN NEW; END IF;
 SELECT program INTO program_kind FROM commission_order_snapshot WHERE order_id=NEW.order_id;
 IF program_kind='sharing_officer' THEN
  PERFORM id FROM commerce_order WHERE id=NEW.order_id FOR UPDATE;
  IF NOT EXISTS(SELECT 1 FROM commission_order_snapshot s JOIN commerce_order o ON o.id=s.order_id
    JOIN sharing_policy p ON p.id=s.sharing_policy_id JOIN commerce_shipment ship ON ship.order_id=s.order_id
    WHERE s.order_id=NEW.order_id AND s.referrer_member_id=NEW.referrer_member_id AND p.id=NEW.source_fact_id
     AND o.status='paid' AND s.source_kind='verified_commerce'
     AND ship.receipt_confirmed_at<=clock_timestamp()-make_interval(days=>p.release_days)
     AND NOT EXISTS(SELECT 1 FROM commission_payment_composition_observation x WHERE x.order_id=s.order_id)
     AND NOT EXISTS(SELECT 1 FROM commerce_wechat_receipt_observation w WHERE w.order_id=s.order_id AND w.in_complaint=true)
     AND NOT EXISTS(SELECT 1 FROM commerce_aftersale_case c LEFT JOIN commission_refund_intent ci ON ci.request_id=c.refund_request_id
       WHERE c.order_id=s.order_id AND c.state NOT IN ('cancelled','rejected') AND NOT(c.state='refund_pending' AND ci.state='succeeded'))
     AND NOT EXISTS(SELECT 1 FROM commerce_refund_request r LEFT JOIN commission_refund_intent i ON i.request_id=r.id
       WHERE r.order_id=s.order_id AND (r.state='requested' OR r.state='approved' AND (i.id IS NULL OR i.state IN ('prepared','abnormal'))))
   ) OR EXISTS(SELECT 1 FROM commission_ledger_entry WHERE order_id=NEW.order_id AND kind='release')
   OR NEW.amount_cents<>(SELECT COALESCE(sum(amount_cents),0) FROM commission_ledger_entry WHERE order_id=NEW.order_id AND kind IN ('accrual','refund_reversal'))
   OR NEW.amount_cents<=0
  THEN RAISE EXCEPTION 'SHARING_RELEASE_NOT_ELIGIBLE' USING ERRCODE='23514'; END IF;
 ELSE
  IF NOT EXISTS(SELECT 1 FROM commerce_fulfillment_attestation f JOIN commerce_order o ON o.id=f.order_id
   JOIN commission_order_snapshot s ON s.order_id=o.id WHERE f.id=NEW.source_fact_id AND f.state='verified'
    AND f.order_id=NEW.order_id AND o.status='paid' AND o.transaction_source_kind='verified_commerce'
    AND s.referrer_member_id=NEW.referrer_member_id)
  THEN RAISE EXCEPTION 'COMMISSION_VERIFIED_FULFILLMENT_REQUIRED' USING ERRCODE='23514'; END IF;
 END IF; RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION guard_commission_settlement_source() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.kind<>'settlement' THEN RETURN NEW; END IF;
 IF EXISTS(SELECT 1 FROM commission_order_snapshot WHERE order_id=NEW.order_id AND program='sharing_officer') THEN
  IF NOT EXISTS(SELECT 1 FROM sharing_settlement_line l JOIN sharing_settlement_allocation a ON a.line_id=l.id
   WHERE l.id=NEW.source_fact_id AND l.state='paid' AND l.member_id=NEW.referrer_member_id
    AND a.order_id=NEW.order_id AND a.amount_cents=NEW.amount_cents)
   OR EXISTS(SELECT 1 FROM commission_ledger_entry WHERE order_id=NEW.order_id AND source_fact_id=NEW.source_fact_id AND kind='settlement')
  THEN RAISE EXCEPTION 'SHARING_RECORDED_PAYMENT_REQUIRED' USING ERRCODE='23514'; END IF;
 ELSE
  IF NOT EXISTS(SELECT 1 FROM commission_transfer_fact f JOIN commission_settlement_request r ON r.id=f.request_id
   JOIN commission_settlement_allocation a ON a.request_id=r.id AND a.order_id=NEW.order_id
   WHERE f.id=NEW.source_fact_id AND f.state='SUCCESS' AND r.member_id=NEW.referrer_member_id AND a.amount_cents=NEW.amount_cents)
  THEN RAISE EXCEPTION 'SETTLEMENT_VERIFIED_TRANSFER_REQUIRED' USING ERRCODE='23514'; END IF;
 END IF; RETURN NEW;
END $$;
CREATE FUNCTION guard_sharing_settlement_line() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' OR OLD.state IN ('paid','voided') OR
  (NEW.id,NEW.batch_id,NEW.member_id,NEW.gross_cents,NEW.created_at) IS DISTINCT FROM (OLD.id,OLD.batch_id,OLD.member_id,OLD.gross_cents,OLD.created_at)
  OR NEW.version<>OLD.version+1 OR NEW.state NOT IN ('reviewed','paid','voided')
  OR (NEW.state='paid' AND OLD.state<>'reviewed')
 THEN RAISE EXCEPTION 'SHARING_SETTLEMENT_IMMUTABLE_OR_INVALID_TRANSITION' USING ERRCODE='55000'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER sharing_settlement_line_guard BEFORE UPDATE OR DELETE ON sharing_settlement_line FOR EACH ROW EXECUTE FUNCTION guard_sharing_settlement_line();
CREATE FUNCTION guard_sharing_allocation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE owner uuid; net bigint; released bigint; paid bigint; held bigint;
BEGIN
 PERFORM id FROM commerce_order WHERE id=NEW.order_id FOR UPDATE;
 SELECT s.referrer_member_id INTO owner FROM commission_order_snapshot s WHERE s.order_id=NEW.order_id AND s.program='sharing_officer' AND s.source_kind='verified_commerce';
 IF owner IS NULL OR NOT EXISTS(SELECT 1 FROM sharing_settlement_line l WHERE l.id=NEW.line_id AND l.member_id=owner AND l.state='prepared')
 THEN RAISE EXCEPTION 'SHARING_ALLOCATION_OWNER_MISMATCH' USING ERRCODE='23514'; END IF;
 SELECT COALESCE(sum(amount_cents) FILTER(WHERE kind IN ('accrual','refund_reversal')),0),COALESCE(sum(amount_cents) FILTER(WHERE kind='release'),0),COALESCE(sum(amount_cents) FILTER(WHERE kind='settlement'),0)
  INTO net,released,paid FROM commission_ledger_entry WHERE order_id=NEW.order_id;
 SELECT COALESCE(sum(a.amount_cents),0) INTO held FROM sharing_settlement_allocation a JOIN sharing_settlement_line l ON l.id=a.line_id WHERE a.order_id=NEW.order_id AND l.state IN ('prepared','reviewed');
 IF NEW.amount_cents>LEAST(net,released)-paid-held THEN RAISE EXCEPTION 'SHARING_ALLOCATION_EXCEEDS_AVAILABLE' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER sharing_allocation_guard BEFORE INSERT ON sharing_settlement_allocation FOR EACH ROW EXECUTE FUNCTION guard_sharing_allocation();

-- Owner explicitly selected permanent/first attribution and no self commission
-- on 2026-11-13; delegated the initial rate/release recommendation to Codex.
-- This is a disclosed initial product policy, never a fabricated member action.
INSERT INTO sharing_policy(enabled,attribution_days,priority,self_purchase,basis_points,release_days,reason,created_principal)
 VALUES(true,NULL,'first',false,1000,7,'用户确认永久首次归属、自购不计佣；委托采用首期10%、收货满7天且无进行中售后；可由后台修改','owner-authorized:20261113:sharing-officer');

-- migrate:down
-- Only the unused bootstrap can be removed. Any application, attribution,
-- command, batch, or financial source makes this forward-only in practice.
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM sharing_officer) OR EXISTS(SELECT 1 FROM sharing_settlement_batch)
  OR EXISTS(SELECT 1 FROM sharing_command) OR EXISTS(SELECT 1 FROM commission_order_snapshot WHERE program='sharing_officer')
  OR EXISTS(SELECT 1 FROM sharing_policy WHERE created_principal<>'owner-authorized:20261113:sharing-officer')
 THEN RAISE EXCEPTION 'SHARING_ROLLBACK_REQUIRES_DATA_PRESERVATION'; END IF;
END $$;
CREATE OR REPLACE FUNCTION guard_commission_release_source() RETURNS trigger LANGUAGE plpgsql AS $$
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
CREATE OR REPLACE FUNCTION guard_commission_settlement_source() RETURNS trigger LANGUAGE plpgsql AS $$
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
DROP TRIGGER sharing_snapshot_guard ON commission_order_snapshot;
DROP TRIGGER sharing_no_legacy_payout ON commission_settlement_allocation;
DROP TRIGGER sharing_no_credit_conversion ON commission_credit_source;
ALTER TABLE commission_order_snapshot DROP CONSTRAINT commission_program_shape;
ALTER TABLE commission_order_snapshot DROP COLUMN sharing_relation_event_id,DROP COLUMN sharing_visit_id,DROP COLUMN sharing_policy_id,DROP COLUMN program;
ALTER TABLE commission_order_snapshot ALTER COLUMN referral_code_id SET NOT NULL,ALTER COLUMN rate_rule_id SET NOT NULL;
ALTER TABLE commission_order_snapshot ADD CONSTRAINT commission_order_snapshot_check CHECK(buyer_member_id<>referrer_member_id);
DROP TABLE sharing_recovery,sharing_settlement_allocation,sharing_settlement_line,sharing_settlement_batch,sharing_payee,sharing_asset,sharing_customer_relation,sharing_relation_event,sharing_visit,sharing_link,sharing_officer_event,sharing_officer,sharing_policy,sharing_command;
DROP FUNCTION guard_sharing_snapshot(),guard_sharing_manual_sources(),guard_sharing_settlement_line(),guard_sharing_allocation();
