-- Query-only operator reconciliation preserves parcel, dispatch and attempt history.
CREATE OR REPLACE FUNCTION guard_commerce_shipping_sync() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' OR
    (NEW.id,NEW.order_id,NEW.created_by_member_id,NEW.request_key,NEW.request_hmac,
     NEW.encrypted_parcel,NEW.key_version,NEW.evidence_reference,NEW.upload_time,NEW.created_at)
    IS DISTINCT FROM
    (OLD.id,OLD.order_id,OLD.created_by_member_id,OLD.request_key,OLD.request_hmac,
     OLD.encrypted_parcel,OLD.key_version,OLD.evidence_reference,OLD.upload_time,OLD.created_at)
    OR (OLD.dispatched_at IS NOT NULL AND NEW.dispatched_at IS DISTINCT FROM OLD.dispatched_at)
    OR (OLD.state <> 'prepared' AND NEW.state='prepared')
    OR (OLD.state='synced' AND NEW IS DISTINCT FROM OLD)
    OR (OLD.state='manual_review' AND NOT ((
      NEW.state='synced' AND NEW.last_code='MANUAL_QUERY_MATCHED'
      AND NEW.platform_order_state IN (2,3,4,6)
      AND (to_jsonb(NEW)-ARRAY['state','last_code','platform_order_state','updated_at'])
        = (to_jsonb(OLD)-ARRAY['state','last_code','platform_order_state','updated_at'])
    ) IS TRUE))
    OR NEW.query_attempts < OLD.query_attempts
  THEN RAISE EXCEPTION 'SHIPPING_SYNC_HISTORY_IMMUTABLE' USING ERRCODE='55000'; END IF;
  RETURN NEW;
END $$;

-- migrate:down
CREATE OR REPLACE FUNCTION guard_commerce_shipping_sync() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' OR
    (NEW.id,NEW.order_id,NEW.created_by_member_id,NEW.request_key,NEW.request_hmac,
     NEW.encrypted_parcel,NEW.key_version,NEW.evidence_reference,NEW.upload_time,NEW.created_at)
    IS DISTINCT FROM
    (OLD.id,OLD.order_id,OLD.created_by_member_id,OLD.request_key,OLD.request_hmac,
     OLD.encrypted_parcel,OLD.key_version,OLD.evidence_reference,OLD.upload_time,OLD.created_at)
    OR (OLD.dispatched_at IS NOT NULL AND NEW.dispatched_at IS DISTINCT FROM OLD.dispatched_at)
    OR (OLD.state <> 'prepared' AND NEW.state='prepared')
    OR (OLD.state IN ('synced','manual_review') AND NEW IS DISTINCT FROM OLD)
    OR NEW.query_attempts < OLD.query_attempts
  THEN RAISE EXCEPTION 'SHIPPING_SYNC_HISTORY_IMMUTABLE' USING ERRCODE='55000'; END IF;
  RETURN NEW;
END $$;
