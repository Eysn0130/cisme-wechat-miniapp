import { loadConfig } from "@cisme/config";
import { createPool } from "../../api/src/db.js";
import { createObjectStorage } from "../../api/src/storage.js";
import { runWorkerCycle } from "./jobs.js";

// One scheduled execution: await all work and release database connections.
// This is an internal entry point, not a publicly callable HTTP route.
export async function runOnce() {
  const config = loadConfig();
  const pool = createPool(config.databaseUrl, config.database);
  try {
    const storage = createObjectStorage(config);
    await storage.ensureReady();
    return await runWorkerCycle(pool, storage, { ugcGoLiveGate: config.ugcGoLiveGate });
  } finally {
    await pool.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  console.log(JSON.stringify(await runOnce()));
}
