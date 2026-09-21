import { describe, expect, it, vi } from "vitest";
import type pg from "pg";
import { resetDatabase, resolveTestDatabaseUrl, testPool } from "@cisme/testkit";

describe("integration database isolation", () => {
  it("rejects missing test targets and never falls back to an application or default database", () => {
    for(const env of [{}, {DATABASE_URL:"postgres://localhost/cisme_test"}]){
      expect(()=>resolveTestDatabaseUrl(env)).toThrow("EXPLICIT_TEST_DATABASE_URL_REQUIRED");
      expect(()=>testPool(env)).toThrow("EXPLICIT_TEST_DATABASE_URL_REQUIRED");
    }
  });
  it.each(["cisme", "postgres", "cisme_staging", "cisme_production"])("rejects %s before opening a reset connection", (name) => {
    expect(() => resolveTestDatabaseUrl({ TEST_DATABASE_URL: `postgres://localhost/${name}` })).toThrow("TEST_DATABASE_REQUIRED");
  });
  it("prefers an explicitly isolated test connection over application configuration", () => {
    expect(resolveTestDatabaseUrl({ TEST_DATABASE_URL: "postgres://localhost/cisme_test", DATABASE_URL: "postgres://localhost/cisme" })).toBe("postgres://localhost/cisme_test");
  });
  it("checks the connected database before issuing destructive SQL", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ name: "cisme" }] });
    await expect(resetDatabase({ query } as unknown as pg.Pool, {TEST_DATABASE_URL:"postgres://localhost/cisme_test"})).rejects.toThrow("TEST_DATABASE_REQUIRED");
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0]![0]).not.toMatch(/DROP|DELETE|TRUNCATE/i);
  });
  it("does not query or reset a pool unless its test target was explicit",async()=>{
    const query=vi.fn();
    await expect(resetDatabase({query} as unknown as pg.Pool,{})).rejects.toThrow("EXPLICIT_TEST_DATABASE_URL_REQUIRED");
    expect(query).not.toHaveBeenCalled();
  });
  it("rejects a different connected test database before destructive SQL",async()=>{
    const query=vi.fn().mockResolvedValue({rows:[{name:"cisme_other_test"}]});
    await expect(resetDatabase({query} as unknown as pg.Pool,{TEST_DATABASE_URL:"postgres://localhost/cisme_expected_test"})).rejects.toThrow("TEST_DATABASE_TARGET_MISMATCH");
    expect(query).toHaveBeenCalledTimes(1);
  });
});
