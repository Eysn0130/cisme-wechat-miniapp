import { expect, it, vi } from 'vitest';
import type pg from 'pg';
import { assertDisposableTarget, resetCapability, resetDatabase } from '@cisme/testkit';

const runId = 'a'.repeat(24), token = 'b'.repeat(64);
const url = `postgres://runner_${runId}:synthetic@127.0.0.1:32769/cisme_test_${runId}`;
const env = { TEST_DATABASE_URL: url, CISME_TEST_OWNED_URL: url, CISME_TEST_RUN_ID: runId,
  CISME_TEST_RESET_TOKEN: token, CISME_TEST_RESET_AUTHORIZED: 'disposable-only' };
const fact = { database: `cisme_test_${runId}`, role: `runner_${runId}`, run_id: runId, token,
  purpose: 'disposable-synthetic', reset_authorized: true, same_instance: true, same_endpoint: true };

it.each(['', 'http://127.0.0.1:32769/cisme_test', 'postgres://127.0.0.1:55432/cisme_test',
  'postgres://remote:32769/cisme_test', `${url}?host=remote`])('refuses unsafe destination %s', value => {
  expect(() => resetCapability({ ...env, TEST_DATABASE_URL: value, CISME_TEST_OWNED_URL: value })).toThrow();
});
it.each(['CISME_TEST_RUN_ID', 'CISME_TEST_RESET_TOKEN', 'CISME_TEST_OWNED_URL', 'CISME_TEST_RESET_AUTHORIZED'])
('refuses missing capability %s', key => expect(() => resetCapability({ ...env, [key]: '' })).toThrow());
it.each(['database', 'role', 'run_id', 'token', 'purpose', 'reset_authorized', 'same_instance', 'same_endpoint'])
('rejects wrong ownership fact %s without destructive SQL', async key => {
  const query = vi.fn().mockResolvedValue({ rows: [{ ...fact, [key]: null }] });
  await expect(assertDisposableTarget({ query } as unknown as pg.PoolClient, env)).rejects.toThrow('TARGET_MISMATCH');
  expect(query).toHaveBeenCalledTimes(1);
  expect(query.mock.calls[0]![0]).not.toMatch(/DROP|DELETE|TRUNCATE/);
});
it('verifies a complete instance capability', async () => {
  const query = vi.fn().mockResolvedValue({ rows: [fact] });
  await expect(assertDisposableTarget({ query } as unknown as pg.PoolClient, env)).resolves.toBeUndefined();
});
it('refuses a concurrent reset and releases its dedicated connection', async () => {
  const query = vi.fn().mockResolvedValueOnce({ rows: [fact] }).mockResolvedValueOnce({ rows: [{ acquired: false }] });
  const release = vi.fn(), connect = vi.fn().mockResolvedValue({ query, release });
  await expect(resetDatabase({ connect } as unknown as pg.Pool, env)).rejects.toThrow('CONCURRENT_TEST_RESET_REFUSED');
  expect(query.mock.calls.some(([sql]) => /DROP|CREATE/.test(sql))).toBe(false);
  expect(release).toHaveBeenCalledOnce();
});
