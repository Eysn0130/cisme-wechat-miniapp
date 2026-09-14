import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const exec = promisify(execFile);
const baseEnv = {
  ...process.env,
  APP_ENV: "development",
  ALLOW_DEV_ADAPTERS: "true",
  API_LISTEN_HOST: "127.0.0.1",
  DATABASE_URL: "postgres://synthetic:synthetic@127.0.0.1:55433/cisme_pr3_stack_20260914",
  APP_SESSION_SECRET: "synthetic-session",
  UPLOAD_TOKEN_SECRET: "synthetic-upload",
  OBJECT_STORAGE_DRIVER: "api_gateway",
  RUN_BACKGROUND_WORKER: "false",
  UGC_GO_LIVE_GATE: "false",
  COMMERCE_SIMULATED_PAYMENT_ENABLED: "false",
  COMMERCE_FORMAL_PROTOCOL_CONFIG_ENABLED: "false",
  SELECTED_TRANSACTION_PROFILE: ""
};

async function validate(env: NodeJS.ProcessEnv, role = "api") {
  return exec("./node_modules/.bin/tsx", ["scripts/validate-pr3-runtime-config.ts", "local-stack", role], { env })
    .then(({ stdout }) => ({ code: 0, output: JSON.parse(stdout) as Record<string, any> }))
    .catch((error: { code: number; stderr: string }) => ({ code: error.code, output: JSON.parse(error.stderr) as Record<string, any> }));
}

it("validates an isolated local API and refuses the wrong worker role or database", async () => {
  expect(await validate(baseEnv)).toMatchObject({ code: 0, output: { ok: true, externalDeploymentAuthorized: false } });
  expect(await validate({ ...baseEnv, RUN_BACKGROUND_WORKER: "true" })).toMatchObject({ code: 1,
    output: { errors: expect.arrayContaining(["PR3_SEPARATE_WORKER_ROLE_REQUIRED"]) } });
  expect(await validate({ ...baseEnv, DATABASE_URL: "postgres://synthetic:synthetic@127.0.0.1:55432/cisme" })).toMatchObject({ code: 1,
    output: { errors: expect.arrayContaining(["LOCAL_STACK_ISOLATED_DATABASE_REQUIRED"]) } });
  expect(await validate({ ...baseEnv, RUN_BACKGROUND_WORKER: "true" }, "worker")).toMatchObject({ code: 0,
    output: { ok: true, role: "worker" } });
});
