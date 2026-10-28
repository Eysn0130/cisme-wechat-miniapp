import type { AppConfig } from '@cisme/config';
import type pg from 'pg';
import type { ObjectStorage } from '../../api/src/storage.js';
import { UgcSafetyService, startUgcSafetyLoop } from '../../api/src/ugcSafety.js';

/** Editorial text needs no externally reachable image-scan URL. It always has
 * a supervised retry owner; ordinary UGC scans retain their selected mode. */
export function startStandaloneUgcSafety(config:AppConfig,pool:pg.Pool,storage:ObjectStorage,onError:(error:unknown)=>void){
  const baseUrl=config.media.ugcScanWorkerMode==='standalone'?config.media.ugcScanBaseUrl??'':'';
  return startUgcSafetyLoop(new UgcSafetyService(pool,config,storage),baseUrl,onError);
}
