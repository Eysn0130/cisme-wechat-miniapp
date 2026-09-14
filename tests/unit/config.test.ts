import { describe, expect, it } from "vitest";
import { assertPointsRedemptionReady, loadConfig } from "@cisme/config";

const base = {
  DATABASE_URL: "postgres://local/test",
  APP_SESSION_SECRET: "session-secret-long-enough",
  ADMIN_API_TOKEN: "admin-secret-long-enough",
  UPLOAD_TOKEN_SECRET: "upload-secret-long-enough"
};

describe("production configuration fails closed", () => {
  it('accepts a separate synthetic export key only in isolated test configuration',()=>{
    const key='7'.repeat(64);
    expect(loadConfig({...base,APP_ENV:'test',PRIVACY_SYNTHETIC_EXPORT_KEY:key}).privacy.syntheticExportKey).toBe(key);
    expect(()=>loadConfig({...base,APP_ENV:'development',PRIVACY_SYNTHETIC_EXPORT_KEY:key})).toThrow('PRIVACY_SYNTHETIC_EXPORT_KEY_TEST_ONLY');
    expect(()=>loadConfig({...base,APP_ENV:'test',PRIVACY_SYNTHETIC_EXPORT_KEY:'short'})).toThrow('PRIVACY_SYNTHETIC_EXPORT_KEY_TEST_ONLY');
    expect(()=>loadConfig({...base,APP_ENV:'staging',PRIVACY_SYNTHETIC_EXPORT_KEY:key})).toThrow('PRIVACY_SYNTHETIC_EXPORT_KEY_TEST_ONLY');
  });
  it("rejects dev adapters in staging", () => {
    expect(() => loadConfig({ ...base, APP_ENV: "staging", ALLOW_DEV_ADAPTERS: "true", WECHAT_APP_ID: "id", WECHAT_APP_SECRET: "secret" })).toThrow("DEV_ADAPTERS_FORBIDDEN");
  });

  it("never allows plaintext UGC callbacks outside an explicit isolated test",()=>{
    expect(()=>loadConfig({...base,APP_ENV:"production",WECHAT_APP_ID:"wx4eac2d4fb11d299b",
      WECHAT_APP_SECRET:"fixture-secret",OBJECT_STORAGE_PROFILE:"fixture-profile",
      WECHAT_MESSAGE_PLAINTEXT_TEST_ONLY:"true"}))
      .toThrow("UGC_PLAINTEXT_CALLBACK_TEST_ONLY");
    expect(()=>loadConfig({...base,APP_ENV:"development",WECHAT_MESSAGE_AES_KEY:"invalid"}))
      .toThrow("CONFIG_INVALID:WECHAT_MESSAGE_AES_KEY");
    expect(loadConfig({...base,APP_ENV:"test"}).wechat.plaintextCallbackTestOnly).toBe(false);
  });

  it("requires WeChat credentials in production", () => {
    expect(() => loadConfig({ ...base, APP_ENV: "production" })).toThrow("WECHAT_CREDENTIALS_REQUIRED");
  });

  it("keeps transaction profiles unset until a real implementation is compiled in", () => {
    expect(() => loadConfig({
      ...base,
      APP_ENV: "development",
      SELECTED_TRANSACTION_PROFILE: "BUY",
      BUY_VENDOR_PROFILE_ID: "vendor-evidence-v1",
      BUY_SIGNED_WEBHOOK_READY: "true",
      BUY_ACTIVE_PULL_READY: "true",
      BUY_REFUND_READY: "true",
      BUY_SHIPPING_READY: "true",
      BUY_EXPORT_READY: "true",
      BUY_SANDBOX_RECONCILE_READY: "true"
    })).toThrow("TRANSACTION_PROFILE_NOT_IMPLEMENTED");
    expect(() => loadConfig({
      ...base,
      APP_ENV: "development",
      SELECTED_TRANSACTION_PROFILE: "MAKE",
      MAKE_APPROVAL_ID: "make-evidence-v1",
      MAKE_PAYMENT_READY: "true",
      MAKE_REFUND_READY: "true",
      MAKE_SHIPPING_READY: "true",
      MAKE_EXPORT_READY: "true",
      MAKE_SANDBOX_RECONCILE_READY: "true"
    })).toThrow("TRANSACTION_PROFILE_NOT_IMPLEMENTED");
  });

  it("rejects MAKE, UGC and points activation without signed gate evidence", () => {
    expect(() => loadConfig({ ...base, APP_ENV: "development", UGC_GO_LIVE_GATE: "true" })).toThrow("UGC_GATE_INCOMPLETE");
    expect(() => loadConfig({ ...base, APP_ENV: "development", POINTS_RULES_ENABLED: "true" })).toThrow("POINTS_RULE_APPROVAL_REQUIRED");
    expect(() => loadConfig({ ...base, APP_ENV: "development", CARE_PAUSE_POLICY_VERSION: "v1", CARE_PAUSE_MAX_DAYS: "14" })).toThrow("CARE_PAUSE_POLICY_INCOMPLETE");
  });

  it("keeps points redemption separate from points earning and transaction selection", () => {
    expect(() => loadConfig({ ...base, APP_ENV: "development", POINTS_REDEMPTION_ENABLED: "true" })).toThrow("POINTS_REDEMPTION_INCOMPLETE");
    expect(() => assertPointsRedemptionReady({
      POINTS_RULES_ENABLED: "false",
      POINTS_REDEMPTION_ENABLED: "true",
      POINTS_REDEMPTION_APPROVAL_ID: "redemption-policy-v1",
      POINTS_REDEMPTION_APPROVAL_EXPIRES_AT: "2099-12-31T23:59:59Z",
      POINTS_PREPARE_READY: "true",
      POINTS_COMMIT_READY: "true",
      POINTS_RELEASE_READY: "true",
      POINTS_REFUND_ALLOCATION_READY: "true"
    }, "MAKE")).not.toThrow();
    const config = loadConfig({ ...base, APP_ENV: "development", POINTS_RULES_ENABLED: "false", POINTS_REDEMPTION_ENABLED: "false" });
    expect(config.pointsRedemptionEnabled).toBe(false);
  });

  it("requires a selected production storage profile", () => {
    expect(() => loadConfig({ ...base, APP_ENV: "production", WECHAT_APP_ID: "wx4eac2d4fb11d299b", WECHAT_APP_SECRET: "secret" })).toThrow("PRODUCTION_STORAGE_PROFILE_REQUIRED");
  });

  it("keeps the pending-payment order slice isolated from production", () => {
    expect(() => loadConfig({ ...base, APP_ENV: "production", WECHAT_APP_ID:"wx4eac2d4fb11d299b", WECHAT_APP_SECRET:"secret", OBJECT_STORAGE_PROFILE:"production-reviewed", COMMERCE_ORDER_FLOW_ENABLED: "true" }))
      .toThrow("COMMERCE_ORDER_FLOW_NONPRODUCTION_ONLY");
    const isolated = loadConfig({ ...base, APP_ENV: "test", COMMERCE_ORDER_FLOW_ENABLED: "true" });
    expect(isolated.commerce).toEqual({ orderFlowEnabled: true, quoteTtlMinutes: 10, pendingOrderTtlMinutes: 30 });
  });

  it("rejects a non-canonical AppID in staging or production", () => {
    expect(() => loadConfig({ ...base, APP_ENV: "staging", WECHAT_APP_ID: "wxf639399a761abc01", WECHAT_APP_SECRET: "secret" })).toThrow("WECHAT_APP_ID_NOT_CANONICAL");
  });

  it("defaults transaction, UGC and point rules to disabled", () => {
    const config = loadConfig({ ...base, APP_ENV: "development" });
    expect(config.selectedTransactionProfile).toBeNull();
    expect(config.pointsRedemptionEnabled).toBe(false);
    expect(config.ugcGoLiveGate).toBe(false);
    expect(config.pointsRulesEnabled).toBe(false);
    expect(config.wechat.phoneBindingEnabled).toBe(false);
    expect(config.carePausePolicy).toEqual({ version: null, maxDays: 0, reasonCodes: [] });
    expect(config.database).toMatchObject({ poolMax: 10, globalConnectionBudget: 40, instanceCount: 1, poolAcquireTimeoutMs: 2000, statementTimeoutMs: 2500, transactionMaxAttempts: 6 });
    expect(config.api.routeDeadlineMs).toBe(8000);
    expect(config.media.directUploadEnabled).toBe(false);
    expect(config.commerce).toEqual({ orderFlowEnabled: false, quoteTtlMinutes: 10, pendingOrderTtlMinutes: 30 });
  });

  it("fails closed when aggregate instance pools exceed the database budget", () => {
    expect(() => loadConfig({ ...base, APP_ENV: "development", DATABASE_POOL_MAX: "12", SERVICE_INSTANCE_COUNT: "4", DATABASE_GLOBAL_CONNECTION_BUDGET: "40" }))
      .toThrow("DATABASE_CONNECTION_BUDGET_EXCEEDED");
  });

  it("fails closed when direct COS upload lacks its constrained signing configuration", () => {
    expect(() => loadConfig({ ...base, APP_ENV: "development", COS_DIRECT_UPLOAD_ENABLED: "true" })).toThrow("COS_DIRECT_UPLOAD_REQUIRES_COS_GATEWAY");
    expect(() => loadConfig({ ...base, APP_ENV: "development", OBJECT_STORAGE_DRIVER: "cos_gateway", COS_DIRECT_UPLOAD_ENABLED: "true" })).toThrow("COS_DIRECT_UPLOAD_CREDENTIALS_REQUIRED");
  });
});
