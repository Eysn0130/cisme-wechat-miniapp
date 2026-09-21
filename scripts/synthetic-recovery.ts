import { execFile,spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { mkdir,writeFile,readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { S3Client,CreateBucketCommand,PutObjectCommand,GetObjectCommand,DeleteObjectCommand } from '@aws-sdk/client-s3';
import { assertDisposableTarget,resetCapability,resetDatabase,testPool } from '@cisme/testkit';
const exec=promisify(execFile);
const capability=resetCapability(process.env),container=process.env.CISME_TEST_CONTAINER_ID;
if(!container||!/^[a-f0-9]{64}$/.test(container))throw new Error('OWNED_CONTAINER_REQUIRED');
const pool=testPool();
async function owned(){
  await assertDisposableTarget(pool);
  const actual=JSON.parse((await exec('docker',['inspect',container!])).stdout)[0];
  if(actual.Id!==container||actual.Name!==`/cisme-synthetic-${capability.runId}`||
    actual.Config.Labels['cisme.synthetic.run']!==capability.runId||actual.Config.Labels['cisme.synthetic.purpose']!=='disposable')
    throw new Error('RECOVERY_CONTAINER_OWNERSHIP_MISMATCH');
}
async function restore(bytes:Buffer){
  await owned();
  const client=await pool.connect();
  let locked=false;
  try{
    await assertDisposableTarget(client);
    locked=(await client.query('SELECT pg_try_advisory_lock(924173,1) AS acquired')).rows[0]?.acquired===true;
    if(!locked)throw new Error('CONCURRENT_TEST_RESET_REFUSED');
    await new Promise<void>((resolve,reject)=>{
      const child=spawn('docker',['exec','-i',container!,'pg_restore','--exit-on-error','--no-owner','--no-acl',
        '--no-tablespaces','--schema=public','--clean','--if-exists','-U',capability.role,'-d',capability.database],{stdio:['pipe','ignore','pipe']});
      child.stderr.resume();child.stdin.on('error',()=>{});child.stdin.end(bytes);
      child.on('error',reject);child.on('exit',code=>code===0?resolve():reject(new Error('SYNTHETIC_RESTORE_FAILED')));
    });
  }finally{try{if(locked)await client.query('SELECT pg_advisory_unlock(924173,1)');}finally{client.release();}}
}
async function objectRecovery(){
  const s3Container=process.env.CISME_TEST_S3_CONTAINER_ID,endpoint=process.env.CISME_TEST_S3_ENDPOINT,
    bucket=process.env.CISME_TEST_S3_BUCKET;
  if(!s3Container||!endpoint||bucket!==`cisme-${capability.runId}`||!/^http:\/\/127\.0\.0\.1:[0-9]+$/.test(endpoint)||new URL(endpoint).port==='58333')
    throw new Error('OWNED_OBJECT_TARGET_REQUIRED');
  const actual=JSON.parse((await exec('docker',['inspect',s3Container])).stdout)[0];
  const binding=actual.NetworkSettings.Ports['8333/tcp'];
  if(actual.Id!==s3Container||actual.Name!==`/cisme-synthetic-s3-${capability.runId}`||
    actual.Config.Labels['cisme.synthetic.run']!==capability.runId||actual.Config.Labels['cisme.synthetic.purpose']!=='disposable'||
    binding?.length!==1||binding[0].HostIp!=='127.0.0.1'||String(binding[0].HostPort)!==new URL(endpoint).port)
    throw new Error('OBJECT_RECOVERY_OWNERSHIP_MISMATCH');
  const s3=new S3Client({endpoint,region:'us-east-1',forcePathStyle:true,
    credentials:{accessKeyId:process.env.CISME_TEST_S3_ACCESS_KEY!,secretAccessKey:process.env.CISME_TEST_S3_SECRET!}});
  const key=`recovery/${capability.runId}/synthetic-only.txt`,bytes=Buffer.from('CISME synthetic object recovery; no user data');
  try{
    await s3.send(new CreateBucketCommand({Bucket:bucket}));
    await s3.send(new PutObjectCommand({Bucket:bucket,Key:key,Body:bytes}));
    const snapshot=await s3.send(new GetObjectCommand({Bucket:bucket,Key:key}));
    const backup=Buffer.from((await snapshot.Body?.transformToByteArray())??[]);
    if(!backup.equals(bytes))throw new Error('SYNTHETIC_OBJECT_SNAPSHOT_MISMATCH');
    await s3.send(new DeleteObjectCommand({Bucket:bucket,Key:key}));
    await s3.send(new PutObjectCommand({Bucket:bucket,Key:key,Body:backup}));
    const object=await s3.send(new GetObjectCommand({Bucket:bucket,Key:key}));
    if(!Buffer.from((await object.Body?.transformToByteArray())??[]).equals(backup))throw new Error('SYNTHETIC_OBJECT_RESTORE_MISMATCH');
    return {status:'PASS',scope:'one owned synthetic object, in-memory snapshot; not production durability',
      bytes:backup.length,sha256:createHash('sha256').update(backup).digest('hex')};
  }finally{await s3.send(new DeleteObjectCommand({Bucket:bucket,Key:key}));s3.destroy();}
}
const action=process.argv[2]??'rehearse';
try{
  await owned();
  if(action!=='rehearse')throw new Error('ONLY_SYNTHETIC_REHEARSAL_SUPPORTED: no arbitrary archive is executed');
  await resetDatabase(pool);
  await pool.query('CREATE TABLE recovery_synthetic_probe(id integer PRIMARY KEY,value text NOT NULL)');
  await pool.query("INSERT INTO recovery_synthetic_probe VALUES(1,'synthetic-recovery-only')");
  const before=(await pool.query('SELECT count(*)::int n FROM schema_migration')).rows[0].n;
  await owned();
  const {stdout:dump}=await exec('docker',['exec',container,'pg_dump','--format=custom','--no-owner','--no-acl',
    '--schema=public','-U',capability.role,'-d',capability.database],{encoding:'buffer',maxBuffer:64*1024*1024});
  const expected=createHash('sha256').update(dump).digest('hex');
  // Deliberate synthetic corruption of our one fixture; no existing data read.
  await pool.query("UPDATE recovery_synthetic_probe SET value='synthetic-corruption'");
  await restore(dump);
  const restored=(await pool.query('SELECT value FROM recovery_synthetic_probe WHERE id=1')).rows[0]?.value;
  const after=(await pool.query('SELECT count(*)::int n FROM schema_migration')).rows[0].n;
  if(restored!=='synthetic-recovery-only'||before!==after)throw new Error('RECOVERY_FACT_MISMATCH');
  await assertDisposableTarget(pool);
  const result={schemaVersion:1,runId:capability.runId,kind:'owned-synthetic-database-restore',dumpSha256:expected,
    dumpBytes:dump.length,migrationsBefore:before,migrationsAfter:after,probeRestored:true,ownershipSurvived:true,
    productionBackup:false,oldIncidentRestored:false,objectStorageRecovery:await objectRecovery(),releaseReady:false};
  const output=process.env.RUNNER_TEMP?resolve(process.env.RUNNER_TEMP,'native-validation'):resolve('docs/evidence/release-preparation-20260921/recovery');await mkdir(output,{recursive:true});
  await writeFile(resolve(output,'synthetic-restore.json'),JSON.stringify(result,null,2)+'\n');
  console.log(JSON.stringify(result));
}finally{await pool.end();}
