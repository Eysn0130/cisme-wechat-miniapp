-- One durable member conversation is the support authority for both the user
-- and mobile operator experiences. WebSocket/polling are only transports.
INSERT INTO data_retention_policy(code,data_class,trigger_event,duration_days,disposition,legal_basis,enforcement_state,active)
VALUES
  ('support_conversation_policy_pending','support conversation and message','conversation resolved',NULL,'restrict_then_delete','POLICY PENDING: operations and legal must approve a duration based on service necessity, after-sales disputes, legal duties, and user rights before activation','declared',false),
  ('support_audit_policy_pending','support handling audit and purge tombstone','support event recorded',NULL,'restrict_then_delete','POLICY PENDING: operations and legal must approve the minimum audit retention needed for accountability and disputes before activation','declared',false);
INSERT INTO processing_purpose(code,title,description,lawful_basis,required,data_categories,retention_policy_code,active)
VALUES('support_service','客服与问题处理','处理用户主动提交的客服咨询、人工接管、回复和解决状态；模型与外部处理者当前未启用。','contract_necessary',false,ARRAY['support message','member nickname','masked phone when explicitly viewed'],'support_conversation_policy_pending',false);

CREATE TABLE support_conversation (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id uuid NOT NULL UNIQUE REFERENCES member(id),
  status text NOT NULL CHECK (status IN ('ai_active','waiting_human','human_active','resolved')),
  current_handler_principal_id text,
  priority text NOT NULL DEFAULT 'normal' CHECK (priority IN ('normal','high','urgent')),
  next_sequence bigint NOT NULL DEFAULT 1 CHECK (next_sequence > 0),
  member_unread_count integer NOT NULL DEFAULT 0 CHECK (member_unread_count >= 0),
  team_unread_count integer NOT NULL DEFAULT 0 CHECK (team_unread_count >= 0),
  member_last_read_sequence bigint NOT NULL DEFAULT 0 CHECK (member_last_read_sequence >= 0),
  team_last_read_sequence bigint NOT NULL DEFAULT 0 CHECK (team_last_read_sequence >= 0),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  CHECK ((status = 'human_active') = (current_handler_principal_id IS NOT NULL)),
  CHECK ((status = 'resolved' AND resolved_at IS NOT NULL) OR (status <> 'resolved' AND resolved_at IS NULL))
);

CREATE TABLE support_message (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES support_conversation(id),
  sequence bigint NOT NULL CHECK (sequence > 0),
  sender_type text NOT NULL CHECK (sender_type IN ('user','ai','admin','system')),
  sender_principal_id text NOT NULL,
  body text NOT NULL CHECK (length(btrim(body)) BETWEEN 1 AND 4000),
  attachment_refs jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(attachment_refs) = 'array'),
  client_message_id text NOT NULL CHECK (length(client_message_id) BETWEEN 8 AND 200),
  delivery_state text NOT NULL DEFAULT 'persisted' CHECK (delivery_state IN ('persisted','read')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (conversation_id, sequence),
  UNIQUE (conversation_id, sender_type, sender_principal_id, client_message_id)
);

CREATE INDEX support_conversation_team_queue
  ON support_conversation(status, team_unread_count DESC, updated_at DESC, id DESC);
CREATE INDEX support_conversation_retention_eligible
  ON support_conversation(resolved_at, id) WHERE status='resolved';
CREATE INDEX support_message_conversation_sequence
  ON support_message(conversation_id, sequence DESC);

CREATE FUNCTION reject_support_message_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' AND current_setting('cisme.support_purge_conversation_id',true)=OLD.conversation_id::text THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'SUPPORT_MESSAGE_IMMUTABLE';
END $$;
CREATE TRIGGER support_message_immutable BEFORE UPDATE OR DELETE ON support_message
  FOR EACH ROW EXECUTE FUNCTION reject_support_message_mutation();

CREATE FUNCTION enforce_support_message_sender() RETURNS trigger LANGUAGE plpgsql AS $$
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
CREATE TRIGGER support_message_sender_guard BEFORE INSERT ON support_message
  FOR EACH ROW EXECUTE FUNCTION enforce_support_message_sender();

CREATE FUNCTION enforce_support_conversation_transition() RETURNS trigger LANGUAGE plpgsql AS $$
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
CREATE TRIGGER support_conversation_transition_guard BEFORE UPDATE ON support_conversation
  FOR EACH ROW EXECUTE FUNCTION enforce_support_conversation_transition();

CREATE FUNCTION enforce_support_conversation_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('cisme.support_purge_conversation_id',true) IS DISTINCT FROM OLD.id::text THEN
    RAISE EXCEPTION 'SUPPORT_CONVERSATION_PURGE_PATH_REQUIRED';
  END IF;
  RETURN OLD;
END $$;
CREATE TRIGGER support_conversation_delete_guard BEFORE DELETE ON support_conversation
  FOR EACH ROW EXECUTE FUNCTION enforce_support_conversation_delete();

-- migrate:down
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM support_message) OR EXISTS(SELECT 1 FROM support_conversation) THEN
    RAISE EXCEPTION 'SUPPORT_ROLLBACK_REQUIRES_DATA_PRESERVATION';
  END IF;
END $$;
DROP TRIGGER support_message_sender_guard ON support_message;
DROP FUNCTION enforce_support_message_sender();
DROP TRIGGER support_message_immutable ON support_message;
DROP FUNCTION reject_support_message_mutation();
DROP TRIGGER support_conversation_delete_guard ON support_conversation;
DROP FUNCTION enforce_support_conversation_delete();
DROP TRIGGER support_conversation_transition_guard ON support_conversation;
DROP FUNCTION enforce_support_conversation_transition();
DROP TABLE support_message;
DROP TABLE support_conversation;
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM processing_purpose WHERE code='support_service' AND (active OR version<>1)) OR
     EXISTS(SELECT 1 FROM data_retention_policy WHERE code IN ('support_conversation_policy_pending','support_audit_policy_pending') AND (active OR version<>1 OR enforcement_state<>'declared' OR duration_days IS NOT NULL)) THEN
    RAISE EXCEPTION 'SUPPORT_PRIVACY_POLICY_ROLLBACK_REQUIRES_REVIEW';
  END IF;
END $$;
DELETE FROM processing_purpose WHERE code='support_service';
DELETE FROM data_retention_policy WHERE code IN ('support_conversation_policy_pending','support_audit_policy_pending');
