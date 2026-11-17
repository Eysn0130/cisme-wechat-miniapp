BEGIN;
-- Forward-only, owner-approved rules; every historical grant and order keeps its snapshot.
ALTER TABLE catalog_product ADD COLUMN points_discount_enabled boolean NOT NULL DEFAULT true,
 ADD COLUMN points_promotion_starts_at timestamptz,ADD COLUMN points_promotion_ends_at timestamptz,
 ADD CONSTRAINT catalog_points_promotion_window CHECK(points_promotion_ends_at IS NULL OR points_promotion_starts_at IS NOT NULL AND points_promotion_ends_at>points_promotion_starts_at);
ALTER TABLE catalog_sku ADD COLUMN points_price integer CHECK(points_price BETWEEN 1 AND 2147483647),
 ADD COLUMN points_redeemable boolean NOT NULL DEFAULT true,
 ADD COLUMN points_member_limit integer NOT NULL DEFAULT 0 CHECK(points_member_limit BETWEEN 0 AND 9999);
-- Existing published 3x promotions retain their explicitly approved finite launch window.
UPDATE catalog_product SET points_promotion_starts_at=clock_timestamp(),points_promotion_ends_at=clock_timestamp()+interval '30 days'
 WHERE shopping_points_multiplier=3;
CREATE FUNCTION effective_shopping_points_multiplier(product uuid,at timestamptz DEFAULT now()) RETURNS smallint LANGUAGE sql STABLE AS $$
 SELECT CASE WHEN COALESCE((SELECT rules->>'taskVersion' FROM member_points_policy WHERE approved_at IS NOT NULL AND starts_at<=at AND (retired_at IS NULL OR retired_at>at) ORDER BY starts_at DESC LIMIT 1),'1')<>'2' THEN p.shopping_points_multiplier
  WHEN p.shopping_points_multiplier=3 AND p.points_promotion_starts_at<=at AND p.points_promotion_ends_at>at THEN 3 ELSE 2 END::smallint FROM catalog_product p WHERE p.id=product
$$;
ALTER TABLE commerce_checkout_quote DROP CONSTRAINT commerce_checkout_quote_shopping_points_multiplier_check,
 ADD CONSTRAINT commerce_checkout_quote_shopping_points_multiplier_check CHECK(shopping_points_multiplier IN (1,2,3));
ALTER TABLE commerce_order DROP CONSTRAINT commerce_order_shopping_points_multiplier_check,
 ADD CONSTRAINT commerce_order_shopping_points_multiplier_check CHECK(shopping_points_multiplier IN (1,2,3));
ALTER TABLE ugc_post_revision ADD COLUMN reward_kind text NOT NULL DEFAULT 'original' CHECK(reward_kind IN ('original','experience')),
 ADD COLUMN experience_product_code text REFERENCES catalog_product(code),
 ADD COLUMN experience_days integer CHECK(experience_days BETWEEN 1 AND 36500);
CREATE FUNCTION preserve_ugc_reward_metadata() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF (NEW.reward_kind,NEW.experience_product_code,NEW.experience_days) IS DISTINCT FROM (OLD.reward_kind,OLD.experience_product_code,OLD.experience_days) THEN RAISE EXCEPTION 'UGC_REVISION_IMMUTABLE';END IF;RETURN NEW;END $$;
CREATE TRIGGER ugc_revision_reward_metadata_immutable BEFORE UPDATE OF reward_kind,experience_product_code,experience_days ON ugc_post_revision FOR EACH ROW EXECUTE FUNCTION preserve_ugc_reward_metadata();
ALTER TABLE commerce_order ADD COLUMN points_share_referrer uuid REFERENCES member(id),ADD COLUMN points_share_visit_id uuid REFERENCES share_visit(id);
CREATE FUNCTION snapshot_order_points_share() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE rule jsonb;
BEGIN
 IF TG_OP='UPDATE' THEN
  IF (NEW.points_share_referrer,NEW.points_share_visit_id) IS DISTINCT FROM (OLD.points_share_referrer,OLD.points_share_visit_id) THEN RAISE EXCEPTION 'ORDER_POINTS_SHARE_IMMUTABLE';END IF;
  RETURN NEW;
 END IF;
 SELECT rules INTO rule FROM member_points_policy WHERE version=NEW.points_policy_version AND approved_at IS NOT NULL;
 NEW.points_share_referrer:=NULL;NEW.points_share_visit_id:=NULL;
 IF rule->>'taskVersion'='2' AND (rule->>'shareOrder')::integer>0 THEN
  SELECT l.member_id,v.id INTO NEW.points_share_referrer,NEW.points_share_visit_id FROM share_visit v JOIN share_link l ON l.id=v.share_link_id
   JOIN member m ON m.id=l.member_id AND m.status='active'
   WHERE v.visitor_member_id=NEW.member_id AND l.member_id<>NEW.member_id AND l.state<>'revoked' AND v.first_seen_at<=NEW.created_at
    AND v.first_seen_at>=NEW.created_at-((rule->>'shareOrderWindowDays')::integer*interval '1 day')
   ORDER BY v.first_seen_at,v.id LIMIT 1;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER commerce_order_points_share BEFORE INSERT OR UPDATE ON commerce_order FOR EACH ROW EXECUTE FUNCTION snapshot_order_points_share();
CREATE TABLE member_points_suggestion(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),member_id uuid NOT NULL REFERENCES member(id),operation_id text NOT NULL,
 encrypted_body text NOT NULL,body_sha256 text NOT NULL CHECK(body_sha256 ~ '^[a-f0-9]{64}$'),key_version text NOT NULL,
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','approved','rejected')),version integer NOT NULL DEFAULT 1,
 review_reason text,reviewed_by uuid REFERENCES member(id),reviewed_at timestamptz,created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(member_id,operation_id),UNIQUE(member_id,body_sha256)
);
CREATE INDEX member_points_suggestion_review ON member_points_suggestion(created_at,id) WHERE state='pending';
CREATE FUNCTION capture_member_points_v2_source() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE owner uuid;source text;at timestamptz;kind text;
BEGIN
 IF TG_TABLE_NAME='commission_payment_inbox' THEN
  IF NEW.state<>'applied' OR (TG_OP='UPDATE' AND OLD.state='applied') THEN RETURN NEW;END IF;
  SELECT member_id INTO owner FROM commerce_order WHERE id=NEW.order_id;source:=NEW.order_id::text;at:=NEW.verified_paid_at;kind:='payment';
 ELSIF TG_TABLE_NAME='member_profile' THEN
  IF NEW.completed_at IS NULL OR NEW.avatar_data_url IS NULL THEN RETURN NEW;END IF;
  IF TG_OP='UPDATE' AND OLD.completed_at IS NOT NULL AND OLD.avatar_data_url IS NOT NULL THEN RETURN NEW;END IF;
  owner:=NEW.member_id;source:=NEW.member_id::text;at:=clock_timestamp();kind:='profile';
 ELSIF TG_TABLE_NAME='member_points_suggestion' THEN
  IF NEW.state<>'approved' OR OLD.state='approved' THEN RETURN NEW;END IF;
  owner:=NEW.member_id;source:=NEW.id::text;at:=NEW.created_at;kind:='suggestion';
 END IF;
 INSERT INTO member_points_source_event(kind,source_id,member_id,occurred_at) VALUES(kind,source,owner,at) ON CONFLICT DO NOTHING;
 RETURN NEW;
END $$;
CREATE TRIGGER member_points_payment AFTER INSERT OR UPDATE OF state ON commission_payment_inbox FOR EACH ROW EXECUTE FUNCTION capture_member_points_v2_source();
CREATE TRIGGER member_points_profile_completion AFTER INSERT OR UPDATE OF completed_at,avatar_data_url ON member_profile FOR EACH ROW EXECUTE FUNCTION capture_member_points_v2_source();
CREATE TRIGGER member_points_suggestion_approved AFTER UPDATE OF state ON member_points_suggestion FOR EACH ROW EXECUTE FUNCTION capture_member_points_v2_source();
DO $$ DECLARE r record;BEGIN
 FOR r IN SELECT conname FROM pg_constraint WHERE conrelid='member_points_policy'::regclass AND contype='c' AND pg_get_constraintdef(oid) LIKE '%approval_source%' LOOP
  EXECUTE format('ALTER TABLE member_points_policy DROP CONSTRAINT %I',r.conname);
 END LOOP;
END $$;
ALTER TABLE member_points_policy ADD CONSTRAINT member_points_approval_source_check CHECK(approval_source IN ('management_review','owner_instruction_20261110','owner_instruction_20261117')),
 ADD CONSTRAINT member_points_approval_check CHECK((state='draft' AND approved_by IS NULL AND approved_at IS NULL AND created_by IS NOT NULL) OR
 (state<>'draft' AND approved_at IS NOT NULL AND length(btrim(approval_evidence))>=8 AND
  (approval_source='management_review' AND approved_by IS NOT NULL AND approved_by<>created_by OR
   approval_source IN ('owner_instruction_20261110','owner_instruction_20261117') AND created_by IS NULL AND approved_by IS NULL)));
DO $$ DECLARE at timestamptz:=clock_timestamp();BEGIN
 IF EXISTS(SELECT 1 FROM member_points_policy WHERE state='active' AND starts_at>at) THEN
  RAISE EXCEPTION 'POINTS_FUTURE_POLICY_REQUIRES_EXPLICIT_RECONCILIATION';
 END IF;
 UPDATE member_points_policy SET state='retired',retired_at=at WHERE state='active';
 INSERT INTO member_points_policy(version,rules,state,starts_at,approved_at,approval_source,approval_evidence)
 VALUES('club-owner-20261117-v2','{"daily":10,"note":5,"streak7":20,"streak30":50,"post":0,"featured":100,"comment":2,"questionnaire":100,"firstOrder":300,"inviteSponsor":300,"inviteFriend":200,"postWeeklyLimit":0,"commentDailyLimit":3,"expiryMonths":12,"reminderDays":30,"discountBps":2000,"pointsPerYuan":100,"refundGraceDays":30,"birthdayMultiplier":2,"taskVersion":2,"firstPost":20,"originalPost":30,"originalMonthlyLimit":2,"experiencePost":80,"experienceMonthlyLimit":1,"share":5,"shareDailyLimit":3,"suggestion":20,"suggestionMonthlyLimit":2,"profile":50,"commentMinHan":15,"postMinHan":15,"experienceMinHan":30,"memberDay":18,"dailyShoppingMultiplier":2,"shoppingPointsPerYuan":1,"awardOnPayment":1,"inviteExclusive":1,"shareOrder":30,"shareOrderWindowDays":30}','active',at,at,'owner_instruction_20261117',
 '2026-11-17 用户采用积分攻略V1.0并逐项批准建议值，确认实付商品每元1基础分、日常2倍/有限预售3倍、评论2分15汉字每天3次、受邀200与普通首购300不叠加；授权修正不合理边界。沿用原12月有效期、退款原批次返还及30天过期宽限。分享下单新规则30分限同一有效订单一次，首单有邀请300时不另叠加；该参数可后台更改仅影响未来快照。');
END $$;
COMMIT;
-- migrate:down
DO $$ BEGIN RAISE EXCEPTION 'POINTS_V2_ROLLBACK_REQUIRES_ASSET_PRESERVATION';END $$;
