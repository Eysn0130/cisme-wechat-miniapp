import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {loadConfig} from '@cisme/config';
import {createObjectStorage} from '../../services/api/src/storage.js';
import {createCosSuppressionRemote} from '../../services/api/src/accountClosureRemote.js';
import {createPool} from '../../services/api/src/db.js';
import COS from 'cos-nodejs-sdk-v5';
const base='/opt/cisme/rehearsals/r3-20260926-1100';
const live=Object.fromEntries((await readFile('/opt/cisme/runtime.env','utf8')).split(/\r?\n/).filter(l=>/^[A-Z][A-Z0-9_]*=/.test(l)).map(l=>{const i=l.indexOf('=');let v=l.slice(i+1).trim();if((v.startsWith('"')&&v.endsWith('"'))||(v.startsWith("'")&&v.endsWith("'")))v=v.slice(1,-1);return [l.slice(0,i),v]}));
const synthetic=JSON.parse(await readFile(base+'/runtime.json','utf8'));
const facts:any={productionConfigInstalled:false,mainArtifact:false,tests:[]};const record=(name:string,result:unknown)=>facts.tests.push({name,result});
const marker='submissions/00000000-0000-4000-8000-000000000026/probe/r3-20260926-1035z-original.txt';
const env={...live,DATABASE_URL:synthetic.DATABASE_URL,APP_ENV:'production',ALLOW_DEV_ADAPTERS:'false',COMMERCE_ORDER_FLOW_ENABLED:'false',COMMERCE_FULFILLMENT_ENABLED:'false',RUN_BACKGROUND_WORKER:'false',CISME_MIGRATION_READ_ONLY:'true',COS_BUCKET_PRODUCT:'lighthouse',COS_READINESS_OBJECT_KEY:marker,COS_READINESS_OBJECT_SHA256:'25f62e1c96e45bb05478d2ee960b21b28dbd8fb834d7ddb1bb3580f6bbd86f07',PRIVACY_SUPPRESSION_BUCKET:'cisme-privacy-1257392443',PRIVACY_SUPPRESSION_DIR:base+'/production-suppression'};
let pool:any,app:any;
try{
 const config=loadConfig(env);record('productionConfigParsed',{env:config.env,allowDevAdapters:config.allowDevAdapters,driver:config.objectStorage.driver,product:config.objectStorage.cosBucketProduct});
 const storage=createObjectStorage(config);try{await storage.ensureReady();record('lighthouseActualAdapterReadiness',{ok:true,marker})}catch(e:any){record('lighthouseActualAdapterReadiness',{ok:false,code:e.code??e.message})}
 const client=new COS({SecretId:live.S3_ACCESS_KEY_ID,SecretKey:live.S3_SECRET_ACCESS_KEY,Protocol:'https:',Timeout:30000});
 for(const [name,fn] of [['privacyVersioning',()=>client.getBucketVersioning({Bucket:'cisme-privacy-1257392443',Region:'ap-shanghai'})],['privacyScopedList',()=>client.getBucket({Bucket:'cisme-privacy-1257392443',Region:'ap-shanghai',Prefix:'privacy-suppression/v1/wx4eac2d4fb11d299b/',MaxKeys:1})]] as const){try{const r:any=await fn();record(name,{ok:true,status:r.statusCode,versioning:r.VersioningConfiguration??null,count:r.Contents?.length??null,truncated:r.IsTruncated??null})}catch(e:any){record(name,{ok:false,code:e.code,status:e.statusCode,requestId:e.requestId})}}
 const remote=createCosSuppressionRemote(config);try{const rows=await remote.list();record('privacyActualAdapterList',{ok:true,count:rows.length})}catch(e:any){record('privacyActualAdapterList',{ok:false,code:e.code??e.message,status:e.statusCode})}
 await mkdir(env.PRIVACY_SUPPRESSION_DIR,{recursive:true,mode:0o700});Object.assign(process.env,env);pool=createPool(config.databaseUrl,config.database);
 const {createApp}=await import(base+'/candidate/index.js');
 try{app=await createApp({config,pool,storage});await app.listen({port:31958,host:'127.0.0.1'});const r=await fetch('http://127.0.0.1:31958/health/ready');record('productionCandidateHTTP',{status:r.status,body:await r.json()});const rejected=await fetch('http://127.0.0.1:31958/v1/identity/dev',{method:'POST',headers:{'content-type':'application/json'},body:'{}'});const data:any=await rejected.json();record('productionWriteGuard',{status:rejected.status,code:data.code})}catch(e:any){record('productionCandidateStartup',{ok:false,code:e.code??e.message})}
 record('existingSecretsPresent',Object.fromEntries(['APP_SESSION_SECRET','UPLOAD_TOKEN_SECRET','CONTACT_ENCRYPTION_KEY','CONTACT_HASH_KEY','PRIVACY_FORMAL_EXPORT_KEY','WECHAT_APP_SECRET','S3_ACCESS_KEY_ID','S3_SECRET_ACCESS_KEY'].map(k=>[k,Boolean(live[k])])));
}catch(e:any){record('configFailure',{code:e.code??e.message})}finally{if(app)await app.close();if(pool)await pool.end();await writeFile(base+'/storage-runtime-result.json',JSON.stringify(facts,null,2)+'\n',{mode:0o600});console.log(JSON.stringify(facts));}
