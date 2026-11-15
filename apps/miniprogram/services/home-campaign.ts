import type { CatalogProduct } from './commerce';
import { formatCnyCents } from './presentation';

export const campaignEssenceCode = 'aigerong-scalp-repair-essence-100';
export type CampaignDestination = 'shop' | 'essence' | 'support';
export interface HomeCampaignSlide {
  id: string; image: string; imageKey: string; heading: string; action: string;
  destination: CampaignDestination; imageLoaded: boolean; imageFailed: boolean;
  requested: boolean; price: string; imageAttempt: number;
}
const media = [
  ['brand', 'd5ec985bec7d7126381ae7cf2d8f2eba26dbd2cadf2f921904982caeece4a75b', '40+ 头皮养护', '了解爱格荣', 'shop'],
  ['essence', 'b63a0f255bbd2769553a183bbc40cde64116e978fd2daec31bca7f057e8baf81', '精华照顾头皮', '了解精华', 'essence'],
  ['set', 'c549ecd011c93a8563135aed46f3a02d7a896c64cec114a5be18fc359c9a7c18', '精华套组', '查看套组', 'essence'],
  ['selection', '180850ebd07f069bbfb4198f6d5580055e5dd48d574b57311c707f8ed4dbf38d', '适合你的洗护', '选品咨询', 'support']
] as const;

export function homeCampaignSlides(apiOrigin: string): HomeCampaignSlide[] {
  // Campaigns are public, immutable brand material; never send member tokens,
  // custom development origins or private-upload URLs to the image component.
  const origin = apiOrigin === 'https://api.cisme.cn' ? apiOrigin : 'https://staging-api.cisme.cn';
  return media.map(([id, hash, heading, action, destination], index) => ({
    id, image: `${origin}/v1/catalog/public-images/${hash}.jpg`, imageKey: `${origin}:${hash}`,
    heading, action, destination, imageLoaded: false, imageFailed: false, requested: index < 2, price: '', imageAttempt: 0
  }));
}
export function campaignEssence(items: CatalogProduct[]): CatalogProduct | undefined {
  return items.find(p => p.code === campaignEssenceCode && p.sourceKind === 'admin'
    && p.publicationStatus === 'published' && p.qualificationStatus === 'eligible'
    && p.currency === 'CNY' && typeof p.price === 'number' && formatCnyCents(p.price) !== null);
}
export function campaignPrice(item?: CatalogProduct): string {
  return item && typeof item.price === 'number' ? `¥${formatCnyCents(item.price) ?? ''}` : '';
}
