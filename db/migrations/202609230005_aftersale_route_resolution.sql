-- A buyer's valid earlier return instruction remains immutable. The operator
-- records what was actually done about the changed route on the same case.
ALTER TABLE commerce_aftersale_case ADD COLUMN route_review_outcome text
  CHECK (route_review_outcome IN ('carrier_contacted','rerouted','received'));
ALTER TABLE commerce_aftersale_case ADD COLUMN route_reviewed_at timestamptz;
ALTER TABLE commerce_aftersale_case ADD CONSTRAINT commerce_aftersale_route_review_shape CHECK (
  (route_review_outcome IS NULL)=(route_reviewed_at IS NULL));
ALTER TABLE commerce_aftersale_event DROP CONSTRAINT commerce_aftersale_event_action_check;
ALTER TABLE commerce_aftersale_event ADD CONSTRAINT commerce_aftersale_event_action_check CHECK (action IN
  ('request','cancel','provide_info','request_info','reject','approve_return','send_return_instruction',
   'approve_refund_without_return','report_old_route','ship_return','receive_return','inspect_return',
   'request_refund','reopen_refund','resolve_old_route'));
CREATE FUNCTION guard_aftersale_route_review() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' OR
    (OLD.route_review_outcome IN ('rerouted','received') AND
      (NEW.route_review_outcome,NEW.route_reviewed_at) IS DISTINCT FROM
      (OLD.route_review_outcome,OLD.route_reviewed_at)) OR
    (OLD.route_review_outcome='carrier_contacted' AND NEW.route_review_outcome IS NULL)
  THEN RAISE EXCEPTION 'AFTERSALE_ROUTE_REVIEW_IMMUTABLE' USING ERRCODE='55000'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER commerce_aftersale_route_review_guard BEFORE UPDATE OR DELETE ON commerce_aftersale_case
  FOR EACH ROW EXECUTE FUNCTION guard_aftersale_route_review();

-- migrate:down
DO $$ BEGIN IF EXISTS(SELECT 1 FROM commerce_aftersale_case WHERE route_review_outcome IS NOT NULL)
  THEN RAISE EXCEPTION 'AFTERSALE_ROUTE_REVIEW_ROLLBACK_REQUIRES_DATA_PRESERVATION'; END IF; END $$;
DROP TRIGGER commerce_aftersale_route_review_guard ON commerce_aftersale_case;
DROP FUNCTION guard_aftersale_route_review();
ALTER TABLE commerce_aftersale_event DROP CONSTRAINT commerce_aftersale_event_action_check;
ALTER TABLE commerce_aftersale_event ADD CONSTRAINT commerce_aftersale_event_action_check CHECK (action IN
  ('request','cancel','provide_info','request_info','reject','approve_return','send_return_instruction',
   'approve_refund_without_return','report_old_route','ship_return','receive_return','inspect_return',
   'request_refund','reopen_refund'));
ALTER TABLE commerce_aftersale_case DROP CONSTRAINT commerce_aftersale_route_review_shape;
ALTER TABLE commerce_aftersale_case DROP COLUMN route_reviewed_at;
ALTER TABLE commerce_aftersale_case DROP COLUMN route_review_outcome;
