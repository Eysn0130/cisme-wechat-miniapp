import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {writeFile,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
export const project=new URL('../../../../apps/miniprogram/',import.meta.url).pathname.replace(/\/$/,'');
export const directory=new URL('../',import.meta.url).pathname.replace(/\/$/,'');
const exec=promisify(execFile);
let lastToolStart=0;
export async function cli(tool,args=[]){
  // The IDE has a documented-at-runtime 60 calls/minute limit. Keep all
  // callers of this client sequential and below that limit, including samples.
  const delay=Math.max(0,1500-(Date.now()-lastToolStart));
  if(delay)await new Promise(resolve=>setTimeout(resolve,delay));
  lastToolStart=Date.now();
  const {stdout}=await exec('wechatide',['-c','Codex',tool,'--project',project,...args],{maxBuffer:8e6,timeout:60000});
  const value=JSON.parse(stdout.slice(stdout.indexOf('{')));
  if(!value.ok)throw Error(JSON.stringify(value));
  return value.result;
}
export async function evaluate(fn,...args){
  const temporary=await mkdtemp(join(tmpdir(),'cisme-motion-'));
  const file=join(temporary,'args.json');
  try{
    await writeFile(file,JSON.stringify(args));
    const result=await cli('automation_evaluate',['--fn-source','function(){return ('+fn.toString()+').apply(null,arguments);}','--args-file',file]);
    return result.result?.result??result.result??result;
  }finally{await rm(temporary,{recursive:true,force:true});}
}
export async function capture(name){
  const result=await cli('simulator_screenshot',['--path',directory+'/'+name+'.png','--optimize','false']);
  return result;
}
if(process.argv[2]==='baseline'){
  const facts=await evaluate(async function(){
    const page=getCurrentPages().slice(-1)[0];
    const rects=await new Promise(resolve=>wx.createSelectorQuery().selectAll('.feed-card,.feed-card__media,.feed-card__image').boundingClientRect().exec(result=>resolve(result[0])));
    return {route:page.route,width:wx.getWindowInfo().windowWidth,mode:page.data.mode,loading:page.data.loading,feedReady:page.data.feedReady,error:page.data.error,
      count:page.data.displayFeedCount,signedIn:Boolean(getApp().globalData.sessionToken),rects,
      images:page.data.feedColumns?.flat().map(card=>({key:card.imageKey,phase:card.imagePhase,hasImage:Boolean(card.image)}))};
  });
  await writeFile(directory+'/baseline-native.json',JSON.stringify(facts,null,2)+'\n');
  await capture('baseline-community');
  console.log(JSON.stringify(facts));
}
if(process.argv[2]==='image-baseline'){
  const facts=await evaluate(async function(){
    const page=getCurrentPages().slice(-1)[0],card=page.data.feedColumns[0][0],oldKey=card.imageKey;
    const measure=()=>new Promise(resolve=>wx.createSelectorQuery().select('.feed-card__media').boundingClientRect().select('.feed-card__meta').boundingClientRect().exec(result=>resolve({media:result[0],author:result[1]})));
    const before=await measure();page.feedImageFailed({currentTarget:{dataset:{imageKey:oldKey}}});await new Promise(resolve=>setTimeout(resolve,50));
    const failed=await measure();page.retryFeedImage({currentTarget:{dataset:{imageKey:oldKey}}});
    const samples=[];
    for(let i=0;i<15;i++){
      samples.push({time:Date.now(),phase:page.data.feedColumns[0][0].imagePhase,...await measure()});
      await new Promise(resolve=>setTimeout(resolve,35));
    }
    return {before,failed,samples};
  });
  await writeFile(directory+'/'+(process.argv[3]||'image-retry')+'.json',JSON.stringify(facts,null,2)+'\n');
  console.log(JSON.stringify({before: facts.before, failed:facts.failed,samples:facts.samples.map(value=>({phase:value.phase,height:value.media?.height,authorTop:value.author?.top}))}));
}
