import { mkdir, readFile, writeFile, readdir, copyFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { build } from 'tsup';

const root = fileURLToPath(new URL('../', import.meta.url));
const git=(...args)=>execFileSync('git',args,{cwd:root,encoding:'utf8'}).trim();
if(git('status','--porcelain'))throw new Error('CLEAN_COMMITTED_SOURCE_REQUIRED');
const sourceHead=git('rev-parse','HEAD'),sourceTree=git('rev-parse','HEAD^{tree}');
const output = resolve(root, `dist/tencent-release-${sourceHead.slice(0,12)}`);
const source = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
await mkdir(resolve(root,'dist'),{recursive:true});
await mkdir(output); // Existing candidates are immutable; never clean/overwrite one.
await build({
  entry: {
    index: resolve(root, 'services/api/src/server.ts'),
    worker: resolve(root, 'services/worker/src/main.ts'),
    'worker-once': resolve(root, 'services/worker/src/once.ts')
  },
  outDir: output, format: ['esm'], target: 'node24', splitting: false,
  clean: false, sourcemap: false, noExternal: [/^@cisme\//],
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
await mkdir(resolve(output,'db/migrations'),{recursive:true});
const migrationFiles=(await readdir(resolve(root,'db/migrations'))).filter(name=>name.endsWith('.sql')).sort();
for(const file of migrationFiles)await copyFile(resolve(root,'db/migrations',file),resolve(output,'db/migrations',file));
await copyFile(resolve(root,'scripts/release-migrate.mjs'),resolve(output,'migrate.mjs'));
const hashes = {};
for (const file of ['index.js', 'worker.js', 'worker-once.js', 'package.json', 'package-lock.json', 'migrate.mjs', ...migrationFiles.map(name=>`db/migrations/${name}`)]) {
  hashes[file] = createHash('sha256').update(await readFile(resolve(output, file))).digest('hex');
}
await writeFile(resolve(output, 'release-manifest.json'), JSON.stringify({
  schemaVersion:1,sourceHead,sourceTree,sourceLockSha256:createHash('sha256').update(await readFile(resolve(root,'package-lock.json'))).digest('hex'),
  generatedAt: new Date().toISOString(), runtime: source.engines.node, node:process.version, migrations:migrationFiles, hashes,
  configurationIncluded: false, deployed: false,releaseReady:false
}, null, 2) + '\n');
console.log(JSON.stringify({output,sourceHead,sourceTree,migrations:migrationFiles.length,deployed:false,releaseReady:false}));
