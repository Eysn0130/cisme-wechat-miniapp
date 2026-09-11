import { describe, expect, it, vi } from "vitest";
import type pg from "pg";
import { resetDatabase, resolveTestDatabaseUrl } from "@cisme/testkit";

describe("integration database isolation", () => {
  it("defaults to a dedicated test database instead of the local preview database", () => {
    expect(new URL(resolveTestDatabaseUrl({})).pathname).toBe("/cisme_test");
  });
  it.each(["cisme", "postgres", "cisme_staging", "cisme_production"])("rejects %s before opening a reset connection", (name) => {
    expect(() => resolveTestDatabaseUrl({ DATABASE_URL: `postgres://localhost/${name}` })).toThrow("TEST_DATABASE_REQUIRED");
  });
  it("prefers an explicitly isolated test connection over application configuration", () => {
    expect(resolveTestDatabaseUrl({ TEST_DATABASE_URL: "postgres://localhost/cisme_test", DATABASE_URL: "postgres://localhost/cisme" })).toBe("postgres://localhost/cisme_test");
  });
  it("checks the connected database before issuing destructive SQL", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ name: "cisme" }] });
    await expect(resetDatabase({ query } as unknown as pg.Pool)).rejects.toThrow("TEST_DATABASE_REQUIRED");
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0]![0]).not.toMatch(/DROP|DELETE|TRUNCATE/i);
  });
});
