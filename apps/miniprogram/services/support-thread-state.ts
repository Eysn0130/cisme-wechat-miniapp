export interface SupportSequenceMessage {
  id: string;
  sequence: number;
  senderType: string;
}

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

export function supportPollDelay(failureCount: number): number {
  const bounded = Math.max(0, Math.min(3, Math.floor(Number(failureCount) || 0)));
  return Math.min(30_000, 5_000 * 2 ** bounded);
}
