import { createServer } from "node:http";
import { once } from "node:events";
import { describe, expect, it } from "vitest";
import { localPerformanceDatabase, loopbackPopulation, timeoutResponse } from "../../scripts/performance-measurement";

describe("performance measurement safety and outcomes", () => {
  it("requires an explicitly named local synthetic database", () => {
    expect(() => localPerformanceDatabase({})).toThrow("EXPLICIT_LOCAL");
    expect(() => localPerformanceDatabase({ TEST_DATABASE_URL: "postgres://localhost/cisme_production" })).toThrow("TEST_DATABASE_REQUIRED");
    for (const url of ["postgres://remote.invalid/cisme_test", "postgres://localhost/cisme_test?host=remote.invalid", "postgres://localhost/cisme_test?hostaddr=203.0.113.1"]) {
      expect(() => localPerformanceDatabase({ TEST_DATABASE_URL: url })).toThrow("LOCAL_CISME_TEST_DATABASE_REQUIRED");
    }
    expect(localPerformanceDatabase({ TEST_DATABASE_URL: "postgres://127.0.0.1/cisme_native_pr4_test" })).toContain("127.0.0.1");
  });
  it("classifies actual timeout codes including handler 503, but not arbitrary successful content", () => {
    expect(timeoutResponse(503, JSON.stringify({ error: { code: "FST_ERR_HANDLER_TIMEOUT" } }))).toBe(true);
    expect(timeoutResponse(503, JSON.stringify({ error: { code: "HANDLER_DEADLINE_EXCEEDED" } }))).toBe(true);
    expect(timeoutResponse(503, JSON.stringify({ code: "SERVICE_UNAVAILABLE" }))).toBe(false);
    expect(timeoutResponse(429, "{}")).toBe(false);
    expect(timeoutResponse(200, JSON.stringify({ code: "HANDLER_DEADLINE_EXCEEDED" }))).toBe(false);
    expect(timeoutResponse(504, "not json")).toBe(true);
  });
  it.runIf(process.platform === "linux")("uses real separate loopback sources without spoofing proxy headers", async () => {
    const sources: string[] = [];
    const server = createServer((request, response) => {
      sources.push(request.socket.remoteAddress!);
      expect(request.headers["x-forwarded-for"]).toBeUndefined();
      response.end("ok");
    }).listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const clients = loopbackPopulation(2);
    try {
      expect((await clients.send(address, 0)).status).toBe(200);
      expect((await clients.send(address, 1)).status).toBe(200);
      expect(sources).toEqual(["127.1.0.1", "127.1.0.2"]);
      await expect(clients.send("https://production.invalid/", 0)).rejects.toThrow("LOCAL_HTTP");
    } finally { clients.close(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });
});
