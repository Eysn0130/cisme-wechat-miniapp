import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
import {createHash,randomBytes} from 'node:crypto';
import {loadConfig} from '@cisme/config';
import {testPool,assertDisposableTarget,resolveTestDatabaseUrl} from '@cisme/testkit';
import {createApiGatewayStorage} from '../services/api/src/storage';
const directory=resolve(process.argv[2]??'');
if(!directory.startsWith(resolve('dist/tencent-release-')))throw new Error('OWN_CANDIDATE_DIRECTORY_REQUIRED');
const bytes=await readFile(resolve(directory,'release-manifest.json'));
const manifest=JSON.parse(bytes.toString('utf8'));
for(const name of ['index.js','worker.js','worker-once.js','migrate.mjs']){
 if(createHash('sha256').update(await readFile(resolve(directory,name))).digest('hex')!==manifest.hashes[name])throw new Error('CANDIDATE_FILE_HASH_MISMATCH');
}
const pool=testPool(),client=await pool.connect();
try{await assertDisposableTarget(client);
 if((await client.query("SELECT 1 FROM information_schema.tables WHERE table_schema='public'")).rowCount)throw new Error('FRESH_EMPTY_SYNTHETIC_DATABASE_REQUIRED');
}finally{client.release();}
try{
 const run=(action:string)=>{
  const result=spawnSync(process.execPath,[resolve(directory,'migrate.mjs'),action],{encoding:'utf8',
   env:{PATH:process.env.PATH,DATABASE_URL:resolveTestDatabaseUrl(),CISME_MIGRATION_APPROVAL_REF:`synthetic-only:${process.env.CISME_TEST_RUN_ID}`,
    CISME_PREDEPLOY_BACKUP_REF:'synthetic-empty-target-no-existing-data'}});
  if(result.status!==0)throw new Error('SYNTHETIC_CANDIDATE_MIGRATION_FAILED');
  return result.stdout.trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));
 };
 const verified=run('verify'),first=run('up'),second=run('up');
 const versions=(await pool.query('SELECT version FROM schema_migration ORDER BY version')).rows.map(row=>row.version);
 if(JSON.stringify(versions)!==JSON.stringify(manifest.migrations)||first.length!==versions.length||second.length!==0)throw new Error('MIGRATION_REHEARSAL_MISMATCH');
 const runtime=await import(pathToFileURL(resolve(directory,'index.js')).href);
 const config=loadConfig({APP_ENV:'test',DATABASE_URL:resolveTestDatabaseUrl(),APP_SESSION_SECRET:randomBytes(32).toString('hex'),
  UPLOAD_TOKEN_SECRET:randomBytes(32).toString('hex'),OBJECT_STORAGE_DRIVER:'api_gateway'});
 const app=await runtime.createApp({config,pool,storage:createApiGatewayStorage(config)});
 let health:number,protectedStatus:number;
 try{health=(await app.inject({url:'/health/ready'})).statusCode;protectedStatus=(await app.inject({url:'/v1/admin/runtime-metrics'})).statusCode;}
 finally{await app.close();}
 if(health!==200||protectedStatus!==401)throw new Error('CANDIDATE_RUNTIME_SMOKE_FAILED');
 const result={schemaVersion:1,runId:process.env.CISME_TEST_RUN_ID,candidateHead:manifest.sourceHead,candidateTree:manifest.sourceTree,
  manifestSha256:createHash('sha256').update(bytes).digest('hex'),migrationVerify:verified[0],firstApplied:first.length,repeatedApplied:second.length,
  bundleRuntime:{health,unauthenticatedMetrics:protectedStatus},existingTargetTouched:false,deployed:false,productionRestore:false,releaseReady:false};
 await mkdir('tmp/release-preparation',{recursive:true});
 await writeFile('tmp/release-preparation/candidate-rehearsal.json',JSON.stringify(result,null,2)+'\n');
 console.log(JSON.stringify(result));
}finally{await pool.end();}
