import type { CommerceOrderRuntimeStatus } from "./orders";
import { cancelPageReads } from "./page-requests";

export type RuntimeMode = "unknown" | "disabled" | "test" | "formal";
export type RuntimeState = "unknown" | "loading" | "ready" | "error";
const owners = new WeakMap<object, object>();
/** A retry cancels only this page's runtime subscription, never its core read
 * or another consumer's shared GET. Writes never use these read owners. */
export function runtimeReadOwner(page: object): object {
  let owner = owners.get(page);
  if (!owner) { owner = {}; owners.set(page, owner); }
  return owner;
}
export function cancelRuntimeRead(page: object): void {
  const owner = owners.get(page);
  if (owner) cancelPageReads(owner);
}
export function initialRuntimeView() {
  return { runtimeState: "unknown" as RuntimeState, runtimeMode: "unknown" as RuntimeMode,
    runtimeStatus: null as CommerceOrderRuntimeStatus | null, runtimeCopy: "资金操作状态尚未核验。" };
}
/** Version 1 has no formal-money capability. Unsupported envelopes fail closed;
 * neither a truthy flag nor a client setting can authorize real money. The API
 * independently checks every write's principal, object, version and policy. */
export function validateRuntime(value: unknown): CommerceOrderRuntimeStatus {
  const s = value as Partial<CommerceOrderRuntimeStatus> | null;
  if (!s || s.version !== 1 || s.currency !== "CNY" || s.paymentAvailable !== false ||
      s.paymentOnboarding !== "IN_PROGRESS" || typeof s.orderFlowEnabled !== "boolean" ||
      typeof s.isolatedMoneyOperationsAvailable !== "boolean" || typeof s.isolatedTransferAvailable !== "boolean" ||
      typeof s.isolatedCreditCheckoutAvailable !== "boolean" ||
      !["disabled", "synthetic_nonproduction", "verified_isolated_test", "formal_protocol_synthetic_test"].includes(s.scope ?? "")) {
    throw new Error("Unsupported commerce capability contract");
  }
  return s as CommerceOrderRuntimeStatus;
}
export function runtimeView(status: CommerceOrderRuntimeStatus) {
  return { runtimeState: "ready" as RuntimeState, runtimeStatus: status,
    runtimeMode: (status.scope === "disabled" ? "disabled" : "test") as RuntimeMode,
    runtimeCopy: status.scope === "disabled" ? "当前环境未开放资金操作。订单状态以服务端记录为准。" :
      status.scope === "synthetic_nonproduction" ? "正式支付尚未开放，当前仅供合成订单测试。" :
      "当前仅开放隔离协议测试，不会发生真实扣款或转账。" };
}
export function runtimeActions(status: CommerceOrderRuntimeStatus | null) {
  const money = Boolean(status && ["verified_isolated_test", "formal_protocol_synthetic_test"].includes(status.scope) && status.isolatedMoneyOperationsAvailable === true);
  return { money, transfer: Boolean(money && status?.scope === "verified_isolated_test" && status.isolatedTransferAvailable === true),
    credit: Boolean(status && status.scope !== "disabled" && status.isolatedCreditCheckoutAvailable === true) };
}
