-- A committed pending identity precedes the external content-security call.
-- Only a request with no assigned trace can expire into an error and retry;
-- accepted asynchronous scans wait for their authenticated callback/review.
ALTER TABLE ugc_safety_scan ADD COLUMN lease_until timestamptz;
UPDATE ugc_safety_scan SET lease_until=requested_at+interval '2 minutes' WHERE state='pending';
WITH duplicate AS (
  SELECT id,row_number() OVER(PARTITION BY post_id,revision,kind,media_asset_id,content_sha256
    ORDER BY requested_at DESC,id DESC) AS rank FROM ugc_safety_scan WHERE state='pending'
) UPDATE ugc_safety_scan scan SET state='error',result='{"reason":"MIGRATED_DUPLICATE_PENDING"}'::jsonb,
  resolved_at=clock_timestamp() FROM duplicate WHERE scan.id=duplicate.id AND duplicate.rank>1;
CREATE UNIQUE INDEX ugc_safety_pending_identity ON ugc_safety_scan
  (post_id,revision,kind,COALESCE(media_asset_id,'00000000-0000-0000-0000-000000000000'::uuid),content_sha256)
  WHERE state='pending';

-- migrate:down
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM ugc_safety_scan WHERE lease_until IS NOT NULL)
  THEN RAISE EXCEPTION 'UGC_SCAN_CLAIM_ROLLBACK_REQUIRES_DATA_PRESERVATION'; END IF;
END $$;
DROP INDEX ugc_safety_pending_identity;
ALTER TABLE ugc_safety_scan DROP COLUMN lease_until;
