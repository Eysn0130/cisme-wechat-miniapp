-- Preserve the exact instruction the buyer followed. An older valid version
-- remains evidence even when a newer instruction has since been sent.
ALTER TABLE commerce_aftersale_case ADD COLUMN shipped_instruction_version integer
  CHECK (shipped_instruction_version>0);
ALTER TABLE commerce_aftersale_case ADD CONSTRAINT commerce_aftersale_shipped_instruction_fk
  FOREIGN KEY (id,shipped_instruction_version)
  REFERENCES commerce_aftersale_return_instruction(case_id,version) ON DELETE RESTRICT;
ALTER TABLE commerce_aftersale_event DROP CONSTRAINT commerce_aftersale_event_action_check;
ALTER TABLE commerce_aftersale_event ADD CONSTRAINT commerce_aftersale_event_action_check CHECK (action IN
  ('request','cancel','provide_info','request_info','reject','approve_return','send_return_instruction',
   'approve_refund_without_return','report_old_route','ship_return','receive_return','inspect_return','request_refund','reopen_refund'));
CREATE FUNCTION guard_aftersale_shipped_instruction() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' OR (OLD.shipped_instruction_version IS NOT NULL AND
    (NEW.shipped_instruction_version IS DISTINCT FROM OLD.shipped_instruction_version OR
     NEW.return_destination IS DISTINCT FROM OLD.return_destination))
  THEN RAISE EXCEPTION 'AFTERSALE_SHIPPED_INSTRUCTION_IMMUTABLE' USING ERRCODE='55000'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER commerce_aftersale_shipped_instruction_guard BEFORE UPDATE OR DELETE ON commerce_aftersale_case
  FOR EACH ROW EXECUTE FUNCTION guard_aftersale_shipped_instruction();

-- migrate:down
DO $$ BEGIN IF EXISTS(SELECT 1 FROM commerce_aftersale_case WHERE shipped_instruction_version IS NOT NULL)
  THEN RAISE EXCEPTION 'AFTERSALE_SHIPPED_INSTRUCTION_ROLLBACK_REQUIRES_DATA_PRESERVATION'; END IF; END $$;
DROP TRIGGER commerce_aftersale_shipped_instruction_guard ON commerce_aftersale_case;
DROP FUNCTION guard_aftersale_shipped_instruction();
ALTER TABLE commerce_aftersale_event DROP CONSTRAINT commerce_aftersale_event_action_check;
ALTER TABLE commerce_aftersale_event ADD CONSTRAINT commerce_aftersale_event_action_check CHECK (action IN
  ('request','cancel','provide_info','request_info','reject','approve_return','send_return_instruction',
   'approve_refund_without_return','ship_return','receive_return','inspect_return','request_refund','reopen_refund'));
ALTER TABLE commerce_aftersale_case DROP CONSTRAINT commerce_aftersale_shipped_instruction_fk;
ALTER TABLE commerce_aftersale_case DROP COLUMN shipped_instruction_version;
