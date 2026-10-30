-- migrate:up
-- A member may explicitly leave the waiting queue; an active operator is never displaced.
CREATE OR REPLACE FUNCTION enforce_support_conversation_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.member_id <> OLD.member_id OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'SUPPORT_CONVERSATION_IDENTITY_IMMUTABLE';
  END IF;
  IF NEW.version < OLD.version OR NEW.version > OLD.version + 1 OR NEW.next_sequence < OLD.next_sequence OR NEW.next_sequence > OLD.next_sequence + 1 OR NEW.updated_at < OLD.updated_at THEN
    RAISE EXCEPTION 'SUPPORT_CONVERSATION_MONOTONICITY_VIOLATION';
  END IF;
  IF (NEW.status,NEW.current_handler_principal_id,NEW.priority,NEW.next_sequence) IS DISTINCT FROM
     (OLD.status,OLD.current_handler_principal_id,OLD.priority,OLD.next_sequence) AND NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'SUPPORT_CONVERSATION_VERSION_REQUIRED';
  END IF;
  IF NEW.status <> OLD.status AND NOT (
    (OLD.status='ai_active' AND NEW.status IN ('waiting_human','human_active','resolved')) OR
    (OLD.status='waiting_human' AND NEW.status IN ('human_active','resolved')) OR
    (OLD.status='waiting_human' AND NEW.status='ai_active'
      AND COALESCE(current_setting('cisme.support_resume_ai_conversation_id',true),'')=OLD.id::text) OR
    (OLD.status='human_active' AND NEW.status IN ('waiting_human','resolved')) OR
    (OLD.status='resolved' AND NEW.status IN ('ai_active','waiting_human','human_active'))
  ) THEN RAISE EXCEPTION 'SUPPORT_CONVERSATION_ILLEGAL_TRANSITION'; END IF;
  RETURN NEW;
END $$;

-- migrate:down
CREATE OR REPLACE FUNCTION enforce_support_conversation_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.member_id <> OLD.member_id OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'SUPPORT_CONVERSATION_IDENTITY_IMMUTABLE';
  END IF;
  IF NEW.version < OLD.version OR NEW.version > OLD.version + 1 OR NEW.next_sequence < OLD.next_sequence OR NEW.next_sequence > OLD.next_sequence + 1 OR NEW.updated_at < OLD.updated_at THEN
    RAISE EXCEPTION 'SUPPORT_CONVERSATION_MONOTONICITY_VIOLATION';
  END IF;
  IF (NEW.status,NEW.current_handler_principal_id,NEW.priority,NEW.next_sequence) IS DISTINCT FROM
     (OLD.status,OLD.current_handler_principal_id,OLD.priority,OLD.next_sequence) AND NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'SUPPORT_CONVERSATION_VERSION_REQUIRED';
  END IF;
  IF NEW.status <> OLD.status AND NOT (
    (OLD.status='ai_active' AND NEW.status IN ('waiting_human','human_active','resolved')) OR
    (OLD.status='waiting_human' AND NEW.status IN ('human_active','resolved')) OR
    (OLD.status='human_active' AND NEW.status IN ('waiting_human','resolved')) OR
    (OLD.status='resolved' AND NEW.status IN ('ai_active','waiting_human','human_active'))
  ) THEN RAISE EXCEPTION 'SUPPORT_CONVERSATION_ILLEGAL_TRANSITION'; END IF;
  RETURN NEW;
END $$;
