// Deterministic source-level setData payload comparison, NOT WeChat rendering.
// No network, devices, private data or production UGC. Run at repository root.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { transformSync } from 'esbuild';
const root=process.cwd(),relative='apps/miniprogram/pages/community/index.ts';
const baseline='56432fb9b42777ffd4b3aeaf17134a666c7f243c';
const original=execFileSync('git',['show',`${baseline}:${relative}`],{encoding:'utf8'}),current=fs.readFileSync(relative,'utf8');
const hash=text=>createHash('sha256').update(text).digest('hex');
function set(target,key,value){const parts=key.replace(/\[(\d+)\]/g,'.$1').split('.');let cursor=target;for(const [i,part] of parts.entries()){if(i===parts.length-1)cursor[part]=structuredClone(value);else cursor=cursor[part]??= /^\d+$/.test(parts[i+1])?[]:{};}}
async function run(source,total){
  let definition,index=0,bytes=0,calls=0;const patches=[];
  const request=async()=>{const count=Math.min(30,total-index),items=Array.from({length:count},(_,i)=>({id:`post-${index+i}`,title:'合成护理故事',authorId:'synthetic-author',author:'合成会员',coverId:'synthetic-cover',likeCount:0,commentCount:0}));index+=count;return {items,nextCursor:index<total?`cursor-${index}`:null};};
  const mocks={
    '../../services/api':{request},'../../services/page-requests':{pageRead:(_,o)=>request(o),cancelPageReads(){}},
    '../../services/member-avatar':{defaultMemberAvatar:'/neutral.svg'},'../../services/editorial':{editorialStories:[]},
    '../../services/layout':{currentChromeStyle:()=>''},'../../services/member-identity':{memberIdentity:()=>null},'../../services/task-entry':{},
    '../../services/performance-metrics':{measurementClock:()=>performance.now(),recordClientMetric(){}}
  };
  function evaluate(text,file){const module={exports:{}};const require=name=>{if(mocks[name])return mocks[name];const p=path.resolve(path.dirname(file),name+'.ts');return evaluate(fs.readFileSync(p,'utf8'),p);};vm.runInNewContext(transformSync(text,{loader:'ts',format:'cjs'}).code,{module,exports:module.exports,require,Page:d=>definition=d,getApp:()=>({globalData:{sessionToken:'synthetic',apiBaseUrl:'https://synthetic.invalid'}}),wx:{},setTimeout,clearTimeout,console},{filename:file});return module.exports;}
  evaluate(source,path.resolve(relative));
  const page={...definition,data:structuredClone(definition.data),setData(patch,callback){bytes+=Buffer.byteLength(JSON.stringify(patch));calls++;patches.push(Object.keys(patch));for(const [k,v]of Object.entries(patch))set(this.data,k,v);callback?.();}};
  Object.assign(page.data,{mode:'recommend',ugcFeedEnabled:true,loading:false,formalNextCursor:'start'});
  while(index<total)await page.onReachBottom();
  if(page.data.feedColumns.flat().length!==total)throw Error('Benchmark must retain all visible cards');
  return {setDataBytes:bytes,setDataCalls:calls,rawFeedTransfers:patches.filter(keys=>keys.includes('feed')).length,fullColumnTransfers:patches.filter(keys=>keys.includes('feedColumns')).length};
}
const cases=[];
for(const total of [30,100,300]){const before=await run(original,total),after=await run(current,total);cases.push({cards:total,before,after,byteReductionPercent:Math.round((1-after.setDataBytes/before.setDataBytes)*10000)/100});}
console.log(JSON.stringify({kind:'source-VM-native-setData-payload-comparison-NOT-device-performance',baselineCommit:baseline,source:{baselineSha256:hash(original),candidateSha256:hash(current)},node:process.version,sampleCountPerCase:1,cohort:'deterministic synthetic payload size, not latency percentiles',bridgeCallbacks:'synchronous synthetic; native durations/FPS/memory/network unmeasured',fixture:'seven documented card-like fields, 30 rows/page, no actual UGC',cases},null,2));
