import { readFileSync } from "node:fs";
import { afterAll, expect, it } from "vitest";
import { loadConfig } from "@cisme/config";
import { TEST_DATABASE_URL, testPool } from "@cisme/testkit";
import { createApp } from "../../services/api/src/server";
import { createApiGatewayStorage } from "../../services/api/src/storage";
import { registeredOperations, registeredSourceOperations } from "../../scripts/route-contract-lib";

const pool=testPool();
afterAll(async()=>{await pool.end();});

it("the source route inventory equals Fastify's actual registered methods",async()=>{
  const config=loadConfig({APP_ENV:"test",DATABASE_URL:TEST_DATABASE_URL,APP_SESSION_SECRET:"route-inventory-session",
    ADMIN_API_TOKEN:"route-inventory-admin",UPLOAD_TOKEN_SECRET:"route-inventory-upload",OBJECT_STORAGE_DRIVER:"api_gateway"});
  const app=await createApp({config,pool,storage:createApiGatewayStorage(config)});
  try{
    await app.ready();
    const actual=registeredOperations(app.printRoutes({commonPrefix:false,includeHooks:false}));
    const source=registeredSourceOperations(readFileSync("services/api/src/server.ts","utf8"));
    expect(actual).toEqual(source);
  }finally{await app.close();}
});
