-- An explicitly selected, real synchronous WeChat result is distinct from v2.
-- No existing scan, post, visibility or publication intent is changed.
ALTER TABLE ugc_safety_scan DROP CONSTRAINT ugc_safety_scan_provider_check;
ALTER TABLE ugc_safety_scan ADD CONSTRAINT ugc_safety_scan_provider_check
  CHECK (provider IN ('wechat_v2','wechat_v1_sync','test_fixture'));

-- migrate:down
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM ugc_safety_scan WHERE provider='wechat_v1_sync')
  THEN RAISE EXCEPTION 'UGC_SYNC_SAFETY_ROLLBACK_REQUIRES_DATA_PRESERVATION'; END IF;
END $$;
ALTER TABLE ugc_safety_scan DROP CONSTRAINT ugc_safety_scan_provider_check;
ALTER TABLE ugc_safety_scan ADD CONSTRAINT ugc_safety_scan_provider_check
  CHECK (provider IN ('wechat_v2','test_fixture'));
