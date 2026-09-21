import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import pg from "pg";
import { loadConfig } from "@cisme/config";
import { TEST_DATABASE_URL } from "@cisme/testkit";
import { createPool, transaction } from "../../services/api/src/db.js";

// Only this explicit local synthetic database and test table are touched.
const url = new URL(TEST_DATABASE_URL);
if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || !/^cisme_.*test/.test(url.pathname.slice(1))) throw new Error("LOCAL_CISME_TEST_DATABASE_REQUIRED");
const config = loadConfig({ APP_ENV:"test", DATABASE_URL:TEST_DATABASE_URL, APP_SESSION_SECRET:"budget-test", ADMIN_API_TOKEN:"budget-test", UPLOAD_TOKEN_SECRET:"budget-test", DATABASE_POOL_MAX:"1" });
const pool = createPool(TEST_DATABASE_URL, config.database);
const control = new pg.Pool({ connectionString: TEST_DATABASE_URL, max:1, connectionTimeoutMillis:2_000 });
beforeAll(async()=>{await control.query("CREATE TABLE IF NOT EXISTS native_savepoint_test_probe (id TEXT PRIMARY KEY, value INT NOT NULL)");await control.query("DELETE FROM native_savepoint_test_probe");});
afterEach(async()=>{await control.query("DELETE FROM native_savepoint_test_probe");});
afterAll(async()=>{await control.query("DROP TABLE IF EXISTS native_savepoint_test_probe");await pool.end();await control.end();});

it("recovers a constraint failure through SAVEPOINT while retaining the outer deadline and facts",async()=>{
  await transaction(pool,async client=>{
    await client.query("INSERT INTO native_savepoint_test_probe VALUES ('before-savepoint',1)");
    await client.query("SAVEPOINT recoverable_step");
    await expect(client.query("INSERT INTO native_savepoint_test_probe VALUES ('before-savepoint',2)")).rejects.toMatchObject({code:"23505"});
    await client.query("ROLLBACK TO SAVEPOINT recoverable_step");
    await client.query("RELEASE SAVEPOINT recoverable_step");
    await client.query("INSERT INTO native_savepoint_test_probe VALUES ('after-recovery',3)");
  });
  expect((await control.query("SELECT id,value FROM native_savepoint_test_probe ORDER BY id")).rows).toEqual([
    {id:"after-recovery",value:3},{id:"before-savepoint",value:1}
  ]);
});
