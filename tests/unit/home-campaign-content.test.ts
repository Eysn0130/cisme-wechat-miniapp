import { expect, it } from 'vitest';
import { homeCampaignSlides, campaignEssence, campaignPrice, campaignEssenceCode } from '../../apps/miniprogram/services/home-campaign';
const product = { code: campaignEssenceCode, sourceKind: 'admin', publicationStatus: 'published', qualificationStatus: 'eligible', currency: 'CNY', price: 29800 } as any;
it('uses four immutable HTTPS public images without token or arbitrary-origin propagation', () => {
  for (const origin of ['http://localhost:3100', 'https://untrusted.invalid/?token=private', 'https://staging-api.cisme.cn']) {
    const slides = homeCampaignSlides(origin);
    expect(slides.map(s => s.id)).toEqual(['brand', 'essence', 'set', 'selection']);
    for (const slide of slides) expect(slide.image).toMatch(/^https:\/\/staging-api\.cisme\.cn\/v1\/catalog\/public-images\/[a-f0-9]{64}\.jpg$/);
    expect(slides.map(s => s.requested)).toEqual([true, true, false, false]);
    expect(slides.every(s => s.price === '')).toBe(true);
  }
  expect(homeCampaignSlides('https://api.cisme.cn')[0]!.image).toContain('https://api.cisme.cn/');
});
it('shows actual server pricing rather than the supplied poster price', () => {
  const live = campaignEssence([product]); expect(campaignPrice(live)).toBe('¥298');
  expect(campaignPrice(campaignEssence([{ ...product, price: 32150 }]))).toBe('¥321.50');
  expect(campaignPrice(undefined)).toBe('');
});
it.each([{ sourceKind: 'legacy_preview' }, { publicationStatus: 'draft' }, { qualificationStatus: 'blocked' }, { currency: 'USD' }, { price: null }, { price: NaN }, { code: 'other' }])('does not bind unverified sale material %j', change => {
  expect(campaignEssence([{ ...product, ...change }])).toBeUndefined();
});
