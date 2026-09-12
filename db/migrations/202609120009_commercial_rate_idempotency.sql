-- Each proposal is a durable command. A retry must return the same immutable
-- proposal, even if the caller did not receive the first response.
ALTER TABLE commission_rate_rule ADD COLUMN request_key text;
ALTER TABLE commission_rate_rule ADD COLUMN request_fingerprint text;
ALTER TABLE commission_rate_rule ADD CONSTRAINT commission_rate_request_pair_check
  CHECK ((request_key IS NULL AND request_fingerprint IS NULL) OR
    (request_key ~ '^[A-Za-z0-9._:-]{8,200}$' AND request_fingerprint ~ '^[0-9a-f]{64}$'));
CREATE UNIQUE INDEX commission_rate_request_unique ON commission_rate_rule(created_by,request_key)
  WHERE request_key IS NOT NULL;

-- migrate:down
DROP INDEX commission_rate_request_unique;
ALTER TABLE commission_rate_rule DROP CONSTRAINT commission_rate_request_pair_check;
ALTER TABLE commission_rate_rule DROP COLUMN request_fingerprint;
ALTER TABLE commission_rate_rule DROP COLUMN request_key;
