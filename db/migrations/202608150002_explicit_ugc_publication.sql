ALTER TABLE feed_item
  ADD COLUMN ai_usage text NOT NULL DEFAULT 'unknown' CHECK (ai_usage IN ('none','assisted','generated','unknown')),
  ADD COLUMN published_by text,
  ADD COLUMN publication_reason_code text,
  ADD COLUMN publication_evidence jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE UNIQUE INDEX care_cycle_member_open_unique ON care_cycle(member_id)
  WHERE phase IN ('planned','active','paused');

-- migrate:down
DROP INDEX care_cycle_member_open_unique;
ALTER TABLE feed_item
  DROP COLUMN publication_evidence,
  DROP COLUMN publication_reason_code,
  DROP COLUMN published_by,
  DROP COLUMN ai_usage;
