import { loadConfig } from "@cisme/config";
import { createPool } from "../../api/src/db.js";
import { createObjectStorage } from "../../api/src/storage.js";
import { startBackgroundWorker } from "./jobs.js";
import { startMoneyBackgroundWorker } from "./moneyJobs.js";
import { isolatedPaymentProtocol } from "../../api/src/isolatedPaymentProtocol.js";
import { RefundCommandService } from "../../api/src/refundCommand.js";
import { AuthorityService } from "../../api/src/authority.js";
import { SettlementCommandService } from "../../api/src/settlementCommand.js";
export { processOutboxBatch, processMediaCleanup, sweepExpired, WORKER_MAX_ATTEMPTS } from "./jobs.js";
export { expirePendingOrders } from "../../api/src/commerceOrders.js";

if (import.meta.url === `file://${process.argv[1]}`) {
  const config = loadConfig();
  const pool = createPool(config.databaseUrl, config.database);
  const storage = createObjectStorage(config);
  const worker = startBackgroundWorker(pool, storage, { ugcGoLiveGate: config.ugcGoLiveGate }, (error) => console.error("CISME_WORKER_TICK_FAILED", error));
  const paymentProtocol=isolatedPaymentProtocol(config,pool);
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
      error=>console.error("CISME_MONEY_WORKER_TICK_FAILED",error)):null;
  const stop = async () => { moneyWorker?.stop(); await worker.stop(); await pool.end(); };
  process.once("SIGTERM", () => void stop());
  process.once("SIGINT", () => void stop());
}
