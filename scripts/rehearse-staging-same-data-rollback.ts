/** Offline same-data rollback probe. Run only through scripts/disposable-test.mjs.
 * It exercises the exact old compiled API against a new-schema synthetic DB.
 */
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadConfig } from '@cisme/config';
import { assertDisposableTarget, resolveTestDatabaseUrl, testPool } from '@cisme/testkit';
import { createApiGatewayStorage } from '../services/api/src/storage';

const OLD_HEAD = '43885ba9982f63dd3bd02ee7cc0df112a256cc78';
const OLD_TREE = 'ae83c8f17c33c42f247b3883069cc1027ca27e87';
const OLD_MANIFEST_SHA = 'aa642653c2fdff99bc4d95db4c0e6cfcbb3012c051e610b845c52db0f393a99e';
const OLD_INDEX_SHA = '58c3a0c7eb08e9d656907ca45253614b9826d09d593626ffdb7265dfeea5c64d';
const oldDirectory = resolve('dist/tencent-release-43885ba9982f');
const candidateDirectory = resolve(process.argv[2] ?? '');
const expectedHead = process.argv[3] ?? '';
const expectedTree = process.argv[4] ?? '';
const expectedManifestSha = process.argv[5] ?? '';
if (!/^dist\/tencent-release-[a-f0-9]{12}$/.test(process.argv[2] ?? '') ||
    !/^[a-f0-9]{40}$/.test(expectedHead ?? '') || !/^[a-f0-9]{40}$/.test(expectedTree ?? '') ||
    !/^[a-f0-9]{64}$/.test(expectedManifestSha ?? '') ||
    candidateDirectory !== resolve(`dist/tencent-release-${expectedHead.slice(0, 12)}`)) {
  throw new Error('EXACT_CANDIDATE_ARGUMENTS_REQUIRED');
}
if (!process.env.CISME_TEST_RUN_ID) throw new Error('DISPOSABLE_RUN_REQUIRED');
function requiredSyntheticEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`DISPOSABLE_${name}_REQUIRED`);
  return value;
}
// Never inherit a caller's COS, payment, notification, callback or provider
// settings into a compiled old worker/server. Only ownership markers from the
// disposable runner and explicit inert application values reach the child.
const childBaseEnv = {
  PATH: requiredSyntheticEnv('PATH'),
  CISME_TEST_RUN_ID: requiredSyntheticEnv('CISME_TEST_RUN_ID'),
  CISME_TEST_CONTAINER_ID: requiredSyntheticEnv('CISME_TEST_CONTAINER_ID'),
  CISME_TEST_OBJECT_ROOT: requiredSyntheticEnv('CISME_TEST_OBJECT_ROOT'),
  CISME_TEST_OWNED_URL: requiredSyntheticEnv('CISME_TEST_OWNED_URL')
};
const sha = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');
type Manifest = { sourceHead: string; sourceTree: string; migrations: string[]; hashes: Record<string, string> };
async function checkedManifest(directory: string, expectedSha: string): Promise<Manifest> {
  const raw = await readFile(resolve(directory, 'release-manifest.json'));
  if (sha(raw) !== expectedSha) throw new Error('EXACT_RELEASE_MANIFEST_REQUIRED');
  const manifest = JSON.parse(raw.toString('utf8')) as Manifest;
  for (const [name, digest] of Object.entries(manifest.hashes)) {
    if (name.startsWith('/') || name.split('/').includes('..') || sha(await readFile(resolve(directory, name))) !== digest)
      throw new Error('COMPILED_ARTIFACT_DRIFT');
  }
  return manifest;
}
const oldManifest = await checkedManifest(oldDirectory, OLD_MANIFEST_SHA);
const nextManifest = await checkedManifest(candidateDirectory, expectedManifestSha);
if (oldManifest.sourceHead !== OLD_HEAD || oldManifest.sourceTree !== OLD_TREE ||
    oldManifest.hashes['index.js'] !== OLD_INDEX_SHA || oldManifest.migrations.length !== 76)
  throw new Error('EXACT_PREVIOUS_STAGING_ARTIFACT_REQUIRED');
if (nextManifest.sourceHead !== expectedHead || nextManifest.sourceTree !== expectedTree ||
    nextManifest.migrations.length !== 94 ||
    JSON.stringify(nextManifest.migrations.slice(0, 76)) !== JSON.stringify(oldManifest.migrations) ||
    oldManifest.migrations.some(name => oldManifest.hashes[`db/migrations/${name}`] !== nextManifest.hashes[`db/migrations/${name}`]))
  throw new Error('COMPATIBLE_FORWARD_MIGRATION_PREFIX_REQUIRED');

const pool = testPool();
const client = await pool.connect();
try {
  await assertDisposableTarget(client);
  if ((await client.query("SELECT 1 FROM information_schema.tables WHERE table_schema='public'")).rowCount)
    throw new Error('FRESH_EMPTY_SYNTHETIC_DATABASE_REQUIRED');
} finally { client.release(); }
const databaseUrl = resolveTestDatabaseUrl();
if (databaseUrl !== childBaseEnv.CISME_TEST_OWNED_URL) throw new Error('DISPOSABLE_DATABASE_IDENTITY_MISMATCH');
const secret = randomBytes(32).toString('hex');
const uploadSecret = randomBytes(32).toString('hex');
const config = loadConfig({ APP_ENV: 'test', DATABASE_URL: databaseUrl, APP_SESSION_SECRET: secret,
  UPLOAD_TOKEN_SECRET: uploadSecret, OBJECT_STORAGE_DRIVER: 'api_gateway' });
const storage = createApiGatewayStorage(config);
await storage.ensureReady();
function migrate(directory: string): number {
  const result = spawnSync(process.execPath, [resolve(directory, 'migrate.mjs'), 'up'], {
    cwd: directory, encoding: 'utf8', env: { PATH: process.env.PATH, DATABASE_URL: databaseUrl,
      CISME_MIGRATION_APPROVAL_REF: `synthetic-only:${process.env.CISME_TEST_RUN_ID}`,
      CISME_PREDEPLOY_BACKUP_REF: 'synthetic-empty-target-no-existing-data' } });
  if (result.status !== 0) throw new Error('SYNTHETIC_FORWARD_MIGRATION_FAILED');
  return result.stdout.trim().split('\n').filter(Boolean).length;
}
async function appFor(directory: string) {
  const bundle = await import(pathToFileURL(resolve(directory, 'index.js')).href);
  return bundle.createApp({ config, pool, storage });
}
function requireStatus(response: { statusCode: number; body: string }, expected: number, label: string) {
  if (response.statusCode !== expected) throw new Error(`${label}:${response.statusCode}:${response.body.slice(0, 180)}`);
}
let oldApplied = 0, forwardApplied = 0, repeatedApplied = 0;
let previousReadNew = false, candidateReadOld = false, candidateReadRollbackWrite = false;
let oldHealthyOnNewSchema = false, sameObjectReadable = false, oldWorkerCompleted = false;
let oldStagingWorkerCompleted = false, oldStagingServerReadNew = false;
async function openLoopbackPort(): Promise<number> {
  const socket = createServer();
  await new Promise<void>((done, fail) => socket.once('error', fail).listen(0, '127.0.0.1', done));
  const address = socket.address();
  if (!address || typeof address === 'string') throw new Error('LOOPBACK_PORT_REQUIRED');
  await new Promise<void>((done, fail) => socket.close(error => error ? fail(error) : done()));
  return address.port;
}
try {
  oldApplied = migrate(oldDirectory);
  if (oldApplied !== 76) throw new Error('OLD_MIGRATION_COUNT_MISMATCH');
  let oldApp = await appFor(oldDirectory);
  const login = await oldApp.inject({ method: 'POST', url: '/v1/identity/dev', payload: {
    externalUserId: `rollback-${process.env.CISME_TEST_RUN_ID}`, displayName: 'Synthetic rollback owner',
    consents: [{ documentType: 'privacy', version: 'test' }, { documentType: 'terms', version: 'test' }] } });
  requireStatus(login, 200, 'OLD_IDENTITY_FAILED');
  const auth = { authorization: `Bearer ${login.json().sessionToken}` };
  const { memberId, principalId } = login.json();
  const baseline = await oldApp.inject({ method: 'POST', url: '/v1/me/privacy-requests', headers: auth,
    payload: { kind: 'other', message: 'Synthetic before upgrade' } });
  requireStatus(baseline, 200, 'OLD_BASELINE_WRITE_FAILED');
  const baselineId = baseline.json().id;
  await oldApp.close();

  forwardApplied = migrate(candidateDirectory);
  repeatedApplied = migrate(candidateDirectory);
  if (forwardApplied !== 18 || repeatedApplied !== 0) throw new Error('FORWARD_MIGRATION_COUNT_MISMATCH');
  let nextApp = await appFor(candidateDirectory);
  const prior = await nextApp.inject({ url: '/v1/me/privacy-requests', headers: auth });
  requireStatus(prior, 200, 'CANDIDATE_OLD_READ_FAILED');
  candidateReadOld = prior.body.includes(baselineId);
  if (!candidateReadOld) throw new Error('CANDIDATE_LOST_OLD_WRITE');
  const newWrite = await nextApp.inject({ method: 'POST', url: '/v1/me/privacy-requests', headers: auth,
    payload: { kind: 'other', message: 'Synthetic after upgrade before rollback' } });
  requireStatus(newWrite, 200, 'CANDIDATE_NEW_WRITE_FAILED');
  const newId = newWrite.json().id;
  const objectKey = `ugc-derived/rollback-${process.env.CISME_TEST_RUN_ID}.webp`;
  const image = Buffer.from('524946460400000057454250', 'hex');
  await storage.writeDerivedImage(objectKey, image);
  const imageSha = sha(image);
  await nextApp.close();

  const oldWorker = spawnSync(process.execPath, [resolve(oldDirectory, 'worker-once.js')], {
    cwd: oldDirectory, encoding: 'utf8', timeout: 30_000,
    env: { ...childBaseEnv, APP_ENV: 'test', DATABASE_URL: databaseUrl,
      APP_SESSION_SECRET: secret, UPLOAD_TOKEN_SECRET: uploadSecret,
      OBJECT_STORAGE_DRIVER: 'api_gateway', OBJECT_STORAGE_PROFILE: 'synthetic-rollback',
      COMMERCE_ORDER_FLOW_ENABLED: 'false', COMMERCE_FULFILLMENT_ENABLED: 'false',
      UGC_GO_LIVE_GATE: 'false', POINTS_REDEMPTION_ENABLED: 'false',
      POINTS_RULES_ENABLED: 'false', COS_DIRECT_UPLOAD_ENABLED: 'false',
      WECHAT_PHONE_BINDING_ENABLED: 'false', RUN_BACKGROUND_WORKER: 'false' } });
  if (oldWorker.status !== 0) throw new Error(`OLD_WORKER_ON_NEW_SCHEMA_FAILED:${oldWorker.stderr?.slice(-180)}`);
  JSON.parse(oldWorker.stdout.trim());
  oldWorkerCompleted = true;
  const stagingWorker = spawnSync(process.execPath, [resolve(oldDirectory, 'worker-once.js')], {
    cwd: oldDirectory, encoding: 'utf8', timeout: 30_000,
    env: { ...childBaseEnv, APP_ENV: 'staging', DATABASE_URL: databaseUrl,
      APP_SESSION_SECRET: secret, UPLOAD_TOKEN_SECRET: uploadSecret,
      WECHAT_APP_ID: 'wx4eac2d4fb11d299b', WECHAT_APP_SECRET: 'synthetic-offline-only',
      OBJECT_STORAGE_DRIVER: 'api_gateway', OBJECT_STORAGE_PROFILE: 'synthetic-rollback',
      COMMERCE_ORDER_FLOW_ENABLED: 'false', COMMERCE_FULFILLMENT_ENABLED: 'false',
      ALLOW_DEV_ADAPTERS: 'false', UGC_GO_LIVE_GATE: 'false',
      POINTS_REDEMPTION_ENABLED: 'false', POINTS_RULES_ENABLED: 'false',
      COS_DIRECT_UPLOAD_ENABLED: 'false', WECHAT_PHONE_BINDING_ENABLED: 'false',
      RUN_BACKGROUND_WORKER: 'false' } });
  if (stagingWorker.status !== 0) throw new Error(`OLD_STAGING_WORKER_ON_NEW_SCHEMA_FAILED:${stagingWorker.stderr?.slice(-180)}`);
  JSON.parse(stagingWorker.stdout.trim());
  oldStagingWorkerCompleted = true;

  // Run the old compiled entrypoint as a loopback staging server. This path
  // loads its own bundled config and storage adapter, unlike createApp above.
  const port = await openLoopbackPort();
  const oldServer = spawn(process.execPath, [resolve(oldDirectory, 'index.js')], {
    cwd: oldDirectory, stdio: 'ignore',
    env: { ...childBaseEnv, APP_ENV: 'staging', DATABASE_URL: databaseUrl,
      APP_SESSION_SECRET: secret, UPLOAD_TOKEN_SECRET: uploadSecret,
      WECHAT_APP_ID: 'wx4eac2d4fb11d299b', WECHAT_APP_SECRET: 'synthetic-offline-only',
      OBJECT_STORAGE_DRIVER: 'api_gateway', OBJECT_STORAGE_PROFILE: 'synthetic-rollback',
      API_LISTEN_HOST: '127.0.0.1', PORT: String(port), RUN_BACKGROUND_WORKER: 'false',
      COMMERCE_ORDER_FLOW_ENABLED: 'false', COMMERCE_FULFILLMENT_ENABLED: 'false',
      ALLOW_DEV_ADAPTERS: 'false', UGC_GO_LIVE_GATE: 'false',
      POINTS_REDEMPTION_ENABLED: 'false', POINTS_RULES_ENABLED: 'false',
      COS_DIRECT_UPLOAD_ENABLED: 'false', WECHAT_PHONE_BINDING_ENABLED: 'false' } });
  try {
    let ready = false;
    for (let n = 0; n < 30; n++) {
      if (oldServer.exitCode !== null) throw new Error('OLD_STAGING_SERVER_EXITED');
      try { ready = (await fetch(`http://127.0.0.1:${port}/health/ready`)).status === 200; }
      catch { /* the child may still be starting */ }
      if (ready) break;
      await new Promise(done => setTimeout(done, 100));
    }
    if (!ready) throw new Error('OLD_STAGING_SERVER_NOT_READY');
    const encoded = Buffer.from(JSON.stringify({ memberId, principalId, adapter: 'wechat',
      provider: 'wechat_miniprogram', appId: 'wx4eac2d4fb11d299b', expiresAt: Date.now() + 300_000 })).toString('base64url');
    const token = `${encoded}.${createHmac('sha256', secret).update(encoded).digest('base64url')}`;
    const response = await fetch(`http://127.0.0.1:${port}/v1/me/privacy-requests`,
      { headers: { authorization: `Bearer ${token}` } });
    oldStagingServerReadNew = response.status === 200 && (await response.text()).includes(newId);
    if (!oldStagingServerReadNew) throw new Error(`OLD_STAGING_SERVER_CANNOT_READ_NEW_WRITE:${response.status}`);
  } finally {
    oldServer.kill('SIGTERM');
    await Promise.race([
      new Promise<void>(done => oldServer.once('exit', () => done())),
      new Promise<void>(done => setTimeout(() => { oldServer.kill('SIGKILL'); done(); }, 3_000))
    ]);
  }

  oldApp = await appFor(oldDirectory);
  const ready = await oldApp.inject({ url: '/health/ready' });
  requireStatus(ready, 200, 'OLD_HEALTH_ON_NEW_SCHEMA_FAILED');
  oldHealthyOnNewSchema = true;
  const rolled = await oldApp.inject({ url: '/v1/me/privacy-requests', headers: auth });
  requireStatus(rolled, 200, 'OLD_NEW_WRITE_READ_FAILED');
  previousReadNew = rolled.body.includes(newId) && rolled.body.includes(baselineId);
  if (!previousReadNew) throw new Error('OLD_APP_CANNOT_READ_POST_UPGRADE_WRITE');
  sameObjectReadable = sha((await storage.read(objectKey)).bytes) === imageSha;
  if (!sameObjectReadable) throw new Error('OBJECT_CHANGED_DURING_APPLICATION_ROLLBACK');
  const rollbackWrite = await oldApp.inject({ method: 'POST', url: '/v1/me/privacy-requests', headers: auth,
    payload: { kind: 'other', message: 'Synthetic during old application rollback' } });
  requireStatus(rollbackWrite, 200, 'OLD_WRITE_ON_NEW_SCHEMA_FAILED');
  const rollbackId = rollbackWrite.json().id;
  await oldApp.close();

  nextApp = await appFor(candidateDirectory);
  const restored = await nextApp.inject({ url: '/v1/me/privacy-requests', headers: auth });
  requireStatus(restored, 200, 'CANDIDATE_RESTORE_READ_FAILED');
  candidateReadRollbackWrite = restored.body.includes(rollbackId) && restored.body.includes(newId) && restored.body.includes(baselineId);
  await nextApp.close();
  if (!candidateReadRollbackWrite) throw new Error('CANDIDATE_CANNOT_READ_ROLLBACK_WRITE');
  const versions = (await pool.query('SELECT version FROM schema_migration ORDER BY version')).rows.map(row => row.version);
  if (JSON.stringify(versions) !== JSON.stringify(nextManifest.migrations)) throw new Error('SAME_SCHEMA_HISTORY_CHANGED');
  const receipt = { schemaVersion: 1, oldHead: OLD_HEAD, oldTree: OLD_TREE,
    oldIndexSha256: OLD_INDEX_SHA, candidateHead: expectedHead, candidateTree: nextManifest.sourceTree,
    oldApplied, forwardApplied, repeatedApplied, migrationCount: versions.length,
    candidateReadOld, previousReadNew, oldHealthyOnNewSchema, sameObjectReadable,
    candidateReadRollbackWrite, oldWorkerCompleted, oldStagingWorkerCompleted, oldStagingServerReadNew,
    sameDatabase: true, databaseRestore: false, downMigration: false,
    syntheticOnly: true, publicStagingTested: false };
  await mkdir('tmp/release-preparation', { recursive: true });
  await writeFile(`tmp/release-preparation/rollback-rehearsal-${expectedHead.slice(0, 12)}.json`,
    JSON.stringify(receipt, null, 2) + '\n');
  console.log(JSON.stringify(receipt));
} finally { await pool.end(); }
