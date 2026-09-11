-- Delivery addresses are member-owned preparation data. They are not orders and
-- do not imply that checkout, payment, fulfilment or refunds are available.
CREATE TABLE member_delivery_address (
  id uuid PRIMARY KEY,
  member_id uuid NOT NULL REFERENCES member(id),
  encrypted_payload text NOT NULL,
  payload_hmac char(64) NOT NULL,
  key_version text NOT NULL,
  label text NOT NULL CHECK (label IN ('home','company','other')),
  is_default boolean NOT NULL DEFAULT false,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  client_request_key text NOT NULL CHECK (length(client_request_key) BETWEEN 8 AND 200),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  UNIQUE (member_id, client_request_key)
);

CREATE INDEX member_delivery_address_owner_active
  ON member_delivery_address(member_id, updated_at DESC)
  WHERE deleted_at IS NULL;

CREATE UNIQUE INDEX member_delivery_address_one_default
  ON member_delivery_address(member_id)
  WHERE is_default AND deleted_at IS NULL;

CREATE UNIQUE INDEX member_delivery_address_payload_active
  ON member_delivery_address(member_id, payload_hmac)
  WHERE deleted_at IS NULL;

-- migrate:down
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM member_delivery_address) THEN
    RAISE EXCEPTION 'DELIVERY_ADDRESS_ROLLBACK_REQUIRES_DATA_PRESERVATION';
  END IF;
END $$;
DROP TABLE member_delivery_address;
