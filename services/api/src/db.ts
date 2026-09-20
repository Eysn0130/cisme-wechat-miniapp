import pg from "pg";
import { DomainError } from "@cisme/domain";
import { OperationBudget, currentOperationBudget, runWithOperationBudget } from "./operationBudget.js";
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

/** pg 8.23 has no public AbortSignal query API. Its query_timeout only stops
 * waiting. We instead set server-side timeouts, and release(true) destroys a
 * non-pipelined active connection on cancellation. No SQL is left in a raced
 * promise and no such connection is returned to the healthy pool. */
async function acquireWithinBudget(pool: pg.Pool, budget: OperationBudget): Promise<pg.PoolClient> {
  budget.check();
  return new Promise((resolve, reject) => {
    let settled = false;
    const cancel = () => {
      if (settled) return;
      settled = true;
      try { budget.check(); } catch (error) { reject(error); }
    };
    budget.signal.addEventListener("abort", cancel, { once: true });
    // pg-pool cannot cancel an individual queued acquisition publicly. Its
    // configured connectionTimeoutMillis bounds the queue; a late grant is
    // returned immediately and can never execute SQL for the expired caller.
    pool.connect().then(client => {
      budget.signal.removeEventListener("abort", cancel);
      if (settled) { client.release(); return; }
      settled = true;
      try { budget.check(); resolve(client); } catch (error) { client.release(); reject(error); }
    }, error => {
      budget.signal.removeEventListener("abort", cancel);
      if (!settled) { settled = true; reject(error); }
    });
    if (budget.signal.aborted) cancel();
  });
}

interface BudgetLease {
  client: DbClient;
  raw: pg.PoolClient;
  released(): boolean;
  drain(): Promise<void>;
  release(discard?: boolean): Promise<void>;
}
async function leaseWithinBudget(pool: pg.Pool, budget: OperationBudget, options: DatabaseOptions, local: boolean): Promise<BudgetLease> {
  const raw = await acquireWithinBudget(pool, budget);
  let released = false, closing = false;
  let tail = Promise.resolve();
  let cleanup: Promise<void> | undefined;
  const rawQuery = raw.query.bind(raw) as (...args: any[]) => Promise<any>;
  const releaseOnce = (discard: boolean) => {
    if (released) return;
    released = true;
    budget.signal.removeEventListener("abort", cancel);
    raw.removeListener?.("error", connectionFailed);
    raw.release(discard);
  };
  const cancel = () => releaseOnce(true);
  const connectionFailed = () => releaseOnce(true);
  raw.on?.("error", connectionFailed);
  budget.signal.addEventListener("abort", cancel, { once: true });
  if (budget.signal.aborted) cancel();
  const assertUsable = () => {
    budget.check();
    if (released || closing) throw new DomainError("DATABASE_LEASE_CLOSED", "Database connection is no longer available", 503);
  };
  const query = (...input: any[]) => {
    const callback = typeof input.at(-1) === "function" ? input.pop() as (error: unknown, result?: unknown) => void : undefined;
    const result = tail.then(async () => {
      assertUsable();
      const remaining = budget.remaining();
      // A transaction's SET LOCAL rolls back with it. Standalone leases reset
      // session settings before their one healthy release (below).
      // An aborted PostgreSQL transaction rejects even SELECT set_config.
      // ROLLBACK / ROLLBACK TO must reach the server first so existing
      // savepoint recovery can restore a usable transaction. This does not
      // renew the absolute budget or detach its active-connection cancellation.
      if (!/^\s*ROLLBACK\b/i.test(queryText(input))) {
        await rawQuery("SELECT set_config('statement_timeout',$1,$3), set_config('lock_timeout',$2,$3)", [String(Math.min(options.statementTimeoutMs, remaining)), String(Math.min(options.lockTimeoutMs, remaining)), local]);
      }
      assertUsable();
      return rawQuery(...input);
    });
    tail = result.then(() => {}, () => {});
    if (callback) { void result.then(value => callback(null, value), error => callback(error)); return; }
    return result;
  };
  const release = (discard = false): Promise<void> => {
    if (cleanup) return cleanup;
    closing = true;
    cleanup = (async () => {
      await tail;
      if (released) return;
      if (discard || budget.signal.aborted) { releaseOnce(true); return; }
      if (!local) {
        try {
          budget.check();
          await rawQuery("SELECT set_config('statement_timeout',$1,false), set_config('lock_timeout',$2,false)", [String(options.statementTimeoutMs), String(options.lockTimeoutMs)]);
        } catch { releaseOnce(true); return; }
      }
      releaseOnce(false);
    })();
    return cleanup;
  };
  const client = new Proxy(raw, { get(target, property) {
    if (property === "query") return query;
    if (property === "release") return (error?: Error | boolean) => { void release(Boolean(error)); };
    const value = Reflect.get(target, property, target) as unknown;
    return typeof value === "function" ? value.bind(target) : value;
  } });
  return { client, raw, released: () => released, drain: () => tail, release };
}

const underlyingPools = new WeakMap<object, pg.Pool>();
/** Preserve service APIs, including their manual read leases, while binding all
 * HTTP-originated pool/SQL work to the current operation's remaining budget. */
export function requestBudgetPool(pool: pg.Pool, options: DatabaseOptions): pg.Pool {
  configuredOptions.set(pool, options);
  const proxy = new Proxy(pool, { get(target, property) {
    if (property === "connect") return (callback?: (error: unknown, client?: DbClient, done?: (error?: Error | boolean) => void) => void) => {
      const budget = currentOperationBudget();
      if (!budget) return callback ? target.connect(callback as any) : target.connect();
      const pending = leaseWithinBudget(target, budget, options, false).then(lease => lease.client);
      if (callback) { void pending.then(client => callback(null, client, client.release.bind(client)), error => callback(error)); return; }
      return pending;
    };
    if (property === "query") return (...input: any[]) => {
      const budget = currentOperationBudget();
      if (!budget) return (target.query as (...args: any[]) => unknown)(...input);
      const callback = typeof input.at(-1) === "function" ? input.pop() as (error: unknown, result?: unknown) => void : undefined;
      const pending = (async () => {
        const lease = await leaseWithinBudget(target, budget, options, false);
        let discard = false;
        try { return await (lease.client.query as (...args: any[]) => Promise<unknown>)(...input); }
        catch (error) { discard = true; throw error; }
        finally { await lease.release(discard); }
      })();
      if (callback) { void pending.then(value => callback(null, value), error => callback(error)); return; }
      return pending;
    };
    const value = Reflect.get(target, property, target) as unknown;
    return typeof value === "function" ? value.bind(target) : value;
  } });
  underlyingPools.set(proxy, pool);
  configuredOptions.set(proxy, options);
  return proxy;
}

export async function transaction<T>(pool: pg.Pool, work: (client: DbClient) => Promise<T>, isolation = "READ COMMITTED", suppliedMaxAttempts?: number, suppliedDeadlineMs?: number): Promise<T> {
  if (!["READ COMMITTED", "REPEATABLE READ", "SERIALIZABLE", "REPEATABLE READ READ ONLY"].includes(isolation)) throw new Error("INVALID_TRANSACTION_ISOLATION");
  const options = configuredOptions.get(pool) ?? defaults();
  const maxAttempts = suppliedMaxAttempts ?? options.transactionMaxAttempts;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) throw new Error("INVALID_TRANSACTION_ATTEMPTS");
  const budget = new OperationBudget(suppliedDeadlineMs ?? options.transactionDeadlineMs);
  const actualPool = underlyingPools.get(pool) ?? pool;
  try {
    return await runWithOperationBudget(budget, async () => {
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        budget.check();
        const lease = await leaseWithinBudget(actualPool, budget, options, true);
        let retry = false, discard = false, committing = false;
        try {
          budget.check();
          await lease.raw.query(`BEGIN ISOLATION LEVEL ${isolation}`);
          const result = await work(lease.client);
          await lease.drain();
          budget.check(); // Work, SQL, pool waiting and retries share this deadline.
          if (lease.released()) throw new DomainError("DATABASE_LEASE_CLOSED", "Database connection was cancelled", 503);
          committing = true;
          const completion = await lease.raw.query("COMMIT");
          if (completion.command === "ROLLBACK") {
            committing = false;
            throw new DomainError("TRANSACTION_ABORTED", "数据库已回滚本次事务；未生成本次业务事实", 503);
          }
          // A confirmed COMMIT remains a fact even if the HTTP response is lost.
          return result;
        } catch (error) {
          const code = (error as { code?: string })?.code;
          const conflict = code === "40001" || code === "40P01";
          if (committing && !conflict) {
            discard = true;
            throw new DomainError("TRANSACTION_OUTCOME_UNKNOWN", "提交结果待确认；请用原幂等键或查询接口恢复，不要当作未执行", 503);
          }
          if (!lease.released()) {
            try { await lease.raw.query("ROLLBACK"); }
            catch { discard = true; throw new DomainError("TRANSACTION_ROLLBACK_FAILED", "事务回滚未确认，连接已隔离；请查询最终业务状态", 503); }
          }
          if (budget.signal.aborted) budget.check();
          if (!conflict || attempt === maxAttempts) throw error;
          retry = true;
        } finally { await lease.release(discard); }
        if (retry) {
          // No checked-out connection is held while waiting for a retry.
          const delay = Math.min(250, 10 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 11);
          if (budget.remaining() <= delay) throw new DomainError("OPERATION_DEADLINE_EXCEEDED", "事务重试预算已耗尽，请查询后安全重试", 503);
          recordMetric("transaction_retry", attempt);
          await new Promise<void>((resolve, reject) => {
            const done = () => { budget.signal.removeEventListener("abort", cancel); resolve(); };
            const timer = setTimeout(done, delay);
            const cancel = () => { clearTimeout(timer); budget.signal.removeEventListener("abort", cancel); try { budget.check(); } catch (error) { reject(error); } };
            budget.signal.addEventListener("abort", cancel, { once: true });
            if (budget.signal.aborted) cancel();
          });
        }
      }
      throw new Error("TRANSACTION_RETRY_EXHAUSTED");
    });
  } finally { budget.dispose(); }
}

export async function readSnapshot<T>(pool: pg.Pool, work: (client: DbClient, asOf: Date) => Promise<T>): Promise<T> {
  return transaction(pool, async client => {
    const time = await client.query<{ as_of: Date }>("SELECT transaction_timestamp() AS as_of");
    return work(client, time.rows[0]!.as_of);
  }, "REPEATABLE READ READ ONLY");
}
