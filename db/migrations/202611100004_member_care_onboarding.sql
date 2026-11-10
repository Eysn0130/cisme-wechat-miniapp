-- New registrations receive one private onboarding record. Existing members
-- are not backfilled and no care, reward, referral or order fact is created.
CREATE TABLE member_care_profile (
  member_id uuid PRIMARY KEY REFERENCES member(id),
  questionnaire_version text NOT NULL DEFAULT 'care-account-v1.2',
  required boolean NOT NULL DEFAULT false,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  current_question integer NOT NULL DEFAULT 1 CHECK (current_question BETWEEN 1 AND 10),
  latest_operation_id text,
  answers_encrypted text NOT NULL DEFAULT '',
  key_version text,
  health_choice text NOT NULL DEFAULT 'unasked' CHECK (health_choice IN ('unasked','granted','declined')),
  health_text_version text,
  health_decided_at timestamptz,
  completed_at timestamptz,
  erased_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((answers_encrypted='' AND key_version IS NULL) OR (answers_encrypted<>'' AND key_version IS NOT NULL)),
  CHECK ((health_choice='unasked' AND health_text_version IS NULL AND health_decided_at IS NULL)
    OR (health_choice<>'unasked' AND health_text_version IS NOT NULL AND health_decided_at IS NOT NULL))
);
CREATE TABLE member_care_profile_operation (
  member_id uuid NOT NULL REFERENCES member_care_profile(member_id) ON DELETE CASCADE,
  operation_id text NOT NULL CHECK (length(operation_id) BETWEEN 8 AND 200),
  request_sha256 text NOT NULL CHECK (request_sha256 ~ '^[0-9a-f]{64}$'),
  applied_version integer NOT NULL CHECK (applied_version > 0),
  action text NOT NULL CHECK (action IN ('save','complete')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (member_id, operation_id)
);
CREATE TABLE member_care_consent_event (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id uuid NOT NULL REFERENCES member_care_profile(member_id) ON DELETE CASCADE,
  operation_id text NOT NULL,
  choice text NOT NULL CHECK (choice IN ('granted','declined')),
  purpose text NOT NULL CHECK (purpose='care_profile_and_sample_selection'),
  text_version text NOT NULL,
  text_sha256 text NOT NULL CHECK (text_sha256 ~ '^[0-9a-f]{64}$'),
  text_snapshot text NOT NULL,
  decided_at timestamptz NOT NULL,
  UNIQUE (member_id, operation_id)
);

-- migrate:down
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM member_care_profile) THEN
    RAISE EXCEPTION 'CARE_ONBOARDING_ROLLBACK_REQUIRES_DATA_PRESERVATION';
  END IF;
END $$;
DROP TABLE member_care_consent_event;
DROP TABLE member_care_profile_operation;
DROP TABLE member_care_profile;
