import {afterEach,expect,it,vi} from 'vitest';
import {loadConfig} from '@cisme/config';
import type pg from 'pg';
import type {ObjectStorage} from '../../services/api/src/storage';
import {UgcSafetyService} from '../../services/api/src/ugcSafety';
import {startStandaloneUgcSafety} from '../../services/worker/src/ugcSafety';
afterEach(()=>{vi.restoreAllMocks();vi.useRealTimers();});
it('supervises text-only editorial checks when public UGC is closed and no image scan URL is configured',async()=>{
  vi.useFakeTimers();
  const config=loadConfig({APP_ENV:'test',DATABASE_URL:'postgres://local/test',APP_SESSION_SECRET:'synthetic-test-session',
    UPLOAD_TOKEN_SECRET:'synthetic-upload-token',ADMIN_API_TOKEN:'synthetic-admin-token',UGC_SCAN_WORKER_MODE:'standalone',RUN_BACKGROUND_WORKER:'false'});
  const scan=vi.spyOn(UgcSafetyService.prototype,'scanPendingBatch').mockResolvedValue(0);
  const worker=startStandaloneUgcSafety(config,{} as pg.Pool,{} as ObjectStorage,vi.fn());
  await vi.advanceTimersByTimeAsync(0);expect(scan).toHaveBeenCalledExactlyOnceWith('');await worker.stop();
});
it('runs the shared scan loop in a standalone worker and drains before shutdown',async()=>{
  vi.useFakeTimers();let finish!:()=>void;
  const scan=vi.spyOn(UgcSafetyService.prototype,'scanPendingBatch').mockImplementation(()=>new Promise(resolve=>{finish=()=>resolve(0);}));
  const config=loadConfig({APP_ENV:'test',DATABASE_URL:'postgres://local/test',APP_SESSION_SECRET:'synthetic-test-session',
    UPLOAD_TOKEN_SECRET:'synthetic-upload-token',ADMIN_API_TOKEN:'synthetic-admin-token',UGC_SCAN_WORKER_MODE:'standalone',
    RUN_BACKGROUND_WORKER:'false',UGC_SCAN_BASE_URL:'https://synthetic.invalid'});
  const worker=startStandaloneUgcSafety(config,{} as pg.Pool,{} as ObjectStorage,vi.fn())!;
  await vi.advanceTimersByTimeAsync(0);expect(scan).toHaveBeenCalledWith('https://synthetic.invalid');
  let stopped=false;const stop=worker.stop().then(()=>{stopped=true;});await Promise.resolve();expect(stopped).toBe(false);
  finish();await stop;await vi.advanceTimersByTimeAsync(60_000);expect(scan).toHaveBeenCalledTimes(1);
});
it('leaves ordinary UGC embedded while the standalone worker scans only editorial text',async()=>{
  vi.useFakeTimers();const scan=vi.spyOn(UgcSafetyService.prototype,'scanPendingBatch').mockResolvedValue(0);
  const config=loadConfig({APP_ENV:'test',DATABASE_URL:'postgres://local/test',APP_SESSION_SECRET:'synthetic-test-session',
    UPLOAD_TOKEN_SECRET:'synthetic-upload-token',UGC_SCAN_WORKER_MODE:'embedded',UGC_SCAN_BASE_URL:'https://synthetic.invalid'});
  const worker=startStandaloneUgcSafety(config,{} as pg.Pool,{} as ObjectStorage,vi.fn());await vi.advanceTimersByTimeAsync(0);
  expect(scan).toHaveBeenCalledExactlyOnceWith('');await worker.stop();
});
