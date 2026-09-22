import { readFileSync } from "node:fs";
import yaml from "js-yaml";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import type pg from "pg";
import { loadConfig } from "@cisme/config";
import { createApp } from "../../services/api/src/server.js";
import type { ObjectStorage } from "../../services/api/src/storage.js";
// Authentication breadth, not subject/object/field/action authorization proof.
// Enumerate the current contract and exercise the actual mounted Fastify routes.
type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS";
type Operation = { security?: Array<Record<string, unknown>> };
const document=yaml.load(readFileSync("openapi/openapi.yaml","utf8")) as {paths:Record<string,Record<string,Operation>>};
const methods=["get","post","put","patch","delete","head","options"];
const routes=Object.entries(document.paths).flatMap(([path,operations])=>Object.entries(operations)
  .filter(([method,op])=>methods.includes(method)&&op.security?.length===1&&"session" in op.security[0]!)
  .map(([method])=>({method:method.toUpperCase() as Method,path})));
const accesses={query:vi.fn(()=>{throw Error("Unauthenticated request reached database");}),connect:vi.fn(()=>{throw Error("Unauthenticated request reached database");})};
let app:Awaited<ReturnType<typeof createApp>>;
beforeAll(async()=>{
  const config=loadConfig({APP_ENV:"test",DATABASE_URL:"postgres://unused",APP_SESSION_SECRET:"route-test",ADMIN_API_TOKEN:"route-test",UPLOAD_TOKEN_SECRET:"route-test"});
  app=await createApp({config,pool:accesses as unknown as pg.Pool,storage:{} as ObjectStorage});await app.ready();
});
afterAll(async()=>{await app?.close();});
it("retains the explicit authentication denominator",()=>{expect(routes).toHaveLength(203);});
it.each(routes)("rejects missing and invalid authentication before data access: $method $path",async({method,path})=>{
  const index=routes.findIndex(r=>r.method===method&&r.path===path);
  const url=path.replace(/\{[^}]+\}/g,"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
  for(const authorization of [undefined,"Bearer invalid-synthetic-session"]){
    const result=await app.inject({method,url,remoteAddress:`192.0.2.${index+1}`,headers:authorization?{authorization}:{},
      ...(["GET","HEAD","OPTIONS"].includes(method)?{}:{payload:{}})});
    expect(result.statusCode,`${method} ${path}: ${result.body}`).toBe(401);
  }
  expect(accesses.query).not.toHaveBeenCalled();expect(accesses.connect).not.toHaveBeenCalled();
});
