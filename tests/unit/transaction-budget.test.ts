import { afterEach, describe, expect, it, vi } from "vitest";
import type pg from "pg";
import { transaction, readSnapshot } from "../../services/api/src/db";
import { OperationBudget, runWithOperationBudget, dependencySignal, currentOperationBudget } from "../../services/api/src/operationBudget";

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
function fixture(behavior: (text: string, values?: unknown[]) => Promise<any> = async () => ({ rows: [] })) {
  const queries: string[] = [], releases: boolean[] = [];
  const client = {
    query: vi.fn(async (text: string, values?: unknown[]) => { queries.push(text); return behavior(text, values); }),
    release: vi.fn((discard?: boolean) => { releases.push(Boolean(discard)); })
  };
  const pool = { connect: vi.fn(async () => client) };
  return { pool: pool as unknown as pg.Pool, client, queries, releases };
}
afterEach(() => vi.restoreAllMocks());

describe("PERF-05/06 bounded transaction ownership", () => {
  it.each(["40001", "40P01"])("releases before backoff, retries %s and releases each lease once", async code => {
    const f = fixture(); let attempts = 0; const atBackoff: number[] = [];
    const original = globalThis.setTimeout;
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: any, delay: number, ...args: any[]) => {
      if (delay >= 10 && delay < 300) atBackoff.push(f.releases.length);
      return original(fn, delay, ...args);
    }) as typeof setTimeout);
    expect(await transaction(f.pool, async () => { if (++attempts === 1) throw { code }; return "saved"; }, "SERIALIZABLE", 3, 1000)).toBe("saved");
    expect(atBackoff).toEqual([1]); expect(f.releases).toEqual([false, false]); expect(attempts).toBe(2);
  });
  it("does not commit when work consumes the absolute budget", async () => {
    let now = 100; vi.spyOn(performance, "now").mockImplementation(() => now);
    const f = fixture();
    await expect(transaction(f.pool, async () => { now += 50; return "uncommitted"; }, "READ COMMITTED", 1, 10)).rejects.toMatchObject({ code: "OPERATION_DEADLINE_EXCEEDED" });
    expect(f.queries).not.toContain("COMMIT"); expect(f.queries).toContain("ROLLBACK"); expect(f.releases).toHaveLength(1);
  });
  it("returns a late queued grant without running SQL after the pool-wait deadline", async () => {
    const f = fixture(); const connect = new Promise<unknown>(resolve => setTimeout(() => resolve(f.client), 60));
    (f.pool.connect as any).mockReturnValue(connect);
    await expect(transaction(f.pool, async () => "late", "READ COMMITTED", 1, 20)).rejects.toMatchObject({ code: "OPERATION_DEADLINE_EXCEEDED" });
    await sleep(75); expect(f.queries).toEqual([]); expect(f.releases).toEqual([false]);
  });
  it("awaits the backend timeout fallback before discarding an unsupported cancel transport", async () => {
    const f = fixture(async text => {
      if (text === "SELECT synthetic_slow") { await sleep(45); throw { code: "57014" }; }
      return { rows: [] };
    });
    const started = performance.now();
    await expect(transaction(f.pool, client => client.query("SELECT synthetic_slow"), "READ COMMITTED", 1, 25)).rejects.toMatchObject({ code: "OPERATION_DEADLINE_EXCEEDED" });
    expect(performance.now() - started).toBeGreaterThanOrEqual(40);
    expect(f.releases).toEqual([true]); expect(f.queries).not.toContain("COMMIT"); expect(f.queries).toContain("ROLLBACK");
  });
  it("bounds a lost cancellation acknowledgement and reports uncertainty rather than pretending SQL stopped", async () => {
    let rejectQuery: ((error: unknown) => void) | undefined;
    const f = fixture(async text => {
      if (text === "SELECT lost_ack") return new Promise((_resolve, reject) => { rejectQuery = reject; });
      return { rows: [] };
    });
    f.client.release.mockImplementation(discard => {
      f.releases.push(Boolean(discard)); if (discard) rejectQuery?.({ code: "CONNECTION_ENDED" });
    });
    await expect(transaction(f.pool, client => client.query("SELECT lost_ack"), "READ COMMITTED", 1, 15))
      .rejects.toMatchObject({ code: "DATABASE_CANCELLATION_UNCONFIRMED" });
    expect(f.releases).toEqual([true]); expect(f.queries).not.toContain("COMMIT");
    expect(f.pool.connect).toHaveBeenCalledOnce();
  });
  it("discards a rollback failure, preserves a distinct error and never retries it", async () => {
    const f = fixture(async text => { if (text === "ROLLBACK") throw new Error("synthetic rollback disconnect"); return { rows: [] }; });
    await expect(transaction(f.pool, async () => { throw { code: "40001" }; })).rejects.toMatchObject({ code: "TRANSACTION_ROLLBACK_FAILED" });
    expect(f.releases).toEqual([true]); expect(f.pool.connect).toHaveBeenCalledTimes(1);
  });
  it("never retries or labels an unacknowledged COMMIT as not executed", async () => {
    const f = fixture(async text => { if (text === "COMMIT") throw { code: "ECONNRESET" }; return { rows: [] }; });
    await expect(transaction(f.pool, client => client.query("INSERT synthetic_fact"))).rejects.toMatchObject({ code: "TRANSACTION_OUTCOME_UNKNOWN", status: 503 });
    expect(f.releases).toEqual([true]); expect(f.pool.connect).toHaveBeenCalledTimes(1); expect(f.queries).not.toContain("ROLLBACK");
  });
  it("does not call a server ROLLBACK command tag a successful COMMIT", async () => {
    const f = fixture(async text => ({ command: text === "COMMIT" ? "ROLLBACK" : text, rows: [] }));
    await expect(transaction(f.pool, async () => "not saved")).rejects.toMatchObject({code: "TRANSACTION_ABORTED"});
    expect(f.releases).toEqual([false]); expect(f.pool.connect).toHaveBeenCalledTimes(1);
  });
  it("retains bounded retries for a server-confirmed serialization failure at COMMIT", async () => {
    let commits = 0;
    const f = fixture(async text => { if (text === "COMMIT" && ++commits === 1) throw { code: "40001" }; return { rows: [] }; });
    expect(await transaction(f.pool, async () => "ok")).toBe("ok"); expect(commits).toBe(2); expect(f.releases).toEqual([false, false]);
  });
  it("releases all attempts once when conflicts are exhausted", async () => {
    const f = fixture();
    await expect(transaction(f.pool, async () => { throw { code: "40P01" }; }, "SERIALIZABLE", 3, 2000)).rejects.toMatchObject({ code: "40P01" });
    expect(f.releases).toEqual([false, false, false]);
  });
  it("shrinks statement and lock timeouts across queries without restarting the budget", async () => {
    let now = 100; vi.spyOn(performance, "now").mockImplementation(() => now);
    const budgets: number[] = [];
    const f = fixture(async (text, values) => { if (text.includes("set_config")) budgets.push(Number(values![0])); return { rows: [] }; });
    await transaction(f.pool, async client => { await client.query("SELECT 1"); now += 30; await client.query("SELECT 2"); }, "READ COMMITTED", 1, 100);
    expect(budgets).toEqual([100, 70]); expect(f.releases).toEqual([false]);
  });
  it("applies the same deadline and rollback discipline to consistent read snapshots", async () => {
    const instant = new Date("2026-09-20T00:00:00Z");
    const f = fixture(async text => ({ rows: text.includes("transaction_timestamp") ? [{ as_of: instant }] : [] }));
    expect(await readSnapshot(f.pool, async (_client, asOf) => asOf)).toBe(instant);
    expect(f.queries[0]).toBe("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY"); expect(f.queries.at(-1)).toBe("COMMIT");
  });
  it("inherits a parent's deadline for both SQL and external dependencies without leaking context", async () => {
    const parent = new OperationBudget(1000);
    const f = fixture();
    try {
      await runWithOperationBudget(parent, () => transaction(f.pool, async () => {
        expect(currentOperationBudget()!.deadline).toBeLessThanOrEqual(parent.deadline);
        expect(dependencySignal(15_000)).toBe(currentOperationBudget()!.signal);
        return "ok";
      }, "READ COMMITTED", 1, 5000));
      expect(currentOperationBudget()).toBeUndefined();
    } finally { parent.dispose(); }
  });
});
