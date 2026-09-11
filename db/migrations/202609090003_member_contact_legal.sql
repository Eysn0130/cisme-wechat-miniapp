CREATE TABLE member_contact (
 member_id uuid PRIMARY KEY REFERENCES member(id),
 phone_encrypted text NOT NULL,
 phone_hmac text NOT NULL UNIQUE,
 phone_masked text NOT NULL,
 key_version text NOT NULL,
 bound_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE phone_authorization (
 code_hash text PRIMARY KEY,
 member_id uuid NOT NULL REFERENCES member(id),
 consumed_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE legal_document (
 document_type text NOT NULL CHECK(document_type IN ('privacy','terms')),
 version text NOT NULL,
 title text NOT NULL,
 body text NOT NULL,
 operator_name text NOT NULL,
 contact text NOT NULL,
 active boolean NOT NULL DEFAULT false,
 published_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(document_type,version)
);
CREATE UNIQUE INDEX legal_document_active ON legal_document(document_type) WHERE active;
-- migrate:down
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM member_contact) OR EXISTS(SELECT 1 FROM legal_document) OR EXISTS(SELECT 1 FROM phone_authorization) THEN RAISE EXCEPTION 'IDENTITY_ROLLBACK_REQUIRES_DATA_PRESERVATION'; END IF;
END $$;
DROP TABLE phone_authorization,member_contact,legal_document;
