import { afterEach, expect, it, vi } from "vitest";
import type pg from "pg";
import { transaction } from "../../services/api/src/db";

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

it("allows savepoint recovery after a SQL failure without inserting rejected SQL before rollback", async () => {
  let aborted = false;
  const f = fixture(async text => {
    if (/^ROLLBACK TO SAVEPOINT/.test(text)) { aborted = false; return { rows: [] }; }
    if (aborted && text !== "ROLLBACK") throw { code: "25P02" };
    if (text === "INSERT synthetic_duplicate") { aborted = true; throw { code: "23505" }; }
    return { rows: [], command: text };
  });
  const result = await transaction(f.pool, async client => {
    await client.query("SAVEPOINT recoverable_step");
    await expect(client.query("INSERT synthetic_duplicate")).rejects.toMatchObject({ code: "23505" });
    await client.query("ROLLBACK TO SAVEPOINT recoverable_step");
    await client.query("RELEASE SAVEPOINT recoverable_step");
    await client.query("INSERT synthetic_recovered_fact");
    return "saved";
  });
  expect(result).toBe("saved");
  const failed = f.queries.indexOf("INSERT synthetic_duplicate");
  expect(f.queries[failed + 1]).toBe("ROLLBACK TO SAVEPOINT recoverable_step");
  expect(f.queries.at(-1)).toBe("COMMIT");
  expect(f.releases).toEqual([false]);
});
