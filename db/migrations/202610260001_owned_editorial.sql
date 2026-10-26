-- Owner-authorized editorial is separate from public member UGC and preview fixtures.
ALTER TABLE authority_grant DROP CONSTRAINT authority_grant_capability_check;
ALTER TABLE authority_grant ADD CONSTRAINT authority_grant_capability_check CHECK (capability IN (
  'support.read','support.reply','support.assign',
  'commerce.product.manage','commerce.qualification.manage','commerce.inventory.manage','commerce.order.read',
  'commerce.aftersale.review','commerce.return.receive','commerce.return.inspect','commerce.fulfillment.manage','commerce.refund.approve','commerce.money.reconcile',
  'community.moderate','member.support_view','member.profile.read','member.manage',
  'commission.read','commission.rate.manage','commission.rate.approve',
  'commission.settlement.approve','privacy.request.manage','editorial.manage'
));

CREATE TABLE editorial_article (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  external_ref text NOT NULL UNIQUE CHECK (char_length(external_ref) BETWEEN 3 AND 200),
  author_member_id uuid NOT NULL REFERENCES member(id),
  author_display_name text NOT NULL CHECK (char_length(btrim(author_display_name)) BETWEEN 1 AND 40),
  title text NOT NULL CHECK (char_length(btrim(title)) BETWEEN 1 AND 120),
  excerpt text NOT NULL CHECK (char_length(excerpt)<=320),
  body text NOT NULL CHECK (char_length(btrim(body)) BETWEEN 1 AND 20000),
  source_url text,
  authorization_ref text NOT NULL CHECK (char_length(btrim(authorization_ref)) BETWEEN 3 AND 500),
  rights_evidence jsonb NOT NULL CHECK (jsonb_typeof(rights_evidence)='object'),
  media jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(media)='array' AND jsonb_array_length(media)<=9),
  content_sha256 text NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
  status text NOT NULL CHECK (status IN ('draft','published','withdrawn')),
  version integer NOT NULL DEFAULT 1 CHECK (version>0),
  published_by uuid NOT NULL REFERENCES member(id),
  published_principal_id text NOT NULL,
  published_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX editorial_article_published_page ON editorial_article(published_at DESC,id DESC) WHERE status='published';
CREATE INDEX editorial_article_author_page ON editorial_article(author_member_id,published_at DESC,id DESC) WHERE status='published';
CREATE TABLE editorial_article_revision (
  article_id uuid NOT NULL REFERENCES editorial_article(id),
  version integer NOT NULL CHECK (version>0),
  content_sha256 text NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
  action text NOT NULL CHECK (action IN ('publish','withdraw')),
  authorization_sha256 text NOT NULL CHECK (authorization_sha256 ~ '^[0-9a-f]{64}$'),
  rights_sha256 text NOT NULL CHECK (rights_sha256 ~ '^[0-9a-f]{64}$'),
  actor_member_id uuid NOT NULL REFERENCES member(id),
  actor_principal_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(article_id,version)
);
CREATE FUNCTION protect_editorial_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'EDITORIAL_PUBLICATION_EVIDENCE_IMMUTABLE'; END $$;
CREATE TRIGGER editorial_revision_immutable BEFORE UPDATE OR DELETE ON editorial_article_revision
FOR EACH ROW EXECUTE FUNCTION protect_editorial_revision();

-- migrate:down
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM editorial_article) OR EXISTS(SELECT 1 FROM editorial_article_revision) OR
     EXISTS(SELECT 1 FROM authority_grant WHERE capability='editorial.manage') THEN
    RAISE EXCEPTION 'EDITORIAL_EVIDENCE_REQUIRES_DATA_PRESERVATION';
  END IF;
END $$;
DROP TABLE editorial_article_revision;
DROP FUNCTION protect_editorial_revision();
DROP TABLE editorial_article;
ALTER TABLE authority_grant DROP CONSTRAINT authority_grant_capability_check;
ALTER TABLE authority_grant ADD CONSTRAINT authority_grant_capability_check CHECK (capability IN (
  'support.read','support.reply','support.assign',
  'commerce.product.manage','commerce.qualification.manage','commerce.inventory.manage','commerce.order.read',
  'commerce.aftersale.review','commerce.return.receive','commerce.return.inspect','commerce.fulfillment.manage','commerce.refund.approve','commerce.money.reconcile',
  'community.moderate','member.support_view','member.profile.read','member.manage',
  'commission.read','commission.rate.manage','commission.rate.approve',
  'commission.settlement.approve','privacy.request.manage'
));
