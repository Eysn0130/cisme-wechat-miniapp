CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE member (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','blocked','deleted')),
  display_name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE wechat_identity (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id uuid NOT NULL UNIQUE REFERENCES member(id),
  openid text NOT NULL UNIQUE,
  unionid text,
  adapter text NOT NULL CHECK (adapter IN ('wechat','dev')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE consent_acceptance (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id uuid NOT NULL REFERENCES member(id),
  document_type text NOT NULL,
  document_version text NOT NULL,
  accepted_at timestamptz NOT NULL,
  principal_id text NOT NULL,
  UNIQUE (member_id, document_type, document_version)
);

CREATE TABLE qualification_fact (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id uuid NOT NULL REFERENCES member(id),
  source text NOT NULL,
  external_ref text NOT NULL,
  occurred_at timestamptz NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source, external_ref)
);

CREATE TABLE care_cycle (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id uuid NOT NULL REFERENCES member(id),
  qualification_fact_id uuid NOT NULL UNIQUE REFERENCES qualification_fact(id),
  phase text NOT NULL DEFAULT 'planned' CHECK (phase IN ('planned','active','paused','terminated','completed')),
  started_on date,
  timezone text NOT NULL,
  protocol_version text NOT NULL,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((phase = 'planned' AND started_on IS NULL) OR phase <> 'planned')
);

CREATE TABLE care_record (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cycle_id uuid NOT NULL REFERENCES care_cycle(id),
  milestone text NOT NULL CHECK (milestone IN ('D1','D7','D14','D28')),
  due_on date NOT NULL,
  completed_at timestamptz NOT NULL,
  protocol_version text NOT NULL,
  UNIQUE (cycle_id, milestone)
);

CREATE TABLE eligibility_campaign (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  qualifying_milestone text NOT NULL CHECK (qualifying_milestone IN ('D1','D7','D14','D28')),
  capacity integer NOT NULL CHECK (capacity > 0),
  reward_points integer NOT NULL CHECK (reward_points > 0),
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  active boolean NOT NULL DEFAULT false
);

CREATE TABLE eligibility_decision (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id uuid NOT NULL REFERENCES eligibility_campaign(id),
  cycle_id uuid NOT NULL REFERENCES care_cycle(id),
  fact_key text NOT NULL,
  eligible boolean NOT NULL,
  reason_code text NOT NULL,
  decided_at timestamptz NOT NULL,
  UNIQUE (campaign_id, fact_key)
);

CREATE TABLE eligibility_task (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  decision_id uuid NOT NULL UNIQUE REFERENCES eligibility_decision(id),
  campaign_id uuid NOT NULL REFERENCES eligibility_campaign(id),
  member_id uuid NOT NULL REFERENCES member(id),
  state text NOT NULL DEFAULT 'available' CHECK (state IN ('available','claimed','expired','completed')),
  expires_at timestamptz NOT NULL,
  version integer NOT NULL DEFAULT 1,
  UNIQUE (campaign_id, member_id)
);

CREATE TABLE submission (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id uuid NOT NULL REFERENCES member(id),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','submitted','needs_changes','rejected','appealed','approved')),
  post_url text,
  platform_account text,
  disclosure text,
  license_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  version integer NOT NULL DEFAULT 1,
  submitted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX submission_post_url_unique ON submission (lower(post_url)) WHERE post_url IS NOT NULL;

CREATE TABLE task_claim (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id uuid NOT NULL UNIQUE REFERENCES eligibility_task(id),
  member_id uuid NOT NULL REFERENCES member(id),
  submission_id uuid NOT NULL UNIQUE REFERENCES submission(id),
  claimed_at timestamptz NOT NULL,
  UNIQUE (task_id, member_id)
);

CREATE TABLE media_object (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  submission_id uuid NOT NULL REFERENCES submission(id),
  kind text NOT NULL CHECK (kind IN ('original','screenshot')),
  object_key text NOT NULL UNIQUE,
  content_hash text,
  mime_type text NOT NULL,
  size_bytes bigint,
  upload_state text NOT NULL DEFAULT 'authorized' CHECK (upload_state IN ('authorized','uploaded','failed','deleted')),
  uploaded_at timestamptz,
  deleted_at timestamptz,
  UNIQUE (submission_id, kind)
);
CREATE UNIQUE INDEX media_hash_unique ON media_object (content_hash) WHERE content_hash IS NOT NULL AND upload_state = 'uploaded';

CREATE TABLE review_case (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  submission_id uuid NOT NULL UNIQUE REFERENCES submission(id),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','needs_changes','rejected','appealed','approved')),
  version integer NOT NULL DEFAULT 1,
  assigned_to text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE review_action (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  review_case_id uuid NOT NULL REFERENCES review_case(id),
  actor_principal_id text NOT NULL,
  action text NOT NULL CHECK (action IN ('submit','request_changes','resubmit','reject','appeal','approve')),
  reason_code text NOT NULL,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE appeal (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  review_case_id uuid NOT NULL REFERENCES review_case(id),
  member_id uuid NOT NULL REFERENCES member(id),
  reason text NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','accepted','denied')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (review_case_id, status)
);

CREATE TABLE reward_claim (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  submission_id uuid NOT NULL UNIQUE REFERENCES submission(id),
  member_id uuid NOT NULL REFERENCES member(id),
  campaign_id uuid NOT NULL REFERENCES eligibility_campaign(id),
  rule_code text NOT NULL,
  amount integer NOT NULL CHECK (amount > 0),
  state text NOT NULL DEFAULT 'approved' CHECK (state IN ('approved','voided')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE points_grant (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reward_claim_id uuid NOT NULL UNIQUE REFERENCES reward_claim(id),
  member_id uuid NOT NULL REFERENCES member(id),
  amount integer NOT NULL CHECK (amount > 0),
  state text NOT NULL DEFAULT 'frozen' CHECK (state IN ('frozen','available','blocked','expired')),
  blocked_for_use boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE points_lot (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  grant_id uuid NOT NULL UNIQUE REFERENCES points_grant(id),
  original_amount integer NOT NULL,
  frozen_amount integer NOT NULL,
  available_amount integer NOT NULL DEFAULT 0,
  expires_at timestamptz,
  CHECK (original_amount = frozen_amount + available_amount),
  CHECK (frozen_amount >= 0 AND available_amount >= 0)
);

CREATE TABLE points_entry (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id uuid NOT NULL REFERENCES member(id),
  grant_id uuid REFERENCES points_grant(id),
  lot_id uuid REFERENCES points_lot(id),
  entry_type text NOT NULL CHECK (entry_type IN ('grant_frozen','unfreeze','expire','reversal','adjustment')),
  frozen_delta integer NOT NULL DEFAULT 0,
  available_delta integer NOT NULL DEFAULT 0,
  debt_delta integer NOT NULL DEFAULT 0,
  business_key text NOT NULL UNIQUE,
  occurred_at timestamptz NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE FUNCTION reject_points_entry_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'points_entry is append-only' USING ERRCODE = '55000';
END $$;
CREATE TRIGGER points_entry_no_update BEFORE UPDATE OR DELETE ON points_entry
  FOR EACH ROW EXECUTE FUNCTION reject_points_entry_mutation();

CREATE TABLE points_projection (
  member_id uuid PRIMARY KEY REFERENCES member(id),
  frozen integer NOT NULL DEFAULT 0,
  available integer NOT NULL DEFAULT 0,
  debt integer NOT NULL DEFAULT 0,
  version integer NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (frozen >= 0 AND available >= 0 AND debt >= 0)
);

CREATE TABLE consent_grant (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  submission_id uuid NOT NULL REFERENCES submission(id),
  member_id uuid NOT NULL REFERENCES member(id),
  purpose text NOT NULL,
  granted_at timestamptz NOT NULL,
  UNIQUE (submission_id, purpose)
);

CREATE TABLE revocation_request (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  consent_grant_id uuid NOT NULL UNIQUE REFERENCES consent_grant(id),
  requested_by uuid NOT NULL REFERENCES member(id),
  reason text NOT NULL,
  requested_at timestamptz NOT NULL,
  processed_at timestamptz
);

CREATE TABLE feed_item (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  submission_id uuid NOT NULL UNIQUE REFERENCES submission(id),
  member_id uuid NOT NULL REFERENCES member(id),
  title text NOT NULL,
  excerpt text NOT NULL,
  cover_object_key text,
  published_at timestamptz NOT NULL,
  visible boolean NOT NULL DEFAULT true
);

CREATE TABLE outbox_event (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type text NOT NULL,
  aggregate_type text NOT NULL,
  aggregate_id uuid NOT NULL,
  aggregate_version integer NOT NULL,
  business_key text NOT NULL UNIQUE,
  payload jsonb NOT NULL,
  occurred_at timestamptz NOT NULL,
  processed_at timestamptz,
  attempts integer NOT NULL DEFAULT 0,
  last_error text
);

CREATE TABLE idempotency_operation (
  principal_id text NOT NULL,
  operation text NOT NULL,
  idempotency_key text NOT NULL,
  business_key text NOT NULL,
  request_hash text NOT NULL,
  response_status integer NOT NULL,
  response_body jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (principal_id, operation, idempotency_key),
  UNIQUE (principal_id, operation, business_key)
);

CREATE TABLE principal_role (
  principal_id text NOT NULL,
  role text NOT NULL CHECK (role IN ('reviewer','review_lead','auditor','support')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (principal_id, role)
);

CREATE TABLE audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  principal_id text NOT NULL,
  action text NOT NULL,
  object_type text NOT NULL,
  object_id uuid,
  reason_code text,
  before_state jsonb,
  after_state jsonb,
  trace_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE emergency_switch (
  key text PRIMARY KEY CHECK (key IN ('identity','uploads','reviews','rewards')),
  enabled boolean NOT NULL DEFAULT true,
  reason text NOT NULL DEFAULT 'normal',
  updated_by text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO emergency_switch(key, updated_by) VALUES
  ('identity','migration'),('uploads','migration'),('reviews','migration'),('rewards','migration');

-- migrate:down
DROP TABLE IF EXISTS emergency_switch, audit_log, principal_role, idempotency_operation,
  outbox_event, feed_item, revocation_request, consent_grant, points_projection,
  points_entry, points_lot, points_grant, reward_claim, appeal, review_action,
  review_case, media_object, task_claim, submission, eligibility_task,
  eligibility_decision, eligibility_campaign, care_record, care_cycle,
  qualification_fact, consent_acceptance, wechat_identity, member CASCADE;
DROP FUNCTION IF EXISTS reject_points_entry_mutation();
