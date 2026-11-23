import{stripTypeScriptTypes}from'node:module';
import{runInNewContext}from'node:vm';
import{sectionTabs}from'../../apps/miniprogram/services/section-tabs';
import{identityLabel}from'../../apps/miniprogram/services/display-identity';
import{nativeCampaignComponent}from'./native-campaign';
import {readFileSync} from 'node:fs';
import {dirname,resolve} from 'node:path';

// miniprogram-simulate's inline-source loader does not resolve native imports.
// Expand this shared template for its renderer; actual imports are separately
// compiled in WeChat DevTools, and the production pages keep the one template.
export function nativePageTemplate(path:string):string {
  let source=readFileSync(path,'utf8');
  source=source.replace(/<include src="([^"]+)"\s*\/>/g,(_tag,src:string)=>nativePageTemplate(src.startsWith('/')?resolve('apps/miniprogram','.'+src):resolve(dirname(path),src)));
  const imported=source.match(/<import src="([^"]*community-feed\.wxml)"\s*\/>/);
  if(!imported)return source;
  const templates=new Map<string,string>();
  const definition=readFileSync(resolve(dirname(path),imported[1]!),'utf8');
  for(const match of definition.matchAll(/<template name="([^"]+)"\s*>([\s\S]*?)<\/template>/g))templates.set(match[1]!,match[2]!);
  return source.replace(imported[0],'').replace(/<template\b([^>]*?)\bis="([^"]+)"([^>]*?)\/>/g,(tag,before:string,name:string,after:string)=>{
    const template=templates.get(name);if(template===undefined)return tag;
    const condition=(before+after).match(/wx:if="([^"]+)"/);
    return condition?`<block wx:if="${condition[1]}">${template}</block>`:template;
  });
}

// Inline page fixtures must explicitly register real native custom components.
// Run the production definition with its real tab projection, rather than a dummy template.
export function nativePageComponents(simulate:{load:(definition:any)=>string}):Record<string,string>{
 let definition:any;
 const source=readFileSync('apps/miniprogram/components/section-tabs/index.ts','utf8').replace(/^import[^\n]*\n/gm,'');
 runInNewContext(stripTypeScriptTypes(source),{Component:(value:any)=>{definition=value;},sectionTabs,shouldReduceMotion:()=>true});
 const section=simulate.load({...definition,template:readFileSync('apps/miniprogram/components/section-tabs/index.wxml','utf8')});
 const foil=readFileSync('apps/miniprogram/components/card-foil/index.ts','utf8').replace(/^import[^\n]*\n/gm,'');
 runInNewContext(stripTypeScriptTypes(foil),{Component:(value:any)=>{definition=value;},shouldReduceMotion:()=>true});
 const cardFoil=simulate.load({...definition,template:readFileSync('apps/miniprogram/components/card-foil/index.wxml','utf8')});
 const badge=readFileSync('apps/miniprogram/components/identity-badge/index.ts','utf8').replace(/^import[^\n]*\n/gm,'');
 runInNewContext(stripTypeScriptTypes(badge),{Component:(value:any)=>{definition=value;},identityLabel});
 const identityBadge=simulate.load({...definition,template:readFileSync('apps/miniprogram/components/identity-badge/index.wxml','utf8')});
 // The independent reward lifecycle is exercised by onboarding-feedback.test.ts;
 // tab snapshot fixtures have no first-completion intent or points receipt.
 return {'care-campaign':nativeCampaignComponent(simulate),'section-tabs':section,'card-foil':cardFoil,'identity-badge':identityBadge,
  'reward-checkout':simulate.load({properties:{voucher:String,active:Boolean},template:'<view></view>'}),
  'reward-moment':simulate.load({properties:{owner:String,open:Boolean},template:'<view></view>'}),
  'points-celebration':simulate.load({properties:{owner:String,enabled:Boolean},template:'<view></view>'})};
}
