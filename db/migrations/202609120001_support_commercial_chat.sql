CREATE TABLE support_operator_profile (
  principal_id text PRIMARY KEY,
  display_name text NOT NULL CHECK (length(btrim(display_name)) BETWEEN 1 AND 40),
  avatar_variant text NOT NULL DEFAULT 'cisme' CHECK (avatar_variant IN ('cisme','plum','pearl')),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE support_presence (
  conversation_id uuid NOT NULL REFERENCES support_conversation(id) ON DELETE CASCADE,
  actor_type text NOT NULL CHECK (actor_type IN ('member','operator')),
  actor_principal_id text NOT NULL,
  online_expires_at timestamptz NOT NULL,
  typing_expires_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (conversation_id, actor_type),
  CHECK (typing_expires_at <= online_expires_at)
);
CREATE INDEX support_presence_expiry ON support_presence(online_expires_at, conversation_id);

ALTER TABLE support_message ADD COLUMN content_type text NOT NULL DEFAULT 'text';
ALTER TABLE support_message ADD COLUMN linked_order_id uuid REFERENCES commerce_order(id) ON DELETE RESTRICT;
ALTER TABLE support_message ADD COLUMN order_snapshot jsonb;
UPDATE support_message SET content_type='system' WHERE sender_type='system';
ALTER TABLE support_message DROP CONSTRAINT support_message_body_check;
ALTER TABLE support_message ADD CONSTRAINT support_message_body_check
  CHECK (length(btrim(body)) BETWEEN 0 AND 4000);
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
CREATE INDEX support_message_linked_order ON support_message(linked_order_id) WHERE linked_order_id IS NOT NULL;

DROP INDEX media_hash_unique;
CREATE UNIQUE INDEX media_hash_unique ON media_object(content_hash)
  WHERE content_hash IS NOT NULL AND upload_state='uploaded' AND is_current AND submission_id IS NOT NULL;
ALTER TABLE media_object ALTER COLUMN submission_id DROP NOT NULL;
ALTER TABLE media_object DROP CONSTRAINT media_object_kind_check;
ALTER TABLE media_object ADD COLUMN support_conversation_id uuid REFERENCES support_conversation(id) ON DELETE CASCADE;
ALTER TABLE media_object ADD COLUMN support_member_id uuid REFERENCES member(id) ON DELETE RESTRICT;
ALTER TABLE media_object ADD COLUMN bound_support_message_id uuid REFERENCES support_message(id) ON DELETE SET NULL;
ALTER TABLE media_object ADD COLUMN authorized_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE media_object ADD COLUMN support_expires_at timestamptz;
ALTER TABLE media_object ADD CONSTRAINT media_object_parent_check CHECK (
  (submission_id IS NOT NULL AND support_conversation_id IS NULL AND support_member_id IS NULL AND support_expires_at IS NULL AND kind IN ('original','screenshot'))
  OR (submission_id IS NULL AND support_conversation_id IS NOT NULL AND support_member_id IS NOT NULL AND support_expires_at IS NOT NULL AND kind='chat_image')
);
CREATE INDEX media_object_support_draft ON media_object(support_conversation_id, support_member_id, upload_state, support_expires_at)
  WHERE submission_id IS NULL;
CREATE INDEX media_object_support_message ON media_object(bound_support_message_id)
  WHERE bound_support_message_id IS NOT NULL;

ALTER TABLE media_cleanup_queue DROP CONSTRAINT media_cleanup_queue_reason_check;
ALTER TABLE media_cleanup_queue ADD CONSTRAINT media_cleanup_queue_reason_check
  CHECK (reason IN ('replaced','member_deleted','failed_verification','authorization_expired','support_deleted','support_orphan','support_purged'));
ALTER TABLE media_cleanup_queue DROP CONSTRAINT media_cleanup_queue_media_id_fkey;
ALTER TABLE media_cleanup_queue ALTER COLUMN media_id DROP NOT NULL;
ALTER TABLE media_cleanup_queue ADD CONSTRAINT media_cleanup_queue_media_id_fkey
  FOREIGN KEY (media_id) REFERENCES media_object(id) ON DELETE SET NULL;

-- migrate:down
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM support_operator_profile)
     OR EXISTS(SELECT 1 FROM support_presence)
     OR EXISTS(SELECT 1 FROM support_message WHERE content_type NOT IN ('text','system') OR linked_order_id IS NOT NULL OR jsonb_array_length(attachment_refs)>0)
     OR EXISTS(SELECT 1 FROM media_object WHERE support_conversation_id IS NOT NULL)
     OR EXISTS(SELECT 1 FROM media_cleanup_queue WHERE media_id IS NULL OR reason IN ('support_deleted','support_orphan','support_purged')) THEN
    RAISE EXCEPTION 'SUPPORT_COMMERCIAL_CHAT_ROLLBACK_REQUIRES_DATA_PRESERVATION';
  END IF;
END $$;
DROP INDEX media_object_support_draft;
DROP INDEX media_object_support_message;
ALTER TABLE media_object DROP CONSTRAINT media_object_parent_check;
ALTER TABLE media_object DROP COLUMN support_expires_at;
ALTER TABLE media_object DROP COLUMN authorized_at;
ALTER TABLE media_object DROP COLUMN bound_support_message_id;
ALTER TABLE media_object DROP COLUMN support_member_id;
ALTER TABLE media_object DROP COLUMN support_conversation_id;
ALTER TABLE media_object ALTER COLUMN submission_id SET NOT NULL;
ALTER TABLE media_object ADD CONSTRAINT media_object_kind_check CHECK (kind IN ('original','screenshot'));
DROP INDEX media_hash_unique;
CREATE UNIQUE INDEX media_hash_unique ON media_object(content_hash) WHERE content_hash IS NOT NULL AND upload_state='uploaded' AND is_current;
DROP INDEX support_message_linked_order;
ALTER TABLE support_message DROP CONSTRAINT support_message_content_shape_check;
ALTER TABLE support_message DROP CONSTRAINT support_message_content_type_check;
ALTER TABLE support_message DROP CONSTRAINT support_message_body_check;
ALTER TABLE support_message ADD CONSTRAINT support_message_body_check CHECK (length(btrim(body)) BETWEEN 1 AND 4000);
ALTER TABLE support_message DROP COLUMN order_snapshot;
ALTER TABLE support_message DROP COLUMN linked_order_id;
ALTER TABLE support_message DROP COLUMN content_type;
DROP TABLE support_presence;
DROP TABLE support_operator_profile;
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM media_cleanup_queue WHERE media_id IS NULL) THEN
    RAISE EXCEPTION 'MEDIA_CLEANUP_ROLLBACK_REQUIRES_DRAIN';
  END IF;
END $$;
ALTER TABLE media_cleanup_queue DROP CONSTRAINT media_cleanup_queue_media_id_fkey;
ALTER TABLE media_cleanup_queue ALTER COLUMN media_id SET NOT NULL;
ALTER TABLE media_cleanup_queue ADD CONSTRAINT media_cleanup_queue_media_id_fkey
  FOREIGN KEY (media_id) REFERENCES media_object(id);
ALTER TABLE media_cleanup_queue DROP CONSTRAINT media_cleanup_queue_reason_check;
ALTER TABLE media_cleanup_queue ADD CONSTRAINT media_cleanup_queue_reason_check
  CHECK (reason IN ('replaced','member_deleted','failed_verification','authorization_expired'));
