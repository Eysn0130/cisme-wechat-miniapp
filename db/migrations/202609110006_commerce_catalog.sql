-- R4-A: first-party catalog authority. This slice deliberately excludes cart,
-- order, payment, fulfillment, refund, merchant and tenant structures.

ALTER TABLE authority_grant DROP CONSTRAINT authority_grant_capability_check;
ALTER TABLE authority_grant ADD CONSTRAINT authority_grant_capability_check CHECK (capability IN (
  'support.read','support.reply','support.assign',
  'commerce.product.manage','commerce.qualification.manage','commerce.inventory.manage','commerce.order.read',
  'commerce.fulfillment.manage','commerce.refund.approve',
  'community.moderate','member.support_view','privacy.request.manage'
));

CREATE TABLE catalog_product (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE CHECK (code ~ '^[a-z0-9][a-z0-9-]{2,63}$'),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  subtitle text NOT NULL DEFAULT '' CHECK (length(subtitle) <= 240),
  description text NOT NULL DEFAULT '' CHECK (length(description) <= 4000),
  image_path text CHECK (image_path IS NULL OR (
    image_path ~ '^/assets/cisme/[a-z0-9/_-]+[.]jpg$' AND image_path !~ '[.][.]'
  )),
  source_kind text NOT NULL DEFAULT 'admin' CHECK (source_kind IN ('admin','legacy_preview','synthetic_test')),
  qualification_status text NOT NULL DEFAULT 'pending' CHECK (qualification_status IN ('pending','eligible','blocked')),
  publication_status text NOT NULL DEFAULT 'draft' CHECK (publication_status IN ('draft','published','unpublished')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_by text NOT NULL,
  updated_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  unpublished_at timestamptz,
  CHECK (publication_status <> 'published' OR (qualification_status='eligible' AND published_at IS NOT NULL))
);

CREATE TABLE catalog_sku (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL REFERENCES catalog_product(id) ON DELETE RESTRICT,
  code text NOT NULL UNIQUE CHECK (code ~ '^[A-Z0-9][A-Z0-9_-]{2,63}$'),
  label text NOT NULL CHECK (length(btrim(label)) BETWEEN 1 AND 120),
  active boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 0 CHECK (sort_order BETWEEN 0 AND 10000),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_by text NOT NULL,
  updated_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(product_id, code)
);

CREATE TABLE catalog_price (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sku_id uuid NOT NULL UNIQUE REFERENCES catalog_sku(id) ON DELETE RESTRICT,
  currency text NOT NULL DEFAULT 'CNY' CHECK (currency='CNY'),
  amount_cents integer NOT NULL CHECK (amount_cents BETWEEN 1 AND 100000000),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_by text NOT NULL,
  updated_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE catalog_inventory_level (
  sku_id uuid PRIMARY KEY REFERENCES catalog_sku(id) ON DELETE RESTRICT,
  stock_on_hand integer NOT NULL DEFAULT 0 CHECK (stock_on_hand BETWEEN 0 AND 2000000000),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_by text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE catalog_qualification_decision (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL REFERENCES catalog_product(id) ON DELETE RESTRICT,
  from_status text NOT NULL CHECK (from_status IN ('pending','eligible','blocked')),
  to_status text NOT NULL CHECK (to_status IN ('pending','eligible','blocked')),
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 3 AND 1000),
  evidence_ref text CHECK (evidence_ref IS NULL OR length(btrim(evidence_ref)) BETWEEN 3 AND 500),
  decided_by text NOT NULL,
  decided_at timestamptz NOT NULL DEFAULT now(),
  CHECK (from_status <> to_status)
);

CREATE TABLE catalog_inventory_adjustment (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sku_id uuid NOT NULL REFERENCES catalog_sku(id) ON DELETE RESTRICT,
  delta integer NOT NULL CHECK (delta <> 0),
  before_quantity integer NOT NULL CHECK (before_quantity >= 0),
  after_quantity integer NOT NULL CHECK (after_quantity >= 0),
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 3 AND 500),
  adjusted_by text NOT NULL,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 200),
  adjusted_at timestamptz NOT NULL DEFAULT now(),
  CHECK (after_quantity = before_quantity + delta),
  UNIQUE(adjusted_by, idempotency_key)
);

CREATE INDEX catalog_product_public_page_idx
  ON catalog_product(published_at DESC, id DESC)
  WHERE publication_status='published' AND qualification_status='eligible';
CREATE INDEX catalog_product_management_page_idx ON catalog_product(updated_at DESC, id DESC);
CREATE INDEX catalog_sku_product_page_idx ON catalog_sku(product_id, sort_order, id);
CREATE INDEX catalog_price_amount_idx ON catalog_price(currency,amount_cents,sku_id);
CREATE INDEX catalog_inventory_adjustment_sku_history_idx ON catalog_inventory_adjustment(sku_id, adjusted_at DESC, id DESC);
CREATE INDEX catalog_qualification_product_history_idx ON catalog_qualification_decision(product_id, decided_at DESC, id DESC);

CREATE FUNCTION protect_catalog_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'CATALOG_EVIDENCE_IMMUTABLE';
END $$;
CREATE TRIGGER catalog_inventory_adjustment_immutable BEFORE UPDATE OR DELETE ON catalog_inventory_adjustment
  FOR EACH ROW EXECUTE FUNCTION protect_catalog_evidence();
CREATE TRIGGER catalog_qualification_decision_immutable BEFORE UPDATE OR DELETE ON catalog_qualification_decision
  FOR EACH ROW EXECUTE FUNCTION protect_catalog_evidence();

-- Preserve the three pre-R4 presentation records as explicitly non-sellable
-- legacy previews. They are visible only in the management catalog until a
-- qualified operator records eligibility and publication is separately done.
INSERT INTO catalog_product(id,code,name,subtitle,description,image_path,source_kind,created_by,updated_by)
VALUES
  ('c1000000-0000-4000-8000-000000000001','care-serum-30','头皮护理精华 30ml','轻盈日常护理','R4 前只读预览记录；尚未完成商品资格核验。','/assets/cisme/community-card-purple-bottle-v1.jpg','legacy_preview','migration:r4-a','migration:r4-a'),
  ('c1000000-0000-4000-8000-000000000002','care-set-r0','28 天护理组合','精华与护理手册','R4 前只读预览记录；尚未完成商品资格核验。','/assets/cisme/community-card-care-flatlay-v2.jpg','legacy_preview','migration:r4-a','migration:r4-a'),
  ('c1000000-0000-4000-8000-000000000003','travel-serum-10','随行护理精华 10ml','便携装','R4 前只读预览记录；尚未完成商品资格核验。','/assets/cisme/community-card-care-journal-v2.jpg','legacy_preview','migration:r4-a','migration:r4-a');

INSERT INTO catalog_sku(id,product_id,code,label,created_by,updated_by)
VALUES
  ('c2000000-0000-4000-8000-000000000001','c1000000-0000-4000-8000-000000000001','CARE_SERUM_30','30ml','migration:r4-a','migration:r4-a'),
  ('c2000000-0000-4000-8000-000000000002','c1000000-0000-4000-8000-000000000002','CARE_SET_R0','组合装','migration:r4-a','migration:r4-a'),
  ('c2000000-0000-4000-8000-000000000003','c1000000-0000-4000-8000-000000000003','TRAVEL_SERUM_10','10ml','migration:r4-a','migration:r4-a');

INSERT INTO catalog_price(id,sku_id,amount_cents,created_by,updated_by)
VALUES
  ('c3000000-0000-4000-8000-000000000001','c2000000-0000-4000-8000-000000000001',26900,'migration:r4-a','migration:r4-a'),
  ('c3000000-0000-4000-8000-000000000002','c2000000-0000-4000-8000-000000000002',48900,'migration:r4-a','migration:r4-a'),
  ('c3000000-0000-4000-8000-000000000003','c2000000-0000-4000-8000-000000000003',9900,'migration:r4-a','migration:r4-a');

INSERT INTO catalog_inventory_level(sku_id,updated_by)
SELECT id,'migration:r4-a' FROM catalog_sku;

-- migrate:down
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM catalog_inventory_adjustment) OR
     EXISTS(SELECT 1 FROM catalog_qualification_decision) OR
     EXISTS(SELECT 1 FROM catalog_product WHERE source_kind <> 'legacy_preview' OR version<>1 OR updated_by<>'migration:r4-a') OR
     EXISTS(SELECT 1 FROM catalog_sku WHERE version<>1 OR updated_by<>'migration:r4-a') OR
     EXISTS(SELECT 1 FROM catalog_price WHERE version<>1 OR updated_by<>'migration:r4-a') OR
     EXISTS(SELECT 1 FROM catalog_inventory_level WHERE version<>1 OR updated_by<>'migration:r4-a' OR stock_on_hand<>0) OR
     EXISTS(SELECT 1 FROM authority_grant WHERE capability='commerce.qualification.manage') THEN
    RAISE EXCEPTION 'COMMERCE_CATALOG_ROLLBACK_REQUIRES_DATA_PRESERVATION';
  END IF;
END $$;
DROP TRIGGER catalog_qualification_decision_immutable ON catalog_qualification_decision;
DROP TRIGGER catalog_inventory_adjustment_immutable ON catalog_inventory_adjustment;
DROP FUNCTION protect_catalog_evidence();
DROP TABLE catalog_inventory_adjustment, catalog_qualification_decision, catalog_inventory_level, catalog_price, catalog_sku, catalog_product;
ALTER TABLE authority_grant DROP CONSTRAINT authority_grant_capability_check;
ALTER TABLE authority_grant ADD CONSTRAINT authority_grant_capability_check CHECK (capability IN (
  'support.read','support.reply','support.assign',
  'commerce.product.manage','commerce.inventory.manage','commerce.order.read',
  'commerce.fulfillment.manage','commerce.refund.approve',
  'community.moderate','member.support_view','privacy.request.manage'
));
