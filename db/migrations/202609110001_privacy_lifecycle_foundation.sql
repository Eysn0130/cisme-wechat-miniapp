-- Privacy lifecycle foundation. These tables define closed, auditable control
-- planes; this migration does not execute exports, erasure, or account closure.

ALTER TABLE privacy_request
  ADD COLUMN version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  ADD COLUMN due_at timestamptz,
  ADD COLUMN resolution_code text,
  ADD COLUMN completed_at timestamptz;

UPDATE privacy_request SET due_at = created_at + interval '30 days';
ALTER TABLE privacy_request ALTER COLUMN due_at SET NOT NULL;
ALTER TABLE privacy_request ADD CONSTRAINT privacy_request_due_after_creation CHECK (due_at >= created_at);
ALTER TABLE privacy_request DROP CONSTRAINT privacy_request_status_check;
ALTER TABLE privacy_request ADD CONSTRAINT privacy_request_status_check CHECK(status IN (
  'received','verifying','reviewing','approved','executing','completed',
  'partially_completed','failed','rejected','canceled','responded'
));
ALTER TABLE privacy_request ADD CONSTRAINT privacy_request_completion_check CHECK (
  (status IN ('completed','partially_completed') AND completed_at IS NOT NULL)
  OR (status NOT IN ('completed','partially_completed') AND completed_at IS NULL)
);

CREATE FUNCTION guard_privacy_request_status_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status=OLD.status THEN RETURN NEW; END IF;
  IF NOT (
    (OLD.status='received' AND NEW.status IN ('verifying','reviewing','responded','rejected','canceled'))
    OR (OLD.status='verifying' AND NEW.status IN ('reviewing','responded','rejected','canceled'))
    OR (OLD.status='reviewing' AND NEW.status IN ('verifying','responded','approved','rejected','canceled'))
    OR (OLD.status='responded' AND NEW.status IN ('verifying','reviewing','approved','rejected','canceled'))
    OR (OLD.status='approved' AND NEW.status IN ('executing','canceled'))
    OR (OLD.status='executing' AND NEW.status IN ('completed','partially_completed','failed'))
    OR (OLD.status='failed' AND NEW.status IN ('reviewing','approved','canceled'))
  ) THEN RAISE EXCEPTION 'PRIVACY_REQUEST_STATUS_TRANSITION_INVALID' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER privacy_request_status_transition BEFORE UPDATE OF status ON privacy_request
FOR EACH ROW EXECUTE FUNCTION guard_privacy_request_status_transition();

CREATE TABLE data_retention_policy (
  code text PRIMARY KEY CHECK (code ~ '^[a-z][a-z0-9_]{2,79}$'),
  data_class text NOT NULL CHECK (length(data_class) BETWEEN 3 AND 120),
  trigger_event text NOT NULL CHECK (length(trigger_event) BETWEEN 3 AND 120),
  duration_days integer CHECK (duration_days IS NULL OR duration_days > 0),
  disposition text NOT NULL CHECK (disposition IN ('delete','anonymize','restrict_then_delete','device_controlled')),
  legal_basis text NOT NULL CHECK (length(legal_basis) BETWEEN 3 AND 500),
  enforcement_state text NOT NULL DEFAULT 'declared' CHECK (enforcement_state IN ('declared','enforced')),
  active boolean NOT NULL DEFAULT false,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (NOT active OR enforcement_state = 'enforced')
);

CREATE TABLE processing_purpose (
  code text PRIMARY KEY CHECK (code ~ '^[a-z][a-z0-9_]{2,79}$'),
  title text NOT NULL CHECK (length(title) BETWEEN 2 AND 120),
  description text NOT NULL CHECK (length(description) BETWEEN 10 AND 1000),
  lawful_basis text NOT NULL CHECK (lawful_basis IN (
    'consent','separate_consent','contract_necessary','hr_management',
    'legal_duty','public_health','public_interest','publicly_disclosed','other_law'
  )),
  required boolean NOT NULL,
  data_categories text[] NOT NULL CHECK (cardinality(data_categories) > 0),
  retention_policy_code text NOT NULL REFERENCES data_retention_policy(code),
  active boolean NOT NULL DEFAULT false,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE processor_registry (
  code text PRIMARY KEY CHECK (code ~ '^[a-z][a-z0-9_]{2,79}$'),
  provider_name text NOT NULL CHECK (length(provider_name) BETWEEN 2 AND 200),
  processor_role text NOT NULL CHECK (processor_role IN ('processor','joint_controller','independent_controller')),
  processing_region text NOT NULL CHECK (length(processing_region) BETWEEN 2 AND 200),
  data_categories text[] NOT NULL CHECK (cardinality(data_categories) > 0),
  purpose_codes text[] NOT NULL CHECK (cardinality(purpose_codes) > 0),
  agreement_reference text NOT NULL CHECK (length(agreement_reference) BETWEEN 3 AND 500),
  subprocessors_reviewed_at timestamptz,
  exit_plan text NOT NULL CHECK (length(exit_plan) BETWEEN 10 AND 1000),
  active boolean NOT NULL DEFAULT false,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE consent_receipt (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id uuid NOT NULL REFERENCES member(id),
  purpose_code text NOT NULL REFERENCES processing_purpose(code),
  purpose_version integer NOT NULL CHECK (purpose_version > 0),
  document_type text NOT NULL,
  document_version text NOT NULL,
  scope jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(scope) = 'object'),
  channel text NOT NULL CHECK (channel IN ('miniprogram','admin_assisted','api_migration')),
  proof_sha256 text NOT NULL CHECK (proof_sha256 ~ '^[0-9a-f]{64}$'),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','withdrawn')),
  granted_at timestamptz NOT NULL,
  withdrawn_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((status = 'active' AND withdrawn_at IS NULL) OR (status = 'withdrawn' AND withdrawn_at IS NOT NULL))
);
CREATE UNIQUE INDEX consent_receipt_one_active_purpose
  ON consent_receipt(member_id,purpose_code) WHERE status='active';
CREATE INDEX consent_receipt_member_history ON consent_receipt(member_id,granted_at DESC,id DESC);

CREATE FUNCTION guard_consent_evidence_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.member_id,NEW.purpose_code,NEW.purpose_version,NEW.document_type,NEW.document_version,NEW.scope,NEW.channel,NEW.proof_sha256,NEW.granted_at,NEW.created_at)
    IS DISTINCT FROM
    (OLD.member_id,OLD.purpose_code,OLD.purpose_version,OLD.document_type,OLD.document_version,OLD.scope,OLD.channel,OLD.proof_sha256,OLD.granted_at,OLD.created_at)
  THEN RAISE EXCEPTION 'CONSENT_EVIDENCE_IMMUTABLE' USING ERRCODE='55000'; END IF;
  IF NOT (NEW.status=OLD.status OR (OLD.status='active' AND NEW.status='withdrawn')) THEN
    RAISE EXCEPTION 'CONSENT_STATUS_TRANSITION_INVALID' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER consent_evidence_mutation BEFORE UPDATE ON consent_receipt
FOR EACH ROW EXECUTE FUNCTION guard_consent_evidence_mutation();

CREATE TABLE legal_hold (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reason_code text NOT NULL CHECK (reason_code ~ '^[A-Z][A-Z0-9_]{2,79}$'),
  legal_basis text NOT NULL CHECK (length(legal_basis) BETWEEN 10 AND 1000),
  approved_by text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','released','expired')),
  review_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  released_by text,
  released_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (review_at <= expires_at),
  CHECK ((status='active' AND released_at IS NULL AND released_by IS NULL) OR (status<>'active' AND released_at IS NOT NULL AND released_by IS NOT NULL))
);

CREATE FUNCTION guard_legal_hold_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.reason_code,NEW.legal_basis,NEW.approved_by,NEW.review_at,NEW.expires_at,NEW.created_at)
    IS DISTINCT FROM (OLD.reason_code,OLD.legal_basis,OLD.approved_by,OLD.review_at,OLD.expires_at,OLD.created_at)
  THEN RAISE EXCEPTION 'LEGAL_HOLD_EVIDENCE_IMMUTABLE' USING ERRCODE='55000'; END IF;
  IF NOT (NEW.status=OLD.status OR (OLD.status='active' AND NEW.status IN ('released','expired'))) THEN
    RAISE EXCEPTION 'LEGAL_HOLD_STATUS_TRANSITION_INVALID' USING ERRCODE='23514';
  END IF;
  IF OLD.status<>'active' AND (NEW.released_by,NEW.released_at) IS DISTINCT FROM (OLD.released_by,OLD.released_at) THEN
    RAISE EXCEPTION 'LEGAL_HOLD_RELEASE_EVIDENCE_IMMUTABLE' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER legal_hold_mutation BEFORE UPDATE ON legal_hold
FOR EACH ROW EXECUTE FUNCTION guard_legal_hold_mutation();

CREATE TABLE legal_hold_binding (
  hold_id uuid NOT NULL REFERENCES legal_hold(id),
  object_type text NOT NULL CHECK (length(object_type) BETWEEN 2 AND 80),
  object_id text NOT NULL CHECK (length(object_id) BETWEEN 1 AND 200),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (hold_id,object_type,object_id)
);
CREATE INDEX legal_hold_binding_object ON legal_hold_binding(object_type,object_id);

CREATE TABLE data_export_job (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  privacy_request_id uuid NOT NULL UNIQUE REFERENCES privacy_request(id),
  member_id uuid NOT NULL REFERENCES member(id),
  status text NOT NULL DEFAULT 'planned' CHECK (status IN ('planned','approved','running','succeeded','failed','expired','canceled')),
  execution_mode text NOT NULL DEFAULT 'plan_only' CHECK (execution_mode IN ('plan_only','generate_archive')),
  scope jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(scope) = 'object'),
  requested_by text NOT NULL,
  approved_by text,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 20),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease_token uuid,
  leased_until timestamptz,
  manifest jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(manifest) = 'object'),
  archive_object_key text,
  result_sha256 text CHECK (result_sha256 IS NULL OR result_sha256 ~ '^[0-9a-f]{64}$'),
  archive_expires_at timestamptz,
  last_error_code text,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((lease_token IS NULL) = (leased_until IS NULL)),
  CHECK (approved_by IS NULL OR approved_by<>requested_by),
  CHECK (status IN ('planned','canceled') OR approved_by IS NOT NULL),
  CHECK ((status IN ('succeeded','expired') AND completed_at IS NOT NULL AND result_sha256 IS NOT NULL AND archive_object_key IS NOT NULL AND archive_expires_at IS NOT NULL)
    OR (status NOT IN ('succeeded','expired') AND completed_at IS NULL AND result_sha256 IS NULL AND archive_object_key IS NULL AND archive_expires_at IS NULL)),
  CHECK (execution_mode<>'plan_only' OR (
    status IN ('planned','canceled') AND approved_by IS NULL AND attempts=0
    AND lease_token IS NULL AND leased_until IS NULL AND completed_at IS NULL
    AND archive_object_key IS NULL AND result_sha256 IS NULL AND archive_expires_at IS NULL
  ))
);
CREATE INDEX data_export_job_due ON data_export_job(next_attempt_at,created_at) WHERE status IN ('approved','failed');

CREATE TABLE data_erasure_job (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  privacy_request_id uuid NOT NULL UNIQUE REFERENCES privacy_request(id),
  member_id uuid NOT NULL REFERENCES member(id),
  erasure_mode text NOT NULL CHECK (erasure_mode IN ('delete_scope','close_account','withdraw_purpose')),
  dry_run boolean NOT NULL DEFAULT true,
  status text NOT NULL DEFAULT 'planned' CHECK (status IN ('planned','approved','running','succeeded','partially_succeeded','failed','canceled')),
  scope jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(scope) = 'object'),
  requested_by text NOT NULL,
  approved_by text,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 20),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease_token uuid,
  leased_until timestamptz,
  legal_hold_count integer NOT NULL DEFAULT 0 CHECK (legal_hold_count >= 0),
  manifest jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(manifest) = 'object'),
  result_sha256 text CHECK (result_sha256 IS NULL OR result_sha256 ~ '^[0-9a-f]{64}$'),
  last_error_code text,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((lease_token IS NULL) = (leased_until IS NULL)),
  CHECK (approved_by IS NULL OR approved_by<>requested_by),
  CHECK (status IN ('planned','canceled') OR approved_by IS NOT NULL),
  CHECK ((status IN ('succeeded','partially_succeeded') AND completed_at IS NOT NULL AND result_sha256 IS NOT NULL)
    OR (status NOT IN ('succeeded','partially_succeeded') AND completed_at IS NULL AND result_sha256 IS NULL)),
  CONSTRAINT data_erasure_job_dry_run_only CHECK (
    dry_run AND status IN ('planned','canceled') AND approved_by IS NULL AND attempts=0
    AND lease_token IS NULL AND leased_until IS NULL AND completed_at IS NULL AND result_sha256 IS NULL
  )
);
CREATE INDEX data_erasure_job_due ON data_erasure_job(next_attempt_at,created_at) WHERE status IN ('approved','failed');

CREATE FUNCTION enforce_privacy_job_owner_and_exclusivity() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE request_member uuid; active_hold_count integer;
BEGIN
  SELECT member_id INTO request_member FROM privacy_request WHERE id=NEW.privacy_request_id FOR UPDATE;
  IF request_member IS NULL OR request_member<>NEW.member_id THEN
    RAISE EXCEPTION 'PRIVACY_JOB_OWNER_MISMATCH' USING ERRCODE='23514';
  END IF;
  IF TG_TABLE_NAME='data_export_job' AND EXISTS(SELECT 1 FROM data_erasure_job WHERE privacy_request_id=NEW.privacy_request_id) THEN
    RAISE EXCEPTION 'PRIVACY_REQUEST_JOB_ALREADY_EXISTS' USING ERRCODE='23505';
  END IF;
  IF TG_TABLE_NAME='data_erasure_job' AND EXISTS(SELECT 1 FROM data_export_job WHERE privacy_request_id=NEW.privacy_request_id) THEN
    RAISE EXCEPTION 'PRIVACY_REQUEST_JOB_ALREADY_EXISTS' USING ERRCODE='23505';
  END IF;
  IF TG_TABLE_NAME='data_erasure_job' THEN
    SELECT count(*) INTO active_hold_count FROM legal_hold_binding binding
      JOIN legal_hold hold ON hold.id=binding.hold_id
      WHERE hold.status='active' AND hold.expires_at>now()
        AND binding.object_type='member' AND binding.object_id=NEW.member_id::text;
    NEW.legal_hold_count:=active_hold_count;
    IF NOT NEW.dry_run AND active_hold_count>0 THEN
      RAISE EXCEPTION 'PRIVACY_ERASURE_BLOCKED_BY_LEGAL_HOLD' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER data_export_job_owner BEFORE INSERT OR UPDATE OF privacy_request_id,member_id ON data_export_job
FOR EACH ROW EXECUTE FUNCTION enforce_privacy_job_owner_and_exclusivity();
CREATE TRIGGER data_erasure_job_owner BEFORE INSERT OR UPDATE OF privacy_request_id,member_id,dry_run ON data_erasure_job
FOR EACH ROW EXECUTE FUNCTION enforce_privacy_job_owner_and_exclusivity();

CREATE FUNCTION guard_privacy_job_status_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status=OLD.status THEN RETURN NEW; END IF;
  IF TG_TABLE_NAME='data_export_job' AND NOT (
    (OLD.status='planned' AND NEW.status IN ('approved','canceled'))
    OR (OLD.status='approved' AND NEW.status IN ('running','canceled'))
    OR (OLD.status='running' AND NEW.status IN ('succeeded','failed'))
    OR (OLD.status='failed' AND NEW.status IN ('running','canceled'))
    OR (OLD.status='succeeded' AND NEW.status='expired')
  ) THEN RAISE EXCEPTION 'DATA_EXPORT_STATUS_TRANSITION_INVALID' USING ERRCODE='23514'; END IF;
  IF TG_TABLE_NAME='data_erasure_job' AND NOT (
    (OLD.status='planned' AND NEW.status IN ('approved','canceled'))
    OR (OLD.status='approved' AND NEW.status IN ('running','canceled'))
    OR (OLD.status='running' AND NEW.status IN ('succeeded','partially_succeeded','failed'))
    OR (OLD.status='failed' AND NEW.status IN ('running','canceled'))
  ) THEN RAISE EXCEPTION 'DATA_ERASURE_STATUS_TRANSITION_INVALID' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER data_export_job_status_transition BEFORE UPDATE OF status ON data_export_job
FOR EACH ROW EXECUTE FUNCTION guard_privacy_job_status_transition();
CREATE TRIGGER data_erasure_job_status_transition BEFORE UPDATE OF status ON data_erasure_job
FOR EACH ROW EXECUTE FUNCTION guard_privacy_job_status_transition();

CREATE TABLE privacy_request_event (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  privacy_request_id uuid NOT NULL REFERENCES privacy_request(id),
  actor_id text NOT NULL,
  event_type text NOT NULL CHECK (event_type IN (
    'received','verification_requested','review_started','execution_planned',
    'approved','execution_started','execution_succeeded','execution_partially_succeeded',
    'execution_failed','responded','rejected','canceled'
  )),
  detail jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(detail) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX privacy_request_event_timeline ON privacy_request_event(privacy_request_id,created_at,id);

CREATE FUNCTION reject_privacy_event_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'PRIVACY_REQUEST_EVENT_IMMUTABLE' USING ERRCODE='55000'; END $$;
CREATE TRIGGER privacy_request_event_immutable BEFORE UPDATE OR DELETE ON privacy_request_event
FOR EACH ROW EXECUTE FUNCTION reject_privacy_event_mutation();

-- migrate:down
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM data_retention_policy)
    OR EXISTS(SELECT 1 FROM processing_purpose)
    OR EXISTS(SELECT 1 FROM processor_registry)
    OR EXISTS(SELECT 1 FROM consent_receipt)
    OR EXISTS(SELECT 1 FROM legal_hold)
    OR EXISTS(SELECT 1 FROM data_export_job)
    OR EXISTS(SELECT 1 FROM data_erasure_job)
    OR EXISTS(SELECT 1 FROM privacy_request_event)
    OR EXISTS(SELECT 1 FROM privacy_request WHERE status NOT IN ('received','reviewing','responded') OR version<>1 OR resolution_code IS NOT NULL OR completed_at IS NOT NULL OR due_at<>created_at+interval '30 days')
  THEN RAISE EXCEPTION 'PRIVACY_LIFECYCLE_ROLLBACK_REQUIRES_DATA_PRESERVATION'; END IF;
END $$;
DROP TRIGGER privacy_request_event_immutable ON privacy_request_event;
DROP FUNCTION reject_privacy_event_mutation();
DROP TRIGGER data_export_job_status_transition ON data_export_job;
DROP TRIGGER data_erasure_job_status_transition ON data_erasure_job;
DROP FUNCTION guard_privacy_job_status_transition();
DROP TRIGGER data_export_job_owner ON data_export_job;
DROP TRIGGER data_erasure_job_owner ON data_erasure_job;
DROP FUNCTION enforce_privacy_job_owner_and_exclusivity();
DROP TRIGGER consent_evidence_mutation ON consent_receipt;
DROP FUNCTION guard_consent_evidence_mutation();
DROP TRIGGER legal_hold_mutation ON legal_hold;
DROP FUNCTION guard_legal_hold_mutation();
DROP TABLE privacy_request_event,data_erasure_job,data_export_job,legal_hold_binding,legal_hold,consent_receipt,processor_registry,processing_purpose,data_retention_policy;
DROP TRIGGER privacy_request_status_transition ON privacy_request;
DROP FUNCTION guard_privacy_request_status_transition();
ALTER TABLE privacy_request DROP CONSTRAINT privacy_request_completion_check;
ALTER TABLE privacy_request DROP CONSTRAINT privacy_request_status_check;
ALTER TABLE privacy_request DROP CONSTRAINT privacy_request_due_after_creation;
ALTER TABLE privacy_request DROP COLUMN version,DROP COLUMN due_at,DROP COLUMN resolution_code,DROP COLUMN completed_at;
ALTER TABLE privacy_request ADD CONSTRAINT privacy_request_status_check CHECK(status IN ('received','reviewing','responded'));
