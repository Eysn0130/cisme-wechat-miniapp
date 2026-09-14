import { loadConfig } from "@cisme/config";

const target = process.argv[2];
const role = process.argv[3];
if (!(["local-stack", "staging-candidate"].includes(target ?? "") && ["api", "worker"].includes(role ?? ""))) {
  throw new Error("Usage: tsx scripts/validate-pr3-runtime-config.ts local-stack|staging-candidate api|worker");
}

const config = loadConfig(process.env);
const errors: string[] = [];
const database = new URL(config.databaseUrl);
if (target === "local-stack") {
  if (config.env !== "development") errors.push("LOCAL_STACK_DEVELOPMENT_ENV_REQUIRED");
  if (database.hostname !== "127.0.0.1" || !/^cisme_pr3_(?:stack|restore)_\d{8}$/.test(decodeURIComponent(database.pathname.slice(1)))) {
    errors.push("LOCAL_STACK_ISOLATED_DATABASE_REQUIRED");
  }
  if (process.env.API_LISTEN_HOST !== "127.0.0.1") errors.push("LOCAL_STACK_LOOPBACK_LISTENER_REQUIRED");
  if (config.objectStorage.driver !== "api_gateway") errors.push("LOCAL_STACK_CONTROLLED_STORAGE_REQUIRED");
} else {
  if (config.env !== "staging" || config.allowDevAdapters) errors.push("STAGING_FAIL_CLOSED_ENV_REQUIRED");
  if (database.hostname === "127.0.0.1" || database.hostname === "localhost") errors.push("STAGING_REMOTE_DATABASE_REQUIRED");
  if (config.objectStorage.driver === "api_gateway") errors.push("STAGING_PERSISTENT_STORAGE_REQUIRED");
}
if (config.commerce.simulatedPayment || config.commerce.formalProtocol || config.selectedTransactionProfile) errors.push("PR3_REAL_MONEY_DISABLED_REQUIRED");
if (config.ugcGoLiveGate) errors.push("PR3_PUBLIC_UGC_DISABLED_REQUIRED");
if ((process.env.RUN_BACKGROUND_WORKER === "true") !== (role === "worker")) errors.push("PR3_SEPARATE_WORKER_ROLE_REQUIRED");

if (errors.length) {
  console.error(JSON.stringify({ ok: false, target, role, errors }));
  process.exitCode = 1;
} else {
  console.log(JSON.stringify({ ok: true, target, role, databaseName: decodeURIComponent(database.pathname.slice(1)),
    storageDriver: config.objectStorage.driver, paymentOutboundEnabled: false, publicUgcEnabled: false,
    externalDeploymentAuthorized: false }));
}
