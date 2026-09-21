import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import pg from "pg";

function assertTestDatabaseName(name: string): void {
  if (!name.startsWith("cisme_") || !/(^|_)test(_|$)/.test(name)) {
    throw new Error("TEST_DATABASE_REQUIRED: reset is limited to a dedicated cisme_*test* database");
  }
}

export function resolveTestDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const url = env.TEST_DATABASE_URL;
  if (!url) throw new Error("EXPLICIT_TEST_DATABASE_URL_REQUIRED");
  assertTestDatabaseName(decodeURIComponent(new URL(url).pathname.slice(1)));
  return url;
}

// Importing helpers must stay side-effect-free; testPool/reset validate before any connection.
export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? "";

export function testPool(env: NodeJS.ProcessEnv = process.env): pg.Pool {
  return new pg.Pool({ connectionString: resolveTestDatabaseUrl(env), max: 12 });
}

export async function resetDatabase(pool: pg.Pool, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const expectedName = decodeURIComponent(new URL(resolveTestDatabaseUrl(env)).pathname.slice(1));
  const target = await pool.query<{ name: string }>("SELECT current_database() AS name");
  assertTestDatabaseName(target.rows[0]?.name ?? "");
  if (target.rows[0]?.name !== expectedName) throw new Error("TEST_DATABASE_TARGET_MISMATCH");
  await pool.query("DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public");
  await pool.query("CREATE TABLE schema_migration(version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
  const directory = resolve(process.cwd(), "db/migrations");
  const files = (await readdir(directory)).filter((name) => name.endsWith(".sql")).sort();
  for (const name of files) {
    const source = await readFile(resolve(directory, name), "utf8");
    const [up] = source.split("-- migrate:down");
    await pool.query(up ?? source);
    await pool.query("INSERT INTO schema_migration(version) VALUES ($1)", [name]);
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
