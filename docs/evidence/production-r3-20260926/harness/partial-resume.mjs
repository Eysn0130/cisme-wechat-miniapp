import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';
const b='/opt/cisme/rehearsals/r3-20260926-1100',require=createRequire(b+'/final-candidate/package.json'),{Pool}=require('pg');
const originalEnv=JSON.parse(await readFile(b+'/runtime.json','utf8'));const url=new URL(originalEnv.DATABASE_URL);assert.equal(url.hostname,'127.0.0.1');assert.equal(url.port,'31956');url.pathname='/cisme_r3_partial';
const env={...originalEnv,DATABASE_URL:url.href},admin=new Pool({host:b+'/socket',port:31956,user:'cisme',database:'postgres'});let pool,holder;
const facts={mainArtifact:false,productionTouched:false,sourceHead:'82656217d83d9ebeb6febf646597a395625c74d6'};
try{
 if(!(await admin.query("SELECT 1 FROM pg_database WHERE datname='cisme_r3_partial'")).rowCount)await admin.query('CREATE DATABASE cisme_r3_partial OWNER r3_runtime TEMPLATE cisme_r3_original');await admin.query('ALTER DATABASE cisme_r3_partial SET default_transaction_read_only=off');
 pool=new Pool({connectionString:url.href});holder=await pool.connect();await holder.query('BEGIN');await holder.query('LOCK TABLE member IN ACCESS EXCLUSIVE MODE');
 let failure;try{execFileSync('/opt/node-v24.14.0-linux-x64/bin/node',[b+'/final-candidate/migrate.mjs','up'],{env,encoding:'utf8',stdio:'pipe'})}catch(e){failure=e}
 assert(failure);assert(String(failure.stderr).includes('RELEASE_MIGRATION_FAILED'));assert((await readFile(b+'/postgres.log','utf8')).includes('canceling statement due to lock timeout'));await holder.query('ROLLBACK');holder.release();holder=null;
 const partial=(await pool.query('SELECT count(*)::int n FROM schema_migration')).rows[0].n;assert(partial>23&&partial<95);
 const output=execFileSync('/opt/node-v24.14.0-linux-x64/bin/node',[b+'/final-candidate/migrate.mjs','up'],{env,encoding:'utf8'});
 const final=(await pool.query('SELECT count(*)::int n FROM schema_migration')).rows[0].n;assert.equal(final,95);const again=execFileSync('/opt/node-v24.14.0-linux-x64/bin/node',[b+'/final-candidate/migrate.mjs','up'],{env,encoding:'utf8'});assert.equal(again.trim(),'');
 Object.assign(facts,{ok:true,interruption:'real PostgreSQL lock timeout',partialJournalCount:partial,finalJournalCount:final,resumedApplied:output.trim().split('\n').length,repeatedApplied:0,originalSqlModified:false,oldDatabaseRestored:false});
}catch(e){facts.ok=false;facts.error={code:e.code,message:e.message};process.exitCode=1}finally{if(holder){await holder.query('ROLLBACK');holder.release()}if(pool)await pool.end();await admin.end();await writeFile(b+'/partial-resume-result.json',JSON.stringify(facts,null,2)+'\n',{mode:0o600});console.log(JSON.stringify(facts))}
