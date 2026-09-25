import { loadConfig } from "@cisme/config";
import { createPool } from "../../api/src/db.js";
import { createObjectStorage } from "../../api/src/storage.js";
import { startBackgroundWorker } from "./jobs.js";
import { startMoneyBackgroundWorker } from "./moneyJobs.js";
import { formalPaymentProtocol } from "../../api/src/formalPaymentProtocol.js";
import { startFormalRecoveryWorker } from "./formalRecovery.js";
import { isolatedPaymentProtocol } from "../../api/src/isolatedPaymentProtocol.js";
import { RefundCommandService } from "../../api/src/refundCommand.js";
import { AuthorityService } from "../../api/src/authority.js";
import { SettlementCommandService } from "../../api/src/settlementCommand.js";
import { safeFailureFields } from "../../api/src/observability.js";
import { fulfillmentRuntime } from "../../api/src/fulfillmentRuntime.js";
import { startWorkerLoop } from "./loop.js";
import { AccountClosure } from "../../api/src/accountClosure.js";
import { createCosSuppressionRemote } from "../../api/src/accountClosureRemote.js";
import { rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
export { processOutboxBatch, processMediaCleanup, sweepExpired, WORKER_MAX_ATTEMPTS } from "./jobs.js";
export { expirePendingOrders } from "../../api/src/commerceOrders.js";

if (import.meta.url === `file://${process.argv[1]}`) {
  const config = loadConfig();
  const pool = createPool(config.databaseUrl, config.database);
  const storage = createObjectStorage(config);
  if(config.env==='production'&&!config.privacy.suppressionDirectory)
    throw new Error('FAIL_CLOSED:PRIVACY_SUPPRESSION_DIR_REQUIRED');
  const accountClosure=new AccountClosure(config.privacy.suppressionDirectory,
    config.env==='production'?createCosSuppressionRemote(config):undefined);
  await accountClosure.replay(pool);
  const shipping=fulfillmentRuntime(config,pool);
  const shippingWorker=shipping?startWorkerLoop(async()=>{await shipping.runCycle();return false;},
    error=>console.error('CISME_SHIPPING_WORKER_FAILED',safeFailureFields(error)),5000):null;
  let lastHeartbeat=0;
  const heartbeatPath=join(tmpdir(),'cisme-worker-heartbeat.json');
  const recordWorkerCycle=async()=>{
    if(Date.now()-lastHeartbeat<10_000)return;
    const temporary=`${heartbeatPath}.${process.pid}.tmp`;
    await writeFile(temporary,JSON.stringify({completedAtUtc:new Date().toISOString()})+'\n',{mode:0o600});
    await rename(temporary,heartbeatPath);
    lastHeartbeat=Date.now();
  };
  const worker = startBackgroundWorker(pool, storage, { ugcGoLiveGate: config.ugcGoLiveGate,privacyEnvironment:config.env,
    privacySyntheticExportKey:config.env==='test'?config.privacy.syntheticExportKey:null,
    formalPrivacyConfig:config,accountClosure },
    (error) => console.error("CISME_WORKER_TICK_FAILED", safeFailureFields(error)),recordWorkerCycle);
  const isolatedProtocol=isolatedPaymentProtocol(config,pool);
  const formalProtocol=isolatedProtocol?undefined:formalPaymentProtocol(config,pool);
  const paymentProtocol=isolatedProtocol??formalProtocol;
  const moneyWorker=paymentProtocol&&config.commerce.simulatedPayment
    ?startMoneyBackgroundWorker(paymentProtocol.inbox,paymentProtocol.refundInbox,
      new RefundCommandService(pool,new AuthorityService(pool,config.env),paymentProtocol.channel,
        paymentProtocol.refundInbox,{merchantId:config.commerce.simulatedPayment.merchantId,
          notifyUrl:paymentProtocol.refundNotifyUrl}),
      config.commerce.simulatedPayment.transferSceneId&&paymentProtocol.transferNotifyUrl
        ?new SettlementCommandService(pool,new AuthorityService(pool,config.env),paymentProtocol.channel,
          config.env,{appId:config.commerce.simulatedPayment.appId,
            merchantId:config.commerce.simulatedPayment.merchantId,
            sceneId:config.commerce.simulatedPayment.transferSceneId,
            notifyUrl:paymentProtocol.transferNotifyUrl}):undefined,
      paymentProtocol.transferInbox,
      error=>console.error("CISME_MONEY_WORKER_TICK_FAILED",safeFailureFields(error))):null;
  const recoveryWorker=formalProtocol
    ?startFormalRecoveryWorker(config,pool,formalProtocol,error=>console.error("CISME_FORMAL_RECOVERY_FAILED",safeFailureFields(error))):null;
  const stop = async () => {
    await Promise.all([shippingWorker?.stop(),recoveryWorker?.stop(),moneyWorker?.stop(),worker.stop()]);
    await pool.end();
  };
  process.once("SIGTERM", () => void stop());
  process.once("SIGINT", () => void stop());
}
