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
    runtimeStatus: null as CommerceOrderRuntimeStatus | null, runtimeCopy: "正在连接支付服务…" };
}
/** Version 1 is isolated; version 2 carries the explicit formal capability.
 * A contradictory projection cannot enable a client action. The API still
 * independently authorizes every write; this is not a replacement for it. */
export function validateRuntime(value: unknown): CommerceOrderRuntimeStatus {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Unsupported commerce capability contract");
  const s = value as Partial<CommerceOrderRuntimeStatus>;
  const common=s.currency==="CNY"&&typeof s.orderFlowEnabled==="boolean"&&typeof s.isolatedMoneyOperationsAvailable==="boolean"
    &&typeof s.isolatedTransferAvailable==="boolean"&&typeof s.isolatedCreditCheckoutAvailable==="boolean";
  const nonfinancial=s.scope==="disabled"||s.scope==="synthetic_nonproduction";
  const isolated=common&&s.version===1&&s.paymentAvailable===false&&s.paymentOnboarding==="IN_PROGRESS"
    &&["disabled","synthetic_nonproduction","verified_isolated_test","formal_protocol_synthetic_test"].includes(s.scope??"")
    &&(s.formalMoneyOperationsAvailable===undefined||s.formalMoneyOperationsAvailable===false)
    &&(s.formalRecoveryAvailable===undefined||s.formalRecoveryAvailable===false)
    &&(!nonfinancial||!s.isolatedMoneyOperationsAvailable&&!s.isolatedTransferAvailable&&!s.isolatedCreditCheckoutAvailable);
  const formal=common&&s.version===2&&s.scope==="formal_commerce"&&typeof s.formalMoneyOperationsAvailable==="boolean"&&typeof s.formalRecoveryAvailable==="boolean"
    &&s.paymentAvailable===s.formalMoneyOperationsAvailable&&s.orderFlowEnabled===s.formalMoneyOperationsAvailable
    &&s.paymentOnboarding===(s.paymentAvailable?"READY":"IN_PROGRESS")
    &&s.isolatedMoneyOperationsAvailable===false&&s.isolatedTransferAvailable===false&&s.isolatedCreditCheckoutAvailable===false;
  if(!isolated&&!formal)throw new Error("Unsupported commerce capability contract");
  return s as CommerceOrderRuntimeStatus;
}
export function runtimeView(status: CommerceOrderRuntimeStatus) {
  return { runtimeState: "ready" as RuntimeState, runtimeStatus: status,
    runtimeMode: (status.scope === "formal_commerce" ? "formal" : status.scope === "disabled" ? "disabled" : "test") as RuntimeMode,
    runtimeCopy: status.scope === "formal_commerce" ? (status.paymentAvailable?"可使用微信支付。":"付款暂不可用，订单与售后仍可查看。") : status.scope === "disabled" ? "付款暂不可用，已有订单仍可查看。" :
      "测试环境，不会真实扣款或转账。" };
}
export function runtimeActions(status: CommerceOrderRuntimeStatus | null) {
  // Some callers consume a cached projection directly. Validate here as well
  // so an unsupported version or malformed flags cannot expose write controls.
  try { validateRuntime(status); }
  catch { return { money: false, recovery: false, transfer: false, credit: false }; }
  const money = Boolean(status && (status.version===2&&status.scope==="formal_commerce"&&status.formalMoneyOperationsAvailable===true || ["verified_isolated_test", "formal_protocol_synthetic_test"].includes(status.scope) && status.isolatedMoneyOperationsAvailable === true));
  return { money, recovery:Boolean(status?.version===2&&status.scope==="formal_commerce"&&status.formalRecoveryAvailable), transfer: Boolean(money && status?.scope === "verified_isolated_test" && status.isolatedTransferAvailable === true),
    credit: Boolean(status && status.scope !== "disabled" && status.isolatedCreditCheckoutAvailable === true) };
}
