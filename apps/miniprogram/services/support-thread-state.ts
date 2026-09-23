export interface SupportSequenceMessage {
  id: string;
  sequence: number;
  senderType: string;
  createdAt?: string;
}

export type SupportHeaderTone = "ai" | "waiting" | "online" | "neutral" | "resolved";
export interface SupportHeaderInput {
  status: "ai_active" | "waiting_human" | "human_active" | "resolved";
  agentDisplayName?: string | null;
  operatorOnline?: boolean;
}

export type PresentedSupportMessage<TMessage extends SupportSequenceMessage> = TMessage & {
  groupStart: boolean;
  groupEnd: boolean;
  timeSeparatorLabel: string;
  timeLabel: string;
  senderLabel: string;
  avatarKind: "ai" | "human" | "member" | "system";
  deliveryLabel: "" | "正在发送" | "已发送" | "已读" | "发送失败" | "结果待核对";
};

export interface SupportThreadState<TMessage extends SupportSequenceMessage> {
  messages: TMessage[];
  syncCursor: number;
  maxSeenSequence: number;
  readCursor: number;
}

function validSequence(value: unknown): number {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : 0;
}

function mergeMessages<TMessage extends SupportSequenceMessage>(current: readonly TMessage[], incoming: readonly TMessage[]): TMessage[] {
  const byId = new Map<string, TMessage>();
  for (const item of [...current, ...incoming]) {
    if (!item?.id || !validSequence(item.sequence)) continue;
    byId.set(item.id, item);
  }
  return [...byId.values()].sort((left, right) => left.sequence - right.sequence || left.id.localeCompare(right.id));
}

function maxSequence(messages: readonly SupportSequenceMessage[]): number {
  return messages.reduce((maximum, item) => Math.max(maximum, validSequence(item.sequence)), 0);
}

export function createSupportThreadState<TMessage extends SupportSequenceMessage>(messages: readonly TMessage[] = [], serverSyncCursor = 0): SupportThreadState<TMessage> {
  const normalized = mergeMessages<TMessage>([], messages);
  return {
    messages: normalized,
    syncCursor: validSequence(serverSyncCursor),
    maxSeenSequence: maxSequence(normalized),
    readCursor: 0
  };
}

export function mergeSyncPage<TMessage extends SupportSequenceMessage>(state: SupportThreadState<TMessage>, incoming: readonly TMessage[], serverSyncCursor: number): SupportThreadState<TMessage> {
  const messages = mergeMessages(state.messages, incoming);
  return {
    ...state,
    messages,
    // Only a response from the synchronization endpoint may advance this
    // watermark. Message acknowledgements are display facts, not proof that
    // every earlier server message has been observed.
    syncCursor: Math.max(state.syncCursor, validSequence(serverSyncCursor)),
    maxSeenSequence: Math.max(state.maxSeenSequence, maxSequence(messages))
  };
}

export function mergeAcknowledgement<TMessage extends SupportSequenceMessage>(state: SupportThreadState<TMessage>, acknowledgement: TMessage): SupportThreadState<TMessage> {
  const messages = mergeMessages(state.messages, [acknowledgement]);
  return { ...state, messages, maxSeenSequence: Math.max(state.maxSeenSequence, validSequence(acknowledgement.sequence)) };
}

export function mergeHistoryPage<TMessage extends SupportSequenceMessage>(state: SupportThreadState<TMessage>, history: readonly TMessage[]): SupportThreadState<TMessage> {
  const messages = mergeMessages(state.messages, history);
  return { ...state, messages, maxSeenSequence: Math.max(state.maxSeenSequence, maxSequence(messages)) };
}

export function readableSequence<TMessage extends SupportSequenceMessage>(state: SupportThreadState<TMessage>, ownSenderType: string, visible: boolean, atBottom: boolean): number | null {
  if (!visible || !atBottom) return null;
  const readable = state.messages.reduce((maximum, item) => item.senderType === ownSenderType ? maximum : Math.max(maximum, item.sequence), state.readCursor);
  return readable > state.readCursor ? readable : null;
}

export function withReadCursor<TMessage extends SupportSequenceMessage>(state: SupportThreadState<TMessage>, sequence: number): SupportThreadState<TMessage> {
  return { ...state, readCursor: Math.max(state.readCursor, validSequence(sequence)) };
}

function parsedTime(value: string | undefined): number | null {
  const time = typeof value === "string" ? Date.parse(value) : Number.NaN;
  return Number.isFinite(time) ? time : null;
}

function shiftedDate(time: number, timezoneOffsetMinutes: number): Date {
  return new Date(time - timezoneOffsetMinutes * 60_000);
}

function dateKey(time: number, timezoneOffsetMinutes: number): string {
  const date = shiftedDate(time, timezoneOffsetMinutes);
  return `${date.getUTCFullYear()}-${date.getUTCMonth() + 1}-${date.getUTCDate()}`;
}

function clockLabel(time: number, timezoneOffsetMinutes: number): string {
  const date = shiftedDate(time, timezoneOffsetMinutes);
  return `${String(date.getUTCHours()).padStart(2, "0")}:${String(date.getUTCMinutes()).padStart(2, "0")}`;
}

function separatorLabel(time: number, now: Date, timezoneOffsetMinutes: number): string {
  const key = dateKey(time, timezoneOffsetMinutes);
  const today = dateKey(now.getTime(), timezoneOffsetMinutes);
  const yesterday = dateKey(now.getTime() - 86_400_000, timezoneOffsetMinutes);
  const date = shiftedDate(time, timezoneOffsetMinutes);
  const day = key === today ? "今天" : key === yesterday ? "昨天" : `${date.getUTCMonth() + 1}月${date.getUTCDate()}日`;
  return `${day} ${clockLabel(time, timezoneOffsetMinutes)}`;
}

function sameMessageGroup(left: SupportSequenceMessage | undefined, right: SupportSequenceMessage | undefined): boolean {
  if (!left || !right || left.senderType === "system" || right.senderType === "system" || left.senderType !== right.senderType) return false;
  const leftTime = parsedTime(left.createdAt);
  const rightTime = parsedTime(right.createdAt);
  return leftTime !== null && rightTime !== null && rightTime >= leftTime && rightTime - leftTime <= 5 * 60_000;
}

export function presentSupportMessages<TMessage extends SupportSequenceMessage>(messages: readonly TMessage[], options: {
  ownSenderType: string;
  counterpartyReadSequence?: number;
  memberDisplayName?: string;
  agentDisplayName?: string;
  now?: Date;
  timezoneOffsetMinutes?: number;
}): Array<PresentedSupportMessage<TMessage>> {
  const now = options.now ?? new Date();
  const timezoneOffsetMinutes = options.timezoneOffsetMinutes ?? now.getTimezoneOffset();
  const counterpartyReadSequence = validSequence(options.counterpartyReadSequence);
  return messages.map((item, index) => {
    const previous = messages[index - 1];
    const next = messages[index + 1];
    const time = parsedTime(item.createdAt);
    const previousTime = parsedTime(previous?.createdAt);
    const needsSeparator = time !== null && (!previous || previousTime === null || dateKey(time, timezoneOffsetMinutes) !== dateKey(previousTime, timezoneOffsetMinutes) || time - previousTime > 5 * 60_000);
    const senderLabel = item.senderType === "user" ? options.memberDisplayName ?? "CISME 会员"
      : item.senderType === "admin" ? `${options.agentDisplayName ?? "CISME 客服"} · 人工客服`
      : item.senderType === "ai" ? "CISME AI 助手" : "";
    const localState = (item as TMessage & { localState?: string }).localState;
    const deliveryLabel = item.senderType !== options.ownSenderType ? ""
      : localState === "pending" ? "正在发送"
      : localState === "failed" ? "发送失败"
      : localState === "unknown" ? "结果待核对"
      : item.sequence <= counterpartyReadSequence ? "已读" : "已发送";
    return {
      ...item,
      groupStart: !sameMessageGroup(previous, item),
      groupEnd: !sameMessageGroup(item, next),
      timeSeparatorLabel: needsSeparator && time !== null ? separatorLabel(time, now, timezoneOffsetMinutes) : "",
      timeLabel: time === null ? "" : clockLabel(time, timezoneOffsetMinutes),
      senderLabel,
      avatarKind: item.senderType === "admin" ? "human" : item.senderType === "ai" ? "ai" : item.senderType === "user" ? "member" : "system",
      deliveryLabel
    };
  });
}

export function supportHeaderPresentation(input: SupportHeaderInput): { tone: SupportHeaderTone; label: string } {
  if (input.status === "ai_active") return { tone: "ai", label: "CISME AI 助手" };
  if (input.status === "waiting_human") return { tone: "waiting", label: "等待人工客服" };
  if (input.status === "resolved") return { tone: "resolved", label: "本次服务已结束" };
  if (input.operatorOnline) return { tone: "online", label: `${input.agentDisplayName || "CISME 客服"} · 人工客服已接入` };
  return { tone: "neutral", label: "人工客服处理中" };
}

export function supportMessageSetDataPatch<TMessage extends SupportSequenceMessage>(current: readonly TMessage[], next: readonly TMessage[], field = "messages"): Record<string, unknown> {
  const appendOnly = next.length >= current.length && current.every((item, index) => next[index]?.id === item.id);
  if (!appendOnly) return { [field]: next };
  const patch: Record<string, unknown> = {};
  for (let index = 0; index < next.length; index += 1) {
    if (index >= current.length || JSON.stringify(current[index]) !== JSON.stringify(next[index])) patch[`${field}[${index}]`] = next[index];
  }
  return patch;
}

export function supportPollDelay(failureCount: number, active = false): number {
  const failures = Math.max(0, Math.floor(Number(failureCount) || 0));
  if (!failures) return active ? 2_000 : 5_000;
  const bounded = Math.min(3, failures - 1);
  return Math.min(30_000, 5_000 * 2 ** bounded);
}
