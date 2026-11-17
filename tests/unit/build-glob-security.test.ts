import {readFileSync,realpathSync} from 'node:fs';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {expect,it} from 'vitest';
const root=resolve('tools/vendor/picomatch-hardened');
const pm=createRequire(import.meta.url)(root);
it('pins the owned patch and verifies every vendored runtime file against its reviewed provenance',()=>{
 const p=JSON.parse(readFileSync(resolve(root,'PROVENANCE.json'),'utf8'));
 expect(p.upstream).toBe('picomatch@4.0.7');expect(p.officialFixAvailable).toBe(false);
 expect(p.advisory).toBe('https://github.com/advisories/GHSA-fc5q-39xc-vjpf');
 for(const[file,sha]of Object.entries(p.installedFilesSha256))expect(createHash('sha256').update(readFileSync(resolve(root,file))).digest('hex'),file).toBe(sha);
 expect(readFileSync(resolve(root,'LICENSE'),'utf8')).toContain('MIT License');
});
it.each(['vite','vitest','tinyglobby'])('requires %s to use the patched implementation after a clean install',name=>{
 const require=createRequire(resolve('node_modules',name,'package.json'));
 expect(realpathSync(require.resolve('picomatch'))).toBe(realpathSync(resolve(root,'index.js')));
 expect(require('picomatch/package.json').cismePatch).toBe('GHSA-fc5q-39xc-vjpf-single-branch-v1');
});
it('bounds the advisory attacks in a killable child, including attempts to opt out of recursion checks',()=>{
 const code=`const p=require(process.argv[1]);let count=0;for(const pattern of ['+(*)','+(*a)','*(*?a)','+([ab])','+((a+))'])for(const options of [{},{maxExtglobRecursion:false}]){if(p.isMatch('a'.repeat(64)+'!',pattern,options))throw Error('Unexpected attack match');count++;}process.stdout.write(String(count));`;
 const result=spawnSync(process.execPath,['-e',code,root],{timeout:2000,maxBuffer:4096,encoding:'utf8'});
 expect(result.error).toBeUndefined();expect(result.signal).toBeNull();expect(result.status).toBe(0);expect(result.stdout).toBe('10');
});
it('preserves the project path-glob and simple repeated-literal semantics',()=>{
 for(const[path,pattern,yes]of [['tests/unit/example.test.ts','**/*.test.ts',true],['apps/main.ts','**/*.{ts,tsx}',true],['apps/main.js','**/*.{ts,tsx}',false],['ab','+(a|b)',true],['abab','+(ab)',true],['docs/one.md','docs/!(secret).md',true]])expect(pm.isMatch(path,pattern),String(pattern)).toBe(yes);
});
