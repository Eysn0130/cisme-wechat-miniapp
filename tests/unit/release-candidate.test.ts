import {afterEach,it,expect} from 'vitest';
import {mkdtemp,mkdir,copyFile,writeFile,readFile,rm} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
const roots:string[]=[];
afterEach(async()=>{await Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true})));});
async function fixture(){
 await mkdir('tmp',{recursive:true});const root=await mkdtemp(resolve('tmp/release-migrate-test-'));roots.push(root);
 await copyFile('scripts/release-migrate.mjs',join(root,'migrate.mjs'));
 await mkdir(join(root,'db/migrations'),{recursive:true});
 const file='202601010001_synthetic.sql',sql='SELECT 1; -- synthetic only';
 await writeFile(join(root,'db/migrations',file),sql);
 // Match the immutable release package schema, not the old SQL-only verifier.
 const artifacts=['index.js','worker.js','worker-once.js','package.json','package-lock.json','migrate.mjs',`db/migrations/${file}`];
 for(const name of ['index.js','worker.js','worker-once.js'])await writeFile(join(root,name),'export const synthetic=true;\n');
 await writeFile(join(root,'package.json'),'{"type":"module"}');
 await writeFile(join(root,'package-lock.json'),'{"lockfileVersion":3}');
 const hashes=Object.fromEntries(await Promise.all(artifacts.map(async name=>[name,createHash('sha256').update(await readFile(join(root,name))).digest('hex')])));
 const manifest={schemaVersion:1,sourceHead:'a'.repeat(40),sourceTree:'b'.repeat(40),migrations:[file],hashes};
 await writeFile(join(root,'release-manifest.json'),JSON.stringify(manifest));
 return {root,file,manifest,run:(action:string)=>spawnSync(process.execPath,[join(root,'migrate.mjs'),action],
  {encoding:'utf8',env:{PATH:process.env.PATH}})};
}
it('verifies candidate migrations without database access and rejects altered content',async()=>{
 const f=await fixture();const valid=f.run('verify');expect(valid.status,valid.stderr).toBe(0);expect(JSON.parse(valid.stdout)).toMatchObject({verified:true,applied:false,migrations:1,artifacts:7,sourceHead:'a'.repeat(40),sourceTree:'b'.repeat(40)});
 await writeFile(join(f.root,'db/migrations',f.file),'SELECT 2;');
 expect(f.run('verify').stderr).toContain('MIGRATION_HASH_MISMATCH');
});
it('rejects down, implicit targets and path traversal before any database connection',async()=>{
 const f=await fixture();for(const action of ['up','down',''])expect(f.run(action).stderr).toContain('EXPLICIT_TARGET_UP_APPROVAL_AND_BACKUP_REFERENCES_REQUIRED');
 await writeFile(join(f.root,'release-manifest.json'),JSON.stringify({...f.manifest,migrations:['../../secret.sql']}));
 expect(f.run('verify').stderr).toContain('MIGRATION_PATH_INVALID');
});
it('rejects altered runtime artifacts even when migration files are unchanged',async()=>{
 const f=await fixture();
 for(const name of ['index.js','worker.js','worker-once.js','package-lock.json']){
  const path=join(f.root,name),original=await readFile(path);
  await writeFile(path,Buffer.concat([original,Buffer.from('\n')]));
  const rejected=f.run('verify');expect(rejected.status).not.toBe(0);expect(rejected.stdout).toBe('');
  expect(rejected.stderr).toContain('CANDIDATE_HASH_MISMATCH');
  await writeFile(path,original);
 }
 expect(f.run('verify').status).toBe(0);
});
