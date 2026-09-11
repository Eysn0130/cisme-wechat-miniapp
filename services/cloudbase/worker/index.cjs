'use strict';
const {timingSafeEqual}=require('node:crypto');
const {execFile}=require('node:child_process');
const {promisify}=require('node:util');
const exec=promisify(execFile);
exports.main=async(event={})=>{
  const expected=process.env.CISME_WORKER_TRIGGER_SECRET || '';
  let supplied='';
  try { supplied=JSON.parse(event.Message || '{}').authorization || ''; } catch {}
  const equal=(left,right)=>typeof left==='string' && Buffer.byteLength(left)===Buffer.byteLength(right) && timingSafeEqual(Buffer.from(left),Buffer.from(right));
  // CloudBase's ordinary trigger schema omits Message. A private, unpredictable
  // trigger name provides the shared credential; never trust Type alone.
  const timerName='cismeWorker_'+expected.slice(0,48);
  const validTimer=event.Type==='Timer' && equal(event.TriggerName,timerName);
  if (expected.length<32 || (!equal(supplied,expected) && !validTimer)) throw new Error('WORKER_TRIGGER_UNAUTHORIZED');
  if (process.env.CISME_WORKER_PAUSED === 'true') return {completed:false,paused:true};
  const childEnv={...process.env,RUN_BACKGROUND_WORKER:'false'};
  delete childEnv.NODE_OPTIONS;
  let stage='runtime-unpack';
  try {
    await exec(process.execPath,['unpack.cjs'],{cwd:__dirname,timeout:20000,env:childEnv});
    stage='worker-cycle';
    const {stdout}=await exec('/tmp/cisme-node24',['worker.mjs'],{cwd:__dirname,timeout:35000,maxBuffer:1024*1024,env:childEnv});
    return {completed:true,summary:JSON.parse(stdout.trim())};
  } catch(error) {
    console.error('CISME_WORKER_FAILURE',JSON.stringify({stage,code:error.code || error.name,signal:error.signal || null}));
    throw new Error('CISME_WORKER_FAILED:'+stage+':'+(error.code || error.name));
  }
};
