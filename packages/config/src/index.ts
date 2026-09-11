export type AppEnvironment = "development" | "test" | "staging" | "production";
export type TransactionProfile = "MAKE" | "BUY" | null;
export const implementedTransactionProfiles: ReadonlySet<Exclude<TransactionProfile, null>> = new Set();
export const CANONICAL_WECHAT_MINIPROGRAM_APP_ID = "wx4eac2d4fb11d299b";

export interface AppConfig {
  env: AppEnvironment;
  port: number;
  databaseUrl: string;
  allowDevAdapters: boolean;
  devClock: string | null;
  sessionSecret: string;
  adminApiToken: string;
  contacts: { encryptionKey: string | null; hashKey: string | null; keyVersion: string };
  wechat: { appId: string | null; appSecret: string | null; phoneBindingEnabled: boolean };
  objectStorage: {
    profile: string | null;
    driver: "s3" | "api_gateway" | "s3_gateway" | "cos_gateway";
    endpoint: string | null;
    region: string;
    bucket: string;
    accessKeyId: string | null;
    secretAccessKey: string | null;
    uploadTokenSecret: string;
  };
  selectedTransactionProfile: TransactionProfile;
  pointsRedemptionEnabled: boolean;
  pointsRedemptionApprovalExpiresAt: string | null;
  ugcGoLiveGate: boolean;
  pointsRulesEnabled: boolean;
  pointsRuleIds: string[];
  pointsFinanceApprovalId: string | null;
  pointsFinanceApprovalExpiresAt: string | null;
  pointsHoldDays: number;
  pointsExpiryDays: number;
  carePausePolicy: { version: string | null; maxDays: number; reasonCodes: string[] };
  database: {
    poolMax: number;
    globalConnectionBudget: number;
    instanceCount: number;
    poolAcquireTimeoutMs: number;
    statementTimeoutMs: number;
    lockTimeoutMs: number;
    idleTransactionTimeoutMs: number;
    transactionDeadlineMs: number;
    transactionMaxAttempts: number;
  };
  api: { routeDeadlineMs: number };
  observability: { logLevel: "silent" | "error" | "warn" | "info" | "debug" };
  media: { directUploadEnabled: boolean };
  commerce: { orderFlowEnabled: boolean; quoteTtlMinutes: number; pendingOrderTtlMinutes: number };
}

function bool(value: string | undefined, fallback = false): boolean {
  if (value === undefined) return fallback;
  return value === "true";
}

function required(name: string, value: string | undefined): string {
  if (!value) throw new Error(`CONFIG_MISSING:${name}`);
  return value;
}

function integer(name: string, value: string | undefined, fallback: number, minimum: number, maximum: number): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) throw new Error(`CONFIG_INVALID:${name}`);
  return parsed;
}

export function assertPointsRedemptionReady(env: NodeJS.ProcessEnv, selectedTransactionProfile: TransactionProfile): void {
  if (!bool(env.POINTS_REDEMPTION_ENABLED)) return;
  const redemptionGates = ["POINTS_PREPARE_READY", "POINTS_COMMIT_READY", "POINTS_RELEASE_READY", "POINTS_REFUND_ALLOCATION_READY"];
  const approvalExpiresAt = env.POINTS_REDEMPTION_APPROVAL_EXPIRES_AT?.trim() || null;
  const approvalExpiryTime = approvalExpiresAt ? Date.parse(approvalExpiresAt) : Number.NaN;
  if (
    !selectedTransactionProfile ||
    !env.POINTS_REDEMPTION_APPROVAL_ID ||
    !Number.isFinite(approvalExpiryTime) ||
    approvalExpiryTime <= Date.now() ||
    redemptionGates.some((name) => !bool(env[name]))
  ) {
    throw new Error("FAIL_CLOSED:POINTS_REDEMPTION_INCOMPLETE");
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const appEnv = (env.APP_ENV ?? "development") as AppEnvironment;
  if (!["development", "test", "staging", "production"].includes(appEnv)) throw new Error("CONFIG_INVALID:APP_ENV");
  const allowDevAdapters = bool(env.ALLOW_DEV_ADAPTERS, appEnv !== "production" && appEnv !== "staging");
  if ((appEnv === "production" || appEnv === "staging") && allowDevAdapters) throw new Error("FAIL_CLOSED:DEV_ADAPTERS_FORBIDDEN");

  const transactionRaw = env.SELECTED_TRANSACTION_PROFILE?.trim() || null;
  const pointsRulesEnabled = bool(env.POINTS_RULES_ENABLED);
  if (transactionRaw && transactionRaw !== "MAKE" && transactionRaw !== "BUY") throw new Error("CONFIG_INVALID:SELECTED_TRANSACTION_PROFILE");
  const selectedTransactionProfile = transactionRaw as TransactionProfile;
  if (selectedTransactionProfile && !implementedTransactionProfiles.has(selectedTransactionProfile)) {
    throw new Error("FAIL_CLOSED:TRANSACTION_PROFILE_NOT_IMPLEMENTED");
  }
  if (selectedTransactionProfile === "BUY") {
    const gates = [
      "BUY_SIGNED_WEBHOOK_READY",
      "BUY_ACTIVE_PULL_READY",
      "BUY_REFUND_READY",
      "BUY_SHIPPING_READY",
      "BUY_EXPORT_READY",
      "BUY_SANDBOX_RECONCILE_READY"
    ];
    if (!env.BUY_VENDOR_PROFILE_ID || gates.some((name) => !bool(env[name]))) throw new Error("FAIL_CLOSED:BUY_PROFILE_INCOMPLETE");
  }
  if (selectedTransactionProfile === "MAKE") {
    const gates = ["MAKE_PAYMENT_READY", "MAKE_REFUND_READY", "MAKE_SHIPPING_READY", "MAKE_EXPORT_READY", "MAKE_SANDBOX_RECONCILE_READY"];
    if (!env.MAKE_APPROVAL_ID || gates.some((name) => !bool(env[name]))) throw new Error("FAIL_CLOSED:MAKE_PROFILE_INCOMPLETE");
  }
  const pointsRedemptionEnabled = bool(env.POINTS_REDEMPTION_ENABLED);
  assertPointsRedemptionReady(env, selectedTransactionProfile);

  if ((appEnv === "production" || appEnv === "staging") && (!env.WECHAT_APP_ID || !env.WECHAT_APP_SECRET)) {
    throw new Error("FAIL_CLOSED:WECHAT_CREDENTIALS_REQUIRED");
  }
  if ((appEnv === "production" || appEnv === "staging") && env.WECHAT_APP_ID !== CANONICAL_WECHAT_MINIPROGRAM_APP_ID) {
    throw new Error("FAIL_CLOSED:WECHAT_APP_ID_NOT_CANONICAL");
  }
  if ((appEnv === "production" || appEnv === "staging") && (!env.APP_SESSION_SECRET || !env.ADMIN_API_TOKEN)) {
    throw new Error("FAIL_CLOSED:AUTH_SECRETS_REQUIRED");
  }
  const storageDriver = (env.OBJECT_STORAGE_DRIVER ?? "s3") as "s3" | "api_gateway" | "s3_gateway" | "cos_gateway";
  if (!['s3', 'api_gateway', 's3_gateway', 'cos_gateway'].includes(storageDriver)) throw new Error("CONFIG_INVALID:OBJECT_STORAGE_DRIVER");
  if (storageDriver === "cos_gateway" && (appEnv === "staging" || appEnv === "production") &&
      (!env.S3_ACCESS_KEY_ID || !env.S3_SECRET_ACCESS_KEY || !env.S3_BUCKET || !env.S3_REGION)) {
    throw new Error("FAIL_CLOSED:COS_STORAGE_CREDENTIALS_REQUIRED");
  }
  if ((appEnv === "production" || appEnv === "staging") && storageDriver !== "s3" && !env.UPLOAD_TOKEN_SECRET) {
    throw new Error("FAIL_CLOSED:UPLOAD_SECRET_REQUIRED");
  }
  if ((appEnv === "production" || appEnv === "staging") && !env.OBJECT_STORAGE_PROFILE) {
    throw new Error("FAIL_CLOSED:PRODUCTION_STORAGE_PROFILE_REQUIRED");
  }
  const ugcGoLiveGate = bool(env.UGC_GO_LIVE_GATE);
  if (ugcGoLiveGate && (!env.UGC_LEGAL_APPROVAL_ID || ["UGC_PROVENANCE_READY", "UGC_CONTENT_SAFETY_READY", "UGC_MODERATION_READY"].some((name) => !bool(env[name])))) {
    throw new Error("FAIL_CLOSED:UGC_GATE_INCOMPLETE");
  }
  const pointsRuleIds = (env.POINTS_RULE_IDS ?? "").split(",").map((value) => value.trim()).filter(Boolean);
  const pointsApprovalExpiry = env.POINTS_FINANCE_APPROVAL_EXPIRES_AT ?? null;
  const pointsApprovalExpiryTime = pointsApprovalExpiry ? Date.parse(pointsApprovalExpiry) : Number.NaN;
  const pointsHoldDays = Number(env.POINTS_HOLD_DAYS ?? 0);
  const pointsExpiryDays = Number(env.POINTS_EXPIRY_DAYS ?? 0);
  if (pointsRulesEnabled && (
    !env.POINTS_FINANCE_APPROVAL_ID ||
    pointsRuleIds.length < 3 ||
    pointsRuleIds.length > 5 ||
    !pointsRuleIds.includes("CARE_D7_STORY_R0") ||
    !bool(env.POINTS_MAKER_CHECKER_READY) ||
    !Number.isInteger(pointsHoldDays) || pointsHoldDays < 1 || pointsHoldDays > 90 ||
    !Number.isInteger(pointsExpiryDays) || pointsExpiryDays < 30 || pointsExpiryDays > 1095 ||
    !Number.isFinite(pointsApprovalExpiryTime) ||
    pointsApprovalExpiryTime <= Date.now()
  )) {
    throw new Error("FAIL_CLOSED:POINTS_RULE_APPROVAL_REQUIRED");
  }
  const carePausePolicyVersion = env.CARE_PAUSE_POLICY_VERSION?.trim() || null;
  const carePauseMaxDays = Number(env.CARE_PAUSE_MAX_DAYS ?? 0);
  const carePauseReasonCodes = (env.CARE_PAUSE_REASON_CODES ?? "").split(",").map((value) => value.trim()).filter(Boolean);
  if (!Number.isInteger(carePauseMaxDays) || carePauseMaxDays < 0 || carePauseMaxDays > 90) throw new Error("CONFIG_INVALID:CARE_PAUSE_MAX_DAYS");
  if ((carePausePolicyVersion || carePauseMaxDays > 0 || carePauseReasonCodes.length > 0) && (!carePausePolicyVersion || carePauseMaxDays < 1 || carePauseReasonCodes.length < 1)) {
    throw new Error("FAIL_CLOSED:CARE_PAUSE_POLICY_INCOMPLETE");
  }
  const database = {
    poolMax: integer("DATABASE_POOL_MAX", env.DATABASE_POOL_MAX, 10, 1, 100),
    globalConnectionBudget: integer("DATABASE_GLOBAL_CONNECTION_BUDGET", env.DATABASE_GLOBAL_CONNECTION_BUDGET, 40, 1, 1000),
    instanceCount: integer("SERVICE_INSTANCE_COUNT", env.SERVICE_INSTANCE_COUNT, 1, 1, 100),
    poolAcquireTimeoutMs: integer("DATABASE_POOL_ACQUIRE_TIMEOUT_MS", env.DATABASE_POOL_ACQUIRE_TIMEOUT_MS, 2_000, 100, 60_000),
    statementTimeoutMs: integer("DATABASE_STATEMENT_TIMEOUT_MS", env.DATABASE_STATEMENT_TIMEOUT_MS, 2_500, 100, 60_000),
    lockTimeoutMs: integer("DATABASE_LOCK_TIMEOUT_MS", env.DATABASE_LOCK_TIMEOUT_MS, 750, 50, 30_000),
    idleTransactionTimeoutMs: integer("DATABASE_IDLE_TRANSACTION_TIMEOUT_MS", env.DATABASE_IDLE_TRANSACTION_TIMEOUT_MS, 5_000, 500, 120_000),
    transactionDeadlineMs: integer("DATABASE_TRANSACTION_DEADLINE_MS", env.DATABASE_TRANSACTION_DEADLINE_MS, 4_000, 200, 120_000),
    transactionMaxAttempts: integer("DATABASE_TRANSACTION_MAX_ATTEMPTS", env.DATABASE_TRANSACTION_MAX_ATTEMPTS, 6, 1, 8)
  };
  if (database.poolMax * database.instanceCount > database.globalConnectionBudget) {
    throw new Error("FAIL_CLOSED:DATABASE_CONNECTION_BUDGET_EXCEEDED");
  }
  const logLevel = (env.LOG_LEVEL ?? (appEnv === "test" ? "silent" : "info")) as AppConfig["observability"]["logLevel"];
  if (!["silent", "error", "warn", "info", "debug"].includes(logLevel)) throw new Error("CONFIG_INVALID:LOG_LEVEL");
  const directUploadEnabled = bool(env.COS_DIRECT_UPLOAD_ENABLED);
  if (directUploadEnabled && storageDriver !== "cos_gateway") throw new Error("FAIL_CLOSED:COS_DIRECT_UPLOAD_REQUIRES_COS_GATEWAY");
  if (directUploadEnabled && (!env.S3_ACCESS_KEY_ID || !env.S3_SECRET_ACCESS_KEY)) throw new Error("FAIL_CLOSED:COS_DIRECT_UPLOAD_CREDENTIALS_REQUIRED");
  const orderFlowEnabled = bool(env.COMMERCE_ORDER_FLOW_ENABLED);
  if (orderFlowEnabled && appEnv === "production") throw new Error("FAIL_CLOSED:COMMERCE_ORDER_FLOW_NONPRODUCTION_ONLY");

  return {
    env: appEnv,
    port: Number(env.PORT ?? 3100),
    databaseUrl: required("DATABASE_URL", env.DATABASE_URL),
    allowDevAdapters,
    devClock: env.DEV_CLOCK ?? null,
    sessionSecret: required("APP_SESSION_SECRET", env.APP_SESSION_SECRET),
    adminApiToken: required("ADMIN_API_TOKEN", env.ADMIN_API_TOKEN),
    contacts: { encryptionKey: env.CONTACT_ENCRYPTION_KEY ?? null, hashKey: env.CONTACT_HASH_KEY ?? null, keyVersion: env.CONTACT_KEY_VERSION || "v1" },
    wechat: { appId: env.WECHAT_APP_ID ?? null, appSecret: env.WECHAT_APP_SECRET ?? null, phoneBindingEnabled: bool(env.WECHAT_PHONE_BINDING_ENABLED) },
    objectStorage: {
      profile: env.OBJECT_STORAGE_PROFILE ?? null,
      driver: storageDriver,
      endpoint: env.S3_ENDPOINT ?? null,
      region: env.S3_REGION ?? "us-east-1",
      bucket: env.S3_BUCKET ?? "cisme-dev",
      accessKeyId: env.S3_ACCESS_KEY_ID ?? null,
      secretAccessKey: env.S3_SECRET_ACCESS_KEY ?? null,
      uploadTokenSecret: required("UPLOAD_TOKEN_SECRET", env.UPLOAD_TOKEN_SECRET)
    },
    selectedTransactionProfile,
    pointsRedemptionEnabled,
    pointsRedemptionApprovalExpiresAt: env.POINTS_REDEMPTION_APPROVAL_EXPIRES_AT?.trim() || null,
    ugcGoLiveGate,
    pointsRulesEnabled,
    pointsRuleIds,
    pointsFinanceApprovalId: env.POINTS_FINANCE_APPROVAL_ID ?? null,
    pointsFinanceApprovalExpiresAt: pointsApprovalExpiry,
    pointsHoldDays,
    pointsExpiryDays,
    carePausePolicy: { version: carePausePolicyVersion, maxDays: carePauseMaxDays, reasonCodes: carePauseReasonCodes },
    database,
    api: { routeDeadlineMs: integer("API_ROUTE_DEADLINE_MS", env.API_ROUTE_DEADLINE_MS, 8_000, 250, 120_000) },
    observability: { logLevel },
    media: { directUploadEnabled },
    commerce: {
      orderFlowEnabled,
      quoteTtlMinutes: integer("COMMERCE_QUOTE_TTL_MINUTES", env.COMMERCE_QUOTE_TTL_MINUTES, 10, 1, 60),
      pendingOrderTtlMinutes: integer("COMMERCE_PENDING_ORDER_TTL_MINUTES", env.COMMERCE_PENDING_ORDER_TTL_MINUTES, 30, 5, 120)
    }
  };
}
