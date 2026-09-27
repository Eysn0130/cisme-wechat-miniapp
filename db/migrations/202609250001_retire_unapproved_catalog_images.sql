-- Retire only the three known legacy preview references. The old catalog
-- constraint also allowed admin paths under /assets/cisme; those may be real
-- product data and must not be rewritten by a directory-wide UPDATE.
-- This file is still a local candidate. Check the target migration journal
-- before deployment; never replace an already-applied migration in place.
ALTER TABLE catalog_product DROP CONSTRAINT catalog_product_image_path_check;

-- The ALTER holds the table lock through this migration's transaction. If an
-- unexpected product uses a removed asset, stop for a row-level review rather
-- than changing its image or version without knowing its provenance.
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM catalog_product
    WHERE image_path IN (
      '/assets/cisme/avatars/avatar-jiajing-v1.jpg',
      '/assets/cisme/avatars/avatar-jingyu-v1.jpg',
      '/assets/cisme/avatars/avatar-luna-v1.jpg',
      '/assets/cisme/avatars/avatar-muguang-v1.jpg',
      '/assets/cisme/avatars/avatar-yurou-v1.jpg',
      '/assets/cisme/avatars/avatar-zhihe-v1.jpg',
      '/assets/cisme/community-card-care-flatlay-v2.jpg',
      '/assets/cisme/community-card-care-journal-v2.jpg',
      '/assets/cisme/community-card-glossy-hair-v1.jpg',
      '/assets/cisme/community-card-mirror-roots-v2.jpg',
      '/assets/cisme/community-card-purple-bottle-v1.jpg',
      '/assets/cisme/community-card-scalp-massage-v2.jpg',
      '/assets/cisme/community-hero-scalp-ritual-v1.jpg'
    )
    AND NOT (
      source_kind = 'legacy_preview' AND created_by = 'migration:r4-a' AND (
        (id = 'c1000000-0000-4000-8000-000000000001' AND image_path = '/assets/cisme/community-card-purple-bottle-v1.jpg') OR
        (id = 'c1000000-0000-4000-8000-000000000002' AND image_path = '/assets/cisme/community-card-care-flatlay-v2.jpg') OR
        (id = 'c1000000-0000-4000-8000-000000000003' AND image_path = '/assets/cisme/community-card-care-journal-v2.jpg')
      )
    )
  ) THEN
    RAISE EXCEPTION 'CATALOG_RETIRED_IMAGE_REVIEW_REQUIRED';
  END IF;
END $$;

-- NULL is understood by both old and new API versions and renders with the
-- packaged neutral icon. No retired path is restored by the down migration.
UPDATE catalog_product
SET image_path = NULL,
    version = version + 1,
    updated_by = 'migration:retire-unapproved-images',
    updated_at = now()
WHERE source_kind = 'legacy_preview' AND created_by = 'migration:r4-a' AND (
  (id = 'c1000000-0000-4000-8000-000000000001' AND image_path = '/assets/cisme/community-card-purple-bottle-v1.jpg') OR
  (id = 'c1000000-0000-4000-8000-000000000002' AND image_path = '/assets/cisme/community-card-care-flatlay-v2.jpg') OR
  (id = 'c1000000-0000-4000-8000-000000000003' AND image_path = '/assets/cisme/community-card-care-journal-v2.jpg')
);

-- Keep the original format for other catalog data. The thirteen retired file
-- names are denied explicitly, while the new neutral icon is allowed.
ALTER TABLE catalog_product ADD CONSTRAINT catalog_product_image_path_check
  CHECK (image_path IS NULL OR image_path = '/assets/icons/spray-bottle-plum.svg' OR (
    image_path ~ '^/assets/cisme/[a-z0-9/_-]+[.]jpg$' AND image_path !~ '[.][.]'
    AND image_path NOT IN (
      '/assets/cisme/avatars/avatar-jiajing-v1.jpg',
      '/assets/cisme/avatars/avatar-jingyu-v1.jpg',
      '/assets/cisme/avatars/avatar-luna-v1.jpg',
      '/assets/cisme/avatars/avatar-muguang-v1.jpg',
      '/assets/cisme/avatars/avatar-yurou-v1.jpg',
      '/assets/cisme/avatars/avatar-zhihe-v1.jpg',
      '/assets/cisme/community-card-care-flatlay-v2.jpg',
      '/assets/cisme/community-card-care-journal-v2.jpg',
      '/assets/cisme/community-card-glossy-hair-v1.jpg',
      '/assets/cisme/community-card-mirror-roots-v2.jpg',
      '/assets/cisme/community-card-purple-bottle-v1.jpg',
      '/assets/cisme/community-card-scalp-massage-v2.jpg',
      '/assets/cisme/community-hero-scalp-ritual-v1.jpg'
    )
  )) NOT VALID;
ALTER TABLE catalog_product VALIDATE CONSTRAINT catalog_product_image_path_check;

-- migrate:down
-- Local rollback rehearsal only; the production release migrator is up-only.
-- A new icon write cannot be represented by the old schema, so refuse rather
-- than erase or remap it. Preserve all later edits to the three seed rows.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM catalog_product WHERE image_path = '/assets/icons/spray-bottle-plum.svg')
    OR EXISTS (
      SELECT 1 FROM catalog_product WHERE updated_by = 'migration:retire-unapproved-images'
      AND NOT (
        id IN (
          'c1000000-0000-4000-8000-000000000001',
          'c1000000-0000-4000-8000-000000000002',
          'c1000000-0000-4000-8000-000000000003'
        ) AND source_kind = 'legacy_preview' AND created_by = 'migration:r4-a'
        AND image_path IS NULL AND version = 2
      )
    )
    OR EXISTS (
      SELECT 1 FROM catalog_product
      WHERE id IN (
        'c1000000-0000-4000-8000-000000000001',
        'c1000000-0000-4000-8000-000000000002',
        'c1000000-0000-4000-8000-000000000003'
      ) AND image_path IS NULL AND version > 1
      AND NOT (
        source_kind = 'legacy_preview' AND created_by = 'migration:r4-a'
        AND updated_by = 'migration:retire-unapproved-images' AND version = 2
      )
    )
  THEN
    RAISE EXCEPTION 'CATALOG_IMAGE_RETIREMENT_ROLLBACK_REQUIRES_DATA_PRESERVATION';
  END IF;
END $$;
ALTER TABLE catalog_product DROP CONSTRAINT catalog_product_image_path_check;
UPDATE catalog_product
SET version = 1,
    updated_by = 'migration:r4-a',
    updated_at = now()
WHERE id IN (
  'c1000000-0000-4000-8000-000000000001',
  'c1000000-0000-4000-8000-000000000002',
  'c1000000-0000-4000-8000-000000000003'
) AND source_kind = 'legacy_preview' AND created_by = 'migration:r4-a'
  AND updated_by = 'migration:retire-unapproved-images'
  AND image_path IS NULL AND version = 2;
ALTER TABLE catalog_product ADD CONSTRAINT catalog_product_image_path_check
  CHECK (image_path IS NULL OR (
    image_path ~ '^/assets/cisme/[a-z0-9/_-]+[.]jpg$' AND image_path !~ '[.][.]'
  ));
