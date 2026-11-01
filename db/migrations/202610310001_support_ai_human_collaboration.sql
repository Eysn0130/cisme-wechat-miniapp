-- migrate:up
-- Human assignment remains intact while question-scoped AI replies coexist.
-- Legacy manual requests deliberately keep an unknown original question.
ALTER TABLE support_conversation
  ADD COLUMN human_request_generation integer NOT NULL DEFAULT 0 CHECK(human_request_generation>=0),
  ADD COLUMN human_request_anchor_sequence bigint CHECK(human_request_anchor_sequence IS NULL OR human_request_anchor_sequence>0),
  ADD COLUMN human_request_context_version integer NOT NULL DEFAULT 0 CHECK(human_request_context_version>=0);
-- No FK: precise ordinary-content removal must not delete preserved evidence
-- or be blocked by a reply link. Inserts validate the target; reads hide stale links.
ALTER TABLE support_message ADD COLUMN reply_to_message_id uuid;
CREATE INDEX support_message_reply_target ON support_message(conversation_id,reply_to_message_id,sender_type)
  WHERE reply_to_message_id IS NOT NULL;
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
  IF (NEW.human_request_generation,NEW.human_request_anchor_sequence,NEW.human_request_context_version) IS DISTINCT FROM
     (OLD.human_request_generation,OLD.human_request_anchor_sequence,OLD.human_request_context_version) THEN
    IF NOT (
      (NEW.human_request_generation=OLD.human_request_generation+1 AND NEW.status='waiting_human'
        AND OLD.status IN ('ai_active','resolved')
        AND COALESCE(current_setting('cisme.support_human_request_transition',true),'')=
          OLD.id::text||':'||OLD.member_id::text||':'||OLD.human_request_generation::text||':'||NEW.human_request_generation::text||':'||NEW.human_request_context_version::text||':'||COALESCE(NEW.human_request_anchor_sequence,0)::text) OR
      (NEW.human_request_generation=OLD.human_request_generation AND OLD.human_request_generation>0
        AND OLD.human_request_anchor_sequence IS NULL AND NEW.human_request_anchor_sequence IS NOT NULL
        AND OLD.status IN ('waiting_human','human_active') AND NEW.status=OLD.status
        AND NEW.human_request_context_version=OLD.human_request_context_version
        AND COALESCE(current_setting('cisme.support_human_anchor_bind',true),'')=
          OLD.id::text||':'||OLD.member_id::text||':'||OLD.human_request_generation::text||':'||NEW.human_request_anchor_sequence::text||':'||NEW.human_request_context_version::text)
    ) THEN RAISE EXCEPTION 'SUPPORT_HUMAN_REQUEST_METADATA_REQUIRED'; END IF;
    IF NEW.version<>OLD.version+1 THEN RAISE EXCEPTION 'SUPPORT_CONVERSATION_VERSION_REQUIRED'; END IF;
    IF NEW.human_request_anchor_sequence IS NOT NULL AND NOT EXISTS(
      SELECT 1 FROM support_message WHERE conversation_id=NEW.id AND sequence=NEW.human_request_anchor_sequence AND sender_type='user'
    ) THEN RAISE EXCEPTION 'SUPPORT_HUMAN_REQUEST_ANCHOR_INVALID'; END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION enforce_support_message_sender() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE current_state support_conversation%ROWTYPE; source support_message%ROWTYPE;
  boundary bigint:=0; topic_version integer:=0;
BEGIN
  SELECT * INTO current_state FROM support_conversation WHERE id=NEW.conversation_id FOR UPDATE;
  IF NOT FOUND OR NEW.sequence<>current_state.next_sequence THEN RAISE EXCEPTION 'SUPPORT_MESSAGE_SEQUENCE_CONFLICT'; END IF;
  SELECT COALESCE(MAX((response_body->>'contextStartSequence')::bigint),0),COALESCE(MAX((response_body->>'resultVersion')::integer),0)
    INTO boundary,topic_version FROM idempotency_operation WHERE principal_id='member:'||current_state.member_id::text
      AND operation='support.conversation.new_topic' AND response_body->>'conversationId'=current_state.id::text;
  IF NEW.reply_to_message_id IS NOT NULL THEN
    SELECT * INTO source FROM support_message WHERE id=NEW.reply_to_message_id AND conversation_id=NEW.conversation_id
      AND sender_type='user' AND sequence>boundary AND sequence<NEW.sequence;
    IF NOT FOUND THEN RAISE EXCEPTION 'SUPPORT_REPLY_TARGET_INVALID'; END IF;
  END IF;
  IF NEW.sender_type='ai' AND current_state.status<>'ai_active' THEN
    IF current_state.status NOT IN ('waiting_human','human_active','resolved') OR NEW.reply_to_message_id IS NULL
      OR COALESCE(current_setting('cisme.support_ai_reply',true),'')<>
        current_state.id::text||':'||NEW.reply_to_message_id::text||':'||topic_version::text||':'||current_state.human_request_generation::text
      OR NOT EXISTS(SELECT 1 FROM member WHERE id=current_state.member_id AND status='active')
      THEN RAISE EXCEPTION 'SUPPORT_AI_COLLABORATION_CONTEXT_REQUIRED'; END IF;
  END IF;
  IF NEW.sender_type='admin' AND (current_state.status<>'human_active' OR NEW.sender_principal_id<>current_state.current_handler_principal_id)
    THEN RAISE EXCEPTION 'SUPPORT_ADMIN_ASSIGNMENT_REQUIRED'; END IF;
  RETURN NEW;
END $$;

-- migrate:down
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM support_conversation WHERE human_request_generation<>0 OR human_request_anchor_sequence IS NOT NULL OR human_request_context_version<>0)
    OR EXISTS(SELECT 1 FROM support_message WHERE reply_to_message_id IS NOT NULL)
    THEN RAISE EXCEPTION 'SUPPORT_COLLABORATION_ROLLBACK_REQUIRES_DATA_PRESERVATION'; END IF;
END $$;
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

CREATE OR REPLACE FUNCTION enforce_support_message_sender() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE current_state support_conversation%ROWTYPE;
BEGIN
  SELECT * INTO current_state FROM support_conversation WHERE id=NEW.conversation_id FOR UPDATE;
  IF NOT FOUND OR NEW.sequence <> current_state.next_sequence THEN
    RAISE EXCEPTION 'SUPPORT_MESSAGE_SEQUENCE_CONFLICT';
  END IF;
  IF NEW.sender_type='ai' AND current_state.status <> 'ai_active' THEN
    RAISE EXCEPTION 'SUPPORT_AI_REPLY_FORBIDDEN_AFTER_HANDOFF';
  END IF;
  IF NEW.sender_type='admin' AND (current_state.status <> 'human_active' OR NEW.sender_principal_id <> current_state.current_handler_principal_id) THEN
    RAISE EXCEPTION 'SUPPORT_ADMIN_ASSIGNMENT_REQUIRED';
  END IF;
  RETURN NEW;
END $$;
DROP INDEX support_message_reply_target;
ALTER TABLE support_message DROP COLUMN reply_to_message_id;
ALTER TABLE support_conversation DROP COLUMN human_request_generation,DROP COLUMN human_request_anchor_sequence,DROP COLUMN human_request_context_version;
