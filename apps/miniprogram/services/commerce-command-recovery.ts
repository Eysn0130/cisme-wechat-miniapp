import { request } from "./api";
import { pageRead } from "./page-requests";
import { clientOperationKey } from "./orders";
import { commerceContextRevision, commerceUuid, commandSlot, forgetCommerceCommand, normalizeCommandPayload, putCommerceCommand, readCommerceCommands,
  type CommerceCommandKind, type CommandPayload, type StoredCommerceCommand } from "./commerce-command-store";

export type RecoveryScope = { group: "commission" } | { group: "order"; objectId: string };
export interface RecoveryView { key: string; kind: CommerceCommandKind; label: string; retryable: boolean; recorded: boolean }
interface Receipt { version: 1; memberId: string; kind: CommerceCommandKind; status: "recorded" | "not_observed";
  record: null | { id: string; state: string; orderId?: string; amountCents?: number } }
const active = new Set<string>();
const labels: Record<CommerceCommandKind, string> = { refund: "退款申请", settlement: "结算意向", credit: "权益转换",
  "credit-cancel": "权益撤销", cancel: "取消订单", "cancel-verified": "取消订单" };
const states: Record<CommerceCommandKind, readonly string[]> = {
  refund: ["requested", "approved", "rejected"],
  settlement: ["requested", "reserved", "unknown", "processing", "succeeded", "failed", "cancelled", "rejected"],
  credit: ["available", "cancelled"], "credit-cancel": ["cancelled"], cancel: ["cancelled"], "cancel-verified": ["cancelled"]
};
const changed = () => ({ code: "COMMERCE_RECOVERY_CONTEXT", title: "页面或身份已变化；未确认的原操作会保留，请返回原页面核对。" });
const unresolved = () => ({ code: "COMMERCE_RECOVERY_PENDING", title: "上一笔操作尚未核实。请先核对或重试原操作，不要修改金额后另行提交。" });
function environment(): string {
  const data = getApp<IAppOption>().globalData;
  if (!data.apiBaseUrl || /[?#@]/.test(data.apiBaseUrl)) throw changed();
  return JSON.stringify([data.apiBaseUrl.replace(/\/$/, ""), data.cloudFunction ?? null]);
}
function inScope(record: StoredCommerceCommand, scope: RecoveryScope): boolean {
  return scope.group === "commission" ? ["settlement", "credit", "credit-cancel"].includes(record.kind) :
    !["settlement", "credit", "credit-cancel"].includes(record.kind) && record.objectId === scope.objectId;
}
async function owner(page: object | undefined, current: () => boolean) {
  const token = getApp<IAppOption>().globalData.sessionToken, target = environment(), revision = commerceContextRevision();
  const check = () => { if (revision !== commerceContextRevision() || !token || token !== getApp<IAppOption>().globalData.sessionToken || target !== environment() || !current()) throw changed(); };
  check();
  const options = { path: "/v1/me/profile" };
  const result = page ? await pageRead<{ id: string }>(page, options) : await request<{ id: string }>(options);
  check(); if (!result || !commerceUuid.test(result.id)) throw changed();
  return { ownerId: result.id, environment: target, check };
}
function path(command: StoredCommerceCommand): string {
  if (command.kind === "refund") return `/v1/me/orders/${command.objectId}/refund-requests`;
  if (command.kind === "settlement") return "/v1/me/commission/settlement-requests";
  if (command.kind === "credit") return "/v1/me/commission/credit-conversions";
  if (command.kind === "credit-cancel") return `/v1/me/commission/credit-conversions/${command.objectId}/cancel`;
  return `/v1/me/orders/${command.objectId}/${command.kind}`;
}
async function receipt(command: StoredCommerceCommand, page?: object): Promise<Receipt> {
  const options = { path: `/v1/me/commerce/command-receipts/${command.kind}${command.objectId ? `?objectId=${command.objectId}` : ""}`,
    idempotencyKey: command.key };
  const value = page ? await pageRead<Receipt>(page, options) : await request<Receipt>(options);
  if (!value || value.version !== 1 || value.memberId !== command.ownerId || value.kind !== command.kind ||
    !["recorded", "not_observed"].includes(value.status) || value.status === "not_observed" && value.record !== null ||
    value.status === "recorded" && (!value.record || !commerceUuid.test(value.record.id) || !states[command.kind].includes(value.record.state) ||
      command.kind === "refund" && value.record.orderId !== command.objectId ||
      command.payload?.amountCents !== undefined && value.record.amountCents !== command.payload.amountCents ||
      ["cancel", "cancel-verified", "credit-cancel"].includes(command.kind) && (value.record.id !== command.objectId || value.record.state !== "cancelled"))) {
    throw { code: "COMMERCE_RECOVERY_RECEIPT", title: "原操作核对回执不完整，请稍后核对，暂不创建新操作。" };
  }
  return value;
}
export async function readCommerceRecovery(page: object, scope: RecoveryScope, current: () => boolean): Promise<RecoveryView[]> {
  const context = await owner(page, current);
  const pending = readCommerceCommands().filter(row => row.ownerId === context.ownerId && row.environment === context.environment && inScope(row, scope));
  const output: RecoveryView[] = [];
  for (const row of pending) {
    context.check();
    const value = active.has(commandSlot(row)) ? null : await receipt(row, page); context.check();
    const recorded = value?.status === "recorded";
    output.push({ key: row.key, kind: row.kind, recorded,
      label: recorded ? `原${labels[row.kind]}已在服务端记录；请查看对应历史后确认。` : `${labels[row.kind]}结果待核对`,
      retryable: !recorded && row.payload !== null });
  }
  return output;
}
function writeResultIsComplete(command: StoredCommerceCommand, result: unknown): boolean {
  const value = result as { id?: string; orderId?: string; amountCents?: number; state?: string; status?: string } | null;
  if (!value || !commerceUuid.test(value.id ?? "")) return false;
  if (command.kind === "refund" && value.orderId !== command.objectId) return false;
  if (["cancel", "cancel-verified", "credit-cancel"].includes(command.kind))
    return value.id === command.objectId && (value.status ?? value.state) === "cancelled";
  return states[command.kind].includes(value.state ?? "") && Number.isSafeInteger(value.amountCents) && value.amountCents === command.payload?.amountCents;
}
async function dispatch<T>(command: StoredCommerceCommand, check: () => void): Promise<{ recovered: boolean; result?: T }> {
  check();
  if (!command.payload) throw { code: "COMMERCE_RECOVERY_REDACTED", title: "退出登录后已清除原填写内容。请仅核对原申请，仍未知时联系客服，不要新建重复申请。" };
  // Persist the may-have-been-sent boundary before the transport call.
  const payload = command.payload;
  command = { ...command, dispatched: true }; putCommerceCommand(command); check();
  const result = await request<T>({ path: path(command), method: "POST", idempotencyKey: command.key, data: payload });
  // A successful HTTP envelope with missing business facts remains unknown.
  if (!writeResultIsComplete(command, result)) throw { code: "COMMERCE_RECOVERY_RESPONSE", title: "操作回执不完整；请核对原操作，不要重复新建。" };
  // Retire only this owner/key even if its page has gone away. Never write any
  // payment success to the new page or delete another account's pending record.
  forgetCommerceCommand(command);
  return { recovered: false, result };
}
export async function executeCommerceCommand<T>(input: { kind: CommerceCommandKind; objectId?: string; key: string; payload: CommandPayload }, current: () => boolean): Promise<{ recovered: boolean; result?: T }> {
  const context = await owner(undefined, current); context.check();
  const candidate: StoredCommerceCommand = { version: 1, ownerId: context.ownerId, environment: context.environment,
    kind: input.kind, objectId: input.objectId ?? null, key: input.key || clientOperationKey(input.kind),
    payload: normalizeCommandPayload(input.kind, input.payload), createdAt: Date.now(), dispatched: false };
  const slot = commandSlot(candidate);
  if (active.has(slot)) throw unresolved();
  active.add(slot);
  try {
    const existing = readCommerceCommands().find(row => commandSlot(row) === slot);
    if (existing) {
      // A user's edited payload is not permission to replay a different command,
      // nor to silently replay the old amount while the new amount is displayed.
      if (existing.kind !== candidate.kind || existing.objectId !== candidate.objectId ||
        JSON.stringify(existing.payload) !== JSON.stringify(candidate.payload)) throw unresolved();
      const value = await receipt(existing); context.check();
      if (value.status === "recorded") { forgetCommerceCommand(existing); return { recovered: true }; }
      const result = await dispatch<T>(existing, context.check); context.check(); return result;
    }
    putCommerceCommand(candidate);
    const result = await dispatch<T>(candidate, context.check); context.check(); return result;
  } finally { active.delete(slot); }
}
export async function retryCommerceCommand(key: string, scope: RecoveryScope, current: () => boolean): Promise<void> {
  const context = await owner(undefined, current); context.check();
  const command = readCommerceCommands().find(row => row.ownerId === context.ownerId && row.environment === context.environment && row.key === key && inScope(row, scope));
  if (!command) throw changed();
  const slot = commandSlot(command); if (active.has(slot)) throw unresolved(); active.add(slot);
  try {
    const value = await receipt(command); context.check();
    if (value.status === "recorded") { forgetCommerceCommand(command); return; }
    await dispatch(command, context.check); context.check();
  } finally { active.delete(slot); }
}

export async function acknowledgeCommerceCommand(key: string, scope: RecoveryScope, current: () => boolean): Promise<void> {
  const context = await owner(undefined, current); context.check();
  const command = readCommerceCommands().find(row => row.ownerId === context.ownerId && row.environment === context.environment && row.key === key && inScope(row, scope));
  if (!command || active.has(commandSlot(command))) throw changed();
  const value = await receipt(command); context.check();
  if (value.status !== "recorded") throw unresolved();
  forgetCommerceCommand(command);
}
