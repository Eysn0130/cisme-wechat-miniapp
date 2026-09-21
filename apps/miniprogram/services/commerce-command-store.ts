/** Local recovery hints only. The API remains the authority for every command.
 * Never persist a session token, OpenID, payment/transfer package or response. */
export const COMMERCE_COMMAND_STORAGE = "cisme.commerce-command-recovery.v1";
export type CommerceCommandKind = "refund" | "settlement" | "credit" | "credit-cancel" | "cancel" | "cancel-verified";
export type CommandPayload = { amountCents?: number; reason?: string; expectedVersion?: number; confirmed?: true; taxPolicyVersion?: string };
export interface StoredCommerceCommand {
  version: 1; ownerId: string; environment: string; kind: CommerceCommandKind; objectId: string | null;
  key: string; payload: CommandPayload | null; createdAt: number; dispatched: boolean;
}
let contextRevision = 0;
export function commerceContextRevision(): number { return contextRevision; }
export function invalidateCommerceRecoveryContext(): void { contextRevision += 1; }
const kinds: CommerceCommandKind[] = ["refund", "settlement", "credit", "credit-cancel", "cancel", "cancel-verified"];
export const commerceUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const keyPattern = /^[A-Za-z0-9._:-]{8,200}$/;
const maximumRecords = 16, maximumSerializedUnits = 64_000;
const problem = () => ({ code: "COMMERCE_RECOVERY_STORAGE", title: "原操作恢复记录无法安全保存或读取；请勿重新提交，先联系客服核对。" });
export function normalizeCommandPayload(kind: CommerceCommandKind, input: CommandPayload): CommandPayload {
  if (!kinds.includes(kind) || !input || typeof input !== "object" || Array.isArray(input)) throw problem();
  const fields = kind === "credit" ? ["amountCents", "confirmed", "taxPolicyVersion"] :
    kind === "credit-cancel" ? [] : kind.startsWith("cancel") ? ["expectedVersion", "reason"] : ["amountCents", "reason"];
  if (Object.keys(input).some(field => !fields.includes(field))) throw problem();
  if (kind === "credit-cancel") return {};
  if (kind.startsWith("cancel")) {
    if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion! < 1 || typeof input.reason !== "string" ||
      Array.from(input.reason.trim()).length < 3 || Array.from(input.reason.trim()).length > 500) throw problem();
    return { expectedVersion: input.expectedVersion!, reason: input.reason.trim() };
  }
  if (!Number.isSafeInteger(input.amountCents) || input.amountCents! < 1 || input.amountCents! > 9_900_000_000) throw problem();
  if (kind === "credit") {
    if (input.confirmed !== true || input.taxPolicyVersion !== "isolated-synthetic-zero-withholding-v1") throw problem();
    return { amountCents: input.amountCents!, confirmed: true, taxPolicyVersion: input.taxPolicyVersion };
  }
  if (typeof input.reason !== "string" || Array.from(input.reason.trim()).length < (kind === "settlement" ? 4 : 3) ||
    Array.from(input.reason.trim()).length > (kind === "settlement" ? 300 : 500)) throw problem();
  return { amountCents: input.amountCents!, reason: input.reason.trim() };
}
function valid(record: StoredCommerceCommand): boolean {
  if (!record || record.version !== 1 || !commerceUuid.test(record.ownerId) || !kinds.includes(record.kind) ||
    typeof record.environment !== "string" || record.environment.length < 1 || record.environment.length > 1000 ||
    typeof record.key !== "string" || !keyPattern.test(record.key) || !Number.isSafeInteger(record.createdAt) || record.createdAt < 0 ||
    typeof record.dispatched !== "boolean" || Object.keys(record).some(k => !["version", "ownerId", "environment", "kind", "objectId", "key", "payload", "createdAt", "dispatched"].includes(k))) return false;
  if (["settlement", "credit"].includes(record.kind) ? record.objectId !== null : !commerceUuid.test(record.objectId ?? "")) return false;
  try { return record.payload === null || JSON.stringify(normalizeCommandPayload(record.kind, record.payload)) === JSON.stringify(record.payload); }
  catch { return false; }
}
export function commandSlot(record: Pick<StoredCommerceCommand, "ownerId" | "environment" | "kind" | "objectId">): string {
  // Commission conversions and settlement intentions consume related assets.
  // One unresolved commission command blocks another kind, not just its button.
  return JSON.stringify([record.environment, record.ownerId, ["credit", "credit-cancel", "settlement"].includes(record.kind) ? "commission" : record.objectId]);
}
export function readCommerceCommands(): StoredCommerceCommand[] {
  try {
    const raw: unknown = wx.getStorageSync(COMMERCE_COMMAND_STORAGE);
    if (raw === undefined || raw === null || raw === "") return [];
    if (typeof raw !== "object" || Array.isArray(raw)) throw problem();
    const envelope = raw as { version?: number; commands?: StoredCommerceCommand[] };
    if (envelope.version !== 1 || !Array.isArray(envelope.commands) || envelope.commands.length > maximumRecords ||
      JSON.stringify(raw).length > maximumSerializedUnits || Object.keys(envelope).some(k => !["version", "commands"].includes(k)) ||
      envelope.commands.some(record => !valid(record)) || new Set(envelope.commands.map(commandSlot)).size !== envelope.commands.length) throw problem();
    return envelope.commands.map(record => ({ ...record, payload: record.payload && { ...record.payload } }));
  } catch { throw problem(); }
}
function write(commands: StoredCommerceCommand[]): void {
  const value = { version: 1, commands };
  if (commands.length > maximumRecords || JSON.stringify(value).length > maximumSerializedUnits || commands.some(record => !valid(record))) throw problem();
  try {
    wx.setStorageSync(COMMERCE_COMMAND_STORAGE, value);
    if (JSON.stringify(readCommerceCommands()) !== JSON.stringify(commands)) throw problem();
  } catch { throw problem(); }
}
export function putCommerceCommand(record: StoredCommerceCommand): void {
  const rows = readCommerceCommands(), slot = commandSlot(record), previous = rows.find(row => commandSlot(row) === slot);
  if (previous && (previous.key !== record.key || previous.kind !== record.kind || previous.objectId !== record.objectId ||
    previous.payload === null && record.payload !== null || previous.dispatched && !record.dispatched ||
    previous.payload !== null && record.payload !== null && JSON.stringify(previous.payload) !== JSON.stringify(record.payload))) throw problem();
  write([...rows.filter(row => commandSlot(row) !== slot), record]);
}
export function forgetCommerceCommand(record: StoredCommerceCommand): void {
  write(readCommerceCommands().filter(row => !(commandSlot(row) === commandSlot(record) && row.key === record.key && row.kind === record.kind)));
}
/** Logout clears free-text and amount payloads, not evidence that a command may
 * have executed. A later login can query its receipt, never silently start over.
 * Fail closed: a redaction failure must not prevent the session itself clearing. */
export function redactCommerceCommandPayloads(): void {
  const rows = readCommerceCommands();
  if (rows.length) write(rows.map(record => ({ ...record, payload: null })));
}
