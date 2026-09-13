-- A signed create/query response provides the channel's refund acceptance
-- time. It is NOT evidence that the payer has received the refund. Trade
-- REFUND bills are keyed by this time, not by refund success time.
CREATE TABLE commission_refund_channel_observation (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  refund_intent_id uuid NOT NULL REFERENCES commission_refund_intent(id) ON DELETE RESTRICT,
  source_kind text NOT NULL CHECK (source_kind IN ('signed_create','signed_query')),
  raw_sha256 text NOT NULL CHECK (raw_sha256 ~ '^[0-9a-f]{64}$'),
  provider_refund_id text NOT NULL CHECK (char_length(provider_refund_id) BETWEEN 8 AND 200),
  accepted_at timestamptz NOT NULL,
  observed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(refund_intent_id,raw_sha256)
);
CREATE INDEX commission_refund_channel_observation_day ON commission_refund_channel_observation(accepted_at,refund_intent_id);
CREATE TRIGGER commission_refund_channel_observation_immutable BEFORE UPDATE OR DELETE
  ON commission_refund_channel_observation FOR EACH ROW EXECUTE FUNCTION commercial_evidence_immutable();

-- migrate:down
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM commission_refund_channel_observation)
  THEN RAISE EXCEPTION 'REFUND_CHANNEL_OBSERVATION_ROLLBACK_REQUIRES_DATA_PRESERVATION'; END IF;
END $$;
DROP TRIGGER commission_refund_channel_observation_immutable ON commission_refund_channel_observation;
DROP TABLE commission_refund_channel_observation;
