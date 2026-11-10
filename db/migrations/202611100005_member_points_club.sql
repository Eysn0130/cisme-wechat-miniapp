-- One points wallet. Existing grants, entries, lots and member balances remain
-- the authority. This migration adopts the owner-approved rule prospectively;
-- it issues no historical reward.
ALTER TABLE points_grant ALTER COLUMN reward_claim_id DROP NOT NULL;
ALTER TABLE points_grant ADD COLUMN source_type text,
  ADD COLUMN source_id text, ADD COLUMN component text,
  ADD COLUMN rule_version text, ADD COLUMN rule_snapshot jsonb,
  ADD COLUMN reversed_total integer NOT NULL DEFAULT 0 CHECK(reversed_total>=0 AND reversed_total<=amount);
CREATE UNIQUE INDEX points_grant_source_component ON points_grant(member_id,source_type,source_id,component)
  WHERE source_type IS NOT NULL;
ALTER TABLE points_lot DROP CONSTRAINT points_lot_conservation_check;
ALTER TABLE points_lot ADD COLUMN reserved_amount integer NOT NULL DEFAULT 0 CHECK(reserved_amount>=0),
  ADD COLUMN used_amount integer NOT NULL DEFAULT 0 CHECK(used_amount>=0),
  ADD COLUMN offset_amount integer NOT NULL DEFAULT 0 CHECK(offset_amount>=0),
  ADD CONSTRAINT points_lot_conservation_check CHECK(original_amount=frozen_amount+available_amount+expired_amount+reversed_amount+reserved_amount+used_amount+offset_amount);
ALTER TABLE points_lot ADD COLUMN invalid_reserved integer NOT NULL DEFAULT 0 CHECK(invalid_reserved>=0 AND invalid_reserved<=reserved_amount),
 ADD COLUMN invalid_used integer NOT NULL DEFAULT 0 CHECK(invalid_used>=0 AND invalid_used<=used_amount),
 ADD COLUMN invalid_offset integer NOT NULL DEFAULT 0 CHECK(invalid_offset>=0 AND invalid_offset<=offset_amount);
ALTER TABLE points_projection ADD COLUMN reserved integer NOT NULL DEFAULT 0 CHECK(reserved>=0);
CREATE TABLE points_transaction(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), member_id uuid NOT NULL REFERENCES member(id),
  business_key text NOT NULL UNIQUE, kind text NOT NULL,
  reverse_of uuid REFERENCES points_transaction(id), occurred_at timestamptz NOT NULL,
  actor_principal_id text NOT NULL, rule_version text, reason text NOT NULL
);
CREATE TRIGGER points_transaction_immutable BEFORE UPDATE OR DELETE ON points_transaction
  FOR EACH ROW EXECUTE FUNCTION reject_points_entry_mutation();
ALTER TABLE points_entry DROP CONSTRAINT points_entry_entry_type_check;
ALTER TABLE points_entry ADD CONSTRAINT points_entry_entry_type_check CHECK(entry_type IN
  ('grant_frozen','grant_available','unfreeze','expire','reversal','adjustment','debt_created','debt_offset','reserve','release','spend','refund_return'));
ALTER TABLE points_entry ADD COLUMN transaction_id uuid REFERENCES points_transaction(id),
  ADD COLUMN reserved_delta integer NOT NULL DEFAULT 0,
  ADD COLUMN used_delta integer NOT NULL DEFAULT 0,
  ADD COLUMN expired_delta integer NOT NULL DEFAULT 0;
CREATE INDEX points_lot_expiry_fefo ON points_lot(expires_at,id) WHERE available_amount>0 OR frozen_amount>0;

CREATE TABLE member_points_policy(
  version text PRIMARY KEY CHECK(length(version) BETWEEN 8 AND 80),
  rules jsonb NOT NULL CHECK(jsonb_typeof(rules)='object'),
  monthly_budget integer CHECK(monthly_budget BETWEEN 1 AND 100000000),
  state text NOT NULL DEFAULT 'draft' CHECK(state IN ('draft','active','retired')),
  starts_at timestamptz NOT NULL, ends_at timestamptz CHECK(ends_at>starts_at),
  created_by uuid REFERENCES member(id),created_at timestamptz NOT NULL DEFAULT now(),
  approved_by uuid REFERENCES member(id),approved_at timestamptz,approval_evidence text,retired_at timestamptz,
  approval_source text NOT NULL DEFAULT 'management_review' CHECK(approval_source IN ('management_review','owner_instruction_20261110')),
  CHECK((state='draft' AND approved_by IS NULL AND approved_at IS NULL AND created_by IS NOT NULL) OR
    (state<>'draft' AND approved_at IS NOT NULL AND length(btrim(approval_evidence))>=8 AND
      (approval_source='management_review' AND approved_by IS NOT NULL AND approved_by<>created_by OR
       approval_source='owner_instruction_20261110' AND created_by IS NULL AND approved_by IS NULL)))
);
CREATE UNIQUE INDEX member_points_one_active_policy ON member_points_policy((true)) WHERE state='active';
CREATE TABLE member_points_budget(
  policy_version text NOT NULL REFERENCES member_points_policy(version),month_bucket text NOT NULL,
  issued bigint NOT NULL DEFAULT 0 CHECK(issued>=0), PRIMARY KEY(policy_version,month_bucket)
);
CREATE TABLE member_points_wallet_check(
 member_id uuid PRIMARY KEY REFERENCES member(id),projection_version integer NOT NULL,
 status text NOT NULL CHECK(status IN ('balanced','mismatch')),detail jsonb NOT NULL,checked_at timestamptz NOT NULL
);
CREATE TABLE member_points_source_event(
  id bigserial PRIMARY KEY, kind text NOT NULL, source_id text NOT NULL,
  member_id uuid NOT NULL REFERENCES member(id), occurred_at timestamptz NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}',state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','applied','skipped')),
  attempts integer NOT NULL DEFAULT 0,next_attempt_at timestamptz NOT NULL DEFAULT now(),last_error text,
  processed_at timestamptz, UNIQUE(kind,source_id)
);
CREATE INDEX member_points_source_pending ON member_points_source_event(next_attempt_at,id) WHERE state='pending';
CREATE TABLE member_points_attendance(
  member_id uuid NOT NULL REFERENCES member(id),care_day date NOT NULL,
  first_source text NOT NULL,qualified_at timestamptz NOT NULL,
  PRIMARY KEY(member_id,care_day)
);
CREATE TABLE member_points_checkin(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),member_id uuid NOT NULL REFERENCES member(id),
  care_day date NOT NULL,products text[] NOT NULL CHECK(cardinality(products) BETWEEN 1 AND 3),
  note_encrypted text NOT NULL DEFAULT '',key_version text,note_qualifies boolean NOT NULL DEFAULT false,
  version integer NOT NULL DEFAULT 1,operation_id text NOT NULL,request_sha256 text NOT NULL,
  created_at timestamptz NOT NULL,updated_at timestamptz NOT NULL,
  UNIQUE(member_id,care_day),UNIQUE(member_id,operation_id),
  CHECK(products<@ARRAY['net_run','net_xie','essence']::text[])
);
CREATE TABLE member_points_command(
  member_id uuid NOT NULL REFERENCES member(id),operation_id text NOT NULL,
  action text NOT NULL,source_id uuid NOT NULL,request_sha256 text NOT NULL,created_at timestamptz NOT NULL,
  PRIMARY KEY(member_id,operation_id)
);
CREATE TRIGGER member_points_command_immutable BEFORE UPDATE OR DELETE ON member_points_command
  FOR EACH ROW EXECUTE FUNCTION reject_points_entry_mutation();
CREATE TABLE member_points_profile(
  member_id uuid PRIMARY KEY REFERENCES member(id),birthday_month_day text,
  birthday_set_at timestamptz,birthday_change_after timestamptz,updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK(birthday_month_day IS NULL OR birthday_month_day ~ '^(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$')
);
CREATE TABLE member_points_badge(
  member_id uuid NOT NULL REFERENCES member(id),code text NOT NULL,earned_at timestamptz NOT NULL,
  PRIMARY KEY(member_id,code)
);
CREATE TABLE member_points_featured(
  post_id uuid PRIMARY KEY REFERENCES ugc_post(id),selected_by uuid NOT NULL REFERENCES member(id),
  selected_at timestamptz NOT NULL DEFAULT now(),reason text NOT NULL CHECK(length(btrim(reason))>=4)
);
CREATE TABLE member_points_referral(
  member_id uuid PRIMARY KEY REFERENCES member(id),referrer_member_id uuid NOT NULL REFERENCES member(id),
  share_attribution_id uuid NOT NULL UNIQUE REFERENCES share_attribution(id),created_at timestamptz NOT NULL,
  CHECK(member_id<>referrer_member_id)
);
CREATE TABLE member_points_reward_fingerprint(
  member_id uuid NOT NULL REFERENCES member(id),kind text NOT NULL,fingerprint text NOT NULL,
  source_id text NOT NULL,PRIMARY KEY(member_id,kind,fingerprint)
);
-- The owner retained the two advertised product promotions on 2026-11-10.
-- New ordinary products default to base 1x; authorized product operators may
-- explicitly select 3x. Quote/order snapshots preserve existing buyer rights.
ALTER TABLE catalog_product ADD COLUMN shopping_points_multiplier smallint NOT NULL DEFAULT 1 CHECK(shopping_points_multiplier IN (1,3));
CREATE FUNCTION initialize_catalog_points_multiplier() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.source_kind='admin' AND NEW.code IN ('aigerong-moisture-shampoo-280','aigerong-scalp-repair-essence-100') THEN NEW.shopping_points_multiplier:=3;END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER catalog_points_multiplier_initial BEFORE INSERT ON catalog_product FOR EACH ROW EXECUTE FUNCTION initialize_catalog_points_multiplier();
WITH changed AS (
 UPDATE catalog_product SET shopping_points_multiplier=3,version=version+1,updated_at=clock_timestamp(),updated_by='system:owner-instruction-20261110'
 WHERE source_kind='admin' AND code IN ('aigerong-moisture-shampoo-280','aigerong-scalp-repair-essence-100') RETURNING id,code,version
) INSERT INTO audit_log(principal_id,action,object_type,object_id,reason_code,before_state,after_state,trace_id)
 SELECT 'system:owner-instruction-20261110','points.catalog_promotion_adopted','catalog_product',id,'OWNER_ADVERTISED_3X',
  jsonb_build_object('shoppingPointsMultiplier',1,'version',version-1),jsonb_build_object('shoppingPointsMultiplier',3,'version',version,'productCode',code),gen_random_uuid()::text FROM changed;
ALTER TABLE commerce_checkout_quote ADD COLUMN shopping_points_multiplier smallint NOT NULL DEFAULT 1 CHECK(shopping_points_multiplier IN (1,3)), ADD COLUMN points_spent integer NOT NULL DEFAULT 0 CHECK(points_spent>=0),
  ADD COLUMN points_policy_version text REFERENCES member_points_policy(version),
  ADD COLUMN points_offer_version integer, ADD COLUMN points_maximum integer NOT NULL DEFAULT 0 CHECK(points_maximum>=0);
ALTER TABLE commerce_order ADD COLUMN shopping_points_multiplier smallint NOT NULL DEFAULT 1 CHECK(shopping_points_multiplier IN (1,3)), ADD COLUMN points_spent integer NOT NULL DEFAULT 0 CHECK(points_spent>=0),
  ADD COLUMN points_policy_version text REFERENCES member_points_policy(version),
  ADD COLUMN points_birthday_month smallint CHECK(points_birthday_month BETWEEN 1 AND 12);
-- Points and optional birthday snapshots are evidence, never mutable switches.
CREATE FUNCTION protect_commerce_points_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (NEW.points_spent,NEW.points_policy_version,NEW.shopping_points_multiplier) IS DISTINCT FROM (OLD.points_spent,OLD.points_policy_version,OLD.shopping_points_multiplier)
  OR (TG_TABLE_NAME='commerce_order' AND (to_jsonb(NEW)->'points_birthday_month') IS DISTINCT FROM (to_jsonb(OLD)->'points_birthday_month'))
  OR (TG_TABLE_NAME='commerce_checkout_quote' AND (to_jsonb(NEW)->'points_offer_version',to_jsonb(NEW)->'points_maximum') IS DISTINCT FROM (to_jsonb(OLD)->'points_offer_version',to_jsonb(OLD)->'points_maximum'))
 THEN RAISE EXCEPTION 'COMMERCE_POINTS_SNAPSHOT_IMMUTABLE';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER commerce_order_points_snapshot BEFORE UPDATE ON commerce_order FOR EACH ROW EXECUTE FUNCTION protect_commerce_points_snapshot();
CREATE TRIGGER commerce_quote_points_snapshot BEFORE UPDATE ON commerce_checkout_quote FOR EACH ROW EXECUTE FUNCTION protect_commerce_points_snapshot();
CREATE TABLE member_points_allocation(
  order_id uuid NOT NULL REFERENCES commerce_order(id),lot_id uuid NOT NULL REFERENCES points_lot(id),
  amount integer NOT NULL CHECK(amount>0),state text NOT NULL CHECK(state IN ('reserved','spent','released')),
  returned integer NOT NULL DEFAULT 0 CHECK(returned>=0 AND returned<=amount),
  PRIMARY KEY(order_id,lot_id)
);
CREATE TABLE member_points_redemption(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),member_id uuid NOT NULL REFERENCES member(id),sku_id uuid NOT NULL REFERENCES catalog_sku(id),
  policy_version text NOT NULL REFERENCES member_points_policy(version),offer_version integer NOT NULL,
  quantity integer NOT NULL CHECK(quantity BETWEEN 1 AND 99),points_cost integer NOT NULL CHECK(points_cost>0),
  item_snapshot jsonb NOT NULL,encrypted_address text NOT NULL,address_hmac text NOT NULL,key_version text NOT NULL,
  state text NOT NULL DEFAULT 'placed' CHECK(state IN ('placed','shipped','received','cancelled','return_requested','returned')),
  version integer NOT NULL DEFAULT 1,operation_id text NOT NULL,request_sha256 text NOT NULL,
  carrier_name text,tracking_number text,created_at timestamptz NOT NULL,updated_at timestamptz NOT NULL,
  UNIQUE(member_id,operation_id)
);
CREATE TABLE member_points_gift_allocation(
  redemption_id uuid NOT NULL REFERENCES member_points_redemption(id),lot_id uuid NOT NULL REFERENCES points_lot(id),
  amount integer NOT NULL CHECK(amount>0),returned boolean NOT NULL DEFAULT false,
  PRIMARY KEY(redemption_id,lot_id)
);
CREATE TABLE member_points_redemption_event(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),redemption_id uuid NOT NULL REFERENCES member_points_redemption(id),
  action text NOT NULL,operation_id text NOT NULL UNIQUE,actor_member_id uuid NOT NULL REFERENCES member(id),
  request_sha256 text NOT NULL,reason text NOT NULL,occurred_at timestamptz NOT NULL
);
CREATE TRIGGER member_points_redemption_event_immutable BEFORE UPDATE OR DELETE ON member_points_redemption_event
  FOR EACH ROW EXECUTE FUNCTION reject_points_entry_mutation();

CREATE FUNCTION guard_member_points_policy() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' OR (OLD.version,OLD.rules,OLD.monthly_budget,OLD.starts_at,OLD.ends_at,OLD.created_by,OLD.created_at,OLD.approval_source)
  IS DISTINCT FROM (NEW.version,NEW.rules,NEW.monthly_budget,NEW.starts_at,NEW.ends_at,NEW.created_by,NEW.created_at,NEW.approval_source)
  OR (OLD.state<>'draft' AND (OLD.approved_by,OLD.approved_at,OLD.approval_evidence) IS DISTINCT FROM (NEW.approved_by,NEW.approved_at,NEW.approval_evidence))
  OR (OLD.retired_at IS DISTINCT FROM NEW.retired_at AND NOT(OLD.state='active' AND NEW.state='retired' AND OLD.retired_at IS NULL AND NEW.retired_at>OLD.starts_at))
  OR NOT(NEW.state=OLD.state OR OLD.state='draft' AND NEW.state='active' OR OLD.state='active' AND NEW.state='retired')
 THEN RAISE EXCEPTION 'POINTS_POLICY_HISTORY_IMMUTABLE';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER member_points_policy_history BEFORE UPDATE OR DELETE ON member_points_policy
 FOR EACH ROW EXECUTE FUNCTION guard_member_points_policy();

-- Durable, transaction-local event capture. The worker always re-reads original
-- sources and their policy window; queued data cannot grant itself authority.
CREATE FUNCTION capture_member_points_source() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE event_kind text;source_key text;owner_id uuid;event_time timestamptz;info jsonb:='{}';
BEGIN
  IF TG_TABLE_NAME='daily_care_record' THEN
    IF TG_OP<>'INSERT' THEN RETURN NEW; END IF;
    event_kind:='care';source_key:=NEW.id::text;owner_id:=NEW.member_id;event_time:=NEW.completed_at;
  ELSIF TG_TABLE_NAME='care_record_step' THEN
    IF NEW.step_code<>'03' OR NEW.sequence<>3 THEN RETURN NEW;END IF;
    event_kind:='care_cycle';source_key:=NEW.record_id::text;
    SELECT c.member_id,r.completed_at INTO owner_id,event_time FROM care_record r JOIN care_cycle c ON c.id=r.cycle_id WHERE r.id=NEW.record_id;
  ELSIF TG_TABLE_NAME='member_care_profile' THEN
    IF NEW.completed_at IS NULL OR (TG_OP='UPDATE' AND OLD.completed_at IS NOT NULL) THEN RETURN NEW;END IF;
    event_kind:='questionnaire';source_key:=NEW.member_id::text;owner_id:=NEW.member_id;event_time:=NEW.completed_at;
  ELSIF TG_TABLE_NAME='ugc_post' THEN
    IF NEW.state='published' AND NEW.visibility='public' AND (TG_OP='INSERT' OR OLD.published_at IS NULL) THEN
      event_kind:='post';source_key:=NEW.id::text;owner_id:=NEW.author_member_id;event_time:=NEW.published_at;
    ELSIF TG_OP='UPDATE' AND OLD.state='published' AND NEW.state<>'published' THEN
      event_kind:='post_removed';source_key:=NEW.id::text;owner_id:=NEW.author_member_id;event_time:=NEW.updated_at;
    ELSE RETURN NEW;END IF;
  ELSIF TG_TABLE_NAME IN ('ugc_comment','editorial_comment') THEN
    IF NEW.state='published' AND (TG_OP='INSERT' OR OLD.state='pending_review') THEN event_kind:='comment';
    ELSIF TG_OP='UPDATE' AND OLD.state='published' AND NEW.state<>'published' THEN event_kind:='comment_removed';
    ELSE RETURN NEW;END IF;
    source_key:=TG_TABLE_NAME||':'||NEW.id::text;owner_id:=NEW.author_member_id;event_time:=NEW.updated_at;info:=jsonb_build_object('table',TG_TABLE_NAME,'id',NEW.id);
  ELSIF TG_TABLE_NAME='commerce_shipment' THEN
    IF NEW.receipt_confirmed_at IS NULL OR (TG_OP='UPDATE' AND OLD.receipt_confirmed_at IS NOT NULL) THEN RETURN NEW;END IF;
    event_kind:='receipt';source_key:=NEW.order_id::text;event_time:=NEW.receipt_confirmed_at;
    SELECT member_id INTO owner_id FROM commerce_order WHERE id=NEW.order_id;
  ELSIF TG_TABLE_NAME='commission_refund_inbox' THEN
    IF NEW.state<>'applied' OR NEW.refund_status<>'SUCCESS' OR (TG_OP='UPDATE' AND OLD.state='applied') THEN RETURN NEW;END IF;
    event_kind:='refund';source_key:=NEW.id::text;event_time:=NEW.applied_at;
    SELECT o.member_id,jsonb_build_object('orderId',o.id) INTO owner_id,info FROM commerce_order o
      JOIN commission_refund_intent i ON i.order_id=o.id WHERE i.id=NEW.refund_intent_id;
  ELSE RETURN NEW;END IF;
  INSERT INTO member_points_source_event(kind,source_id,member_id,occurred_at,payload)
    VALUES(event_kind,source_key,owner_id,event_time,info) ON CONFLICT DO NOTHING;
  IF event_kind IN ('care','care_cycle') AND (event_kind='care' AND to_jsonb(NEW)->'step_codes'='["00","01","02","03"]'::jsonb AND to_jsonb(NEW)->>'self_assessment' IS NOT NULL
    OR event_kind='care_cycle' AND EXISTS(SELECT 1 FROM care_record r WHERE r.id=(to_jsonb(NEW)->>'record_id')::uuid AND r.self_assessment IS NOT NULL
      AND (SELECT array_agg(s.step_code ORDER BY s.sequence) FROM care_record_step s WHERE s.record_id=r.id)=ARRAY['00','01','02','03']::text[])) AND EXISTS(SELECT 1 FROM member_points_policy WHERE approved_at IS NOT NULL
    AND starts_at<=event_time AND (ends_at IS NULL OR ends_at>event_time) AND (retired_at IS NULL OR retired_at>event_time)) THEN
    INSERT INTO member_points_attendance(member_id,care_day,first_source,qualified_at)
      VALUES(owner_id,(event_time AT TIME ZONE 'Asia/Shanghai')::date,source_key,event_time) ON CONFLICT DO NOTHING;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER member_points_daily AFTER INSERT ON daily_care_record FOR EACH ROW EXECUTE FUNCTION capture_member_points_source();
CREATE TRIGGER member_points_cycle AFTER INSERT ON care_record_step FOR EACH ROW EXECUTE FUNCTION capture_member_points_source();
CREATE TRIGGER member_points_questionnaire AFTER INSERT OR UPDATE OF completed_at ON member_care_profile FOR EACH ROW EXECUTE FUNCTION capture_member_points_source();
CREATE TRIGGER member_points_post AFTER INSERT OR UPDATE OF state ON ugc_post FOR EACH ROW EXECUTE FUNCTION capture_member_points_source();
CREATE TRIGGER member_points_comment AFTER INSERT OR UPDATE OF state ON ugc_comment FOR EACH ROW EXECUTE FUNCTION capture_member_points_source();
CREATE TRIGGER member_points_editorial_comment AFTER INSERT OR UPDATE OF state ON editorial_comment FOR EACH ROW EXECUTE FUNCTION capture_member_points_source();
CREATE TRIGGER member_points_receipt AFTER INSERT OR UPDATE OF receipt_confirmed_at ON commerce_shipment FOR EACH ROW EXECUTE FUNCTION capture_member_points_source();
CREATE TRIGGER member_points_refund AFTER INSERT OR UPDATE OF state ON commission_refund_inbox FOR EACH ROW EXECUTE FUNCTION capture_member_points_source();

-- New ordinary comments complete the active engagement loop after real
-- automated safety. Preserve every historical pending/private decision.
CREATE TABLE ugc_comment_direct_publication_policy(
 version text PRIMARY KEY,activated_at timestamptz NOT NULL,decision_source text NOT NULL,evidence text NOT NULL
);
INSERT INTO ugc_comment_direct_publication_policy VALUES('safe-direct-20261110-v1',clock_timestamp(),
 'implementation_decision_under_owner_formal_closure_20261110',
 '本轮用户要求按现行PRD完整交付积分活跃和正式功能；仅新提交的普通社区评论在真实微信安全通过后直接发表，历史待审及私人材料不回填公开。');
CREATE TRIGGER ugc_comment_direct_publication_policy_immutable BEFORE UPDATE OR DELETE ON ugc_comment_direct_publication_policy
 FOR EACH ROW EXECUTE FUNCTION reject_points_entry_mutation();

-- The owner explicitly adopted the attached guide and authorized formal
-- activation, repeated 7/30-day rewards and all future published products.
-- This is a system policy provenance, never a synthetic operator/member grant.
-- Existing records predate starts_at and do not receive a backfill.
INSERT INTO member_points_policy(version,rules,monthly_budget,state,starts_at,ends_at,approved_at,approval_evidence,approval_source)
VALUES('club-owner-20261110-v1',
 '{"daily":10,"note":5,"streak7":50,"streak30":200,"post":50,"featured":100,"comment":5,"questionnaire":100,"firstOrder":300,"inviteSponsor":300,"inviteFriend":200,"postWeeklyLimit":2,"commentDailyLimit":2,"expiryMonths":12,"reminderDays":30,"discountBps":2000,"pointsPerYuan":100,"refundGraceDays":30,"birthdayMultiplier":2}',
 NULL,'active',clock_timestamp(),NULL,clock_timestamp(),
 '2026-11-10 本轮用户明确授权：按上传积分攻略、现行PRD与合理补充完成正式业务闭环；7天和30天循环叠加；纯积分兑换包含所有正常上架及未来商品；不增加文档未要求的商品白名单、限兑次数或硬性月预算。后续明确保留已宣传商品3倍购物积分，生日当月首单再翻倍，按下单快照及退款原倍率处理。','owner_instruction_20261110');

-- migrate:down
DO $$ BEGIN RAISE EXCEPTION 'MEMBER_POINTS_ROLLBACK_REQUIRES_ASSET_PRESERVATION';END $$;
