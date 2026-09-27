import {randomBytes,createHmac,createHash,pbkdf2Sync} from 'node:crypto';
import pg from 'pg';
import {it,expect} from 'vitest';
import {TEST_DATABASE_URL,testPool,assertDisposableTarget} from '@cisme/testkit';

// Rehearsal only. Every role/database lives inside the wrapper-owned disposable
// PostgreSQL container. No production connection or production password enters.
function verifier(password:string){
 const salt=randomBytes(16),iterations=4096,salted=pbkdf2Sync(password,salt,iterations,32,'sha256');
 const client=createHmac('sha256',salted).update('Client Key').digest();
 const stored=createHash('sha256').update(client).digest('base64');
 const server=createHmac('sha256',salted).update('Server Key').digest('base64');
 return `SCRAM-SHA-256$${iterations}:${salt.toString('base64')}$${stored}:${server}`;
}
it('drains both clients, rejects the old credential on fresh connections, and recovers forward without losing new writes',async()=>{
 const ownership=testPool();try{await assertDisposableTarget(ownership);}finally{await ownership.end();}
 const url=new URL(TEST_DATABASE_URL);url.pathname='/postgres';const admin=new pg.Client({connectionString:url.toString()});await admin.connect();
 const suffix=randomBytes(8).toString('hex'),role='cisme_rotation_'+suffix,database='cisme_rotation_'+suffix;
 const oldPassword=randomBytes(32).toString('base64url'),newPassword=randomBytes(32).toString('base64url');
 let roleCreated=false,dbCreated=false;const clients:pg.Client[]=[];
 function connection(password:string,application_name:string){const client=new pg.Client({host:url.hostname,port:Number(url.port),database,user:role,password,application_name,connectionTimeoutMillis:2000,ssl:false});clients.push(client);return client;}
 try{
  await admin.query(`CREATE ROLE ${role} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${verifier(oldPassword)}'`);roleCreated=true;
  await admin.query(`CREATE DATABASE ${database} OWNER ${role}`);dbCreated=true;
  const api=connection(oldPassword,'synthetic-api'),worker=connection(oldPassword,'synthetic-worker');await api.connect();await worker.connect();
  await api.query('CREATE TABLE synthetic_business_fact(id integer PRIMARY KEY,value text NOT NULL)');
  await api.query("INSERT INTO synthetic_business_fact VALUES(1,'before rotation')");
  await admin.query(`ALTER ROLE ${role} PASSWORD '${verifier(newPassword)}'`);
  // PostgreSQL password rotation does not kill already-authenticated sessions.
  // A safe operational plan must drain/restart API and Worker pools explicitly.
  expect((await worker.query('SELECT count(*)::int n FROM synthetic_business_fact')).rows[0].n).toBe(1);
  await Promise.all([api.end(),worker.end()]);
  const stale=connection(oldPassword,'synthetic-old-credential');await expect(stale.connect()).rejects.toMatchObject({code:'28P01'});
  const freshApi=connection(newPassword,'synthetic-api-new'),freshWorker=connection(newPassword,'synthetic-worker-new');await freshApi.connect();await freshWorker.connect();
  await freshApi.query("INSERT INTO synthetic_business_fact VALUES(2,'after rotation')");
  expect((await freshWorker.query('SELECT count(*)::int n FROM synthetic_business_fact')).rows[0].n).toBe(2);
  // Config/startup failure: keep the rotated credential and recover forward.
  const broken=connection(randomBytes(32).toString('base64url'),'synthetic-bad-config');await expect(broken.connect()).rejects.toMatchObject({code:'28P01'});
  const recovered=connection(newPassword,'synthetic-forward-repair');await recovered.connect();
  expect((await recovered.query('SELECT id FROM synthetic_business_fact ORDER BY id')).rows).toEqual([{id:1},{id:2}]);
  const privilege=(await admin.query('SELECT rolsuper,rolcreaterole,rolcreatedb,rolreplication,rolbypassrls FROM pg_roles WHERE rolname=$1',[role])).rows[0];
  expect(privilege).toEqual({rolsuper:false,rolcreaterole:false,rolcreatedb:false,rolreplication:false,rolbypassrls:false});
 }finally{
  await Promise.allSettled(clients.map(client=>client.end()));
  if(dbCreated)await admin.query(`DROP DATABASE ${database}`);
  if(roleCreated)await admin.query(`DROP ROLE ${role}`);
  await admin.end();
 }
},30000);
