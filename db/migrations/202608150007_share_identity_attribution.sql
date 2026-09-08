BEGIN;

CREATE TABLE share_link (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  share_id text NOT NULL UNIQUE CHECK (char_length(share_id) BETWEEN 20 AND 64),
  member_id uuid NOT NULL REFERENCES member(id),
  target_type text NOT NULL CHECK (target_type IN ('post','product')),
  target_ref text NOT NULL CHECK (char_length(target_ref) BETWEEN 1 AND 200),
  state text NOT NULL DEFAULT 'active' CHECK (state IN ('active','revoked','expired')),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE UNIQUE INDEX share_link_active_target_unique
  ON share_link(member_id, target_type, target_ref)
  WHERE state='active';

CREATE TABLE share_visit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  share_link_id uuid NOT NULL REFERENCES share_link(id),
  visit_key text NOT NULL CHECK (char_length(visit_key) BETWEEN 16 AND 100),
  visitor_member_id uuid REFERENCES member(id),
  first_seen_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  UNIQUE (share_link_id, visit_key)
);

CREATE TABLE share_attribution (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  share_visit_id uuid NOT NULL UNIQUE REFERENCES share_visit(id),
  sharer_member_id uuid NOT NULL REFERENCES member(id),
  converted_member_id uuid NOT NULL REFERENCES member(id),
  conversion_type text NOT NULL CHECK (conversion_type IN ('identity')),
  occurred_at timestamptz NOT NULL,
  CHECK (sharer_member_id <> converted_member_id),
  UNIQUE (converted_member_id, conversion_type)
);

COMMIT;

-- migrate:down
BEGIN;
DROP TABLE IF EXISTS share_attribution, share_visit, share_link;
COMMIT;
