-- A report's outcome belongs to content governance, not to a privacy-rights request.
ALTER TABLE ugc_report
  ADD COLUMN decision_code text CHECK (decision_code IN ('hide_post','remove_comment','dismiss')),
  ADD COLUMN decision_reason text CHECK (decision_reason IS NULL OR char_length(btrim(decision_reason)) BETWEEN 4 AND 500),
  ADD COLUMN decided_by_member_id uuid REFERENCES member(id),
  ADD COLUMN decided_at timestamptz,
  ADD CONSTRAINT ugc_report_terminal_decision_check CHECK (
    (state IN ('resolved','rejected') AND decision_code IS NOT NULL AND decision_reason IS NOT NULL
      AND decided_by_member_id IS NOT NULL AND decided_at IS NOT NULL)
    OR (state NOT IN ('resolved','rejected') AND decision_code IS NULL AND decision_reason IS NULL
      AND decided_by_member_id IS NULL AND decided_at IS NULL)
  );

CREATE FUNCTION guard_ugc_report_terminal() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.state IN ('resolved','rejected') AND NEW IS DISTINCT FROM OLD
  THEN RAISE EXCEPTION 'UGC_REPORT_DECISION_IMMUTABLE' USING ERRCODE='55000'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER ugc_report_terminal_guard BEFORE UPDATE ON ugc_report
FOR EACH ROW EXECUTE FUNCTION guard_ugc_report_terminal();

-- migrate:down
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM ugc_report WHERE decision_code IS NOT NULL)
  THEN RAISE EXCEPTION 'UGC_REPORT_DECISION_ROLLBACK_REQUIRES_DATA_PRESERVATION'; END IF;
END $$;
DROP TRIGGER ugc_report_terminal_guard ON ugc_report;
DROP FUNCTION guard_ugc_report_terminal();
ALTER TABLE ugc_report DROP CONSTRAINT ugc_report_terminal_decision_check,
  DROP COLUMN decision_code,DROP COLUMN decision_reason,DROP COLUMN decided_by_member_id,DROP COLUMN decided_at;
