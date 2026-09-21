import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import pg from "pg";
import { assertDisposableTarget, resetCapability } from "./ownership.js";
export { assertDisposableTarget, resetCapability } from "./ownership.js";

function assertTestDatabaseName(name: string): void {
  if (!name.startsWith("cisme_") || !/(^|_)test(_|$)/.test(name)) {
    throw new Error("TEST_DATABASE_REQUIRED: reset is limited to a dedicated cisme_*test* database");
  }
}

export function resolveTestDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const url = env.TEST_DATABASE_URL;
  if (!url) throw new Error("EXPLICIT_TEST_DATABASE_URL_REQUIRED");
  if (!["postgres:", "postgresql:"].includes(new URL(url).protocol)) throw new Error("POSTGRES_TEST_URL_REQUIRED");
  assertTestDatabaseName(decodeURIComponent(new URL(url).pathname.slice(1)));
  return url;
}

// Importing helpers must stay side-effect-free; testPool/reset validate before any connection.
export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ? resolveTestDatabaseUrl() : "";

export function testPool(env: NodeJS.ProcessEnv = process.env): pg.Pool {
  const connectionString = resolveTestDatabaseUrl(env);
  resetCapability(env);
  return new pg.Pool({ connectionString, max: 12 });
}

export async function resetDatabase(pool: pg.Pool, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  resolveTestDatabaseUrl(env);
  resetCapability(env); // No connection to an unowned target, even for inspection.
  const client = await pool.connect();
  let locked = false;
  try {
  await assertDisposableTarget(client, env);
  const lock = await client.query("SELECT pg_try_advisory_lock(924173, 1) AS acquired");
  if (lock.rows[0]?.acquired !== true) throw new Error("CONCURRENT_TEST_RESET_REFUSED");
  locked = true;
  await client.query("DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public");
  await client.query("CREATE TABLE schema_migration(version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
  const directory = resolve(process.cwd(), "db/migrations");
  const files = (await readdir(directory)).filter((name) => name.endsWith(".sql")).sort();
  for (const name of files) {
    const source = await readFile(resolve(directory, name), "utf8");
    const [up] = source.split("-- migrate:down");
    await client.query(up ?? source);
    await client.query("INSERT INTO schema_migration(version) VALUES ($1)", [name]);
  }
  } finally {
    try { if (locked) await client.query("SELECT pg_advisory_unlock(924173, 1)"); }
    finally { client.release(); }
  }
}

export async function seedTestCampaign(pool: pg.Pool): Promise<string> {
  const result = await pool.query<{ id: string }>(`
    INSERT INTO eligibility_campaign
      (code, qualifying_milestone, capacity, reward_points, starts_at, ends_at, active)
    VALUES ('care-d7-story-r0', 'D7', 2, 300, '2026-01-01T00:00:00Z', '2027-01-01T00:00:00Z', true)
    ON CONFLICT (code) DO UPDATE SET active = true
    RETURNING id
  `);
  return result.rows[0]!.id;
}
