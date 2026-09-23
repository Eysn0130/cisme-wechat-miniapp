import {execFile} from 'node:child_process';
import {randomUUID,createHash} from 'node:crypto';
import {readFile,readdir,mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {resolve} from 'node:path';
import {promisify} from 'node:util';
import pg from 'pg';
import {beforeAll,afterAll,it,expect} from 'vitest';
import {TEST_DATABASE_URL,assertDisposableTarget,testPool} from '@cisme/testkit';
const exec=promisify(execFile),url=new URL(TEST_DATABASE_URL);
url.pathname='/postgres';const admin=new pg.Pool({connectionString:url.toString()});
const name='cisme_production_baseline_'+randomUUID().replaceAll('-','');url.pathname='/'+name;
const db=new pg.Pool({connectionString:url.toString()});let created=false;let candidate:string|undefined;
beforeAll(async()=>{const own=testPool();try{await assertDisposableTarget(own);}finally{await own.end();}
 await admin.query(`CREATE DATABASE ${name}`);created=true;});
// GitHub runners may take longer than Vitest's 10-second default to close the
// migration pools and drop this separate synthetic database after the full run.
afterAll(async()=>{try{if(candidate)await rm(candidate,{recursive:true,force:true});await db.end();if(created)await admin.query(`DROP DATABASE ${name}`);}finally{await admin.end();}},60_000);
it('preserves the observed 23-migration production baseline through all forward migrations without fabricating legacy details',async()=>{
 const files=(await readdir('db/migrations')).filter(f=>f.endsWith('.sql')).sort(),cutoff='202609090006_member_identity_display.sql';
 const baseline=files.filter(f=>f<=cutoff);expect(baseline).toHaveLength(23);
 await db.query('CREATE TABLE schema_migration(version text PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now())');
 for(const file of baseline){await db.query((await readFile('db/migrations/'+file,'utf8')).split('-- migrate:down')[0]!);await db.query('INSERT INTO schema_migration(version) VALUES($1)',[file]);}
 const member=(await db.query("INSERT INTO member(display_name) VALUES('SYNTHETIC legacy baseline') RETURNING id")).rows[0].id;
 const fact=(await db.query("INSERT INTO qualification_fact(member_id,source,external_ref,occurred_at) VALUES($1,'synthetic','baseline-only',now()) RETURNING id",[member])).rows[0].id;
 const cycle=(await db.query("INSERT INTO care_cycle(member_id,qualification_fact_id,phase,started_on,timezone,protocol_version) VALUES($1,$2,'active','2026-09-01','Asia/Shanghai','legacy-synthetic') RETURNING id",[member,fact])).rows[0].id;
 const record=(await db.query("INSERT INTO care_record(cycle_id,milestone,due_on,completed_at,protocol_version) VALUES($1,'D1','2026-09-01','2026-09-01T01:00:00Z','legacy-synthetic') RETURNING id",[cycle])).rows[0].id;
 const request=(await db.query("INSERT INTO privacy_request(member_id,kind,message) VALUES($1,'access','Synthetic pre-upgrade request') RETURNING id",[member])).rows[0].id;
 await db.query("INSERT INTO consent_acceptance(member_id,document_type,document_version,accepted_at,principal_id) VALUES($1,'privacy','legacy-synthetic-v1',now(),'synthetic-only')",[member]);
 const before=(await db.query('SELECT row_to_json(m) AS member FROM member m WHERE id=$1',[member])).rows[0].member;
 const env={...process.env,DATABASE_URL:url.toString()};
 // A journal failure must roll back the DDL even when legacy SQL carries BEGIN/COMMIT.
 await db.query(`CREATE FUNCTION reject_test_migration_journal() RETURNS trigger LANGUAGE plpgsql AS $$
 BEGIN IF NEW.version='202609100001_care_record_details.sql' THEN RAISE EXCEPTION 'SYNTHETIC_JOURNAL_FAILURE'; END IF; RETURN NEW; END $$;
 CREATE TRIGGER reject_test_journal BEFORE INSERT ON schema_migration FOR EACH ROW EXECUTE FUNCTION reject_test_migration_journal()`);
 await expect(exec('./node_modules/.bin/tsx',['scripts/migrate.ts','up'],{env})).rejects.toThrow();
 expect((await db.query("SELECT to_regclass('public.care_record_step') AS name")).rows[0].name).toBeNull();
 expect((await db.query("SELECT count(*)::int n FROM schema_migration")).rows[0].n).toBe(23);
 // Exercise the shipped migration entry too; this is an explicitly synthetic
 // archive fixture, not a deployable API/Worker or a production approval.
 await mkdir('tmp',{recursive:true});candidate=await mkdtemp(resolve('tmp/cisme-migration-fixture-'));
 await mkdir(resolve(candidate,'db/migrations'),{recursive:true});
 const payloads:Record<string,string>={'index.js':'// synthetic inert fixture','worker.js':'// synthetic inert fixture',
  'worker-once.js':'// synthetic inert fixture','package.json':'{"type":"module"}','package-lock.json':'{}',
  'migrate.mjs':await readFile('scripts/release-migrate.mjs','utf8')};
 for(const file of files)payloads['db/migrations/'+file]=await readFile('db/migrations/'+file,'utf8');
 const hashes:Record<string,string>={};for(const [path,contents] of Object.entries(payloads)){
  await writeFile(resolve(candidate,path),contents);hashes[path]=createHash('sha256').update(contents).digest('hex');
 }
 await writeFile(resolve(candidate,'release-manifest.json'),JSON.stringify({schemaVersion:1,sourceHead:'a'.repeat(40),sourceTree:'b'.repeat(40),migrations:files,hashes}));
 const releaseEnv={...env,CISME_MIGRATION_APPROVAL_REF:'synthetic-owned-failure-rehearsal',CISME_PREDEPLOY_BACKUP_REF:'synthetic-baseline-fixture-only'};
 await expect(exec(process.execPath,[resolve(candidate,'migrate.mjs'),'up'],{env:releaseEnv})).rejects.toThrow();
 expect((await db.query("SELECT to_regclass('public.care_record_step') AS name")).rows[0].name).toBeNull();
 expect((await db.query('SELECT count(*)::int n FROM schema_migration')).rows[0].n).toBe(23);

 await db.query('DROP TRIGGER reject_test_journal ON schema_migration; DROP FUNCTION reject_test_migration_journal()');
 await exec(process.execPath,[resolve(candidate,'migrate.mjs'),'up'],{env:releaseEnv});
 expect((await db.query('SELECT count(*)::int n FROM schema_migration')).rows[0].n).toBe(files.length);
 expect((await db.query('SELECT row_to_json(m) AS member FROM member m WHERE id=$1',[member])).rows[0].member).toMatchObject(before);
 expect((await db.query('SELECT self_assessment FROM care_record WHERE id=$1',[record])).rows[0].self_assessment).toBeNull();
 expect((await db.query('SELECT count(*)::int n FROM care_record_step WHERE record_id=$1',[record])).rows[0].n).toBe(0);
 expect((await db.query('SELECT status,version FROM privacy_request WHERE id=$1',[request])).rows[0]).toEqual({status:'received',version:1});
 expect((await db.query('SELECT document_version FROM consent_acceptance WHERE member_id=$1',[member])).rows[0].document_version).toBe('legacy-synthetic-v1');
 expect((await db.query('SELECT count(*)::int n FROM commerce_order')).rows[0].n).toBe(0);
 await exec('./node_modules/.bin/tsx',['scripts/migrate.ts','up'],{env});
 expect((await db.query('SELECT count(*)::int n FROM schema_migration')).rows[0].n).toBe(files.length);
},90_000);
