export type AppEnvironment = "development" | "test" | "staging" | "production";
export type TransactionProfile = "MAKE" | "BUY" | null;
export const implementedTransactionProfiles: ReadonlySet<Exclude<TransactionProfile, null>> = new Set();

export interface AppConfig {
  env: AppEnvironment;
  port: number;
  databaseUrl: string;
  allowDevAdapters: boolean;
  devClock: string | null;
  sessionSecret: string;
  adminApiToken: string;
  wechat: { appId: string | null; appSecret: string | null };
  objectStorage: {
    profile: string | null;
    driver: "s3" | "api_gateway";
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
}

function bool(value: string | undefined, fallback = false): boolean {
  if (value === undefined) return fallback;
  return value === "true";
}

function required(name: string, value: string | undefined): string {
  if (!value) throw new Error(`CONFIG_MISSING:${name}`);
  return value;
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
  if ((appEnv === "production" || appEnv === "staging") && (!env.APP_SESSION_SECRET || !env.ADMIN_API_TOKEN)) {
    throw new Error("FAIL_CLOSED:AUTH_SECRETS_REQUIRED");
  }
  const storageDriver = (env.OBJECT_STORAGE_DRIVER ?? "s3") as "s3" | "api_gateway";
  if (!['s3', 'api_gateway'].includes(storageDriver)) throw new Error("CONFIG_INVALID:OBJECT_STORAGE_DRIVER");
  if ((appEnv === "production" || appEnv === "staging") && storageDriver === "api_gateway" && !env.UPLOAD_TOKEN_SECRET) {
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

  return {
    env: appEnv,
    port: Number(env.PORT ?? 3100),
    databaseUrl: required("DATABASE_URL", env.DATABASE_URL),
    allowDevAdapters,
    devClock: env.DEV_CLOCK ?? null,
    sessionSecret: required("APP_SESSION_SECRET", env.APP_SESSION_SECRET),
    adminApiToken: required("ADMIN_API_TOKEN", env.ADMIN_API_TOKEN),
    wechat: { appId: env.WECHAT_APP_ID ?? null, appSecret: env.WECHAT_APP_SECRET ?? null },
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
    carePausePolicy: { version: carePausePolicyVersion, maxDays: carePauseMaxDays, reasonCodes: carePauseReasonCodes }
  };
}
