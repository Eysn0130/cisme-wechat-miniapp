-- migrate:up
ALTER TABLE sharing_v2_agreement_document DROP CONSTRAINT sharing_v2_agreement_document_agreement_version_check;
ALTER TABLE sharing_v2_agreement_document ADD CONSTRAINT sharing_v2_agreement_document_agreement_version_check
  CHECK (agreement_version IN ('V2.0', 'V2.0.1'));
ALTER TABLE sharing_v2_application DROP CONSTRAINT sharing_v2_application_agreement_version_check;
ALTER TABLE sharing_v2_application ADD CONSTRAINT sharing_v2_application_agreement_version_check
  CHECK (agreement_version IN ('V2.0', 'V2.0.1'));

-- The first approval belongs to the immediately preceding application version.
-- Historical identity evidence keeps its original timestamp and contents.
CREATE FUNCTION sharing_v2_approval_at(officer_id uuid, application integer)
RETURNS timestamptz LANGUAGE sql STABLE STRICT AS $$
  SELECT COALESCE(a.verified_at, e.occurred_at)
  FROM sharing_v2_application a
  LEFT JOIN sharing_officer_event e ON e.member_id=a.member_id AND e.version=a.application_version+1
    AND e.from_state='pending' AND e.to_state='active' AND e.actor_id<>a.member_id
    AND e.occurred_at>=a.accepted_at
  WHERE a.member_id=officer_id AND a.application_version=application
$$;

CREATE OR REPLACE FUNCTION guard_sharing_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.program <> 'sharing_officer' THEN RETURN NEW; END IF;
 IF NEW.referrer_member_id=NEW.buyer_member_id
   OR NOT EXISTS(SELECT 1 FROM sharing_policy p WHERE p.id=NEW.sharing_policy_id
     AND (NEW.sharing_v2_application_version IS NOT NULL OR p.basis_points=NEW.basis_points))
   OR (NEW.sharing_v2_application_version IS NOT NULL AND (
     NEW.basis_points<>3000 OR NEW.source_kind<>'verified_commerce'
     OR sharing_v2_approval_at(NEW.referrer_member_id,NEW.sharing_v2_application_version) IS NULL
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

-- migrate:down
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM sharing_v2_agreement_document WHERE agreement_version='V2.0.1')
   OR EXISTS(SELECT 1 FROM sharing_v2_application a WHERE a.verified_at IS NULL
     AND sharing_v2_approval_at(a.member_id,a.application_version) IS NOT NULL)
 THEN RAISE EXCEPTION 'SHARING_APPROVAL_ROLLBACK_REQUIRES_EVIDENCE_PRESERVATION' USING ERRCODE='55000'; END IF;
END $$;

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

DROP FUNCTION sharing_v2_approval_at(uuid, integer);
ALTER TABLE sharing_v2_application DROP CONSTRAINT sharing_v2_application_agreement_version_check;
ALTER TABLE sharing_v2_application ADD CONSTRAINT sharing_v2_application_agreement_version_check
  CHECK (agreement_version = 'V2.0');
ALTER TABLE sharing_v2_agreement_document DROP CONSTRAINT sharing_v2_agreement_document_agreement_version_check;
ALTER TABLE sharing_v2_agreement_document ADD CONSTRAINT sharing_v2_agreement_document_agreement_version_check
  CHECK (agreement_version = 'V2.0');
