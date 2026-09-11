CREATE TABLE privacy_request (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 member_id uuid NOT NULL REFERENCES member(id),
 kind text NOT NULL CHECK(kind IN ('access','correct','delete','close_account','withdraw','other')),
 message text NOT NULL CHECK(char_length(message) BETWEEN 1 AND 2000),
 status text NOT NULL DEFAULT 'received' CHECK(status IN ('received','reviewing','responded')),
 response text,
 responded_by text,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX privacy_request_member_created ON privacy_request(member_id,created_at DESC);
CREATE INDEX privacy_request_pending ON privacy_request(created_at) WHERE status <> 'responded';
ALTER TABLE legal_document DROP CONSTRAINT legal_document_document_type_check;
ALTER TABLE legal_document ADD CONSTRAINT legal_document_document_type_check CHECK(document_type IN ('terms','privacy','cross_border'));
-- migrate:down
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM privacy_request) OR EXISTS(SELECT 1 FROM legal_document WHERE document_type='cross_border') THEN RAISE EXCEPTION 'PRIVACY_ROLLBACK_REQUIRES_DATA_PRESERVATION'; END IF;
END $$;
ALTER TABLE legal_document DROP CONSTRAINT legal_document_document_type_check;
ALTER TABLE legal_document ADD CONSTRAINT legal_document_document_type_check CHECK(document_type IN ('terms','privacy'));
DROP TABLE privacy_request;
