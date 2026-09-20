import { afterEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import * as metrics from "../../services/api/src/observability.js";
import { installRequestBudgets, currentOperationBudget, dependencySignal } from "../../services/api/src/operationBudget.js";
import { registerCloudHttpTransport } from "../../services/api/src/cloudHttpTransport.js";

const apps: FastifyInstance[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())); });
function app() {
  const result = Fastify({ handlerTimeout: 30 }); apps.push(result);
  installRequestBudgets(result, 30);
  result.addHook("onRoute", route => metrics.registerHttpRoute(route.method, route.url));
  registerCloudHttpTransport(result);
  metrics.installHttpMetrics(result);
  return result;
}

describe("route-complete, bounded and phase-labelled HTTP metrics", () => {
  it("does not silently drop the 97th route and distinguishes methods", () => {
    metrics.resetRuntimeMetrics();
    for (let index = 0; index < 260; index++) {
      const route = `/metrics-fixture/${index}/:id`;
      metrics.registerHttpRoute(["GET", "POST"], route);
      for (const method of ["GET", "POST"]) metrics.recordHttpRequest({ method, route, durationMs: 3, responseBytes: 4, statusCode: 200, coldStart: false });
    }
    const result = metrics.runtimeMetrics().http;
    expect(result.routes["GET /metrics-fixture/259/:id"]).toMatchObject({ total: 1 });
    expect(result.routes["POST /metrics-fixture/259/:id"]).toMatchObject({ total: 1 });
    expect(result.total).toBe(520);
  });
  it("aggregates unregistered URLs without storing their IDs, paths or methods", () => {
    metrics.resetRuntimeMetrics();
    const before = Object.keys(metrics.runtimeMetrics().http.routes).length;
    for (let index = 0; index < 10_000; index++) metrics.recordHttpRequest({ method: `SECRET-${index}`, route: `/member/private-${index}?token=private`, durationMs: 1, responseBytes: 0, statusCode: 404, coldStart: false });
    const result = metrics.runtimeMetrics().http;
    expect(Object.keys(result.routes).length - before).toBeLessThanOrEqual(1);
    expect(result.unmatched).toBe(10_000);
    expect(JSON.stringify(result)).not.toMatch(/SECRET-|private-|token=/);
  });
  it("counts 503 handler timeouts and Cloud business status, with completion separate from onSend", async () => {
    metrics.resetRuntimeMetrics();
    const server = app();
    let cancelled = false, sideEffect = false;
    server.get("/budget-slow", async () => {
      expect(currentOperationBudget()).toBeDefined();
      const signal = dependencySignal(2_000);
      await new Promise<void>(resolve => { signal.addEventListener("abort", () => { cancelled = true; resolve(); }, { once: true }); });
      currentOperationBudget()?.check(); sideEffect = true;
      return { ok: true };
    });
    const response = await server.inject({ url: "/budget-slow", headers: { "x-cisme-transport": "cloud-http-v1" } });
    expect(response.statusCode).toBe(200);
    expect(response.json().cismeHttpError.statusCode).toBe(503);
    await new Promise(resolve => setTimeout(resolve, 5));
    expect(cancelled).toBe(true); expect(sideEffect).toBe(false);
    const result = metrics.runtimeMetrics().http;
    expect(result.routes["GET /budget-slow"]).toMatchObject({ total: 1, errors: 1, timeouts: 1, completed: 1 });
    expect(result.timeouts).toBe(1); expect(result.serverErrors).toBe(1);
    expect(result.completedDurationMs.count).toBe(1);
    expect(result.timingBoundary).toContain("onSend");
  });
  it("isolates concurrent request budgets and does not cancel successful work", async () => {
    const server = app();
    const budgets: object[] = [];
    server.get("/budget-fast/:id", async request => {
      budgets.push(currentOperationBudget()!);
      await Promise.resolve();
      currentOperationBudget()?.check();
      return { id: (request.params as { id: string }).id };
    });
    const [a, b] = await Promise.all([server.inject("/budget-fast/a"), server.inject("/budget-fast/b")]);
    expect(a.statusCode).toBe(200); expect(b.statusCode).toBe(200);
    expect(a.json()).toEqual({ id: "a" }); expect(b.json()).toEqual({ id: "b" });
    expect(budgets[0]).toBeTruthy(); expect(budgets[0]).not.toBe(budgets[1]);
    expect(currentOperationBudget()).toBeUndefined();
  });
});
