ALTER TABLE authority_grant DROP CONSTRAINT authority_grant_capability_check;
ALTER TABLE authority_grant ADD CONSTRAINT authority_grant_capability_check CHECK (capability IN (
  'support.read','support.reply','support.assign',
  'commerce.product.manage','commerce.qualification.manage','commerce.inventory.manage','commerce.order.read',
  'commerce.aftersale.review','commerce.return.receive','commerce.return.inspect','commerce.fulfillment.manage','commerce.refund.approve','commerce.money.reconcile',
  'community.moderate','member.support_view','member.profile.read','member.manage',
  'commission.read','commission.rate.manage','commission.rate.approve',
  'commission.settlement.approve','privacy.request.manage'
));
-- PRD §8.2 / AFS-01..03: first release claims the whole order, one active
-- claim at a time. Refund, physical return and inventory are separate facts.
CREATE TABLE commerce_aftersale_case (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES commerce_order(id) ON DELETE RESTRICT,
  member_id uuid NOT NULL REFERENCES member(id) ON DELETE RESTRICT,
  kind text NOT NULL CHECK (kind IN ('refund_only','return_refund')),
  state text NOT NULL DEFAULT 'requested' CHECK (state IN
    ('requested','need_info','awaiting_return','return_in_transit','return_received','quality_checked','refund_pending','rejected','cancelled')),
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 3 AND 500),
  lines jsonb NOT NULL CHECK (jsonb_typeof(lines)='array' AND jsonb_array_length(lines)>0),
  amount_cents bigint NOT NULL CHECK (amount_cents BETWEEN 1 AND 9900000000),
  version integer NOT NULL DEFAULT 1 CHECK (version>0),
  idempotency_key text NOT NULL CHECK (char_length(idempotency_key) BETWEEN 8 AND 200),
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  return_destination jsonb,
  return_carrier text,
  return_tracking text,
  quality_result text CHECK (quality_result IN ('sellable','unsellable')),
  refund_request_id uuid UNIQUE REFERENCES commerce_refund_request(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(member_id,idempotency_key),
  CHECK ((return_carrier IS NULL)=(return_tracking IS NULL)),
  CHECK (return_carrier IS NULL OR char_length(return_carrier) BETWEEN 1 AND 80),
  CHECK (return_tracking IS NULL OR return_tracking ~ '^[A-Za-z0-9-]{6,64}$'),
  CHECK (kind='return_refund' OR (return_destination IS NULL AND return_tracking IS NULL AND quality_result IS NULL)),
  CHECK (state NOT IN ('awaiting_return','return_in_transit','return_received','quality_checked') OR kind='return_refund'),
  CHECK (state NOT IN ('awaiting_return','return_in_transit','return_received','quality_checked') OR return_destination IS NOT NULL),
  CHECK (state NOT IN ('return_in_transit','return_received','quality_checked') OR return_tracking IS NOT NULL),
  CHECK (state<>'quality_checked' OR quality_result IS NOT NULL),
  CHECK ((state='refund_pending')=(refund_request_id IS NOT NULL))
);
CREATE UNIQUE INDEX commerce_aftersale_one_active_order ON commerce_aftersale_case(order_id)
  WHERE state NOT IN ('rejected','cancelled');
CREATE INDEX commerce_aftersale_owner ON commerce_aftersale_case(member_id,created_at,id);
CREATE INDEX commerce_aftersale_queue ON commerce_aftersale_case(created_at,id);
CREATE TABLE commerce_aftersale_event (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id uuid NOT NULL REFERENCES commerce_aftersale_case(id) ON DELETE RESTRICT,
  actor_member_id uuid NOT NULL REFERENCES member(id) ON DELETE RESTRICT,
  action text NOT NULL CHECK (action IN ('request','cancel','provide_info','request_info','reject','approve_return','ship_return','receive_return','inspect_return','request_refund','reopen_refund')),
  note text NOT NULL CHECK (char_length(note) BETWEEN 3 AND 500),
  from_state text,
  to_state text NOT NULL,
  refund_request_id uuid REFERENCES commerce_refund_request(id) ON DELETE RESTRICT,
  case_version integer NOT NULL CHECK(case_version>0),
  idempotency_key text NOT NULL CHECK(char_length(idempotency_key) BETWEEN 8 AND 200),
  request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(actor_member_id,idempotency_key),
  UNIQUE(case_id,case_version)
);
CREATE FUNCTION guard_commerce_aftersale() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' OR NEW.version<>OLD.version+1 OR
    (NEW.id,NEW.order_id,NEW.member_id,NEW.kind,NEW.reason,NEW.lines,NEW.amount_cents,NEW.idempotency_key,NEW.request_hash,NEW.created_at)
      IS DISTINCT FROM
    (OLD.id,OLD.order_id,OLD.member_id,OLD.kind,OLD.reason,OLD.lines,OLD.amount_cents,OLD.idempotency_key,OLD.request_hash,OLD.created_at)
    OR OLD.state IN ('rejected','cancelled')
    OR OLD.return_destination IS NOT NULL AND NEW.return_destination IS DISTINCT FROM OLD.return_destination
    OR OLD.return_tracking IS NOT NULL AND (NEW.return_tracking,NEW.return_carrier) IS DISTINCT FROM (OLD.return_tracking,OLD.return_carrier)
    OR OLD.quality_result IS NOT NULL AND NEW.quality_result IS DISTINCT FROM OLD.quality_result
  THEN RAISE EXCEPTION 'AFTERSALE_FACT_IMMUTABLE' USING ERRCODE='55000'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER commerce_aftersale_guard BEFORE UPDATE OR DELETE ON commerce_aftersale_case
  FOR EACH ROW EXECUTE FUNCTION guard_commerce_aftersale();
CREATE FUNCTION guard_commerce_aftersale_event() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'AFTERSALE_EVENT_IMMUTABLE' USING ERRCODE='55000'; END $$;
CREATE TRIGGER commerce_aftersale_event_guard BEFORE UPDATE OR DELETE ON commerce_aftersale_event
  FOR EACH ROW EXECUTE FUNCTION guard_commerce_aftersale_event();
-- migrate:down
DO $$ BEGIN IF EXISTS(SELECT 1 FROM authority_grant WHERE capability IN ('commerce.aftersale.review','commerce.return.receive','commerce.return.inspect')) THEN RAISE EXCEPTION 'AFTERSALE_GRANTS_REQUIRE_DATA_PRESERVATION'; END IF; END $$;
ALTER TABLE authority_grant DROP CONSTRAINT authority_grant_capability_check;
ALTER TABLE authority_grant ADD CONSTRAINT authority_grant_capability_check CHECK (capability IN (
  'support.read','support.reply','support.assign',
  'commerce.product.manage','commerce.qualification.manage','commerce.inventory.manage','commerce.order.read',
  'commerce.fulfillment.manage','commerce.refund.approve','commerce.money.reconcile',
  'community.moderate','member.support_view','member.profile.read','member.manage',
  'commission.read','commission.rate.manage','commission.rate.approve',
  'commission.settlement.approve','privacy.request.manage'
));
DO $$ BEGIN IF EXISTS(SELECT 1 FROM commerce_aftersale_case) THEN
 RAISE EXCEPTION 'AFTERSALE_ROLLBACK_REQUIRES_DATA_PRESERVATION'; END IF; END $$;
DROP TABLE commerce_aftersale_event;
DROP TABLE commerce_aftersale_case;
DROP FUNCTION guard_commerce_aftersale_event();
DROP FUNCTION guard_commerce_aftersale();
