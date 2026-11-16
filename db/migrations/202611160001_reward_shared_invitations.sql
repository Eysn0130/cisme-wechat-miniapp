-- One administrator-created, forwardable invitation per activity. A link does
-- not contain a member identity and never reserves stock by being opened.
CREATE TABLE reward_activity_share (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 activity_id uuid NOT NULL UNIQUE REFERENCES reward_activity(id),
 version integer NOT NULL DEFAULT 1 CHECK(version>0),
 enabled boolean NOT NULL DEFAULT true,
 created_by uuid NOT NULL REFERENCES member(id),
 created_at timestamptz NOT NULL DEFAULT now()
);

-- migrate:down
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM reward_activity_share)
 THEN RAISE EXCEPTION 'REWARD_SHARE_ROLLBACK_REQUIRES_DATA_PRESERVATION'; END IF;
END $$;
DROP TABLE reward_activity_share;
