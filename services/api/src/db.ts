import pg from "pg";
import type { AppConfig } from "@cisme/config";
import { recordMetric } from "./observability.js";

export type DbClient = pg.PoolClient;

type DatabaseOptions = AppConfig["database"];
const configuredOptions = new WeakMap<object, DatabaseOptions>();
const observedClients = new WeakSet<object>();

function defaults(): DatabaseOptions {
  const read = (name: string, fallback: number) => {
    const value = Number(process.env[name] ?? fallback);
    return Number.isInteger(value) && value > 0 ? value : fallback;
  };
  return {
    poolMax: read("DATABASE_POOL_MAX", 10), globalConnectionBudget: read("DATABASE_GLOBAL_CONNECTION_BUDGET", 40), instanceCount: read("SERVICE_INSTANCE_COUNT", 1),
    poolAcquireTimeoutMs: read("DATABASE_POOL_ACQUIRE_TIMEOUT_MS", 2_000), statementTimeoutMs: read("DATABASE_STATEMENT_TIMEOUT_MS", 2_500),
    lockTimeoutMs: read("DATABASE_LOCK_TIMEOUT_MS", 750), idleTransactionTimeoutMs: read("DATABASE_IDLE_TRANSACTION_TIMEOUT_MS", 5_000),
    transactionDeadlineMs: read("DATABASE_TRANSACTION_DEADLINE_MS", 4_000), transactionMaxAttempts: read("DATABASE_TRANSACTION_MAX_ATTEMPTS", 6)
  };
}

function queryText(args: unknown[]): string {
  const input = args[0];
  if (typeof input === "string") return input;
  if (input && typeof input === "object" && "text" in input && typeof (input as { text?: unknown }).text === "string") return (input as { text: string }).text;
  return "";
}

function observeClient(client: pg.PoolClient): void {
  if (observedClients.has(client)) return;
  observedClients.add(client);
  const originalQuery = client.query.bind(client);
  (client as unknown as { query: (...args: unknown[]) => unknown }).query = (...args: unknown[]) => {
    const controlStatement = /^\s*(?:BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE)\b/i.test(queryText(args));
    const started = performance.now();
    const done = () => { if (!controlStatement) recordMetric("sql_ms", performance.now() - started); };
    const callbackIndex = typeof args.at(-1) === "function" ? args.length - 1 : -1;
    if (callbackIndex >= 0) {
      const callback = args[callbackIndex] as (...values: unknown[]) => unknown;
      args[callbackIndex] = (...values: unknown[]) => { done(); return callback(...values); };
      return (originalQuery as (...queryArgs: unknown[]) => unknown)(...args);
    }
    try {
      const result = (originalQuery as (...queryArgs: unknown[]) => unknown)(...args);
      if (result && typeof result === "object" && "finally" in result && typeof (result as { finally?: unknown }).finally === "function") {
        return (result as Promise<unknown>).finally(done);
      }
      done();
      return result;
    } catch (error) {
      done();
      throw error;
    }
  };
}

function observe(pool: pg.Pool): pg.Pool {
  // Unit tests may replace Pool with a constructor-only probe.
  if (typeof pool.connect !== "function" || typeof pool.query !== "function") return pool;
  const originalConnect = pool.connect.bind(pool);
  if (typeof pool.on === "function") pool.on("connect", observeClient);
  (pool as unknown as { connect: (...args: unknown[]) => unknown }).connect = (...args: unknown[]) => {
    const started = performance.now();
    const callback = args[0];
    if (typeof callback === "function") {
      return (originalConnect as unknown as (callback: (error: Error | undefined, client: pg.PoolClient, done: (release?: unknown) => void) => void) => void)((error, client, done) => {
        recordMetric("pool_wait_ms", performance.now() - started);
        if (!error && client) observeClient(client);
        (callback as (error: Error | undefined, client: pg.PoolClient, done: (release?: unknown) => void) => void)(error, client, done);
      });
    }
    return originalConnect().then((client) => { observeClient(client); return client; })
      .finally(() => recordMetric("pool_wait_ms", performance.now() - started));
  };
  return pool;
}

export function createPool(connectionString: string, supplied?: DatabaseOptions): pg.Pool {
  const options = supplied ?? defaults();
  const tlsValues = [process.env.DATABASE_TLS_CA_BASE64, process.env.DATABASE_TLS_CERT_BASE64, process.env.DATABASE_TLS_KEY_BASE64];
  if (tlsValues.some(Boolean) && !tlsValues.every(Boolean)) throw new Error("DATABASE_MTLS_CONFIGURATION_INCOMPLETE");
  if (tlsValues.every(Boolean)) {
    const url = new URL(connectionString);
    // node-postgres URL ssl flags otherwise overwrite the explicit mTLS object.
    for (const key of ["sslmode", "sslcert", "sslkey", "sslrootcert"]) url.searchParams.delete(key);
    const pool = new pg.Pool({ connectionString: url.toString(), max: options.poolMax, idleTimeoutMillis: 60_000, connectionTimeoutMillis: options.poolAcquireTimeoutMs,
      statement_timeout: options.statementTimeoutMs, options: `-c lock_timeout=${options.lockTimeoutMs} -c idle_in_transaction_session_timeout=${options.idleTransactionTimeoutMs}`,
      ssl: { ca: Buffer.from(tlsValues[0]!, "base64").toString(), cert: Buffer.from(tlsValues[1]!, "base64").toString(), key: Buffer.from(tlsValues[2]!, "base64").toString(), rejectUnauthorized: true } });
    configuredOptions.set(pool, options);
    return observe(pool);
  }
  const pool = new pg.Pool({ connectionString, max: options.poolMax, idleTimeoutMillis: 30_000, connectionTimeoutMillis: options.poolAcquireTimeoutMs,
    statement_timeout: options.statementTimeoutMs, options: `-c lock_timeout=${options.lockTimeoutMs} -c idle_in_transaction_session_timeout=${options.idleTransactionTimeoutMs}` });
  configuredOptions.set(pool, options);
  return observe(pool);
}

export async function transaction<T>(pool: pg.Pool, work: (client: DbClient) => Promise<T>, isolation = "READ COMMITTED", suppliedMaxAttempts?: number, suppliedDeadlineMs?: number): Promise<T> {
  const options = configuredOptions.get(pool) ?? defaults();
  const maxAttempts = suppliedMaxAttempts ?? options.transactionMaxAttempts;
  const deadlineMs = suppliedDeadlineMs ?? options.transactionDeadlineMs;
  const deadline = performance.now() + deadlineMs;
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
      if ((code === "40001" || code === "40P01") && attempt < maxAttempts) {
        const delay = Math.min(250, 10 * (2 ** (attempt - 1))) + Math.floor(Math.random() * 11);
        recordMetric("transaction_retry", attempt);
        if (performance.now() + delay >= deadline) throw error;
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }
      throw error;
    } finally {
      client.release();
    }
  }
  throw new Error("TRANSACTION_RETRY_EXHAUSTED");
}

export async function readSnapshot<T>(pool: pg.Pool, work: (client: DbClient, asOf: Date) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const time = await client.query<{ as_of: Date }>("SELECT transaction_timestamp() AS as_of");
    const result = await work(client, time.rows[0]!.as_of);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally { client.release(); }
}
