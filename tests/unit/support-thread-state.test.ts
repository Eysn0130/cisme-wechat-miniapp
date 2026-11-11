import { describe, expect, it } from "vitest";
import {
  createSupportThreadState,
  mergeAcknowledgement,
  mergeHistoryPage,
  mergeSyncPage,
  newestSupportConversation,
  presentSupportMessages,
  readableSequence,
  supportHeaderPresentation,
  supportPollDelay
} from "../../apps/miniprogram/services/support-thread-state";

type Message = { id: string; sequence: number; senderType: "user" | "admin" | "system"; body: string };
const message = (sequence: number, senderType: Message["senderType"] = "admin"): Message => ({ id: `m-${sequence}`, sequence, senderType, body: `message ${sequence}` });

describe("support thread state", () => {
  it("keeps confirmed handoff versions while allowing a later explicit AI resume", () => {
    const waiting = { id: "same-thread", version: 4, status: "waiting_human" };
    expect(newestSupportConversation(waiting, { ...waiting, version: 3, status: "ai_active" })).toBe(waiting);
    expect(newestSupportConversation(waiting, null)).toBe(waiting);
    expect(newestSupportConversation(waiting, { ...waiting, version: 5, status: "ai_active" })).toEqual({ ...waiting, version: 5, status: "ai_active" });
  });
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
    expect(supportPollDelay(0, true)).toBe(2_000);
    expect(supportPollDelay(0, false)).toBe(5_000);
    expect([1, 2, 3, 8].map((failures) => supportPollDelay(failures, true))).toEqual([5_000, 10_000, 20_000, 30_000]);
  });

  it("groups only the same identity within five minutes and uses sparse server-time separators", () => {
    const presented = presentSupportMessages([
      { ...message(1, "admin"), sender: { key:"same-agent", displayName:"CISME 客服", profileRevision:0, operatorUpdatedAt:null, avatarRevision:null }, createdAt: "2026-09-12T02:00:00.000Z" },
      { ...message(2, "admin"), sender: { key:"same-agent", displayName:"CISME 客服", profileRevision:0, operatorUpdatedAt:null, avatarRevision:null }, createdAt: "2026-09-12T02:02:00.000Z" },
      { ...message(3, "user"), createdAt: "2026-09-12T02:03:00.000Z" },
      { ...message(4, "user"), createdAt: "2026-09-12T02:09:01.000Z" }
    ], { ownSenderType: "user", counterpartyReadSequence: 3, now: new Date("2026-09-12T03:00:00.000Z"), timezoneOffsetMinutes: -480 });

    expect(presented.map((item) => ({ start: item.groupStart, end: item.groupEnd, separator: item.timeSeparatorLabel }))).toEqual([
      { start: true, end: false, separator: "今天 10:00" },
      { start: false, end: true, separator: "" },
      { start: true, end: true, separator: "" },
      { start: true, end: true, separator: "今天 10:09" }
    ]);
    expect(presented[2]!.deliveryLabel).toBe("已读");
    expect(presented[3]!.deliveryLabel).toBe("已发送");
    expect(presented[0]!.senderLabel).toBe("CISME 客服 · 人工客服");
  });

  it("labels an unconfirmed local send as awaiting verification", () => {
    const pending = { ...message(1, "user"), localState: "unknown" };
    expect(presentSupportMessages([pending], { ownSenderType: "user", counterpartyReadSequence: 2 })[0]!.deliveryLabel)
      .toBe("结果待核对");
  });

  it("references each loaded question when interleaved human and AI replies are separated from their source", () => {
    const questions = [
      { ...message(1, "user"), body: "我的退款什么时候处理？" },
      { ...message(2, "user"), body: "护理记录在哪里查看？" }
    ];
    const presented = presentSupportMessages([
      ...questions,
      { ...message(3, "admin"), body: "退款事项已收到。", replyToMessageId: "m-1" },
      { id: "m-4", sequence: 4, senderType: "ai", body: "在底部记录页查看。", replyToMessageId: "m-2" }
    ], { ownSenderType: "user", counterpartyReadSequence: 2 });
    expect(presented.map(item => item.replyReferenceLabel)).toEqual(["", "", "回复：我的退款什么时候处理？", "回复：护理记录在哪里查看？"]);
    expect(presented.map(item => item.senderType)).toEqual(["user", "user", "admin", "ai"]);
    expect(presented.map(item => item.deliveryLabel)).toEqual(["已读", "已读", "", ""]);
  });

  it("identifies the slower first-question answer after the second-question answer arrives first", () => {
    const presented = presentSupportMessages([
      { ...message(1, "user"), body: "先问的问题" },
      { ...message(2, "user"), body: "后来问的问题" },
      { id: "m-3", sequence: 3, senderType: "ai", body: "第二问的答案", replyToMessageId: "m-2" },
      { id: "m-4", sequence: 4, senderType: "ai", body: "第一问的答案", replyToMessageId: "m-1" }
    ], { ownSenderType: "admin" });
    expect(presented[2]!.replyReferenceLabel).toBe("");
    expect(presented[3]!.replyReferenceLabel).toBe("回复：先问的问题");
  });

  it("keeps an adjacent question-answer pair uncluttered even with a system event or empty row between them", () => {
    const presented = presentSupportMessages([
      { ...message(1, "user"), body: "如何保存护理？" },
      { ...message(2, "system"), body: "人工申请已收到" },
      { ...message(3, "admin"), body: "" },
      { id: "m-4", sequence: 4, senderType: "ai", body: "填写感受后保存。", replyToMessageId: "m-1" }
    ], { ownSenderType: "user" });
    expect(presented[3]!.replyReferenceLabel).toBe("");
  });

  it("does not invent a quote for an unloaded, non-user or future source", () => {
    const presented = presentSupportMessages([
      { ...message(1, "admin"), body: "人工回复" },
      { id: "m-2", sequence: 2, senderType: "ai", body: "未知来源", replyToMessageId: "missing" },
      { id: "m-3", sequence: 3, senderType: "ai", body: "非用户来源", replyToMessageId: "m-1" },
      { id: "m-4", sequence: 4, senderType: "ai", body: "未来来源", replyToMessageId: "m-5" },
      { ...message(5, "user"), body: "未来的问题" }
    ], { ownSenderType: "user" });
    expect(presented.every(item => item.replyReferenceLabel === "")).toBe(true);
  });

  it("compacts and bounds a long quote without changing its original question body", () => {
    const body = `护理\n  ${"😊".repeat(100)}`;
    const presented = presentSupportMessages([
      { ...message(1, "user"), body },
      message(2, "user"),
      { id: "m-3", sequence: 3, senderType: "ai", body: "回答", replyToMessageId: "m-1" }
    ], { ownSenderType: "user" });
    expect(presented[0]!.body).toBe(body);
    expect(presented[2]!.replyReferenceLabel).toBe(`回复：护理 ${"😊".repeat(77)}…`);
  });

  it("keeps an old full case id in the underlying event while showing a short receipt", () => {
    const body="售后申请已收到 · 编号 8bb27d44-9e66-4bcd-8471-dd7535263e02。客服将按本案处理。";
    const shown=presentSupportMessages([{...message(1,"system"),body}],{ownSenderType:"user"})[0]!;
    expect(shown.body).toBe(body);
    expect(shown.displayBody).toBe("售后申请已收到，客服会继续处理。");
  });

  it("never turns an assignment into a green online claim without an unexpired heartbeat", () => {
    expect(supportHeaderPresentation({ status: "human_active", agentDisplayName: "小熹", operatorOnline: false })).toEqual({ tone: "neutral", label: "人工客服处理中" });
    expect(supportHeaderPresentation({ status: "human_active", agentDisplayName: "小熹", operatorOnline: true })).toEqual({ tone: "online", label: "小熹 · 人工客服已接入" });
    expect(supportHeaderPresentation({ status: "waiting_human", agentDisplayName: null, operatorOnline: false })).toEqual({ tone: "waiting", label: "等待人工客服" });
  });
});
