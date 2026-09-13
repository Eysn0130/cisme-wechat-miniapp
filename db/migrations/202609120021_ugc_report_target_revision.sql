-- Preserve the version a reporter actually saw; later edits cannot silently
-- replace the evidence placed before a moderator.
ALTER TABLE ugc_report ADD COLUMN reported_revision integer CHECK (reported_revision IS NULL OR reported_revision>0);

-- migrate:down
ALTER TABLE ugc_report DROP COLUMN reported_revision;
