// This file ships inside the immutable backend candidate. No down migration.
import {readFile, lstat, readdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
// Keep the historical file bytes/hash unchanged. Only remove the complete outer
// wrapper when executing, so DDL and its journal share the runner's transaction.
function transactionBody(sql){
 const text=sql.trim();
 if(/^BEGIN\s*;/i.test(text)){
  const wrapped=/^BEGIN\s*;([\s\S]*)\bCOMMIT\s*;$/i.exec(text);
  if(!wrapped)throw new Error('MIGRATION_TRANSACTION_WRAPPER_INVALID');
  return wrapped[1];
 }
 return sql;
}
async function main(){
const root=fileURLToPath(new URL('./',import.meta.url));
// Verify the whole shipped candidate before importing a driver or touching DB.
// Hashes establish consistency, not authenticity: the caller must pin the archive
// and source to the reviewed CI/main SHA and keep the release directory immutable.
const utf8=new TextDecoder('utf-8',{fatal:true});
let totalBytes=0;
async function candidateBytes(name){
 const path=resolve(root,name),stat=await lstat(path);
 if(!stat.isFile()||stat.isSymbolicLink())throw new Error('CANDIDATE_FILE_UNSAFE');
 if(stat.size>20*1024*1024||totalBytes+stat.size>64*1024*1024)throw new Error('CANDIDATE_SIZE_EXCEEDED');
 const bytes=await readFile(path);
 totalBytes+=bytes.length;
 if(bytes.length>20*1024*1024||totalBytes>64*1024*1024)throw new Error('CANDIDATE_SIZE_EXCEEDED');
 return bytes;
}
const manifest=JSON.parse(utf8.decode(await candidateBytes('release-manifest.json')));
if(!manifest||manifest.schemaVersion!==1||!Array.isArray(manifest.migrations)
 ||!manifest.migrations.length||manifest.migrations.length>10000)
 throw new Error('RELEASE_MANIFEST_REQUIRED');
if([manifest.sourceHead,manifest.sourceTree].some(value=>typeof value!=='string'||! /^[a-f0-9]{40}$/.test(value)||/^0{40}$/.test(value)))
 throw new Error('CANDIDATE_SOURCE_BINDING_INVALID');
for(const [index,file] of manifest.migrations.entries()){
 if(typeof file!=='string'||!/^\d+_[A-Za-z0-9_-]+\.sql$/.test(file))throw new Error('MIGRATION_PATH_INVALID');
 if(index>0&&file<=manifest.migrations[index-1])throw new Error('MIGRATION_ORDER_INVALID');
}
const expected=['index.js','worker.js','worker-once.js','package.json','package-lock.json','migrate.mjs',
 ...manifest.migrations.map(file=>`db/migrations/${file}`)];
const hashes=manifest.hashes;
if(!hashes||typeof hashes!=='object'||Array.isArray(hashes)
 ||Object.keys(hashes).length!==expected.length
 ||expected.some(name=>!Object.hasOwn(hashes,name)||typeof hashes[name]!=='string'||! /^[a-f0-9]{64}$/.test(hashes[name])))
 throw new Error('CANDIDATE_HASH_SET_INVALID');
for(const name of ['db','db/migrations']){
 const stat=await lstat(resolve(root,name));
 if(!stat.isDirectory()||stat.isSymbolicLink())throw new Error('CANDIDATE_FILE_UNSAFE');
}
const diskMigrations=(await readdir(resolve(root,'db/migrations'))).filter(name=>name.endsWith('.sql')).sort();
if(JSON.stringify(diskMigrations)!==JSON.stringify(manifest.migrations))throw new Error('MIGRATION_FILE_SET_INVALID');
const sources=[];
for(const name of expected){
 const bytes=await candidateBytes(name);
 if(createHash('sha256').update(bytes).digest('hex')!==hashes[name])
  throw new Error(name.startsWith('db/migrations/')?'MIGRATION_HASH_MISMATCH':'CANDIDATE_HASH_MISMATCH');
 if(name.startsWith('db/migrations/'))sources.push({file:name.slice('db/migrations/'.length),up:transactionBody(utf8.decode(bytes).split('-- migrate:down')[0])});
}
if(process.argv[2]==='verify'){
 console.log(JSON.stringify({migrations:sources.length,sourceHead:manifest.sourceHead,sourceTree:manifest.sourceTree,
  artifacts:expected.length,verified:true,applied:false}));return;
}
if(process.argv[2]!=='up'||!process.env.DATABASE_URL||!/^[-A-Za-z0-9_:.]{8,120}$/.test(process.env.CISME_MIGRATION_APPROVAL_REF??'')||
 !/^[-A-Za-z0-9_:.]{8,120}$/.test(process.env.CISME_PREDEPLOY_BACKUP_REF??''))
 throw new Error('EXPLICIT_TARGET_UP_APPROVAL_AND_BACKUP_REFERENCES_REQUIRED');
// Supplying these references is an operator action, not an approval created by this script.
const {default:pg}=await import('pg');
const pool=new pg.Pool({connectionString:process.env.DATABASE_URL,max:1,connectionTimeoutMillis:5000});
const client=await pool.connect();
try{
 await client.query("SET lock_timeout='5s'");await client.query("SET statement_timeout='120s'");
 const locked=(await client.query('SELECT pg_try_advisory_lock(924173,2) locked')).rows[0]?.locked;
 if(!locked)throw new Error('MIGRATION_ALREADY_RUNNING');
 try{
  await client.query('CREATE TABLE IF NOT EXISTS schema_migration(version text PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now())');
  const applied=(await client.query('SELECT version FROM schema_migration ORDER BY version')).rows.map(row=>row.version);
  if(applied.some((name,index)=>name!==sources[index]?.file))throw new Error('MIGRATION_HISTORY_NOT_CANDIDATE_PREFIX');
  for(const source of sources.slice(applied.length)){
   await client.query('BEGIN');
   try{await client.query(source.up);await client.query('INSERT INTO schema_migration(version) VALUES($1)',[source.file]);await client.query('COMMIT');}
   catch(error){await client.query('ROLLBACK');throw error;}
   console.log(JSON.stringify({applied:source.file,approvalReference:process.env.CISME_MIGRATION_APPROVAL_REF,backupReference:process.env.CISME_PREDEPLOY_BACKUP_REF}));
  }
 }finally{await client.query('SELECT pg_advisory_unlock(924173,2)');}
}finally{client.release();await pool.end();}

}
main().catch(error=>{
 const known=new Set(['MIGRATION_TRANSACTION_WRAPPER_INVALID','RELEASE_MANIFEST_REQUIRED','MIGRATION_PATH_INVALID','MIGRATION_HASH_MISMATCH',
  'CANDIDATE_FILE_UNSAFE','CANDIDATE_SIZE_EXCEEDED','CANDIDATE_SOURCE_BINDING_INVALID','MIGRATION_ORDER_INVALID',
  'CANDIDATE_HASH_SET_INVALID','MIGRATION_FILE_SET_INVALID','CANDIDATE_HASH_MISMATCH',
  'EXPLICIT_TARGET_UP_APPROVAL_AND_BACKUP_REFERENCES_REQUIRED','MIGRATION_ALREADY_RUNNING','MIGRATION_HISTORY_NOT_CANDIDATE_PREFIX']);
 console.error(known.has(error?.message)?error.message:'RELEASE_MIGRATION_FAILED');
 process.exitCode=1; // Never print driver errors, SQL, connection strings or stack traces.
});
