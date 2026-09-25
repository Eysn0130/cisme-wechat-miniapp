-- Purpose is recorded per message because the single member conversation can
-- contain ordinary questions, orders and aftersales at different times.
ALTER TABLE support_message ADD COLUMN retention_purpose text NOT NULL DEFAULT 'legacy_unknown'
  CHECK (retention_purpose IN ('ordinary','transaction','legacy_unknown'));

UPDATE support_message SET retention_purpose='transaction'
  WHERE linked_order_id IS NOT NULL OR linked_case_id IS NOT NULL;
UPDATE support_message message SET retention_purpose='ordinary'
  WHERE retention_purpose='legacy_unknown'
    AND NOT EXISTS(SELECT 1 FROM support_message linked
      WHERE linked.conversation_id=message.conversation_id AND linked.retention_purpose='transaction')
    AND NOT EXISTS(SELECT 1 FROM commerce_aftersale_case claim
      WHERE claim.support_conversation_id=message.conversation_id);

CREATE FUNCTION support_message_retention_purpose_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.linked_order_id IS NOT NULL OR NEW.linked_case_id IS NOT NULL THEN
    NEW.retention_purpose:='transaction';
  END IF;
  IF NEW.retention_purpose='ordinary' AND
    (NEW.linked_order_id IS NOT NULL OR NEW.linked_case_id IS NOT NULL) THEN
    RAISE EXCEPTION 'SUPPORT_ORDINARY_PURPOSE_HAS_TRANSACTION_ANCHOR';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER support_message_retention_purpose_before_insert
  BEFORE INSERT ON support_message FOR EACH ROW
  EXECUTE FUNCTION support_message_retention_purpose_guard();
CREATE INDEX support_message_ordinary_retention
  ON support_message(conversation_id,sequence)
  WHERE retention_purpose='ordinary';

-- migrate:down
DROP INDEX support_message_ordinary_retention;
DROP TRIGGER support_message_retention_purpose_before_insert ON support_message;
DROP FUNCTION support_message_retention_purpose_guard();
ALTER TABLE support_message DROP COLUMN retention_purpose;
