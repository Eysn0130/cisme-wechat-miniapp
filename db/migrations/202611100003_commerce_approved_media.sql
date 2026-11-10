-- Owner-approved commerce photography. Preserve all prior retired-image exclusions.
ALTER TABLE catalog_product DROP CONSTRAINT catalog_product_image_path_check;
ALTER TABLE catalog_product ADD CONSTRAINT catalog_product_image_path_check
CHECK (image_path IS NULL OR image_path IN ('/assets/icons/spray-bottle-plum.svg','/assets/commerce/product1-glass-v4b.jpg','/assets/commerce/product2-glass-v4b.jpg') OR (
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
DO $$ BEGIN IF EXISTS(SELECT 1 FROM catalog_product WHERE image_path IN ('/assets/commerce/product1-glass-v4b.jpg','/assets/commerce/product2-glass-v4b.jpg')) THEN RAISE EXCEPTION 'APPROVED_COMMERCE_MEDIA_STILL_IN_USE'; END IF; END $$;
ALTER TABLE catalog_product DROP CONSTRAINT catalog_product_image_path_check;
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
