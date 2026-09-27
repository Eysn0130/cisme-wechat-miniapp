import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { createPool } from "../services/api/src/db.js";

const direction = process.argv[2] ?? "up";
if (direction !== "up" && direction !== "down") throw new Error("Usage: migrate.ts up|down");
const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("EXPLICIT_DATABASE_URL_REQUIRED");
const pool = createPool(connectionString);
await pool.query(`CREATE TABLE IF NOT EXISTS schema_migration (
  version text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
)`);
const directory = resolve(process.cwd(), "db/migrations");
const files = (await readdir(directory)).filter((name) => name.endsWith(".sql")).sort();

// Historical files own an outer BEGIN/COMMIT. The runner must instead own that
// transaction so DDL and schema_migration journal changes commit atomically.
// Strip only the complete, anchored legacy wrapper; leave function bodies alone.
function transactionBody(sql: string): string {
  const text = sql.trim();
  if (/^BEGIN\s*;/i.test(text)) {
    const wrapped = /^BEGIN\s*;([\s\S]*)\bCOMMIT\s*;$/i.exec(text);
    if (!wrapped) throw new Error("MIGRATION_TRANSACTION_WRAPPER_INVALID");
    return wrapped[1]!;
  }
  return sql;
}

if (direction === "up") {
  for (const file of files) {
    const already = await pool.query("SELECT 1 FROM schema_migration WHERE version=$1", [file]);
    if (already.rowCount) continue;
    const source = await readFile(resolve(directory, file), "utf8");
    const [up] = source.split("-- migrate:down");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(transactionBody(up ?? source));
      await client.query("INSERT INTO schema_migration(version) VALUES ($1)", [file]);
      await client.query("COMMIT");
      console.log(`applied ${file}`);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
} else {
  const applied = await pool.query<{ version: string }>("SELECT version FROM schema_migration ORDER BY version DESC LIMIT 1");
  const version = applied.rows[0]?.version;
  if (!version) throw new Error("No migration to roll back");
  const source = await readFile(resolve(directory, version), "utf8");
  const down = source.split("-- migrate:down")[1];
  if (!down) throw new Error(`Migration ${version} has no down section`);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(transactionBody(down));
    await client.query("DELETE FROM schema_migration WHERE version=$1", [version]);
    await client.query("COMMIT");
    console.log(`rolled back ${version}`);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
await pool.end();
