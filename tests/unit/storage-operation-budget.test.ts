import { createServer } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import COS from "cos-nodejs-sdk-v5";
import { bindCosOperationBudget } from "../../services/api/src/storage.js";
import { OperationBudget, runWithOperationBudget } from "../../services/api/src/operationBudget.js";

describe("pinned COS 3.0.0 / cos-request 1.3.3 cancellation over real loopback HTTP", () => {
  it("closes a stalled socket and rejects the SDK call within the remaining operation budget", async () => {
    let received = 0, disconnected = 0;
    const server = createServer((request, response) => {
      received++;
      response.on("close", () => disconnected++);
      request.resume(); // Intentionally never respond. No external bucket or business data.
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port:number }).port;
    const client = new COS({ SecretId: "synthetic-id", SecretKey: "synthetic-key", Protocol: "http:",
      Domain: `127.0.0.1:${port}`, Timeout: 5_000 });
    const budget = new OperationBudget(120);
    bindCosOperationBudget(client, budget);
    const started = performance.now();
    let settled = false;
    const request = runWithOperationBudget(budget, () => client.headBucket({ Bucket: "synthetic-1250000000", Region: "ap-shanghai" }))
      .then(() => { throw new Error("Stalled loopback unexpectedly succeeded"); }, () => { settled = true; });
    try {
      // Watchdog is test cleanup, not a production Promise.race cancellation mechanism.
      await sleep(400);
      expect(settled).toBe(true);
      expect(received).toBe(1);
      expect(disconnected).toBe(1);
      expect(performance.now() - started).toBeLessThan(1_000);
      await request;
    } finally { budget.dispose(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(()=>resolve())); await request; }
  });
  it("an already aborted context cannot start another HTTP request", async () => {
    let received = 0;
    const server = createServer((_request, response) => { received++; response.end(); });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const client = new COS({ SecretId: "synthetic-id", SecretKey: "synthetic-key", Protocol: "http:",
      Domain: `127.0.0.1:${(server.address() as {port:number}).port}` });
    const budget = new OperationBudget(1_000); budget.abort();
    bindCosOperationBudget(client, budget);
    try { await expect(runWithOperationBudget(budget, () => client.headBucket({ Bucket: "synthetic-1250000000", Region:"ap-shanghai" }))).rejects.toBeDefined(); expect(received).toBe(0); }
    finally { budget.dispose(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(()=>resolve())); }
  });
});
