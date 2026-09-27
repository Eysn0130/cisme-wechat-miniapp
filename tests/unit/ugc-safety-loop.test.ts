import {afterEach,expect,it,vi} from 'vitest';
import {startUgcSafetyLoop,type UgcSafetyService} from '../../services/api/src/ugcSafety';
afterEach(()=>{vi.useRealTimers();vi.unstubAllEnvs();});
it('does not submit content to the provider during migration maintenance',async()=>{
  vi.useFakeTimers();vi.stubEnv('CISME_MIGRATION_READ_ONLY','true');
  const scanPendingBatch=vi.fn();
  const loop=startUgcSafetyLoop({scanPendingBatch} as unknown as UgcSafetyService,'https://synthetic.invalid',vi.fn());
  await vi.advanceTimersByTimeAsync(60_001);
  expect(scanPendingBatch).not.toHaveBeenCalled();await loop.stop();
});
it('waits for an admitted scan to finish before completing shutdown',async()=>{
  vi.useFakeTimers();vi.stubEnv('CISME_MIGRATION_READ_ONLY','false');
  let finish!:()=>void;
  const scanPendingBatch=vi.fn(()=>new Promise<void>(resolve=>{finish=resolve;}));
  const loop=startUgcSafetyLoop({scanPendingBatch} as unknown as UgcSafetyService,'https://synthetic.invalid',vi.fn());
  await vi.advanceTimersByTimeAsync(1);
  let stopped=false;const stopping=Promise.resolve(loop.stop()).then(()=>{stopped=true;});
  await Promise.resolve();expect(stopped).toBe(false);
  finish();await stopping;expect(stopped).toBe(true);
  await vi.advanceTimersByTimeAsync(60_000);expect(scanPendingBatch).toHaveBeenCalledOnce();
});
