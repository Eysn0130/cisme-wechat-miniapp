import { readFileSync } from "node:fs";
import yaml from "js-yaml";
import { expect, it } from "vitest";
import type pg from "pg";
import { loadConfig } from "@cisme/config";
import { createApp } from "../../services/api/src/server.js";
import type { ObjectStorage } from "../../services/api/src/storage.js";
import { runtimeMetrics } from "../../services/api/src/observability.js";
it("pre-registers every OpenAPI method/template rather than only routes that happened to receive traffic",async()=>{
  const config=loadConfig({APP_ENV:"test",DATABASE_URL:"postgres://unused",APP_SESSION_SECRET:"route-test",ADMIN_API_TOKEN:"route-test",UPLOAD_TOKEN_SECRET:"route-test"});
  const pool={connect:()=>{throw Error("Static registration must not query DB");},query:()=>{throw Error("Static registration must not query DB");}} as unknown as pg.Pool;
  const app=await createApp({config,pool,storage:{} as ObjectStorage});
  try {
    await app.ready();
    const document=yaml.load(readFileSync("openapi/openapi.yaml","utf8")) as {paths:Record<string,Record<string,unknown>>};
    const routes=runtimeMetrics().http.routes;
    let count=0;
    for(const [path,operations]of Object.entries(document.paths))for(const method of Object.keys(operations))if(["get","post","put","patch","delete","options","head"].includes(method)){
      count++;expect(routes[`${method.toUpperCase()} ${path.replace(/\{([^}]+)\}/g,":$1")}`],`${method} ${path}`).toBeDefined();
    }
    expect(count).toBe(254);expect(runtimeMetrics().http.registeredRouteCount).toBeGreaterThanOrEqual(count);
  } finally {await app.close();}
});
