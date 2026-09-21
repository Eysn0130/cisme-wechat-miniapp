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
  it("validates an explicit exported target before consumers can create their own pools",async()=>{
    vi.stubEnv("TEST_DATABASE_URL","postgres://localhost/cisme_production");vi.resetModules();
    try { await expect(import("@cisme/testkit")).rejects.toThrow("TEST_DATABASE_REQUIRED"); }
    finally { vi.unstubAllEnvs();vi.resetModules(); }
  });
  it("does not query or reset a pool unless its test target was explicit",async()=>{
    const query=vi.fn();
    await expect(resetDatabase({query} as unknown as pg.Pool,{})).rejects.toThrow("EXPLICIT_TEST_DATABASE_URL_REQUIRED");
    expect(query).not.toHaveBeenCalled();
  });
  it("refuses even an explicit legacy test target before connecting",async()=>{
    const connect=vi.fn();
    await expect(resetDatabase({connect} as unknown as pg.Pool,{TEST_DATABASE_URL:"postgres://localhost/cisme_test"})).rejects.toThrow("DISPOSABLE_TEST_ENDPOINT_REQUIRED");
    expect(connect).not.toHaveBeenCalled();
  });
});
