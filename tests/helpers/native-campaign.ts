import { stripTypeScriptTypes } from 'node:module';
import { runInNewContext } from 'node:vm';
import { readFileSync } from 'node:fs';
import { CampaignRotation, campaignTransitionMs } from '../../apps/miniprogram/services/campaign-rotation';
import { homeCampaignSlides, campaignEssence, campaignPrice } from '../../apps/miniprogram/services/home-campaign';

/** Real production view/definition, with only its public catalog IO isolated. */
export function nativeCampaignComponent(simulate: { load: (definition: any) => string }): string {
  let definition: any;
  const source = readFileSync('apps/miniprogram/components/care-campaign/index.ts', 'utf8').replace(/^import[^\n]*\n/gm, '');
  runInNewContext(stripTypeScriptTypes(source), {
    Component: (value: any) => { definition = value; }, CampaignRotation, campaignTransitionMs,
    homeCampaignSlides, campaignEssence, campaignPrice,
    getApp: () => ({ globalData: { apiBaseUrl: 'https://staging-api.cisme.cn' } }),
    catalogList: async () => ({ items: [] }), cancelPageReads: () => {}
  });
  return simulate.load({ ...definition, template: readFileSync('apps/miniprogram/components/care-campaign/index.wxml', 'utf8') });
}
