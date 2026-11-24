-- migrate:up
CREATE TABLE sharing_v2_agreement_document (
  agreement_version text NOT NULL CHECK (agreement_version = 'V2.0'),
  agreement_digest text NOT NULL CHECK (agreement_digest ~ '^[0-9a-f]{64}$'),
  effective_on date NOT NULL,
  body_snapshot json NOT NULL,
  PRIMARY KEY (agreement_version, agreement_digest, effective_on),
  CHECK (body_snapshot->>'version' IS NOT DISTINCT FROM agreement_version
    AND (body_snapshot->>'effectiveOn')::date IS NOT DISTINCT FROM effective_on
    AND encode(digest(body_snapshot::text,'sha256'),'hex')=agreement_digest)
);
CREATE TRIGGER sharing_v2_agreement_document_immutable BEFORE UPDATE OR DELETE ON sharing_v2_agreement_document
  FOR EACH ROW EXECUTE FUNCTION commercial_evidence_immutable();

CREATE TABLE sharing_v2_application (
  member_id uuid NOT NULL REFERENCES sharing_officer(member_id),
  application_version integer NOT NULL CHECK (application_version > 0),
  agreement_version text NOT NULL CHECK (agreement_version = 'V2.0'),
  agreement_digest text NOT NULL CHECK (agreement_digest ~ '^[0-9a-f]{64}$'),
  effective_on date NOT NULL,
  accepted_at timestamptz NOT NULL,
  verified_by uuid REFERENCES member(id),
  verified_at timestamptz,
  verification_reference text CHECK (char_length(verification_reference) BETWEEN 4 AND 80),
  PRIMARY KEY (member_id, application_version),
  FOREIGN KEY (agreement_version, agreement_digest, effective_on)
    REFERENCES sharing_v2_agreement_document(agreement_version, agreement_digest, effective_on),
  CHECK ((verified_at IS NULL AND verified_by IS NULL AND verification_reference IS NULL)
    OR (verified_at IS NOT NULL AND verified_at >= accepted_at AND verified_by IS NOT NULL
      AND verified_by <> member_id AND verification_reference IS NOT NULL))
);
CREATE FUNCTION guard_sharing_v2_application() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' OR OLD.verified_at IS NOT NULL OR NEW.verified_at IS NULL
   OR (OLD.member_id,OLD.application_version,OLD.agreement_version,OLD.agreement_digest,OLD.effective_on,OLD.accepted_at)
     IS DISTINCT FROM (NEW.member_id,NEW.application_version,NEW.agreement_version,NEW.agreement_digest,NEW.effective_on,NEW.accepted_at)
 THEN RAISE EXCEPTION 'SHARING_V2_AGREEMENT_EVIDENCE_IMMUTABLE' USING ERRCODE='55000'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER sharing_v2_application_guard BEFORE UPDATE OR DELETE ON sharing_v2_application
  FOR EACH ROW EXECUTE FUNCTION guard_sharing_v2_application();
ALTER TABLE sharing_officer ADD COLUMN v2_application_version integer;
ALTER TABLE sharing_officer ADD CONSTRAINT sharing_v2_current_application
  FOREIGN KEY (member_id,v2_application_version) REFERENCES sharing_v2_application(member_id,application_version);

CREATE TABLE sharing_v2_referral_intent (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  buyer_id uuid NOT NULL REFERENCES member(id),
  officer_id uuid NOT NULL REFERENCES sharing_officer(member_id),
  visit_id uuid REFERENCES sharing_visit(id),
  source text NOT NULL CHECK (source IN ('first_touch','member_choice')),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','bound','superseded','released')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (buyer_id <> officer_id)
);
CREATE UNIQUE INDEX sharing_v2_pending_buyer ON sharing_v2_referral_intent(buyer_id) WHERE state='pending';
CREATE INDEX sharing_v2_pending_officer ON sharing_v2_referral_intent(officer_id) WHERE state='pending';

ALTER TABLE commission_order_snapshot
  ADD COLUMN sharing_v2_application_version integer,
  ADD COLUMN sharing_v2_intent_id uuid REFERENCES sharing_v2_referral_intent(id),
  ADD CONSTRAINT sharing_snapshot_v2_application FOREIGN KEY(referrer_member_id,sharing_v2_application_version)
    REFERENCES sharing_v2_application(member_id,application_version);
ALTER TABLE commission_order_snapshot DROP CONSTRAINT commission_program_shape;
ALTER TABLE commission_order_snapshot ADD CONSTRAINT commission_program_shape CHECK (
  (program='legacy' AND referral_code_id IS NOT NULL AND rate_rule_id IS NOT NULL AND buyer_member_id<>referrer_member_id
    AND sharing_policy_id IS NULL AND sharing_visit_id IS NULL AND sharing_relation_event_id IS NULL
    AND sharing_v2_application_version IS NULL AND sharing_v2_intent_id IS NULL)
  OR (program='sharing_officer' AND referral_code_id IS NULL AND rate_rule_id IS NULL AND sharing_policy_id IS NOT NULL
    AND num_nonnulls(sharing_relation_event_id,sharing_v2_intent_id)=1)
);

CREATE OR REPLACE FUNCTION guard_sharing_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.program <> 'sharing_officer' THEN RETURN NEW; END IF;
 IF NEW.referrer_member_id=NEW.buyer_member_id
   OR NOT EXISTS(SELECT 1 FROM sharing_policy p WHERE p.id=NEW.sharing_policy_id
     AND (NEW.sharing_v2_application_version IS NOT NULL OR p.basis_points=NEW.basis_points))
   OR (NEW.sharing_v2_application_version IS NOT NULL AND (
     NEW.basis_points<>3000 OR NEW.source_kind<>'verified_commerce' OR NOT EXISTS(
       SELECT 1 FROM sharing_v2_application a WHERE a.member_id=NEW.referrer_member_id
         AND a.application_version=NEW.sharing_v2_application_version AND a.verified_at IS NOT NULL
     )
   ))
   OR NOT (
    EXISTS(SELECT 1 FROM sharing_relation_event e WHERE e.id=NEW.sharing_relation_event_id
      AND e.buyer_id=NEW.buyer_member_id AND e.to_officer_id=NEW.referrer_member_id AND e.visit_id IS NOT DISTINCT FROM NEW.sharing_visit_id)
    OR (NEW.source_kind='verified_commerce' AND EXISTS(
      SELECT 1 FROM sharing_v2_referral_intent i JOIN sharing_officer o ON o.member_id=i.officer_id
      WHERE i.id=NEW.sharing_v2_intent_id AND i.state='pending' AND o.state='active'
        AND o.v2_application_version IS NOT DISTINCT FROM NEW.sharing_v2_application_version
        AND i.buyer_id=NEW.buyer_member_id AND i.officer_id=NEW.referrer_member_id AND i.visit_id IS NOT DISTINCT FROM NEW.sharing_visit_id
    ))
   )
 THEN RAISE EXCEPTION 'SHARING_SNAPSHOT_SOURCE_MISMATCH' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;

ALTER TABLE sharing_officer_event ALTER COLUMN actor_id DROP NOT NULL;
ALTER TABLE sharing_officer_event ADD COLUMN system_assessment boolean NOT NULL DEFAULT false;
ALTER TABLE sharing_officer_event ADD CONSTRAINT sharing_officer_event_actor_check CHECK (
  (actor_id IS NOT NULL AND NOT system_assessment)
  OR (actor_id IS NULL AND system_assessment AND from_state='active' AND to_state='terminated'));

CREATE TABLE sharing_v2_assessment (
  member_id uuid NOT NULL,
  application_version integer NOT NULL,
  through_period text NOT NULL CHECK (through_period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  valid_order_counts integer[] NOT NULL CHECK (cardinality(valid_order_counts)=3),
  terminated boolean NOT NULL,
  reviewed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(member_id,application_version,through_period),
  FOREIGN KEY(member_id,application_version) REFERENCES sharing_v2_application(member_id,application_version)
);
CREATE TRIGGER sharing_v2_assessment_immutable BEFORE UPDATE OR DELETE ON sharing_v2_assessment
  FOR EACH ROW EXECUTE FUNCTION commercial_evidence_immutable();

-- migrate:down
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM sharing_v2_agreement_document) OR EXISTS(SELECT 1 FROM sharing_v2_referral_intent)
 THEN RAISE EXCEPTION 'SHARING_V2_ROLLBACK_REQUIRES_EVIDENCE_PRESERVATION' USING ERRCODE='55000'; END IF;
END $$;
DROP TABLE sharing_v2_assessment;
ALTER TABLE sharing_officer_event DROP CONSTRAINT sharing_officer_event_actor_check;
ALTER TABLE sharing_officer_event DROP COLUMN system_assessment;
ALTER TABLE sharing_officer_event ALTER COLUMN actor_id SET NOT NULL;
ALTER TABLE commission_order_snapshot DROP CONSTRAINT commission_program_shape;
ALTER TABLE commission_order_snapshot DROP CONSTRAINT sharing_snapshot_v2_application;
ALTER TABLE commission_order_snapshot DROP COLUMN sharing_v2_intent_id, DROP COLUMN sharing_v2_application_version;
ALTER TABLE commission_order_snapshot ADD CONSTRAINT commission_program_shape CHECK(
 (program='legacy' AND referral_code_id IS NOT NULL AND rate_rule_id IS NOT NULL AND buyer_member_id<>referrer_member_id
  AND sharing_policy_id IS NULL AND sharing_visit_id IS NULL AND sharing_relation_event_id IS NULL)
 OR (program='sharing_officer' AND referral_code_id IS NULL AND rate_rule_id IS NULL
  AND sharing_policy_id IS NOT NULL AND sharing_relation_event_id IS NOT NULL));
CREATE OR REPLACE FUNCTION guard_sharing_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.program='sharing_officer' AND NOT EXISTS(
  SELECT 1 FROM sharing_relation_event e JOIN sharing_policy p ON p.id=NEW.sharing_policy_id
  WHERE e.id=NEW.sharing_relation_event_id AND e.buyer_id=NEW.buyer_member_id AND e.to_officer_id=NEW.referrer_member_id
   AND e.visit_id IS NOT DISTINCT FROM NEW.sharing_visit_id AND p.basis_points=NEW.basis_points
   AND NEW.referrer_member_id<>NEW.buyer_member_id
 ) THEN RAISE EXCEPTION 'SHARING_SNAPSHOT_SOURCE_MISMATCH' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
ALTER TABLE sharing_officer DROP COLUMN v2_application_version;
DROP TABLE sharing_v2_referral_intent;
DROP TABLE sharing_v2_application;
DROP TABLE sharing_v2_agreement_document;
DROP FUNCTION guard_sharing_v2_application();
