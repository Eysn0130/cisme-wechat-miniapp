BEGIN;

ALTER TABLE consent_grant ADD COLUMN active boolean NOT NULL DEFAULT true;
ALTER TABLE consent_grant ADD COLUMN version integer NOT NULL DEFAULT 1;
UPDATE consent_grant cg SET active=false
WHERE EXISTS (SELECT 1 FROM revocation_request rr WHERE rr.consent_grant_id=cg.id);
ALTER TABLE consent_grant DROP CONSTRAINT consent_grant_submission_id_purpose_key;
CREATE UNIQUE INDEX consent_grant_active_purpose_unique
  ON consent_grant(submission_id, purpose)
  WHERE active;

COMMIT;
