import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {describe,expect,it} from 'vitest';

// Python cases use only synthetic public fixtures and patched command adapters.
// They never contact a server, load runtime secrets or start a database/service.
describe('trial schema98 application-only upgrade',()=>{
 it('keeps SQL/dependencies fixed and fences unsafe cutover/rollback',()=>{
  const file=fileURLToPath(new URL('../../infra/tencent/test_trial_no_schema_upgrade.py',import.meta.url));
  const result=spawnSync('python3',['-I','-B',file],{
   encoding:'utf8',timeout:20000,maxBuffer:1024*1024,
   env:{PATH:process.env.PATH??'/usr/bin:/bin',LANG:'C.UTF-8'}
  });
  expect(result.error).toBeUndefined();
  expect(result.status,result.stderr).toBe(0);
  expect(result.stderr).toContain('Ran 22 tests');
  expect(result.stderr).toMatch(/\bOK\b/);
 },25000);
});
