import{stripTypeScriptTypes}from'node:module';
import{runInNewContext}from'node:vm';
import{sectionTabs}from'../../apps/miniprogram/services/section-tabs';
import {readFileSync} from 'node:fs';
import {dirname,resolve} from 'node:path';

// miniprogram-simulate's inline-source loader does not resolve native imports.
// Expand this shared template for its renderer; actual imports are separately
// compiled in WeChat DevTools, and the production pages keep the one template.
export function nativePageTemplate(path:string):string {
  let source=readFileSync(path,'utf8');
  const imported=source.match(/<import src="([^"]*community-feed\.wxml)"\s*\/>/);
  if(!imported)return source;
  const template=readFileSync(resolve(dirname(path),imported[1]!),'utf8').replace(/^<template[^>]*>\s*/,'').replace(/\s*<\/template>\s*$/,'');
  return source.replace(imported[0],'').replace(/<template is="communityFeed"[^>]*\/>/,template);
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
 return {'section-tabs':section,'card-foil':simulate.load({...definition,template:readFileSync('apps/miniprogram/components/card-foil/index.wxml','utf8')})};
}
