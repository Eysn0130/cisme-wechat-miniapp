// This file ships inside the immutable backend candidate. No down migration.
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import pg from 'pg';
async function main(){
const root=fileURLToPath(new URL('./',import.meta.url));
const manifest=JSON.parse(await readFile(resolve(root,'release-manifest.json'),'utf8'));
if(manifest.schemaVersion!==1||!Array.isArray(manifest.migrations)||!manifest.migrations.length)
 throw new Error('RELEASE_MANIFEST_REQUIRED');
const sources=[];
for(const file of manifest.migrations){
 if(typeof file!=='string'||!/^\d+_[A-Za-z0-9_-]+\.sql$/.test(file))throw new Error('MIGRATION_PATH_INVALID');
 const bytes=await readFile(resolve(root,'db/migrations',file));
 if(createHash('sha256').update(bytes).digest('hex')!==manifest.hashes[`db/migrations/${file}`])throw new Error('MIGRATION_HASH_MISMATCH');
 sources.push({file,up:bytes.toString('utf8').split('-- migrate:down')[0]});
}
if(process.argv[2]==='verify'){console.log(JSON.stringify({migrations:sources.length,sourceHead:manifest.sourceHead,verified:true,applied:false}));process.exit(0);}
if(process.argv[2]!=='up'||!process.env.DATABASE_URL||!/^[-A-Za-z0-9_:.]{8,120}$/.test(process.env.CISME_MIGRATION_APPROVAL_REF??'')||
 !/^[-A-Za-z0-9_:.]{8,120}$/.test(process.env.CISME_PREDEPLOY_BACKUP_REF??''))
 throw new Error('EXPLICIT_TARGET_UP_APPROVAL_AND_BACKUP_REFERENCES_REQUIRED');
// Supplying these references is an operator action, not an approval created by this script.
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
 const known=new Set(['RELEASE_MANIFEST_REQUIRED','MIGRATION_PATH_INVALID','MIGRATION_HASH_MISMATCH',
  'EXPLICIT_TARGET_UP_APPROVAL_AND_BACKUP_REFERENCES_REQUIRED','MIGRATION_ALREADY_RUNNING','MIGRATION_HISTORY_NOT_CANDIDATE_PREFIX']);
 console.error(known.has(error?.message)?error.message:'RELEASE_MIGRATION_FAILED');
 process.exitCode=1; // Never print driver errors, SQL, connection strings or stack traces.
});
