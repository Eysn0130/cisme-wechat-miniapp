import { execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { promisify } from 'node:util';
import pg from 'pg';
import { mkdtemp, writeFile, readFile, lstat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const execute = promisify(execFile);
// Image downloads/control calls must not hang an unattended acceptance run.
const exec = (file,args,options={}) => execute(file,args,{timeout:120_000,...options});
const command = process.argv.slice(2);
if (!command.length) throw new Error('Usage: node scripts/disposable-test.mjs COMMAND [ARG...]');
if (process.env.CISME_TEST_RUN_ID) throw new Error('NESTED_DISPOSABLE_RUN_REFUSED');
const postgresImage=process.env.CISME_TEST_POSTGRES_IMAGE??'postgres:18.4-alpine';
if(!['postgres:18.4-alpine','postgres:16.15-alpine'].includes(postgresImage))
  throw new Error('DISPOSABLE_POSTGRES_IMAGE_NOT_REVIEWED');
const runId = randomBytes(12).toString('hex');
const token = randomBytes(32).toString('hex');
const role = `runner_${runId}`, database = `cisme_test_${runId}`;
const name = `cisme-synthetic-${runId}`;
const password = randomBytes(32).toString('hex');
let id, s3Id, pool, child, objectRoot;
let stopped = false;
const stop = () => { stopped = true; child?.kill('SIGTERM'); };
process.once('SIGINT', stop); process.once('SIGTERM', stop);
try {
  // Never reuse a container, volume, role, port or database from another run.
  const created = await exec('docker', ['run', '--detach', '--name', name,
    '--label', `cisme.synthetic.run=${runId}`, '--label', 'cisme.synthetic.purpose=disposable',
    '--publish', '127.0.0.1::5432', '--env', 'POSTGRES_USER', '--env', 'POSTGRES_DB',
    '--env', 'POSTGRES_PASSWORD', postgresImage],
    { env: { ...process.env, POSTGRES_USER: role, POSTGRES_DB: database, POSTGRES_PASSWORD: password } });
  id = created.stdout.trim();
  const inspect = JSON.parse((await exec('docker', ['inspect', id])).stdout)[0];
  if (inspect.Config.Labels['cisme.synthetic.run'] !== runId || inspect.Name !== `/${name}`)
    throw new Error('CONTAINER_OWNERSHIP_MISMATCH');
  const binding = inspect.NetworkSettings.Ports['5432/tcp'];
  if (binding?.length !== 1 || binding[0].HostIp !== '127.0.0.1' || binding[0].HostPort === '55432')
    throw new Error('DISPOSABLE_PORT_MISMATCH');
  const url = `postgres://${role}:${password}@127.0.0.1:${binding[0].HostPort}/${database}`;
  pool = new pg.Pool({ connectionString: url, max: 1, connectionTimeoutMillis: 1000 });
  let ready = false;
  for (let attempt = 0; attempt < 60 && !stopped; attempt++) {
    try { await pool.query('SELECT 1'); ready = true; break; }
    catch { await new Promise(resolve => setTimeout(resolve, 500)); }
  }
  if (!ready || stopped) throw new Error('DISPOSABLE_INSTANCE_NOT_READY');
  await pool.query(`CREATE SCHEMA cisme_test_control;
    REVOKE ALL ON SCHEMA cisme_test_control FROM PUBLIC;
    CREATE TABLE cisme_test_control.ownership (
      run_id text, token text, purpose text, reset_authorized boolean,
      instance_started_at timestamptz, server_address text, server_port int)`);
  await pool.query(`INSERT INTO cisme_test_control.ownership
    VALUES ($1,$2,'disposable-synthetic',true,pg_postmaster_start_time(),inet_server_addr()::text,inet_server_port())`, [runId, token]);
  objectRoot=await mkdtemp(join(tmpdir(),`cisme-objects-${runId}-`));
  await writeFile(join(objectRoot,".ownership.json"),JSON.stringify({runId,container:id}),{mode:0o600});
  const s3Access=randomBytes(16).toString('hex'),s3Secret=randomBytes(32).toString('hex');
  const s3Config=join(objectRoot,'s3.json');
  await writeFile(s3Config,JSON.stringify({identities:[{name:`synthetic-${runId}`,
    credentials:[{accessKey:s3Access,secretKey:s3Secret}],actions:['Admin','Read','Write','List','Tagging']}]}),{mode:0o644});
  s3Id=(await exec('docker',['create','--name',`cisme-synthetic-s3-${runId}`,
    '--label',`cisme.synthetic.run=${runId}`,'--label','cisme.synthetic.purpose=disposable',
    '--publish','127.0.0.1::8333','--tmpfs','/data:rw,size=256m',
    'chrislusf/seaweedfs:4.29','server','-dir=/data','-master.volumeSizeLimitMB=8','-volume.max=8','-ip=127.0.0.1','-filer=true','-s3.ip.bind=0.0.0.0','-s3=true','-s3.config=/etc/s3.json','-s3.iam=false'])).stdout.trim();
  await exec('docker',['cp',s3Config,`${s3Id}:/etc/s3.json`]);
  await exec('docker',['start',s3Id]);
  const s3Inspect=JSON.parse((await exec('docker',['inspect',s3Id])).stdout)[0];
  const s3Binding=s3Inspect.NetworkSettings.Ports['8333/tcp'];
  if(s3Inspect.Config.Labels['cisme.synthetic.run']!==runId||s3Binding?.length!==1||
    s3Binding[0].HostIp!=='127.0.0.1'||s3Binding[0].HostPort==='58333')throw new Error('S3_OWNERSHIP_MISMATCH');
  const s3Endpoint=`http://127.0.0.1:${s3Binding[0].HostPort}`;
  let s3Ready=false;
  for(let attempt=0;attempt<60&&!stopped;attempt++){
    try{const response=await fetch(s3Endpoint,{signal:AbortSignal.timeout(1000)});await response.body?.cancel();s3Ready=true;break;}
    catch{await new Promise(resolve=>setTimeout(resolve,500));}
  }
  if(!s3Ready||stopped){
    const logs=await exec('docker',['logs','--tail','12',s3Id]);
    const safe=(logs.stdout+logs.stderr).replaceAll(s3Access,'[redacted]').replaceAll(s3Secret,'[redacted]');
    console.error(safe.slice(-3000));throw new Error('S3_INSTANCE_NOT_READY');
  }
  console.log(JSON.stringify({event:'synthetic-object-target-created',runId,container:s3Id,endpoint:s3Endpoint}));
  const env = { ...process.env, TEST_DATABASE_URL: url, DATABASE_URL: url,
    CISME_TEST_CONTAINER_ID:id,CISME_TEST_OBJECT_ROOT:objectRoot,
    CISME_TEST_S3_CONTAINER_ID:s3Id,CISME_TEST_S3_ENDPOINT:s3Endpoint,CISME_TEST_S3_BUCKET:`cisme-${runId}`,
    CISME_TEST_S3_ACCESS_KEY:s3Access,CISME_TEST_S3_SECRET:s3Secret,
    CISME_TEST_RUN_ID: runId, CISME_TEST_RESET_TOKEN: token, CISME_TEST_OWNED_URL: url,
    CISME_TEST_RESET_AUTHORIZED: 'disposable-only' };
  console.log(JSON.stringify({ event: 'synthetic-target-created', runId, container: id,postgresImage,imageId:inspect.Image,
    host: '127.0.0.1', port: binding[0].HostPort, database, role, purpose: 'disposable-synthetic' }));
  await pool.end(); pool = undefined;
  if (stopped) throw new Error('DISPOSABLE_RUN_CANCELLED');
  child = spawn(command[0], command.slice(1), { env, stdio: 'inherit' });
  process.exitCode = await new Promise((resolve, reject) => {
    child.once('error', reject); child.once('exit', (code) => resolve(code ?? 1));
  });

} finally {
  if (pool) await pool.end();
  if(s3Id){
    const owned=JSON.parse((await exec('docker',['inspect',s3Id])).stdout)[0];
    if(owned.Id!==s3Id||owned.Config.Labels['cisme.synthetic.run']!==runId||owned.Name!==`/cisme-synthetic-s3-${runId}`)
      throw new Error('S3_CLEANUP_OWNERSHIP_MISMATCH');
    await exec('docker',['rm','--force','--volumes',s3Id]);
    console.log(JSON.stringify({event:'synthetic-object-target-removed',runId,container:s3Id}));
  }
  if(objectRoot){
    const marker=JSON.parse(await readFile(join(objectRoot,".ownership.json"),"utf8"));
    if((await lstat(objectRoot)).isSymbolicLink()||marker.runId!==runId||marker.container!==id)
      throw new Error("OBJECT_CLEANUP_OWNERSHIP_MISMATCH");
    await rm(objectRoot,{recursive:true});
  }
  if (id) {
    const owned = JSON.parse((await exec('docker', ['inspect', id])).stdout)[0];
    if (owned.Id !== id || owned.Config.Labels['cisme.synthetic.run'] !== runId || owned.Name !== `/${name}`)
      throw new Error('CLEANUP_OWNERSHIP_MISMATCH');
    await exec('docker', ['rm', '--force', '--volumes', id]);
    console.log(JSON.stringify({ event: 'synthetic-target-removed', runId, container: id }));
  }
}
