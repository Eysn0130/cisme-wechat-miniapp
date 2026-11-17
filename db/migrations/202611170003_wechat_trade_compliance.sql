BEGIN;
-- Provider observations only: never payment, local receipt or settlement facts.
CREATE TABLE wechat_trade_account_state(
 app_id text PRIMARY KEY,managed boolean,settlement_confirmed boolean,checked_at timestamptz,
 order_detail_path text,path_verified boolean NOT NULL DEFAULT false,checks jsonb NOT NULL DEFAULT '[]',
 restricted_at timestamptz,restriction_cleared_at timestamptz,
 CHECK(char_length(app_id) BETWEEN 6 AND 128),CHECK(order_detail_path IS NULL OR char_length(order_detail_path)<=1024)
);
CREATE TABLE wechat_trade_notice(
 notice_key text PRIMARY KEY CHECK(notice_key ~ '^[a-f0-9]{64}$'),app_id text NOT NULL,
 event_type text NOT NULL CHECK(event_type IN('wxa_trade_controlled','trade_manage_remind_access_api','trade_manage_remind_shipping','trade_manage_order_settlement')),
 event_created_at timestamptz NOT NULL,payload jsonb NOT NULL,
 order_id uuid REFERENCES commerce_order(id) ON DELETE RESTRICT,
 state text NOT NULL DEFAULT 'pending' CHECK(state IN('pending','observed','manual_review','recorded')),
 attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 12),
 next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),lease_token uuid,lease_until timestamptz,
 observation jsonb,received_at timestamptz NOT NULL DEFAULT clock_timestamp(),processed_at timestamptz,
 CHECK((lease_token IS NULL)=(lease_until IS NULL))
);
CREATE INDEX wechat_trade_notice_pending ON wechat_trade_notice(next_attempt_at,notice_key) WHERE state='pending';
CREATE FUNCTION guard_wechat_trade_notice() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='DELETE' OR (NEW.notice_key,NEW.app_id,NEW.event_type,NEW.event_created_at,NEW.payload,NEW.received_at)
   IS DISTINCT FROM (OLD.notice_key,OLD.app_id,OLD.event_type,OLD.event_created_at,OLD.payload,OLD.received_at)
 THEN RAISE EXCEPTION 'WECHAT_TRADE_NOTICE_IMMUTABLE' USING ERRCODE='55000';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER wechat_trade_notice_guard BEFORE UPDATE OR DELETE ON wechat_trade_notice FOR EACH ROW EXECUTE FUNCTION guard_wechat_trade_notice();
COMMIT;
-- migrate:down
DO $$ BEGIN RAISE EXCEPTION 'WECHAT_TRADE_OBSERVATIONS_REQUIRE_FORWARD_RECOVERY';END $$;
