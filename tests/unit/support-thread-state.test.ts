import { describe, expect, it } from "vitest";
import {
  createSupportThreadState,
  mergeAcknowledgement,
  mergeHistoryPage,
  mergeSyncPage,
  readableSequence,
  supportPollDelay
} from "../../apps/miniprogram/services/support-thread-state";

type Message = { id: string; sequence: number; senderType: "user" | "admin" | "system"; body: string };
const message = (sequence: number, senderType: Message["senderType"] = "admin"): Message => ({ id: `m-${sequence}`, sequence, senderType, body: `message ${sequence}` });

describe("support thread state", () => {
  it("does not let a late local acknowledgement skip an unseen server message", () => {
    const initial = createSupportThreadState([message(100)], 100);
    const withAck = mergeAcknowledgement(initial, message(102, "user"));
    expect(withAck.syncCursor).toBe(100);
    expect(withAck.maxSeenSequence).toBe(102);

    const caughtUp = mergeSyncPage(withAck, [message(101), message(102, "user")], 102);
    expect(caughtUp.messages.map((item) => item.sequence)).toEqual([100, 101, 102]);
    expect(caughtUp.syncCursor).toBe(102);
  });

  it("deduplicates and sorts reverse or repeated poll pages while trusting the server watermark", () => {
    const state = createSupportThreadState([message(100)], 100);
    const merged = mergeSyncPage(state, [message(103), message(101), message(102), message(101)], 103);
    expect(merged.messages.map((item) => item.sequence)).toEqual([100, 101, 102, 103]);
    expect(merged.syncCursor).toBe(103);
  });

  it("uses the explicit server cursor at a 50-item boundary and after retained messages were cleaned", () => {
    const page = Array.from({ length: 50 }, (_, index) => message(index + 1));
    const first = mergeSyncPage(createSupportThreadState<Message>(), page, 50);
    expect(first.syncCursor).toBe(50);

    const cleaned = mergeSyncPage(first, [], 75);
    expect(cleaned.syncCursor).toBe(75);
    expect(cleaned.maxSeenSequence).toBe(50);
  });

  it("prepends history without moving the incremental cursor", () => {
    const state = createSupportThreadState([message(51), message(52)], 52);
    const merged = mergeHistoryPage(state, [message(49), message(50), message(51)]);
    expect(merged.messages.map((item) => item.sequence)).toEqual([49, 50, 51, 52]);
    expect(merged.syncCursor).toBe(52);
  });

  it("marks only messages actually visible at the bottom as read", () => {
    const state = mergeAcknowledgement(createSupportThreadState([message(100)], 100), message(102, "user"));
    expect(readableSequence(state, "user", false, true)).toBeNull();
    expect(readableSequence(state, "user", true, false)).toBeNull();
    expect(readableSequence(state, "user", true, true)).toBe(100);
  });

  it("uses bounded retry delays", () => {
    expect([0, 1, 2, 3, 8].map(supportPollDelay)).toEqual([5_000, 10_000, 20_000, 30_000, 30_000]);
  });
});
