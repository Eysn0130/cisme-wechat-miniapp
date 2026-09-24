export type AppEnvironment = "development" | "test" | "staging" | "production";
export type TransactionProfile = "MAKE" | "BUY" | null;
export const implementedTransactionProfiles: ReadonlySet<Exclude<TransactionProfile, null>> = new Set();
export const CANONICAL_WECHAT_MINIPROGRAM_APP_ID = "wx4eac2d4fb11d299b";

/** A migration fence is strict: a typo must never silently enable writes. */
export function migrationReadOnly(env: NodeJS.ProcessEnv = process.env): boolean {
  const value=env.CISME_MIGRATION_READ_ONLY;
  if(value===undefined||value==='false')return false;
  if(value==='true')return true;
  throw new Error('CONFIG_INVALID:CISME_MIGRATION_READ_ONLY');
}

export interface AppConfig {
  env: AppEnvironment;
  port: number;
  databaseUrl: string;
  allowDevAdapters: boolean;
  devClock: string | null;
  sessionSecret: string;
  privacy: { syntheticExportKey: string | null; formalExportKey: string | null; suppressionDirectory: string | null };
  contacts: { encryptionKey: string | null; hashKey: string | null; keyVersion: string };
  wechat: { appId: string | null; appSecret: string | null; phoneBindingEnabled: boolean;
    messageToken: string | null; messageAesKey: string | null; plaintextCallbackTestOnly: boolean };
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
  api: { receiveTimeoutMs: number; routeDeadlineMs: number; rateLimit: {
    windowMs: number; cacheSize: number; ingressMax: number; loginMax: number;
    shareVisitMax: number; callbackMax: number; uploadMax: number; readyMax: number; memberMax: number;
    adminWriteMax: number; moneyWriteMax: number; ugcWriteMax: number;
  } };
  observability: { logLevel: "silent" | "error" | "warn" | "info" | "debug" };
  media: { directUploadEnabled: boolean; ugcScanBaseUrl: string | null };
  commerce: { orderFlowEnabled: boolean; quoteTtlMinutes: number; pendingOrderTtlMinutes: number;
    fulfillment?: { appId: string; merchantId: string; authorizationFile?: string };
    simulatedPayment?: { appId: string; merchantId: string; channelUrl: string;
      transferSceneId?: string };
    formalProtocol?: { appId: string; merchantId: string; merchantSerial: string;
      merchantPrivateKeyFile: string; merchantCertificateFile?: string; apiV3KeyFile: string; platformTrustManifestFile: string;
      paymentNotifyUrl: string; refundNotifyUrl: string; recoveryAuthorizationFile?: string; commerceAuthorizationFile?: string;
      transferNotifyUrl?: string; transferSceneId?: string } };
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
  migrationReadOnly(env);
  const appEnv = (env.APP_ENV ?? "development") as AppEnvironment;
  if (!["development", "test", "staging", "production"].includes(appEnv)) throw new Error("CONFIG_INVALID:APP_ENV");
  const allowDevAdapters = bool(env.ALLOW_DEV_ADAPTERS, appEnv !== "production" && appEnv !== "staging");
  if ((appEnv === "production" || appEnv === "staging") && allowDevAdapters) throw new Error("FAIL_CLOSED:DEV_ADAPTERS_FORBIDDEN");
  const syntheticExportKey=env.PRIVACY_SYNTHETIC_EXPORT_KEY?.trim() || null;
  if(syntheticExportKey && (appEnv!=="test" || !/^[0-9a-fA-F]{64}$/.test(syntheticExportKey)))
    throw new Error("FAIL_CLOSED:PRIVACY_SYNTHETIC_EXPORT_KEY_TEST_ONLY");
  const formalExportKey=env.PRIVACY_FORMAL_EXPORT_KEY?.trim() || null;
  if(formalExportKey && !/^[0-9a-fA-F]{64}$/.test(formalExportKey))
    throw new Error('CONFIG_INVALID:PRIVACY_FORMAL_EXPORT_KEY');
  const suppressionDirectory=env.PRIVACY_SUPPRESSION_DIR?.trim() || null;
  if(suppressionDirectory && (!suppressionDirectory.startsWith('/') || suppressionDirectory.includes('\0')))
    throw new Error('CONFIG_INVALID:PRIVACY_SUPPRESSION_DIR');

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
  if ((appEnv === "production" || appEnv === "staging") && !env.APP_SESSION_SECRET) {
    throw new Error("FAIL_CLOSED:SESSION_SECRET_REQUIRED");
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
  const plaintextCallbackTestOnly=bool(env.WECHAT_MESSAGE_PLAINTEXT_TEST_ONLY);
  if(plaintextCallbackTestOnly&&appEnv!=="test")
    throw new Error("FAIL_CLOSED:UGC_PLAINTEXT_CALLBACK_TEST_ONLY");
  if(env.WECHAT_MESSAGE_AES_KEY&&!/^[A-Za-z0-9+/]{43}$/.test(env.WECHAT_MESSAGE_AES_KEY))
    throw new Error("CONFIG_INVALID:WECHAT_MESSAGE_AES_KEY");
  if (ugcGoLiveGate && (!env.UGC_LEGAL_APPROVAL_ID || ["UGC_PROVENANCE_READY", "UGC_CONTENT_SAFETY_READY", "UGC_MODERATION_READY"].some((name) => !bool(env[name])))) {
    throw new Error("FAIL_CLOSED:UGC_GATE_INCOMPLETE");
  }
  if (ugcGoLiveGate && (appEnv === "production" || appEnv === "staging") &&
      (!env.WECHAT_APP_ID || !env.WECHAT_APP_SECRET || !env.WECHAT_MESSAGE_TOKEN || !env.WECHAT_MESSAGE_AES_KEY ||
        !env.UGC_SCAN_BASE_URL || !/^https:\/\/[^/?#]+$/.test(env.UGC_SCAN_BASE_URL) ||
        env.RUN_BACKGROUND_WORKER!=="true")) {
    throw new Error("FAIL_CLOSED:UGC_WECHAT_SAFETY_CREDENTIALS_REQUIRED");
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
  if (orderFlowEnabled && appEnv === "production" &&
    (!bool(env.COMMERCE_FORMAL_PROTOCOL_CONFIG_ENABLED)||!env.COMMERCE_FORMAL_COMMERCE_AUTHORIZATION_FILE||!env.COMMERCE_FORMAL_RECOVERY_AUTHORIZATION_FILE))
    throw new Error("FAIL_CLOSED:COMMERCE_ORDER_FLOW_FORMAL_APPROVAL_REQUIRED");
  const simulatedPaymentEnabled=bool(env.COMMERCE_SIMULATED_PAYMENT_ENABLED);
  if(simulatedPaymentEnabled && (appEnv!=="test"||!orderFlowEnabled))
    throw new Error("FAIL_CLOSED:COMMERCE_SIMULATED_PAYMENT_TEST_ONLY");
  const simulatedChannelUrl=env.COMMERCE_SIMULATED_CHANNEL_URL?.replace(/\/$/,"")??"";
  if(simulatedPaymentEnabled && !/^http:\/\/(127\.0\.0\.1|\[::1\]):[0-9]{2,5}$/.test(simulatedChannelUrl))
    throw new Error("FAIL_CLOSED:COMMERCE_SIMULATED_CHANNEL_LOOPBACK_REQUIRED");
  const simulatedTransferEnabled=bool(env.COMMERCE_SIMULATED_TRANSFER_ENABLED);
  if(simulatedTransferEnabled && (!simulatedPaymentEnabled||appEnv!=="test"))
    throw new Error("FAIL_CLOSED:COMMERCE_SIMULATED_TRANSFER_TEST_ONLY");
  const transferSceneId=simulatedTransferEnabled
    ?required("COMMERCE_SIMULATED_TRANSFER_SCENE_ID",env.COMMERCE_SIMULATED_TRANSFER_SCENE_ID):undefined;
  if(transferSceneId&&!/^[-A-Za-z0-9_]{2,36}$/.test(transferSceneId))
    throw new Error("CONFIG_INVALID:COMMERCE_SIMULATED_TRANSFER_SCENE_ID");
  const formalProtocolEnabled=bool(env.COMMERCE_FORMAL_PROTOCOL_CONFIG_ENABLED);
  if(formalProtocolEnabled&&simulatedPaymentEnabled)
    throw new Error("FAIL_CLOSED:COMMERCE_PROTOCOL_PROFILES_MUTUALLY_EXCLUSIVE");
  // This configuration prepares trust and transport binding; it never grants
  // permission for orders, refunds or transfers. Independent live-capability
  // approvals are deliberately not defined by a single catch-all switch.
  if(env.COMMERCE_FORMAL_COMMERCE_AUTHORIZATION_FILE&&(!formalProtocolEnabled||appEnv!=="production"))
    throw new Error("FAIL_CLOSED:FORMAL_COMMERCE_PRODUCTION_ONLY");
  const formalProtocol=formalProtocolEnabled?{
    appId:required("WECHAT_APP_ID",env.WECHAT_APP_ID),
    ...(env.COMMERCE_FORMAL_COMMERCE_AUTHORIZATION_FILE?{commerceAuthorizationFile:env.COMMERCE_FORMAL_COMMERCE_AUTHORIZATION_FILE}:{}),
    ...(env.COMMERCE_FORMAL_RECOVERY_AUTHORIZATION_FILE?{recoveryAuthorizationFile:env.COMMERCE_FORMAL_RECOVERY_AUTHORIZATION_FILE}:{}),
    merchantId:required("COMMERCE_FORMAL_MERCHANT_ID",env.COMMERCE_FORMAL_MERCHANT_ID),
    merchantSerial:required("COMMERCE_FORMAL_MERCHANT_SERIAL",env.COMMERCE_FORMAL_MERCHANT_SERIAL),
    merchantPrivateKeyFile:required("COMMERCE_FORMAL_MERCHANT_PRIVATE_KEY_FILE",env.COMMERCE_FORMAL_MERCHANT_PRIVATE_KEY_FILE),
    ...(env.COMMERCE_FORMAL_MERCHANT_CERTIFICATE_FILE?{merchantCertificateFile:env.COMMERCE_FORMAL_MERCHANT_CERTIFICATE_FILE}:{}),
    apiV3KeyFile:required("COMMERCE_FORMAL_API_V3_KEY_FILE",env.COMMERCE_FORMAL_API_V3_KEY_FILE),
    platformTrustManifestFile:required("COMMERCE_FORMAL_PLATFORM_TRUST_FILE",env.COMMERCE_FORMAL_PLATFORM_TRUST_FILE),
    paymentNotifyUrl:required("COMMERCE_FORMAL_PAYMENT_NOTIFY_URL",env.COMMERCE_FORMAL_PAYMENT_NOTIFY_URL),
    refundNotifyUrl:required("COMMERCE_FORMAL_REFUND_NOTIFY_URL",env.COMMERCE_FORMAL_REFUND_NOTIFY_URL),
    ...(env.COMMERCE_FORMAL_TRANSFER_SCENE_ID?{
      transferSceneId:env.COMMERCE_FORMAL_TRANSFER_SCENE_ID,
      transferNotifyUrl:required("COMMERCE_FORMAL_TRANSFER_NOTIFY_URL",env.COMMERCE_FORMAL_TRANSFER_NOTIFY_URL)}:{})
  }:undefined;
  if(formalProtocol){
    if(!/^wx[a-zA-Z0-9]{16}$/.test(formalProtocol.appId)||
      !/^[0-9]{8,15}$/.test(formalProtocol.merchantId)||
      !/^[A-Za-z0-9_]{8,100}$/.test(formalProtocol.merchantSerial)||
      (formalProtocol.transferSceneId&&!/^[-A-Za-z0-9_]{2,36}$/.test(formalProtocol.transferSceneId)))
      throw new Error("FAIL_CLOSED:COMMERCE_FORMAL_IDENTITY_INVALID");
    for(const [label,path] of Object.entries({merchantPrivateKeyFile:formalProtocol.merchantPrivateKeyFile,
      apiV3KeyFile:formalProtocol.apiV3KeyFile,platformTrustManifestFile:formalProtocol.platformTrustManifestFile}))
      if(!path.startsWith("/")||path.includes("\0"))throw new Error(`FAIL_CLOSED:COMMERCE_FORMAL_${label}_ABSOLUTE_REQUIRED`);
    for(const [kind,url] of [["payment",formalProtocol.paymentNotifyUrl],["refund",formalProtocol.refundNotifyUrl],
      ...(formalProtocol.transferNotifyUrl?[["transfer",formalProtocol.transferNotifyUrl]]:[])] as const)
      if(!/^https:\/\/[^/?#]+\/v1\/payments\/wechat\/[a-z-]+$/.test(url)||
        !url.endsWith(kind==="payment"?"/callback":`/${kind}-callback`))
        throw new Error(`FAIL_CLOSED:COMMERCE_FORMAL_${kind.toUpperCase()}_NOTIFY_URL_INVALID`);
  }

  const fulfillmentEnabled=bool(env.COMMERCE_FULFILLMENT_ENABLED);
  const fulfillment=fulfillmentEnabled?{
    appId:required('WECHAT_APP_ID',env.WECHAT_APP_ID),
    merchantId:required('COMMERCE_FULFILLMENT_MERCHANT_ID',env.COMMERCE_FULFILLMENT_MERCHANT_ID),
    ...(env.COMMERCE_FULFILLMENT_AUTHORIZATION_FILE?{authorizationFile:env.COMMERCE_FULFILLMENT_AUTHORIZATION_FILE}:{})
  }:undefined;
  if(fulfillment&&(!/^wx[a-zA-Z0-9]{16}$/.test(fulfillment.appId)||!/^\d{8,15}$/.test(fulfillment.merchantId)
    || !/^[a-f0-9]{64}$/i.test(env.CONTACT_ENCRYPTION_KEY??'')||!/^[a-f0-9]{64}$/i.test(env.CONTACT_HASH_KEY??'')
    || (formalProtocol&&(formalProtocol.appId!==fulfillment.appId||formalProtocol.merchantId!==fulfillment.merchantId))
    || (fulfillment.authorizationFile&&(!fulfillment.authorizationFile.startsWith('/')||fulfillment.authorizationFile.includes('\0')))))
    throw new Error('FAIL_CLOSED:FULFILLMENT_BINDING_OR_VAULT_INVALID');

  return {
    env: appEnv,
    port: Number(env.PORT ?? 3100),
    databaseUrl: required("DATABASE_URL", env.DATABASE_URL),
    allowDevAdapters,
    devClock: env.DEV_CLOCK ?? null,
    sessionSecret: required("APP_SESSION_SECRET", env.APP_SESSION_SECRET),
    privacy: { syntheticExportKey, formalExportKey, suppressionDirectory },
    contacts: { encryptionKey: env.CONTACT_ENCRYPTION_KEY ?? null, hashKey: env.CONTACT_HASH_KEY ?? null, keyVersion: env.CONTACT_KEY_VERSION || "v1" },
    wechat: { appId: env.WECHAT_APP_ID ?? null, appSecret: env.WECHAT_APP_SECRET ?? null,
      phoneBindingEnabled: bool(env.WECHAT_PHONE_BINDING_ENABLED), messageToken: env.WECHAT_MESSAGE_TOKEN ?? null,
      messageAesKey:env.WECHAT_MESSAGE_AES_KEY??null,plaintextCallbackTestOnly },
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
    api: { receiveTimeoutMs: integer("API_RECEIVE_TIMEOUT_MS", env.API_RECEIVE_TIMEOUT_MS, 30_000, 250, 120_000), routeDeadlineMs: integer("API_ROUTE_DEADLINE_MS", env.API_ROUTE_DEADLINE_MS, 8_000, 250, 120_000),
      rateLimit: {
        windowMs: integer("API_RATE_WINDOW_MS", env.API_RATE_WINDOW_MS, 60_000, 1_000, 3_600_000),
        cacheSize: integer("API_RATE_CACHE_SIZE", env.API_RATE_CACHE_SIZE, 10_000, 100, 100_000),
        ingressMax: integer("API_RATE_INGRESS_MAX", env.API_RATE_INGRESS_MAX, 600, 1, 100_000),
        loginMax: integer("API_RATE_LOGIN_MAX", env.API_RATE_LOGIN_MAX, 30, 1, 10_000),
        shareVisitMax: integer("API_RATE_SHARE_VISIT_MAX", env.API_RATE_SHARE_VISIT_MAX, 120, 1, 100_000),
        callbackMax: integer("API_RATE_CALLBACK_MAX", env.API_RATE_CALLBACK_MAX, 1_000, 1, 100_000),
        uploadMax: integer("API_RATE_UPLOAD_MAX", env.API_RATE_UPLOAD_MAX, 30, 1, 100_000),
        readyMax: integer("API_RATE_READY_MAX", env.API_RATE_READY_MAX, 120, 1, 100_000),
        memberMax: integer("API_RATE_MEMBER_MAX", env.API_RATE_MEMBER_MAX, 180, 1, 100_000),
        adminWriteMax: integer("API_RATE_ADMIN_WRITE_MAX", env.API_RATE_ADMIN_WRITE_MAX, 60, 1, 100_000),
        moneyWriteMax: integer("API_RATE_MONEY_WRITE_MAX", env.API_RATE_MONEY_WRITE_MAX, 30, 1, 100_000),
        ugcWriteMax: integer("API_RATE_UGC_WRITE_MAX", env.API_RATE_UGC_WRITE_MAX, 60, 1, 100_000)
      } },
    observability: { logLevel },
    media: { directUploadEnabled, ugcScanBaseUrl: env.UGC_SCAN_BASE_URL?.replace(/\/$/, "") ?? null },
    commerce: {
      orderFlowEnabled,
      ...(fulfillment?{fulfillment}:{}),
      quoteTtlMinutes: integer("COMMERCE_QUOTE_TTL_MINUTES", env.COMMERCE_QUOTE_TTL_MINUTES, 10, 1, 60),
      pendingOrderTtlMinutes: integer("COMMERCE_PENDING_ORDER_TTL_MINUTES", env.COMMERCE_PENDING_ORDER_TTL_MINUTES, 30, 5, 120),
      ...(simulatedPaymentEnabled?{simulatedPayment:{appId:required("WECHAT_APP_ID",env.WECHAT_APP_ID),
        merchantId:required("COMMERCE_SIMULATED_MERCHANT_ID",env.COMMERCE_SIMULATED_MERCHANT_ID),
        channelUrl:simulatedChannelUrl,...(transferSceneId?{transferSceneId}:{})}}:{})
      ,...(formalProtocol?{formalProtocol}:{})
    }
  };
}
