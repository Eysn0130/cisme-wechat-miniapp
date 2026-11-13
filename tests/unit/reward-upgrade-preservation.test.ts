import { it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
it('permits only the reviewed reward schema delta and rejects old fact or schema drift', () => {
  const result = JSON.parse(execFileSync(process.execPath, ['docs/evidence/holo-card-depth-20261113/operations-source/db-facts.mjs', '--self-test'], { encoding: 'utf8' }));
  expect(result).toEqual({ offlineAssertions: 7, passed: true });
});
