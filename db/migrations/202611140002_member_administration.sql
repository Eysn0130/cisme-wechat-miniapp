-- Purpose-scoped member administration; never grants a role or rewrites member assets.
ALTER TABLE authority_grant DROP CONSTRAINT authority_grant_capability_check;
ALTER TABLE authority_grant ADD CONSTRAINT authority_grant_capability_check CHECK (capability IN (
  'support.read','support.reply','support.assign',
  'commerce.product.manage','commerce.qualification.manage','commerce.inventory.manage','commerce.order.read',
  'commerce.aftersale.review','commerce.return.receive','commerce.return.inspect','commerce.fulfillment.manage','commerce.refund.approve','commerce.money.reconcile',
  'community.moderate','member.support_view','member.profile.read','member.manage','member.care.read','member.contact.read','member.export',
  'commission.read','commission.rate.manage','commission.rate.approve',
  'commission.settlement.approve','privacy.request.manage','editorial.manage'
));

-- migrate:down
DO $$ BEGIN IF EXISTS(SELECT 1 FROM authority_grant WHERE capability IN ('member.care.read','member.contact.read','member.export')) THEN RAISE EXCEPTION 'USER_ADMIN_GRANTS_REQUIRE_DATA_PRESERVATION'; END IF; END $$;
ALTER TABLE authority_grant DROP CONSTRAINT authority_grant_capability_check;
ALTER TABLE authority_grant ADD CONSTRAINT authority_grant_capability_check CHECK (capability IN (
  'support.read','support.reply','support.assign',
  'commerce.product.manage','commerce.qualification.manage','commerce.inventory.manage','commerce.order.read',
  'commerce.aftersale.review','commerce.return.receive','commerce.return.inspect','commerce.fulfillment.manage','commerce.refund.approve','commerce.money.reconcile',
  'community.moderate','member.support_view','member.profile.read','member.manage',
  'commission.read','commission.rate.manage','commission.rate.approve',
  'commission.settlement.approve','privacy.request.manage','editorial.manage'
));
