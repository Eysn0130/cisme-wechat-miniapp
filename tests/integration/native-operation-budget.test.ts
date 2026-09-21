import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { setTimeout as sleep } from "node:timers/promises";
import pg from "pg";
import { DomainError } from "@cisme/domain";
import { OperationBudget, runWithOperationBudget } from "../../services/api/src/operationBudget.js";
import { loadConfig } from "@cisme/config";
import { TEST_DATABASE_URL } from "@cisme/testkit";
import { createPool, transaction } from "../../services/api/src/db.js";

// Never infer staging/production permission from a URL. Only this local test DB
// and this synthetic table are touched; no .env or external credentials loaded.
const url = new URL(TEST_DATABASE_URL);
if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || !/^cisme_.*test/.test(url.pathname.slice(1))) throw new Error("LOCAL_CISME_TEST_DATABASE_REQUIRED");
const config = loadConfig({ APP_ENV:"test", DATABASE_URL:TEST_DATABASE_URL, APP_SESSION_SECRET:"budget-test", ADMIN_API_TOKEN:"budget-test", UPLOAD_TOKEN_SECRET:"budget-test", DATABASE_POOL_MAX:"1" });
const pool = createPool(TEST_DATABASE_URL, config.database);
const control = new pg.Pool({ connectionString: TEST_DATABASE_URL, max:1, connectionTimeoutMillis:2_000 });
beforeAll(async()=>{await control.query("CREATE TABLE IF NOT EXISTS native_budget_test_probe (id TEXT PRIMARY KEY, value INT NOT NULL)");await control.query("DELETE FROM native_budget_test_probe");});
afterEach(async()=>{await control.query("DELETE FROM native_budget_test_probe");});
afterAll(async()=>{await control.query("DROP TABLE IF EXISTS native_budget_test_probe");await pool.end();await control.end();});

describe("real PostgreSQL transaction deadlines / pg 8.23.0",()=>{
  it("cancels pg_sleep, leaves no committed insert or active late SQL, and restores pool availability",async()=>{
    let lateWork=false;
    await expect(transaction(pool,async client=>{
      await client.query("INSERT INTO native_budget_test_probe VALUES ('deadline',1)");
      await client.query("SELECT pg_sleep(1) /* native_budget_probe_sleep */");
      lateWork=true;
    },"READ COMMITTED",1,180)).rejects.toBeDefined();
    await sleep(80);
    expect(lateWork).toBe(false);
    expect((await control.query("SELECT * FROM native_budget_test_probe")).rowCount).toBe(0);
    const running=await control.query("SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND state='active' AND query LIKE '%native_budget_probe_sleep%'");
    expect(running.rowCount).toBe(0);
    expect((await pool.query("SELECT 1 AS healthy")).rows[0].healthy).toBe(1);
  });
  it("confirms early cancellation before rejecting, without leaving backend SQL or a queued write", async () => {
    const parent = new OperationBudget(4_000);
    let entered = false;
    const outcome = runWithOperationBudget(parent, () => transaction(pool, async client => {
      await client.query("INSERT INTO native_budget_test_probe VALUES ('early-cancel',1)");
      entered = true;
      await client.query("SELECT pg_sleep(1.5) /* early_cancel_regression */");
      await client.query("INSERT INTO native_budget_test_probe VALUES ('late-write',1)");
    }, "READ COMMITTED", 1, 3_000)).then(() => null, error => error);
    try {
      let active = false;
      for (let i = 0; i < 100; i++) {
        const running = await control.query("SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND state='active' AND query LIKE '%early_cancel_regression%'");
        if (running.rowCount) { active = true; break; }
        await sleep(5);
      }
      expect(entered && active).toBe(true);
      const started = performance.now();
      parent.abort(new DomainError("OPERATION_CANCELLED", "Synthetic explicit cancellation", 503));
      expect(await outcome).toMatchObject({ code: "OPERATION_CANCELLED" });
      expect(performance.now() - started).toBeLessThan(1_000);
      // No grace sleep: the operation's rejection is the cleanup boundary.
      expect((await control.query("SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND state='active' AND query LIKE '%early_cancel_regression%'")).rowCount).toBe(0);
      expect((await control.query("SELECT * FROM native_budget_test_probe")).rowCount).toBe(0);
      expect((await pool.query("SELECT 1 AS healthy")).rows[0].healthy).toBe(1);
    } finally { parent.dispose(); await outcome; }
  });
  it("expires a pool queue before BEGIN, returns a late grant once, and never starts its work",async()=>{
    const held=await pool.connect();let entered=false;
    try { await expect(transaction(pool,async()=>{entered=true;},"READ COMMITTED",1,60)).rejects.toMatchObject({code:"OPERATION_DEADLINE_EXCEEDED"}); }
    finally {held.release();}
    await sleep(30);expect(entered).toBe(false);expect(pool.waitingCount).toBe(0);expect((await pool.query("SELECT 1")).rowCount).toBe(1);
  });
  it.each(["40001","40P01"])("releases and rolls back before retrying actual SQLSTATE %s",async code=>{
    let attempts=0, releases=0;const count=()=>{releases++;};pool.on("release",count);
    try {
      await transaction(pool,async client=>{
        attempts++;
        if(attempts>1)expect(releases).toBeGreaterThan(0);
        await client.query("INSERT INTO native_budget_test_probe VALUES ('retry',1)");
        if(attempts===1)await client.query(`DO $$ BEGIN RAISE EXCEPTION 'synthetic conflict' USING ERRCODE='${code}'; END $$`);
      },"SERIALIZABLE",2,2_000);
      expect(attempts).toBe(2);expect((await control.query("SELECT * FROM native_budget_test_probe")).rowCount).toBe(1);
    } finally {pool.removeListener("release",count);}
  });
  it("does not mistake COMMIT returning ROLLBACK after a swallowed SQL error for success",async()=>{
    await expect(transaction(pool,async client=>{
      await client.query("INSERT INTO native_budget_test_probe VALUES ('aborted',1)");
      try {await client.query("SELECT 1/0");} catch { /* Deliberately bad application callback. */ }
      return "not saved";
    })).rejects.toMatchObject({code:"TRANSACTION_ABORTED"});
    expect((await control.query("SELECT * FROM native_budget_test_probe")).rowCount).toBe(0);
  });
  it("classifies an injected lost acknowledgement AFTER real COMMIT as unknown; query recovers one fact",async()=>{
    let attempts=0;
    const lostAckPool=new Proxy(pool,{get(target,key){
      if(key==="connect")return async()=>{const raw=await target.connect();return new Proxy(raw,{get(client,property){
        if(property==="query")return async(...args:any[])=>{const result=await (client.query as any)(...args);if(args[0]==="COMMIT")throw Object.assign(new Error("synthetic lost COMMIT acknowledgement"),{code:"ECONNRESET"});return result;};
        const value=Reflect.get(client,property,client);return typeof value==="function"?value.bind(client):value;
      }});};
      const value=Reflect.get(target,key,target);return typeof value==="function"?value.bind(target):value;
    }});
    await expect(transaction(lostAckPool,async client=>{attempts++;await client.query("INSERT INTO native_budget_test_probe VALUES ('idempotent-key',1)");})).rejects.toMatchObject({code:"TRANSACTION_OUTCOME_UNKNOWN"});
    expect(attempts).toBe(1);expect((await control.query("SELECT value FROM native_budget_test_probe WHERE id='idempotent-key'")).rows).toEqual([{value:1}]);
  });
  it("discards a terminated connection when rollback cannot be confirmed",async()=>{
    await expect(transaction(pool,async client=>{
      const pid=(await client.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      await control.query("SELECT pg_terminate_backend($1)",[pid]);await sleep(10);throw new Error("synthetic worker failed after disconnect");
    })).rejects.toBeDefined();
    expect((await pool.query("SELECT 1 AS healthy")).rows[0].healthy).toBe(1);
  });
});
