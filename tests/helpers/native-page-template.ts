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
