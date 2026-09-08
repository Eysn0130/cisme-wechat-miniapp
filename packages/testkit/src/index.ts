import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import pg from "pg";

export const TEST_DATABASE_URL = process.env.DATABASE_URL ?? "postgres://cisme:cisme-dev-only@127.0.0.1:55432/cisme";

export function testPool(): pg.Pool {
  return new pg.Pool({ connectionString: TEST_DATABASE_URL, max: 12 });
}

export async function resetDatabase(pool: pg.Pool): Promise<void> {
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
