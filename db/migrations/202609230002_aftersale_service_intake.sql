-- PRD §8.2: preserve the submitted claim even when an operator has not yet
-- supplied a return destination. Existing cases retain their original facts.
ALTER TABLE commerce_aftersale_case DROP CONSTRAINT commerce_aftersale_case_reason_check;
ALTER TABLE commerce_aftersale_case ADD CONSTRAINT commerce_aftersale_case_reason_check
  CHECK (char_length(reason) BETWEEN 0 AND 500);
ALTER TABLE commerce_aftersale_case ADD COLUMN claim_basis text NOT NULL DEFAULT 'other'
  CHECK (claim_basis IN ('other','no_reason','quality','wrong_item','missing_item','delivery_issue'));
ALTER TABLE commerce_aftersale_case ADD COLUMN support_conversation_id uuid
  REFERENCES support_conversation(id) ON DELETE RESTRICT;
ALTER TABLE commerce_aftersale_case DROP CONSTRAINT commerce_aftersale_case_state_check;
ALTER TABLE commerce_aftersale_case ADD CONSTRAINT commerce_aftersale_case_state_check CHECK (state IN
  ('requested','need_info','awaiting_instruction','awaiting_return','return_in_transit','return_received','quality_checked','refund_pending','rejected','cancelled'));
CREATE INDEX commerce_aftersale_support ON commerce_aftersale_case(support_conversation_id,created_at DESC,id DESC)
  WHERE support_conversation_id IS NOT NULL;
ALTER TABLE commerce_aftersale_event DROP CONSTRAINT commerce_aftersale_event_action_check;
ALTER TABLE commerce_aftersale_event ADD CONSTRAINT commerce_aftersale_event_action_check CHECK (action IN
  ('request','cancel','provide_info','request_info','reject','approve_return','send_return_instruction','ship_return','receive_return','inspect_return','request_refund','reopen_refund'));

CREATE TABLE commerce_aftersale_return_instruction (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id uuid NOT NULL REFERENCES commerce_aftersale_case(id) ON DELETE RESTRICT,
  version integer NOT NULL CHECK (version>0),
  recipient_name text NOT NULL CHECK (char_length(btrim(recipient_name)) BETWEEN 1 AND 80),
  phone text NOT NULL CHECK (phone ~ '^\+?[0-9-]{7,20}$'),
  region text NOT NULL CHECK (char_length(btrim(region)) BETWEEN 2 AND 100),
  address text NOT NULL CHECK (char_length(btrim(address)) BETWEEN 5 AND 300),
  freight_payer text NOT NULL CHECK (freight_payer IN ('merchant','member')),
  instructions text NOT NULL CHECK (char_length(instructions)<=500),
  issued_by uuid NOT NULL REFERENCES member(id) ON DELETE RESTRICT,
  issued_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(case_id,version)
);
CREATE FUNCTION guard_commerce_aftersale_return_instruction() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'AFTERSALE_RETURN_INSTRUCTION_IMMUTABLE' USING ERRCODE='55000'; END $$;
CREATE TRIGGER commerce_aftersale_return_instruction_guard BEFORE UPDATE OR DELETE ON commerce_aftersale_return_instruction
  FOR EACH ROW EXECUTE FUNCTION guard_commerce_aftersale_return_instruction();

ALTER TABLE support_message ADD COLUMN linked_case_id uuid REFERENCES commerce_aftersale_case(id) ON DELETE RESTRICT;
ALTER TABLE support_message ADD COLUMN return_instruction_snapshot jsonb;
ALTER TABLE support_message DROP CONSTRAINT support_message_content_type_check;
ALTER TABLE support_message ADD CONSTRAINT support_message_content_type_check
  CHECK (content_type IN ('text','image','order','mixed','system','return_instruction'));
ALTER TABLE support_message DROP CONSTRAINT support_message_content_shape_check;
ALTER TABLE support_message ADD CONSTRAINT support_message_content_shape_check CHECK (
  (content_type='text' AND length(btrim(body)) >= 1 AND jsonb_array_length(attachment_refs)=0 AND linked_order_id IS NULL AND order_snapshot IS NULL AND linked_case_id IS NULL)
  OR (content_type='image' AND jsonb_array_length(attachment_refs) BETWEEN 1 AND 3 AND linked_order_id IS NULL AND order_snapshot IS NULL AND linked_case_id IS NULL)
  OR (content_type='order' AND jsonb_array_length(attachment_refs)=0 AND linked_order_id IS NOT NULL AND jsonb_typeof(order_snapshot)='object' AND linked_case_id IS NULL)
  OR (content_type='mixed' AND (length(btrim(body)) >= 1 OR jsonb_array_length(attachment_refs)>0 OR linked_order_id IS NOT NULL)
      AND (jsonb_array_length(attachment_refs)>0 OR linked_order_id IS NOT NULL)
      AND jsonb_array_length(attachment_refs) <= 3 AND linked_case_id IS NULL
      AND ((linked_order_id IS NULL AND order_snapshot IS NULL) OR (linked_order_id IS NOT NULL AND jsonb_typeof(order_snapshot)='object')))
  OR (content_type='system' AND sender_type='system' AND length(btrim(body)) >= 1 AND jsonb_array_length(attachment_refs)=0 AND linked_order_id IS NULL AND order_snapshot IS NULL AND linked_case_id IS NULL)
  OR (content_type='return_instruction' AND sender_type='system' AND length(btrim(body)) >= 1
      AND jsonb_array_length(attachment_refs)=0 AND linked_order_id IS NULL AND order_snapshot IS NULL
      AND linked_case_id IS NOT NULL AND jsonb_typeof(return_instruction_snapshot)='object')
);
ALTER TABLE support_message ADD CONSTRAINT support_message_return_instruction_shape_check
  CHECK ((linked_case_id IS NULL AND return_instruction_snapshot IS NULL)
    OR (content_type='return_instruction' AND linked_case_id IS NOT NULL AND return_instruction_snapshot IS NOT NULL));
CREATE INDEX support_message_linked_case ON support_message(linked_case_id) WHERE linked_case_id IS NOT NULL;

CREATE OR REPLACE FUNCTION guard_commerce_aftersale() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' OR NEW.version<>OLD.version+1 OR
    (NEW.id,NEW.order_id,NEW.member_id,NEW.kind,NEW.reason,NEW.lines,NEW.amount_cents,NEW.idempotency_key,NEW.request_hash,NEW.created_at,NEW.claim_basis)
      IS DISTINCT FROM
    (OLD.id,OLD.order_id,OLD.member_id,OLD.kind,OLD.reason,OLD.lines,OLD.amount_cents,OLD.idempotency_key,OLD.request_hash,OLD.created_at,OLD.claim_basis)
    OR (OLD.support_conversation_id IS NOT NULL AND NEW.support_conversation_id IS DISTINCT FROM OLD.support_conversation_id)
    OR (OLD.support_conversation_id IS NULL AND NEW.support_conversation_id IS NOT NULL AND NOT EXISTS
      (SELECT 1 FROM support_conversation WHERE id=NEW.support_conversation_id AND member_id=OLD.member_id))
    OR OLD.state IN ('rejected','cancelled')
    OR (OLD.return_destination IS NOT NULL AND NEW.return_destination IS DISTINCT FROM OLD.return_destination
        AND (OLD.state<>'awaiting_return' OR OLD.return_tracking IS NOT NULL
          OR (OLD.return_destination->>'version') !~ '^[0-9]+$'
          OR (NEW.return_destination->>'version') !~ '^[0-9]+$'
          OR (NEW.return_destination->>'version')::integer <= (OLD.return_destination->>'version')::integer))
    OR OLD.return_tracking IS NOT NULL AND (NEW.return_tracking,NEW.return_carrier) IS DISTINCT FROM (OLD.return_tracking,OLD.return_carrier)
    OR OLD.quality_result IS NOT NULL AND NEW.quality_result IS DISTINCT FROM OLD.quality_result
  THEN RAISE EXCEPTION 'AFTERSALE_FACT_IMMUTABLE' USING ERRCODE='55000'; END IF;
  RETURN NEW;
END $$;

-- migrate:down
DO $$ BEGIN IF EXISTS(SELECT 1 FROM commerce_aftersale_case WHERE claim_basis<>'other' OR support_conversation_id IS NOT NULL OR state='awaiting_instruction')
  OR EXISTS(SELECT 1 FROM commerce_aftersale_return_instruction) THEN RAISE EXCEPTION 'AFTERSALE_SERVICE_INTAKE_ROLLBACK_REQUIRES_DATA_PRESERVATION'; END IF; END $$;
DROP TRIGGER commerce_aftersale_return_instruction_guard ON commerce_aftersale_return_instruction;
DROP FUNCTION guard_commerce_aftersale_return_instruction();
DROP INDEX support_message_linked_case;
ALTER TABLE support_message DROP CONSTRAINT support_message_return_instruction_shape_check;
ALTER TABLE support_message DROP CONSTRAINT support_message_content_shape_check;
ALTER TABLE support_message DROP CONSTRAINT support_message_content_type_check;
ALTER TABLE support_message DROP COLUMN return_instruction_snapshot;
ALTER TABLE support_message DROP COLUMN linked_case_id;
ALTER TABLE support_message ADD CONSTRAINT support_message_content_type_check
  CHECK (content_type IN ('text','image','order','mixed','system'));
ALTER TABLE support_message ADD CONSTRAINT support_message_content_shape_check CHECK (
  (content_type='text' AND length(btrim(body)) >= 1 AND jsonb_array_length(attachment_refs)=0 AND linked_order_id IS NULL AND order_snapshot IS NULL)
  OR (content_type='image' AND jsonb_array_length(attachment_refs) BETWEEN 1 AND 3 AND linked_order_id IS NULL AND order_snapshot IS NULL)
  OR (content_type='order' AND jsonb_array_length(attachment_refs)=0 AND linked_order_id IS NOT NULL AND jsonb_typeof(order_snapshot)='object')
  OR (content_type='mixed' AND (length(btrim(body)) >= 1 OR jsonb_array_length(attachment_refs)>0 OR linked_order_id IS NOT NULL)
      AND (jsonb_array_length(attachment_refs)>0 OR linked_order_id IS NOT NULL)
      AND jsonb_array_length(attachment_refs) <= 3
      AND ((linked_order_id IS NULL AND order_snapshot IS NULL) OR (linked_order_id IS NOT NULL AND jsonb_typeof(order_snapshot)='object')))
  OR (content_type='system' AND sender_type='system' AND length(btrim(body)) >= 1 AND jsonb_array_length(attachment_refs)=0 AND linked_order_id IS NULL AND order_snapshot IS NULL)
);
DROP TABLE commerce_aftersale_return_instruction;
DROP INDEX commerce_aftersale_support;
ALTER TABLE commerce_aftersale_event DROP CONSTRAINT commerce_aftersale_event_action_check;
ALTER TABLE commerce_aftersale_event ADD CONSTRAINT commerce_aftersale_event_action_check CHECK (action IN
  ('request','cancel','provide_info','request_info','reject','approve_return','ship_return','receive_return','inspect_return','request_refund','reopen_refund'));
ALTER TABLE commerce_aftersale_case DROP CONSTRAINT commerce_aftersale_case_state_check;
ALTER TABLE commerce_aftersale_case ADD CONSTRAINT commerce_aftersale_case_state_check CHECK (state IN
  ('requested','need_info','awaiting_return','return_in_transit','return_received','quality_checked','refund_pending','rejected','cancelled'));
ALTER TABLE commerce_aftersale_case DROP COLUMN support_conversation_id;
ALTER TABLE commerce_aftersale_case DROP COLUMN claim_basis;
ALTER TABLE commerce_aftersale_case DROP CONSTRAINT commerce_aftersale_case_reason_check;
ALTER TABLE commerce_aftersale_case ADD CONSTRAINT commerce_aftersale_case_reason_check CHECK (char_length(reason) BETWEEN 3 AND 500);
CREATE OR REPLACE FUNCTION guard_commerce_aftersale() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' OR NEW.version<>OLD.version+1 OR
    (NEW.id,NEW.order_id,NEW.member_id,NEW.kind,NEW.reason,NEW.lines,NEW.amount_cents,NEW.idempotency_key,NEW.request_hash,NEW.created_at)
      IS DISTINCT FROM
    (OLD.id,OLD.order_id,OLD.member_id,OLD.kind,OLD.reason,OLD.lines,OLD.amount_cents,OLD.idempotency_key,OLD.request_hash,OLD.created_at)
    OR OLD.state IN ('rejected','cancelled')
    OR OLD.return_destination IS NOT NULL AND NEW.return_destination IS DISTINCT FROM OLD.return_destination
    OR OLD.return_tracking IS NOT NULL AND (NEW.return_tracking,NEW.return_carrier) IS DISTINCT FROM (OLD.return_tracking,OLD.return_carrier)
    OR OLD.quality_result IS NOT NULL AND NEW.quality_result IS DISTINCT FROM OLD.quality_result
  THEN RAISE EXCEPTION 'AFTERSALE_FACT_IMMUTABLE' USING ERRCODE='55000'; END IF;
  RETURN NEW;
END $$;
