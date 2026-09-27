-- A physical return is not possible for goods never received, lost in transit,
-- intercepted before delivery, or an explicitly reviewed impracticable return.
-- The decision is a separate immutable case fact; payment approval remains separate.
ALTER TABLE commerce_aftersale_case DROP CONSTRAINT commerce_aftersale_case_state_check;
ALTER TABLE commerce_aftersale_case ADD CONSTRAINT commerce_aftersale_case_state_check CHECK (state IN
  ('requested','need_info','awaiting_instruction','awaiting_return','return_in_transit',
   'return_received','quality_checked','refund_exception_approved','refund_pending','rejected','cancelled'));
ALTER TABLE commerce_aftersale_case ADD COLUMN exception_kind text
  CHECK (exception_kind IN ('lost_in_transit','item_missing','carrier_intercepted','return_impracticable'));
ALTER TABLE commerce_aftersale_case ADD COLUMN exception_evidence_reference text
  CHECK (char_length(exception_evidence_reference) BETWEEN 8 AND 200);
ALTER TABLE commerce_aftersale_case ADD COLUMN exception_approved_by uuid REFERENCES member(id) ON DELETE RESTRICT;
ALTER TABLE commerce_aftersale_case ADD COLUMN exception_approved_at timestamptz;
ALTER TABLE commerce_aftersale_case ADD CONSTRAINT commerce_aftersale_exception_shape_check CHECK (
  (exception_kind IS NULL AND exception_evidence_reference IS NULL AND exception_approved_by IS NULL AND exception_approved_at IS NULL)
  OR (exception_kind IS NOT NULL AND exception_evidence_reference IS NOT NULL AND exception_approved_by IS NOT NULL AND exception_approved_at IS NOT NULL));
ALTER TABLE commerce_aftersale_case ADD CONSTRAINT commerce_aftersale_exception_state_check
  CHECK (state<>'refund_exception_approved' OR exception_kind IS NOT NULL);
ALTER TABLE commerce_aftersale_event DROP CONSTRAINT commerce_aftersale_event_action_check;
ALTER TABLE commerce_aftersale_event ADD CONSTRAINT commerce_aftersale_event_action_check CHECK (action IN
  ('request','cancel','provide_info','request_info','reject','approve_return','send_return_instruction',
   'approve_refund_without_return','ship_return','receive_return','inspect_return','request_refund','reopen_refund'));
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
    OR OLD.exception_kind IS NOT NULL AND
      (NEW.exception_kind,NEW.exception_evidence_reference,NEW.exception_approved_by,NEW.exception_approved_at)
      IS DISTINCT FROM
      (OLD.exception_kind,OLD.exception_evidence_reference,OLD.exception_approved_by,OLD.exception_approved_at)
  THEN RAISE EXCEPTION 'AFTERSALE_FACT_IMMUTABLE' USING ERRCODE='55000'; END IF;
  RETURN NEW;
END $$;

-- migrate:down
DO $$ BEGIN IF EXISTS(SELECT 1 FROM commerce_aftersale_case WHERE exception_kind IS NOT NULL OR state='refund_exception_approved')
  THEN RAISE EXCEPTION 'AFTERSALE_EXCEPTION_ROLLBACK_REQUIRES_DATA_PRESERVATION'; END IF; END $$;
ALTER TABLE commerce_aftersale_event DROP CONSTRAINT commerce_aftersale_event_action_check;
ALTER TABLE commerce_aftersale_event ADD CONSTRAINT commerce_aftersale_event_action_check CHECK (action IN
  ('request','cancel','provide_info','request_info','reject','approve_return','send_return_instruction',
   'ship_return','receive_return','inspect_return','request_refund','reopen_refund'));
ALTER TABLE commerce_aftersale_case DROP CONSTRAINT commerce_aftersale_exception_state_check;
ALTER TABLE commerce_aftersale_case DROP CONSTRAINT commerce_aftersale_exception_shape_check;
ALTER TABLE commerce_aftersale_case DROP CONSTRAINT commerce_aftersale_case_state_check;
ALTER TABLE commerce_aftersale_case ADD CONSTRAINT commerce_aftersale_case_state_check CHECK (state IN
  ('requested','need_info','awaiting_instruction','awaiting_return','return_in_transit',
   'return_received','quality_checked','refund_pending','rejected','cancelled'));
ALTER TABLE commerce_aftersale_case DROP COLUMN exception_approved_at;
ALTER TABLE commerce_aftersale_case DROP COLUMN exception_approved_by;
ALTER TABLE commerce_aftersale_case DROP COLUMN exception_evidence_reference;
ALTER TABLE commerce_aftersale_case DROP COLUMN exception_kind;
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
