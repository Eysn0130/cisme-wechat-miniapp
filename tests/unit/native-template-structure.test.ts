import{readFile,readdir}from'node:fs/promises';
import{it,expect}from'vitest';
it('keeps native page tags balanced and conditional siblings attached after copy refinements',async()=>{
 for(const route of await readdir('apps/miniprogram/pages')){
  const text=(await readFile(`apps/miniprogram/pages/${route}/index.wxml`,'utf8')).replace(/<!--[\s\S]*?-->/g,'');
  const stack:Array<{tag:string;last:string}>=[{tag:'root',last:''}];
  for(const m of text.matchAll(/<(\/?)([a-zA-Z][\w:-]*)(?:"[^"]*"|'[^']*'|[^'">])*>/g)){
   const raw=m[0],tag=m[2]!;if(m[1]){expect(stack.pop()?.tag,`${route}: ${raw}`).toBe(tag);continue;}
   const parent=stack.at(-1)!;if(/\swx:(?:else|elif)(?:\s|=|\/|>)/.test(raw))expect(parent.last,`${route}: orphan conditional ${raw}`).toMatch(/\swx:(?:if|elif)=/);
   parent.last=raw;if(!raw.endsWith('/>'))stack.push({tag,last:''});
  }
  expect(stack.map(x=>x.tag),route).toEqual(['root']);
 }
});
