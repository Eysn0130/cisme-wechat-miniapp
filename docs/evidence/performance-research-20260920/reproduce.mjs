// Read-only source probes. No WeChat device, real account, storage or database.
// Run from the repository root: node docs/evidence/performance-research-20260920/reproduce.mjs
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { transformSync } from 'esbuild';
import Fastify from 'fastify';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const nativeRequire = createRequire(import.meta.url);
const tick = () => new Promise(resolve => setImmediate(resolve));
function loader(mocks = {}, globals = {}) {
  const cache = new Map();
  function load(relative) {
    const file = path.resolve(root, relative);
    if (cache.has(file)) return cache.get(file).exports;
    const module = { exports: {} }; cache.set(file, module);
    const source = transformSync(fs.readFileSync(file, 'utf8'), { loader: 'ts', format: 'cjs', target: 'es2022' }).code;
    const require = specifier => {
      if (Object.hasOwn(mocks, specifier)) return mocks[specifier];
      if (!specifier.startsWith('.')) return nativeRequire(specifier);
      const base = path.resolve(path.dirname(file), specifier.replace(/\.js$/, ''));
      return load(fs.existsSync(base + '.ts') ? base + '.ts' : base);
    };
    vm.runInNewContext(source, { module, exports: module.exports, require, console,
      setTimeout, clearTimeout, setInterval, clearInterval, performance, process: { env: {} }, ...globals }, { filename: file });
    return module.exports;
  }
  return load;
}
function page(file, request, token = 'synthetic-member') {
  let definition;
  const load = loader({
    '../../services/api': { request, requireMemberAccess: () => true, retainMemberSnapshot: () => false, clearAuthenticationRedirectSuppression() {} },
    '../../services/member-identity': { memberIdentity: () => null, publishMemberIdentity() {} },
    '../../services/member-avatar': { defaultMemberAvatar: '/neutral.svg', localMemberAvatar: async () => '/neutral.svg' },
    '../../services/authority': { authorityProjection: async () => ({ version: 1, capabilities: [], managementAvailable: false }) },
    '../../services/task-entry': { consumerTaskEntries: () => [] },
    '../../services/layout': { currentChromeStyle: () => '', shouldReduceMotion: () => true },
    '../../services/share': { registerIncomingShare: async () => {} }
  }, { Page(value) { definition = value; }, getApp: () => ({ globalData: { sessionToken: token } }), wx: {} });
  load(file);
  return { ...definition, data: structuredClone(definition.data), setData(update) { Object.assign(this.data, update); } };
}
const results = {};
let releaseSupport;
const delayedSupport = new Promise(resolve => { releaseSupport = resolve; });
const home = page('apps/miniprogram/pages/home/index.ts', async ({ path }) => path.includes('support') ? delayedSupport : {
  member: { id: 'synthetic', display_name: '合成会员' }, care: { phase: 'planned', completed: [], records: [] }, businessVersion: 1
});
const homeLoad = home.load(); await tick();
results.homeAuxiliaryBarrier = { bootstrapResolved: true, supportPending: true, loading: home.data.loading, authorityAvailable: home.data.authorityAvailable };
releaseSupport({ unreadCount: 0 }); await homeLoad;
results.homeAuxiliaryBarrier.afterSupport = { loading: home.data.loading, authorityAvailable: home.data.authorityAvailable };
const guest = page('apps/miniprogram/pages/home/index.ts', async () => { throw Error('Guest must not request'); }, '');
await guest.load(); const before = guest.data.view.action;
guest.selectProtocolStep({ currentTarget: { dataset: { index: 1 } } });
results.guestStepSelection = { before, after: guest.data.view.action, needsAuthentication: guest.data.needsAuthentication };

let releaseCommercial;
const delayedCommercial = new Promise(resolve => { releaseCommercial = resolve; });
const profile = page('apps/miniprogram/pages/profile/index.ts', async ({ path }) => {
  if (path.includes('commercial-membership')) return delayedCommercial;
  if (path.includes('support')) return { unreadCount: 0 };
  if (path.includes('/tasks')) return [];
  return { member: { id: 'synthetic' }, points: { projection: { available: 0 } }, care: null, businessVersion: 1 };
});
const profileLoad = profile.load(); await tick();
results.profileAuxiliaryBarrier = { bootstrapResolved: true, commercialPending: true, loading: profile.data.loading, memberVisible: Boolean(profile.data.member) };
releaseCommercial({ eligible: false, membershipState: 'none', verifiedOrderCount: 0, commission: { netEarnedCents: 0 } }); await profileLoad;
results.profileAuxiliaryBarrier.afterCommercial = { loading: profile.data.loading, memberVisible: Boolean(profile.data.member) };

const metrics = loader({ '@cisme/domain': { DomainError: class extends Error {} } })('services/api/src/observability.ts');
for (let i = 0; i < 97; i++) metrics.recordHttpRequest({ route: `/synthetic/${i}`, durationMs: 1, responseBytes: 1, statusCode: 200, coldStart: false });
results.metricsCapacity = { submittedRoutes: 97, retainedRoutes: Object.keys(metrics.runtimeMetrics().http.routes).length, totalRequests: metrics.runtimeMetrics().http.total };

let released = false; let releasedWhenBackoff;
const db = loader({ pg: {}, './observability.js': { recordMetric() {} } }, {
  setTimeout(callback) { releasedWhenBackoff = released; callback(); return 1; }
})('services/api/src/db.ts');
let attempts = 0;
await db.transaction({ connect: async () => ({ query: async () => ({}), release() { released = true; } }) }, async () => {
  if (++attempts === 1) throw Object.assign(Error('synthetic conflict'), { code: '40001' }); return true;
}, 'READ COMMITTED', 2, 4000);
results.transactionBackoff = { attempts, connectionReleasedWhenBackoffStarted: releasedWhenBackoff };
let fakeNow = 0; const statements = [];
const deadlineDb = loader({ pg: {}, './observability.js': { recordMetric() {} } }, { performance: { now: () => fakeNow } })('services/api/src/db.ts');
await deadlineDb.transaction({ connect: async () => ({ query: async sql => { statements.push(sql); }, release() {} }) }, async () => { fakeNow = 50; return true; }, 'READ COMMITTED', 1, 10);
results.transactionDeadline = { configuredMs: 10, simulatedWorkMs: 50, committed: statements.includes('COMMIT') };

async function timeoutProbe(option) {
  const app = Fastify({ [option]: 20, logger: false }); let workCompleted = false;
  app.get('/synthetic-delay', async () => { await new Promise(resolve => setTimeout(resolve, 70)); workCompleted = true; return { ok: true }; });
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  try {
    const start = performance.now(); const response = await fetch(address + '/synthetic-delay'); await response.text();
    const elapsedMs = Math.round(performance.now() - start);
    await new Promise(resolve => setTimeout(resolve, 90));
    return { configuredMs: 20, syntheticHandlerDelayMs: 70, status: response.status, elapsedMs, workCompleted };
  } finally { await app.close(); }
}
results.fastifyRequestTimeout = await timeoutProbe('requestTimeout');
results.fastifyHandlerTimeout = await timeoutProbe('handlerTimeout');
console.log(JSON.stringify({ kind: 'isolated-source-behavior-probes-not-device-or-production-performance',
  sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  capturedAt: new Date().toISOString(), nodeVersion: process.version,
  fastifyVersion: nativeRequire('fastify/package.json').version, results }, null, 2));
