import { execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { promisify } from 'node:util';
import pg from 'pg';

const exec = promisify(execFile);
const command = process.argv.slice(2);
if (!command.length) throw new Error('Usage: node scripts/disposable-test.mjs COMMAND [ARG...]');
if (process.env.CISME_TEST_RUN_ID) throw new Error('NESTED_DISPOSABLE_RUN_REFUSED');
const runId = randomBytes(12).toString('hex');
const token = randomBytes(32).toString('hex');
const role = `runner_${runId}`, database = `cisme_test_${runId}`;
const name = `cisme-synthetic-${runId}`;
const password = randomBytes(32).toString('hex');
let id, pool, child;
let stopped = false;
const stop = () => { stopped = true; child?.kill('SIGTERM'); };
process.once('SIGINT', stop); process.once('SIGTERM', stop);
try {
  // Never reuse a container, volume, role, port or database from another run.
  const created = await exec('docker', ['run', '--detach', '--name', name,
    '--label', `cisme.synthetic.run=${runId}`, '--label', 'cisme.synthetic.purpose=disposable',
    '--publish', '127.0.0.1::5432', '--env', 'POSTGRES_USER', '--env', 'POSTGRES_DB',
    '--env', 'POSTGRES_PASSWORD', 'postgres:18.4-alpine'],
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
  const env = { ...process.env, TEST_DATABASE_URL: url, DATABASE_URL: url,
    CISME_TEST_RUN_ID: runId, CISME_TEST_RESET_TOKEN: token, CISME_TEST_OWNED_URL: url,
    CISME_TEST_RESET_AUTHORIZED: 'disposable-only' };
  console.log(JSON.stringify({ event: 'synthetic-target-created', runId, container: id,
    host: '127.0.0.1', port: binding[0].HostPort, database, role, purpose: 'disposable-synthetic' }));
  await pool.end(); pool = undefined;
  if (stopped) throw new Error('DISPOSABLE_RUN_CANCELLED');
  child = spawn(command[0], command.slice(1), { env, stdio: 'inherit' });
  process.exitCode = await new Promise((resolve, reject) => {
    child.once('error', reject); child.once('exit', (code) => resolve(code ?? 1));
  });
} finally {
  if (pool) await pool.end();
  if (id) {
    const owned = JSON.parse((await exec('docker', ['inspect', id])).stdout)[0];
    if (owned.Id !== id || owned.Config.Labels['cisme.synthetic.run'] !== runId || owned.Name !== `/${name}`)
      throw new Error('CLEANUP_OWNERSHIP_MISMATCH');
    await exec('docker', ['rm', '--force', '--volumes', id]);
    console.log(JSON.stringify({ event: 'synthetic-target-removed', runId, container: id }));
  }
}
