import { mkdir, readFile, writeFile, chmod, copyFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { build } from 'tsup';
import { bundleCloudbaseRuntime } from './cloudbase-runtime.mjs';

// A fresh, secret-free artifact. Production configuration is supplied at runtime.
const root = fileURLToPath(new URL('../', import.meta.url));
const output = resolve(root, 'dist/cloudbase-api');
const source = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
await mkdir(output, { recursive: true });
await build({
  entry: { index: resolve(root, 'services/api/src/server.ts') },
  outDir: output, format: ['esm'], target: 'node24', splitting: false,
  clean: true, sourcemap: false, noExternal: [/^@cisme\//],
  tsconfig: resolve(root, 'tsconfig.json')
});
const manifest = {
  name: 'cisme-cloudbase-api', version: source.version, private: true,
  type: 'module', engines: source.engines, dependencies: source.dependencies
};
await writeFile(resolve(output, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
// Preserve the reviewed dependency resolutions while removing workspace links.
const lock = JSON.parse(await readFile(resolve(root, 'package-lock.json'), 'utf8'));
lock.name = manifest.name;
lock.packages[''] = { ...manifest };
delete lock.packages[''].private;
delete lock.packages[''].type;
for (const [key, value] of Object.entries(lock.packages)) {
  if (key && (!key.startsWith('node_modules/') || value.link)) delete lock.packages[key];
}
await writeFile(resolve(output, 'package-lock.json'), JSON.stringify(lock, null, 2) + '\n');
execFileSync('npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: output, stdio: 'inherit' });
await copyFile(resolve(root, 'infra/supabase-prod-ca.crt'), resolve(output, 'supabase-prod-ca.crt'));
// CloudBase's installed Node 24 may be older than the required 24.14 minor.
// Pin the verified runtime by default; native platform runtime is explicit.
const bundled = !process.argv.includes('--platform-runtime');
const runtime = bundled ? await bundleCloudbaseRuntime(output) : '/var/lang/node24/bin/node';
await writeFile(resolve(output, 'scf_bootstrap'), `#!/bin/bash
set -eu
cd /var/user
# Do not run a perpetual worker inside a request-driven function.
export PORT=9000
export RUN_BACKGROUND_WORKER=false
${bundled ? '/var/lang/node24/bin/node unpack.cjs' : ''}
${runtime} -e 'const [major, minor] = process.versions.node.split(".").map(Number); if (major !== 24 || minor < 14) { console.error("CISME_RUNTIME_UNSUPPORTED", process.version); process.exit(1); }'
exec ${runtime} index.js
`);
await chmod(resolve(output, 'scf_bootstrap'), 0o755);
console.log('CloudBase HTTP API artifact prepared at dist/cloudbase-api; not deployed.');
