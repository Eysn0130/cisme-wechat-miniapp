import pg from "pg";

export type DbClient = pg.PoolClient;

export function createPool(connectionString: string): pg.Pool {
  return new pg.Pool({ connectionString, max: 20, idleTimeoutMillis: 30_000 });
}

export async function transaction<T>(pool: pg.Pool, work: (client: DbClient) => Promise<T>, isolation = "READ COMMITTED", maxAttempts = 8): Promise<T> {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const client = await pool.connect();
    try {
      await client.query(`BEGIN ISOLATION LEVEL ${isolation}`);
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      const code = (error as { code?: string }).code;
      if ((code === "40001" || code === "40P01") && attempt < maxAttempts) continue;
      throw error;
    } finally {
      client.release();
    }
  }
  throw new Error("TRANSACTION_RETRY_EXHAUSTED");
}
