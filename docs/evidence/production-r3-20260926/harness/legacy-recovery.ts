import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {loadConfig} from '@cisme/config';
import {createObjectStorage} from '../../services/api/src/storage.js';
const b='/opt/cisme/rehearsals/r3-20260926-1100';
const require=createRequire(b+'/candidate/package.json');const {Pool}=require('pg');
const env=JSON.parse(await readFile(b+'/runtime.json','utf8'));
const admin=new Pool({host:b+'/socket',port:31956,user:'cisme',database:'postgres'});
const url=new URL(env.DATABASE_URL);assert.equal(url.port,'31956');assert.equal(url.pathname,'/cisme_r3_runtime');
const facts:any={productionTouched:false,mainArtifact:false,checks:[]};const record=(name:string,value:any)=>facts.checks.push({name,value});
const pools:any[]=[];let app:any;
function pool(database:string){const u=new URL(url);u.pathname='/'+database;const p=new Pool({connectionString:u.href});pools.push(p);return p;}
async function fingerprint(p:any){const tables=(await p.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows;const rows=[];for(const {tablename:t} of tables){assert(/^[a-z0-9_]+$/.test(t));const r=(await p.query(`SELECT count(*)::int count,md5(coalesce(string_agg(md5(row_to_json(x)::text),'' ORDER BY md5(row_to_json(x)::text)),'')) digest FROM public."${t}" x`)).rows[0];rows.push({table:t,...r})}return rows;}
async function clone(name:string,template:string){assert(['cisme_r3_legacy','cisme_r3_recovery'].includes(name));assert(['cisme_r3_original'].includes(template));await admin.query(`CREATE DATABASE ${name} OWNER r3_runtime TEMPLATE ${template}`);await admin.query(`ALTER DATABASE ${name} SET default_transaction_read_only=off`);}
async function request(path:string,payload?:any,token?:string){const r=await fetch('http://127.0.0.1:31960'+path,{method:payload?'POST':'GET',headers:{...(payload?{'content-type':'application/json'}:{}),...(token?{authorization:'Bearer '+token}:{})},...(payload?{body:JSON.stringify(payload)}:{})});return {status:r.status,body:await r.json() as any};}
try{
 const original=pool('cisme_r3_original');const before=await fingerprint(original);assert.equal((await original.query('SELECT count(*)::int n FROM schema_migration')).rows[0].n,23);await original.end();pools.splice(pools.indexOf(original),1);
 await clone('cisme_r3_legacy','cisme_r3_original');const legacy=pool('cisme_r3_legacy');const ids={member:randomUUID(),qualification:randomUUID(),cycle:randomUUID(),record:randomUUID(),privacy:randomUUID()};
 await legacy.query('BEGIN');
 await legacy.query("INSERT INTO member(id,display_name) VALUES($1,'R3 旧形态合成会员')",[ids.member]);
 await legacy.query("INSERT INTO wechat_identity(member_id,openid,adapter,app_id) VALUES($1,'dev:r3-legacy-shape','dev','dev')",[ids.member]);
 await legacy.query("INSERT INTO qualification_fact(id,member_id,source,external_ref,occurred_at) VALUES($1,$2,'r3_legacy_synthetic','r3-legacy-shape','2026-09-08T00:00:00Z')",[ids.qualification,ids.member]);
 await legacy.query("INSERT INTO care_cycle(id,member_id,qualification_fact_id,phase,started_on,timezone,protocol_version) VALUES($1,$2,$3,'active','2026-09-08','Asia/Shanghai','r3-legacy')",[ids.cycle,ids.member,ids.qualification]);
 await legacy.query("INSERT INTO care_record(id,cycle_id,milestone,due_on,completed_at,protocol_version) VALUES($1,$2,'D1','2026-09-08','2026-09-08T01:00:00Z','r3-legacy')",[ids.record,ids.cycle]);
 await legacy.query("INSERT INTO privacy_request(id,member_id,kind,message,status,response,responded_by) VALUES($1,$2,'access','R3 旧版资料查阅','responded','旧版答复保留','r3-legacy-operator')",[ids.privacy,ids.member]);await legacy.query('COMMIT');
 const legacyUrl=new URL(url);legacyUrl.pathname='/cisme_r3_legacy';const legacyEnv={...env,DATABASE_URL:legacyUrl.href,PORT:'31960'};
 const migrate=execFileSync('/opt/node-v24.14.0-linux-x64/bin/node',[b+'/candidate/migrate.mjs','up'],{env:legacyEnv,encoding:'utf8'});await writeFile(b+'/logs/legacy-migrate.log',migrate,{mode:0o600});assert.equal((await legacy.query('SELECT count(*)::int n FROM schema_migration')).rows[0].n,95);
 Object.assign(process.env,legacyEnv);const config=loadConfig(legacyEnv);const {createApp}=await import(b+'/candidate/index.js');app=await createApp({config,pool:legacy,storage:createObjectStorage(config)});await app.listen({port:31960,host:'127.0.0.1'});
 const identity=await request('/v1/identity/dev',{externalUserId:'r3-legacy-shape',displayName:'R3 旧形态合成会员',consents:[{documentType:'privacy',version:'r3-synthetic'},{documentType:'terms',version:'r3-synthetic'}]});assert.equal(identity.status,200);assert.equal(identity.body.memberId,ids.member);
 const care=await request('/v1/me/care',undefined,identity.body.sessionToken);assert.equal(care.status,200);const careText=JSON.stringify(care.body);assert(careText.includes('r3-legacy'));assert(careText.includes('"selfAssessment":null'));assert(careText.includes('"stepCodes":[]'));
 const privacy=await request('/v1/me/privacy-requests',undefined,identity.body.sessionToken);assert.equal(privacy.status,200);assert(JSON.stringify(privacy.body).includes('旧版答复保留'));
 record('legacyDataReadback',{ids,care:care.body,privacy:privacy.body,migrations:95,missingStepsInvented:false});await app.close();app=null;
 await clone('cisme_r3_recovery','cisme_r3_original');const restored=pool('cisme_r3_recovery');assert.deepEqual(await fingerprint(restored),before);record('beforeNewWritesProtectionPoint',{tables:before.length,digest:createHash('sha256').update(JSON.stringify(before)).digest('hex'),matchedAllRows:true,source:'preserved R2 real backup copy, all 23-migration public tables',newWritesAllowed:false});
 // Exercise a real dump/restore of the upgraded database after new business facts.
 const dump=b+'/runtime-protection-point.dump',pgEnv={...env,PGPASSWORD:url.password};
 execFileSync('/usr/lib/postgresql/16/bin/pg_dump',['-h','127.0.0.1','-p','31956','-U','r3_runtime','-d','cisme_r3_runtime','-Fc','-f',dump],{env:pgEnv});
 await admin.query('CREATE DATABASE cisme_r3_forward_restore OWNER r3_runtime TEMPLATE template0');
 execFileSync('/usr/lib/postgresql/16/bin/pg_restore',['-h','127.0.0.1','-p','31956','-U','r3_runtime','--no-owner','--no-acl','--exit-on-error','--single-transaction','-d','cisme_r3_forward_restore',dump],{env:pgEnv});
 const runtime=pool('cisme_r3_runtime'),forward=pool('cisme_r3_forward_restore');const runtimePrint=await fingerprint(runtime);assert.deepEqual(await fingerprint(forward),runtimePrint);record('afterNewWritesProtectionPoint',{tables:runtimePrint.length,digest:createHash('sha256').update(JSON.stringify(runtimePrint)).digest('hex'),dumpSha256:createHash('sha256').update(await readFile(dump)).digest('hex'),allRowsPreserved:true,oldBackupAppliedToNewFacts:false});
 const untouched=pool('cisme_r3_original');assert.deepEqual(await fingerprint(untouched),before);record('originalCopyUnchanged',true);facts.ok=true;
}catch(e:any){facts.ok=false;facts.error={message:e.message,code:e.code};process.exitCode=1}finally{if(app)await app.close();for(const p of pools)await p.end();await admin.end();await writeFile(b+'/legacy-recovery-result.json',JSON.stringify(facts,null,2)+'\n',{mode:0o600});console.log(JSON.stringify({ok:facts.ok,checks:facts.checks.map((x:any)=>x.name),error:facts.error}));}
