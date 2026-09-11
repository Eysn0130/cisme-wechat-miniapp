-- Operational authority is an enhancement of an existing CISME member, not a
-- second account system. Grants are evaluated on every sensitive request.
CREATE TABLE authority_grant (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id uuid NOT NULL REFERENCES member(id),
  capability text NOT NULL CHECK (capability IN (
    'support.read','support.reply','support.assign',
    'commerce.product.manage','commerce.inventory.manage','commerce.order.read',
    'commerce.fulfillment.manage','commerce.refund.approve',
    'community.moderate','member.support_view','privacy.request.manage'
  )),
  granted_by text NOT NULL,
  grant_reason text NOT NULL CHECK (length(btrim(grant_reason)) BETWEEN 3 AND 500),
  granted_at timestamptz NOT NULL DEFAULT now(),
  revoked_by text,
  revoke_reason text,
  revoked_at timestamptz,
  CHECK ((revoked_at IS NULL AND revoked_by IS NULL AND revoke_reason IS NULL) OR
         (revoked_at IS NOT NULL AND revoked_by IS NOT NULL AND length(btrim(revoke_reason)) BETWEEN 3 AND 500))
);

CREATE UNIQUE INDEX authority_grant_one_active_capability
  ON authority_grant(member_id, capability) WHERE revoked_at IS NULL;
CREATE INDEX authority_grant_member_history
  ON authority_grant(member_id, granted_at DESC, id DESC);

CREATE FUNCTION protect_authority_grant_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'AUTHORITY_GRANT_EVIDENCE_IMMUTABLE';
  END IF;
  IF NEW.member_id <> OLD.member_id OR NEW.capability <> OLD.capability OR
     NEW.granted_by <> OLD.granted_by OR NEW.grant_reason <> OLD.grant_reason OR
     NEW.granted_at <> OLD.granted_at THEN
    RAISE EXCEPTION 'AUTHORITY_GRANT_EVIDENCE_IMMUTABLE';
  END IF;
  IF OLD.revoked_at IS NOT NULL AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'AUTHORITY_GRANT_REVOCATION_IMMUTABLE';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER authority_grant_evidence_guard BEFORE UPDATE OR DELETE ON authority_grant
  FOR EACH ROW EXECUTE FUNCTION protect_authority_grant_evidence();

CREATE FUNCTION audit_authority_grant_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    INSERT INTO audit_log(principal_id,action,object_type,object_id,reason_code,before_state,after_state,trace_id)
    VALUES(NEW.granted_by,'authority.grant','authority_grant',NEW.id,NEW.grant_reason,NULL,
      jsonb_build_object('memberId',NEW.member_id,'capability',NEW.capability),'authority-grant:'||NEW.id::text);
  ELSIF OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL THEN
    INSERT INTO audit_log(principal_id,action,object_type,object_id,reason_code,before_state,after_state,trace_id)
    VALUES(NEW.revoked_by,'authority.revoke','authority_grant',NEW.id,NEW.revoke_reason,
      jsonb_build_object('memberId',OLD.member_id,'capability',OLD.capability,'active',true),
      jsonb_build_object('memberId',NEW.member_id,'capability',NEW.capability,'active',false),'authority-revoke:'||NEW.id::text);
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER authority_grant_audit AFTER INSERT OR UPDATE ON authority_grant
  FOR EACH ROW EXECUTE FUNCTION audit_authority_grant_change();

-- migrate:down
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM authority_grant) THEN
    RAISE EXCEPTION 'AUTHORITY_GRANT_ROLLBACK_REQUIRES_DATA_PRESERVATION';
  END IF;
END $$;
DROP TRIGGER authority_grant_audit ON authority_grant;
DROP FUNCTION audit_authority_grant_change();
DROP TRIGGER authority_grant_evidence_guard ON authority_grant;
DROP FUNCTION protect_authority_grant_evidence();
DROP TABLE authority_grant;
