import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { build } from 'tsup';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = resolve(root, 'dist/tencent-release');
const source = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
await mkdir(output, { recursive: true });
await build({
  entry: {
    index: resolve(root, 'services/api/src/server.ts'),
    worker: resolve(root, 'services/worker/src/main.ts'),
    'worker-once': resolve(root, 'services/worker/src/once.ts')
  },
  outDir: output, format: ['esm'], target: 'node24', splitting: false,
  clean: true, sourcemap: false, noExternal: [/^@cisme\//],
  tsconfig: resolve(root, 'tsconfig.json')
});
const manifest = {
  name: 'cisme-tencent-release', version: source.version, private: true,
  type: 'module', engines: source.engines, dependencies: source.dependencies
};
await writeFile(resolve(output, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
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
const hashes = {};
for (const file of ['index.js', 'worker.js', 'worker-once.js', 'package-lock.json']) {
  hashes[file] = createHash('sha256').update(await readFile(resolve(output, file))).digest('hex');
}
await writeFile(resolve(output, 'release-manifest.json'), JSON.stringify({
  generatedAt: new Date().toISOString(), runtime: source.engines.node, hashes,
  configurationIncluded: false, deployed: false
}, null, 2) + '\n');
console.log('Prepared dist/tencent-release with API and independent worker; credentials remain external.');
