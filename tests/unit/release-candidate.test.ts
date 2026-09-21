import {afterEach,it,expect} from 'vitest';
import {mkdtemp,mkdir,copyFile,writeFile,rm} from 'node:fs/promises';
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
 const manifest={schemaVersion:1,sourceHead:'synthetic',migrations:[file],hashes:{[`db/migrations/${file}`]:createHash('sha256').update(sql).digest('hex')}};
 await writeFile(join(root,'release-manifest.json'),JSON.stringify(manifest));
 return {root,file,manifest,run:(action:string)=>spawnSync(process.execPath,[join(root,'migrate.mjs'),action],
  {encoding:'utf8',env:{PATH:process.env.PATH}})};
}
it('verifies candidate migrations without database access and rejects altered content',async()=>{
 const f=await fixture();const valid=f.run('verify');expect(valid.status,valid.stderr).toBe(0);expect(JSON.parse(valid.stdout)).toMatchObject({verified:true,applied:false,migrations:1});
 await writeFile(join(f.root,'db/migrations',f.file),'SELECT 2;');
 expect(f.run('verify').stderr).toContain('MIGRATION_HASH_MISMATCH');
});
it('rejects down, implicit targets and path traversal before any database connection',async()=>{
 const f=await fixture();for(const action of ['up','down',''])expect(f.run(action).stderr).toContain('EXPLICIT_TARGET_UP_APPROVAL_AND_BACKUP_REFERENCES_REQUIRED');
 await writeFile(join(f.root,'release-manifest.json'),JSON.stringify({...f.manifest,migrations:['../../secret.sql']}));
 expect(f.run('verify').stderr).toContain('MIGRATION_PATH_INVALID');
});
