import { loadConfig } from "@cisme/config";
import { createPool } from "../../api/src/db.js";
import { createObjectStorage } from "../../api/src/storage.js";
import { startBackgroundWorker } from "./jobs.js";
export { processOutboxBatch, processMediaCleanup, sweepExpired, WORKER_MAX_ATTEMPTS } from "./jobs.js";
export { expirePendingOrders } from "../../api/src/commerceOrders.js";

if (import.meta.url === `file://${process.argv[1]}`) {
  const config = loadConfig();
  const pool = createPool(config.databaseUrl, config.database);
  const storage = createObjectStorage(config);
  const worker = startBackgroundWorker(pool, storage, { ugcGoLiveGate: config.ugcGoLiveGate }, (error) => console.error("CISME_WORKER_TICK_FAILED", error));
  const stop = async () => { await worker.stop(); await pool.end(); };
  process.once("SIGTERM", () => void stop());
  process.once("SIGINT", () => void stop());
}
