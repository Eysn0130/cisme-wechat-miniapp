import type { AppConfig } from '@cisme/config';
import type pg from 'pg';
import type { ObjectStorage } from '../../api/src/storage.js';
import { UgcSafetyService, startUgcSafetyLoop } from '../../api/src/ugcSafety.js';

/** Keep scan retries in the independently supervised worker when selected. */
export function startStandaloneUgcSafety(config:AppConfig,pool:pg.Pool,storage:ObjectStorage,onError:(error:unknown)=>void){
  if(config.media.ugcScanWorkerMode!=='standalone'||!config.media.ugcScanBaseUrl)return null;
  return startUgcSafetyLoop(new UgcSafetyService(pool,config,storage),config.media.ugcScanBaseUrl,onError);
}
