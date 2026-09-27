import {afterEach,expect,it,vi} from 'vitest';
import {loadConfig} from '@cisme/config';
import type pg from 'pg';
import type {ObjectStorage} from '../../services/api/src/storage';
import {UgcSafetyService} from '../../services/api/src/ugcSafety';
import {startStandaloneUgcSafety} from '../../services/worker/src/ugcSafety';
afterEach(()=>{vi.restoreAllMocks();vi.useRealTimers();});
it('keeps unrelated worker startup available when public UGC is closed and scanner configuration is absent',()=>{
  const config=loadConfig({APP_ENV:'test',DATABASE_URL:'postgres://local/test',APP_SESSION_SECRET:'synthetic-test-session',
    UPLOAD_TOKEN_SECRET:'synthetic-upload-token',ADMIN_API_TOKEN:'synthetic-admin-token',UGC_SCAN_WORKER_MODE:'standalone',RUN_BACKGROUND_WORKER:'false'});
  const scan=vi.spyOn(UgcSafetyService.prototype,'scanPendingBatch');
  expect(startStandaloneUgcSafety(config,{} as pg.Pool,{} as ObjectStorage,vi.fn())).toBeNull();
  expect(scan).not.toHaveBeenCalled();
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
  expect(startStandaloneUgcSafety({...config,media:{...config.media,ugcScanWorkerMode:'embedded'}},{} as pg.Pool,{} as ObjectStorage,vi.fn())).toBeNull();
});
