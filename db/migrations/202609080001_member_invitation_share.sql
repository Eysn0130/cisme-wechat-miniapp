BEGIN;
ALTER TABLE share_link DROP CONSTRAINT share_link_target_type_check;
ALTER TABLE share_link ADD CONSTRAINT share_link_target_type_check CHECK (target_type IN ('post','product','invite'));
ALTER TABLE share_link ADD CONSTRAINT share_link_invite_target_check CHECK (target_type <> 'invite' OR target_ref = 'home');
COMMIT;

-- migrate:down
BEGIN;
-- Refuse rollback when invitation facts exist; never delete attribution history.
ALTER TABLE share_link DROP CONSTRAINT share_link_invite_target_check;
ALTER TABLE share_link DROP CONSTRAINT share_link_target_type_check;
ALTER TABLE share_link ADD CONSTRAINT share_link_target_type_check CHECK (target_type IN ('post','product'));
COMMIT;
