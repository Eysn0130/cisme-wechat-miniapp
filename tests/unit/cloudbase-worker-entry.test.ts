import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { timingSafeEqual } from 'node:crypto';

function fixture(secret = 'a'.repeat(64)) {
  const exec = vi.fn(async (_file: string, args: string[]) => ({ stdout: args[0] === 'worker.mjs' ? '{"published":0,"cleaned":0}' : '' }));
  const exports = {} as { main: (event?: unknown) => Promise<unknown> };
  runInNewContext(readFileSync('services/cloudbase/worker/index.cjs', 'utf8'), {
    exports, Buffer, console, __dirname: '/var/user',
    process: { env: { CISME_WORKER_TRIGGER_SECRET: secret, NODE_OPTIONS: 'must-not-inherit' }, execPath: '/platform/node' },
    require: (name: string) => name === 'node:crypto' ? { timingSafeEqual } : name === 'node:util' ? { promisify: () => exec } : { execFile: () => undefined }
  });
  return { main: exports.main, exec, secret };
}
describe('private CloudBase worker entry', () => {
  it('rejects missing, malformed and spoofed timer credentials before starting any subprocess', async () => {
    const f = fixture();
    for (const event of [{}, { Message: '{' }, { Message: '{"authorization":123}' }, { Type: 'Timer', TriggerName: 'cismeWorker' }, { Type: 'Timer', TriggerName: 'cismeWorker_' + 'b'.repeat(48) }]) {
      await expect(f.main(event)).rejects.toThrow('WORKER_TRIGGER_UNAUTHORIZED');
    }
    expect(f.exec).not.toHaveBeenCalled();
    await expect(fixture('').main({ Type: 'Timer', TriggerName: 'cismeWorker_' })).rejects.toThrow('WORKER_TRIGGER_UNAUTHORIZED');
  });
  it('accepts only the configured timer credential or complete manual credential and clears child Node options', async () => {
    const f = fixture();
    for (const event of [{ Type: 'Timer', TriggerName: 'cismeWorker_' + f.secret.slice(0,48) }, { Message: JSON.stringify({ authorization: f.secret }) }]) {
      await expect(f.main(event)).resolves.toEqual({ completed: true, summary: { published: 0, cleaned: 0 } });
    }
    expect(f.exec).toHaveBeenCalledTimes(4);
    for (const call of f.exec.mock.calls) expect((call as unknown as [unknown,unknown,{env:Record<string,string>}])[2].env.NODE_OPTIONS).toBeUndefined();
  });
});
