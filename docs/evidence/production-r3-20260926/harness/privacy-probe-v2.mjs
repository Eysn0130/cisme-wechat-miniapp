import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
const b='/opt/cisme/rehearsals/r3-20260926-1100';
const require=createRequire(b+'/candidate/package.json');const COS=require('cos-nodejs-sdk-v5');
const live=Object.fromEntries((await readFile('/opt/cisme/runtime.env','utf8')).split(/\r?\n/).filter(l=>/^[A-Z][A-Z0-9_]*=/.test(l)).map(l=>{const i=l.indexOf('=');let v=l.slice(i+1).trim();if((v.startsWith('"')&&v.endsWith('"'))||(v.startsWith("'")&&v.endsWith("'")))v=v.slice(1,-1);return [l.slice(0,i),v]}));
const c=new COS({SecretId:live.S3_ACCESS_KEY_ID,SecretKey:live.S3_SECRET_ACCESS_KEY,Protocol:'https:',Timeout:30000});
const loc={Bucket:'cisme-privacy-1257392443',Region:'ap-shanghai'};
const run='r3-20260926-1135z',prefix='cisme-probes/r3-20260926/',key=prefix+run+'-original.txt',restored=prefix+run+'-restored.txt';
const data=Buffer.from('CISME R3 private object recovery '+run+'\n'),sha=x=>createHash('sha256').update(x).digest('hex');
const facts={identity:'existing cisme-storage-runtime',scope:'two own objects only; not whole-bucket backup',productionBusinessObjectsChanged:false,tests:[]};
const record=(name,value)=>facts.tests.push({name,value});
try{
 const immutablePut=async(Key,Body)=>{try{await c.putObject({...loc,Key,Body,ContentType:'text/plain',Headers:{'x-cos-forbid-overwrite':'true'}})}catch(e){if(e.code!=='FileAlreadyExists')throw e;assert.equal(sha(Buffer.from((await c.getObject({...loc,Key})).Body)),sha(Body));}};
 await immutablePut(key,data);
 const head=await c.headObject({...loc,Key:key}),read=await c.getObject({...loc,Key:key});assert.equal(sha(Buffer.from(read.Body)),sha(data));record('putHeadGet',{key,status:head.statusCode,bytes:data.length,sha256:sha(data)});
 const backup=b+'/'+run+'.bin';try{await writeFile(backup,Buffer.from(read.Body),{mode:0o600,flag:'wx'})}catch(e){if(e.code!=='EEXIST')throw e}const recovery=await readFile(backup);assert.equal(sha(recovery),sha(data));
 await immutablePut(restored,recovery);assert.equal(sha(Buffer.from((await c.getObject({...loc,Key:restored})).Body)),sha(data));record('backupRestore',{backup,restored,sha256:sha(data),sameHostBackup:true});
 for(const [name,action,code] of [
  ['rootListDenied',()=>c.getBucket({...loc,MaxKeys:1}),'AccessDenied'],
  ['otherAppPrefixDenied',()=>c.getBucket({...loc,Prefix:'privacy-suppression/v1/r3-other-app/',MaxKeys:1}),'AccessDenied'],
  ['outsidePrefixHeadDenied',()=>c.headObject({...loc,Key:'r3-outside-prefix-nonexistent.txt'}),null],
  ['writeWithoutOverwriteGuardDenied',()=>c.putObject({...loc,Key:key,Body:data}),'AccessDenied'],
  ['originalOverwritePrevented',()=>c.putObject({...loc,Key:key,Body:Buffer.from('forbidden overwrite'),Headers:{'x-cos-forbid-overwrite':'true'}}),'FileAlreadyExists']]){
   let err;try{await action()}catch(e){err=e}assert(err,name);record(name,{code:err.code??null,status:err.statusCode});if(code)assert.equal(err.code,code,name);else assert.equal(err.statusCode,403,name);
 }
 assert.equal(sha(Buffer.from((await c.getObject({...loc,Key:key})).Body)),sha(data));record('originalPreserved',true);facts.ok=true;
}catch(e){facts.ok=false;facts.error={code:e.code??e.message};process.exitCode=1}
await writeFile(b+'/privacy-probe-result.json',JSON.stringify(facts,null,2)+'\n',{mode:0o600});console.log(JSON.stringify(facts));
