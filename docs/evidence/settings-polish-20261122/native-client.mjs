import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {writeFile,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const exec=promisify(execFile);
export const project=new URL('../../../apps/miniprogram/',import.meta.url).pathname.replace(/\/$/,'');
export const directory=new URL('./',import.meta.url).pathname.replace(/\/$/,'');
let previous=0;
export async function cli(tool,args=[]){
  const delay=Math.max(0,1500-(Date.now()-previous));
  if(delay)await new Promise(resolve=>setTimeout(resolve,delay));
  previous=Date.now();
  let stdout;
  try{({stdout}=await exec('wechatide',['-c','Codex',tool,'--project',project,...args],{maxBuffer:3e6,timeout:60000}));}
  catch(error){
    let detail='tool execution failed';
    try{const raw=String(error.stdout||'');detail=JSON.parse(raw.slice(raw.indexOf('{'))).message||detail;}catch{}
    throw Error(`${tool}: ${detail}`);
  }
  const result=JSON.parse(stdout.slice(stdout.indexOf('{')));
  if(!result.ok)throw Error(JSON.stringify(result));
  return result.result;
}
export async function evaluate(fn,...args){
  const temporary=await mkdtemp(join(tmpdir(),'cisme-settings-'));
  try{
    const file=join(temporary,'args.json');await writeFile(file,JSON.stringify(args));
    const result=await cli('automation_evaluate',['--fn-source','function(){return ('+fn.toString()+').apply(null,arguments);}','--args-file',file]);
    return result.result?.result??result.result??result;
  }finally{await rm(temporary,{recursive:true,force:true});}
}
