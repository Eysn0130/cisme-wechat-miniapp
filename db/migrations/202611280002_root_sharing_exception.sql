-- migrate:up
ALTER TABLE sharing_officer DROP CONSTRAINT sharing_officer_state_check;
ALTER TABLE sharing_officer ADD CONSTRAINT sharing_officer_state_check
  CHECK (state IN ('pending','rejected','active','suspended','terminated','promotion_only'));

ALTER TABLE sharing_officer_event ADD COLUMN root_exception boolean NOT NULL DEFAULT false;
ALTER TABLE sharing_officer_event ADD CONSTRAINT sharing_officer_event_root_exception_check CHECK (
  NOT root_exception OR (actor_id IS NOT NULL AND actor_id=member_id AND NOT system_assessment
    AND from_state IS NOT DISTINCT FROM 'pending' AND to_state='active')
);

CREATE OR REPLACE FUNCTION sharing_v2_approval_at(officer_id uuid, application integer)
RETURNS timestamptz LANGUAGE sql STABLE STRICT AS $$
  SELECT COALESCE(a.verified_at, e.occurred_at)
  FROM sharing_v2_application a
  LEFT JOIN sharing_officer_event e ON e.member_id=a.member_id AND e.version=a.application_version+1
    AND e.from_state='pending' AND e.to_state='active' AND (e.actor_id<>a.member_id OR e.root_exception)
    AND e.occurred_at>=a.accepted_at
  WHERE a.member_id=officer_id AND a.application_version=application
$$;

-- migrate:down
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM sharing_officer WHERE state='promotion_only')
    OR EXISTS (SELECT 1 FROM sharing_officer_event WHERE root_exception)
    OR EXISTS (SELECT 1 FROM audit_log WHERE action='sharing.root.promotion.grant')
  THEN RAISE EXCEPTION 'SHARING_ROOT_EXCEPTION_ROLLBACK_REQUIRES_EVIDENCE_PRESERVATION' USING ERRCODE='55000'; END IF;
END $$;

CREATE OR REPLACE FUNCTION sharing_v2_approval_at(officer_id uuid, application integer)
RETURNS timestamptz LANGUAGE sql STABLE STRICT AS $$
  SELECT COALESCE(a.verified_at, e.occurred_at)
  FROM sharing_v2_application a
  LEFT JOIN sharing_officer_event e ON e.member_id=a.member_id AND e.version=a.application_version+1
    AND e.from_state='pending' AND e.to_state='active' AND e.actor_id<>a.member_id
    AND e.occurred_at>=a.accepted_at
  WHERE a.member_id=officer_id AND a.application_version=application
$$;

ALTER TABLE sharing_officer_event DROP COLUMN root_exception;
ALTER TABLE sharing_officer DROP CONSTRAINT sharing_officer_state_check;
ALTER TABLE sharing_officer ADD CONSTRAINT sharing_officer_state_check
  CHECK (state IN ('pending','rejected','active','suspended','terminated'));
