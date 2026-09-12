import { authorityProjection, hasCapability, requireCapability } from "../../services/authority";
import { downloadPrivateMedia, request, retainMemberSnapshot } from "../../services/api";
import { centsToYuan } from "../../services/commerce";
import { currentChromeStyle } from "../../services/layout";
import {
  createSupportThreadState,
  mergeAcknowledgement,
  mergeHistoryPage,
  mergeSyncPage,
  presentSupportMessages,
  readableSequence,
  supportMessageSetDataPatch,
  supportPollDelay,
  withReadCursor,
  type PresentedSupportMessage,
  type SupportThreadState
} from "../../services/support-thread-state";

type Attachment = { id: string; mimeType: string; sizeBytes: number; previewPath: string; localPath?: string };
type OrderCard = { orderId: string; orderNumberTail: string; status: string; currency: "CNY"; totalCents: number; productName: string; productImage: string | null; itemSummary: string; statusLabel?: string; totalYuan?: string };
type RawMessage = { id: string; sequence: number; senderType: "user" | "ai" | "admin" | "system"; body: string; contentType?: string; createdAt?: string; attachments?: Attachment[]; orderCard?: OrderCard | null; deliveryState?: "server_accepted" | "read" };
type Message = PresentedSupportMessage<RawMessage>;
type Conversation = { id: string; status: "ai_active" | "waiting_human" | "human_active" | "resolved"; version: number; memberReadSequence?: number; teamReadSequence?: number };
type Presence = { agentDisplayName: string; operatorOnline: boolean; operatorTyping: boolean; memberOnline: boolean; memberTyping: boolean; serverTime: string };
type SendAttempt = { id: string; body: string };

const emptyPresence: Presence = { agentDisplayName: "CISME 客服", operatorOnline: false, operatorTyping: false, memberOnline: false, memberTyping: false, serverTime: "" };
const orderStatusLabels: Record<string, string> = { pending_payment: "待支付", cancelled: "已取消", expired: "已超时" };
function sessionToken(): string { return getApp<IAppOption>().globalData.sessionToken; }

Page({
  pollTimer: null as ReturnType<typeof setTimeout> | null,
  pollInFlight: false,
  pollFailures: 0,
  lifecycleEpoch: 0,
  inputRevision: 0,
  lastScrollTop: 0,
  lastActivityAt: 0,
  lastPresenceSentAt: 0,
  presenceTimer: null as ReturnType<typeof setTimeout> | null,
  mediaDownloads: [] as Array<() => void>,
  data: {
    chromeStyle: currentChromeStyle(),
    id: "",
    memberDisplayName: "CISME 会员",
    statusLabel: "同步中",
    statusTone: "neutral",
    conversation: null as Conversation | null,
    presence: emptyPresence,
    messages: [] as Message[],
    syncCursor: 0,
    maxSeenSequence: 0,
    readCursor: 0,
    olderCursor: null as number | null,
    assignedToMe: false,
    canAssign: false,
    canReply: false,
    canViewContext: false,
    aiStatus: "PROVIDER INTEGRATION PENDING",
    aiProviderAvailable: false,
    input: "",
    sendAttempt: null as SendAttempt | null,
    pendingMessage: null as Message | null,
    loading: true,
    loadingOlder: false,
    busy: false,
    error: "",
    anchor: "",
    contextOpen: false,
    memberContext: null as any,
    pageAlive: false,
    visible: false,
    atBottom: true,
    newMessagesBelow: false,
    newMessagesBelowCount: 0,
    composerFocused: false,
    keyboardHeight: 0,
    composerCapped: false,
    composerLineCount: 1,
    composerSendEnabled: false,
    threadBottomStyle: "bottom:calc(env(safe-area-inset-bottom) + 244rpx)",
    newMessageBottomStyle: "bottom:calc(env(safe-area-inset-bottom) + 266rpx)"
  },

  onLoad(query: Record<string, string | undefined>) {
    this.data.pageAlive = true;
    this.setData({ id: query.id || "" });
  },
  onReady() { this.measureActions(); },
  onResize() {
    this.setData({ chromeStyle: currentChromeStyle() });
    this.measureActions();
  },
  async onShow() {
    this.lifecycleEpoch += 1;
    const epoch = this.lifecycleEpoch;
    this.data.pageAlive = true;
    this.data.visible = true;
    this.lastActivityAt = Date.now();
    const preserve = retainMemberSnapshot(this);
    const ownerToken = sessionToken();
    if (!preserve) {
      this.inputRevision += 1;
      this.clearSensitiveThread();
    }
    this.setData({ loading: true, busy: false });
    if (!await requireCapability("support.read")) {
      this.clearSensitiveThread();
      this.data.visible = false;
      return;
    }
    if (!this.owns(epoch, ownerToken)) return;
    const authority = await authorityProjection();
    if (!this.owns(epoch, ownerToken)) return;
    const canAssign = hasCapability(authority, "support.assign");
    const canReply = hasCapability(authority, "support.reply");
    const canViewContext = hasCapability(authority, "member.support_view");
    if (!canReply) {
      this.inputRevision += 1;
      this.setData({ input: "", sendAttempt: null, pendingMessage: null, composerCapped: false, composerLineCount: 1, composerSendEnabled: false });
    }
    this.setData({ canAssign, canReply, canViewContext, ...(!canViewContext ? { contextOpen: false, memberContext: null } : {}) });
    await Promise.all([this.load(), this.loadAiStatus()]);
    if (this.owns(epoch, ownerToken)) this.startPolling();
    wx.nextTick(() => { if (this.owns(epoch, ownerToken)) this.measureActions(); });
  },
  onHide() {
    void this.publishPresence(false, false, true);
    this.data.visible = false;
    this.lifecycleEpoch += 1;
    this.stopPolling();
    this.clearPresenceTimer();
    this.abortDownloads();
    this.setData({ composerFocused: false, keyboardHeight: 0 });
  },
  onUnload() {
    void this.publishPresence(false, false, true);
    this.data.pageAlive = false;
    this.data.visible = false;
    this.lifecycleEpoch += 1;
    this.stopPolling();
    this.clearPresenceTimer();
    this.abortDownloads();
  },

  owns(epoch: number, ownerToken: string) {
    return this.data.pageAlive && this.data.visible && this.lifecycleEpoch === epoch && sessionToken() === ownerToken;
  },
  abortDownloads() {
    const downloads = this.mediaDownloads ?? [];
    this.mediaDownloads = [];
    for (const abort of downloads) abort();
  },
  clearPresenceTimer() {
    if (this.presenceTimer) clearTimeout(this.presenceTimer);
    this.presenceTimer = null;
  },
  clearSensitiveThread() {
    this.clearPresenceTimer();
    this.abortDownloads();
    this.setData({
      conversation: null,
      presence: emptyPresence,
      messages: [],
      syncCursor: 0,
      maxSeenSequence: 0,
      readCursor: 0,
      olderCursor: null,
      assignedToMe: false,
      canAssign: false,
      canReply: false,
      canViewContext: false,
      input: "",
      sendAttempt: null,
      pendingMessage: null,
      contextOpen: false,
      memberContext: null,
      anchor: "",
      atBottom: true,
      newMessagesBelow: false,
      newMessagesBelowCount: 0,
      busy: false,
      composerFocused: false,
      keyboardHeight: 0,
      composerCapped: false,
      composerLineCount: 1,
      composerSendEnabled: false
    });
  },
  threadState(): SupportThreadState<Message> {
    return { messages: this.data.messages, syncCursor: this.data.syncCursor, maxSeenSequence: this.data.maxSeenSequence, readCursor: this.data.readCursor };
  },
  present(messages: readonly RawMessage[], conversation?: Conversation | null, presence?: Presence, memberDisplayName?: string): Message[] {
    const activeConversation = conversation === undefined ? this.data.conversation : conversation;
    const activePresence = presence ?? this.data.presence ?? emptyPresence;
    const activeMemberName = memberDisplayName ?? this.data.memberDisplayName;
    return presentSupportMessages(messages, {
      ownSenderType: "admin",
      counterpartyReadSequence: activeConversation?.memberReadSequence ?? 0,
      memberDisplayName: activeMemberName,
      agentDisplayName: activePresence.agentDisplayName
    });
  },
  headerPatch(conversation: Conversation | null, presence: Presence, assignedToMe?: boolean) {
    const owned = assignedToMe ?? this.data.assignedToMe;
    if (!conversation) return { statusLabel: "同步中", statusTone: "neutral", presence };
    if (conversation.status === "waiting_human") return { statusLabel: "等待接管", statusTone: "waiting", presence };
    if (conversation.status === "ai_active") return { statusLabel: "AI 助手处理中", statusTone: "ai", presence };
    if (conversation.status === "resolved") return { statusLabel: "本次服务已结束", statusTone: "resolved", presence };
    if (!owned) return { statusLabel: "其他客服处理中", statusTone: "neutral", presence };
    return { statusLabel: presence.memberOnline ? "处理中 · 会员在线" : "处理中 · 会员未在线", statusTone: presence.memberOnline ? "online" : "neutral", presence };
  },
  applyThreadState(state: SupportThreadState<Message>, patch: Record<string, unknown> = {}) {
    const conversation = (patch.conversation as Conversation | undefined) ?? this.data.conversation;
    const presence = (patch.presence as Presence | undefined) ?? this.data.presence;
    const memberDisplayName = (patch.memberDisplayName as string | undefined) ?? this.data.memberDisplayName;
    const messages = this.present(state.messages, conversation, presence, memberDisplayName);
    const messagePatch = supportMessageSetDataPatch(this.data.messages, messages);
    this.setData({ ...messagePatch, syncCursor: state.syncCursor, maxSeenSequence: state.maxSeenSequence, readCursor: state.readCursor, ...patch });
    if (Object.keys(messagePatch).length) this.data.messages = messages;
  },
  measureActions() {
    if (!this.data.pageAlive || typeof wx.createSelectorQuery !== "function") return;
    wx.createSelectorQuery().select(".operator-actions").boundingClientRect((rect) => {
      if (!this.data.pageAlive || !rect || typeof rect.height !== "number") return;
      const height = Math.max(112, Math.ceil(rect.height));
      this.setData({ threadBottomStyle: `bottom:${height}px`, newMessageBottomStyle: `bottom:${height + 12}px` });
    }).exec();
  },
  onComposerLineChange(event: WechatMiniprogram.TextareaLineChange) {
    const lineCount = Math.max(1, Number(event.detail.lineCount) || 1);
    const composerCapped = lineCount > 6;
    if (lineCount !== this.data.composerLineCount || composerCapped !== this.data.composerCapped) this.setData({ composerLineCount: lineCount, composerCapped });
    wx.nextTick(() => this.measureActions());
  },
  onKeyboardHeightChange(event: WechatMiniprogram.TextareaKeyboardHeightChange) {
    const keyboardHeight = Number(event.detail.height) || 0;
    if (keyboardHeight === this.data.keyboardHeight) return;
    this.setData({ keyboardHeight });
    wx.nextTick(() => this.measureActions());
  },
  onComposerFocus() {
    this.lastActivityAt = Date.now();
    this.setData({ composerFocused: true });
    void this.publishPresence(true, Boolean(this.data.input.trim()));
  },
  onComposerBlur() {
    this.setData({ composerFocused: false });
    void this.publishPresence(true, false, true);
  },
  activePolling() {
    return this.data.presence.memberTyping || Date.now() - this.lastActivityAt < 30_000;
  },
  startPolling() {
    this.pollFailures = 0;
    this.schedulePoll();
  },
  schedulePoll() {
    this.stopPolling();
    if (!this.data.pageAlive || !this.data.visible) return;
    this.pollTimer = setTimeout(() => void this.poll(), supportPollDelay(this.pollFailures, this.activePolling()));
  },
  stopPolling() {
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = null;
  },
  normalize(messages: RawMessage[]) {
    return messages.map((item) => ({
      ...item,
      attachments: item.attachments ?? [],
      orderCard: item.orderCard ? {
        ...item.orderCard,
        statusLabel: orderStatusLabels[item.orderCard.status] ?? item.orderCard.status,
        totalYuan: centsToYuan(item.orderCard.totalCents)
      } : null
    }));
  },

  async loadAiStatus() {
    const epoch = this.lifecycleEpoch;
    const ownerToken = sessionToken();
    try {
      const status = await request<any>({ path: "/v1/management/support/ai/status", cacheTags: ["support"] });
      if (this.owns(epoch, ownerToken)) this.setData({ aiStatus: status.status || "PROVIDER INTEGRATION PENDING", aiProviderAvailable: status.providerAvailable === true && status.autoSendEnabled === false });
    } catch {
      if (this.owns(epoch, ownerToken)) this.setData({ aiStatus: "PROVIDER INTEGRATION PENDING", aiProviderAvailable: false });
    }
  },
  async load() {
    if (!this.data.id) {
      this.setData({ loading: false, error: "会话编号缺失。" });
      return;
    }
    const epoch = this.lifecycleEpoch;
    const ownerToken = sessionToken();
    this.setData({ loading: true, error: "" });
    try {
      const page = await request<any>({ path: `/v1/management/support/conversations/${this.data.id}/messages`, cacheTags: ["support"] });
      if (!this.owns(epoch, ownerToken)) return;
      const memberDisplayName = page.memberDisplayName || "CISME 会员";
      const conversation = page.conversation as Conversation;
      const assignedToMe = page.assignedToMe === true;
      const presence = { ...emptyPresence, ...(page.presence ?? {}) } as Presence;
      const raw = this.normalize(page.messages || []);
      const messages = this.present(raw, conversation, presence, memberDisplayName);
      const state = createSupportThreadState(messages, page.latestCursor || 0);
      this.applyThreadState(state, {
        memberDisplayName,
        conversation,
        assignedToMe,
        olderCursor: page.olderCursor ?? null,
        loading: false,
        atBottom: true,
        newMessagesBelow: false,
        newMessagesBelowCount: 0,
        anchor: messages.length ? `operator-${messages[messages.length - 1]!.sequence}` : "",
        ...this.headerPatch(conversation, presence, assignedToMe)
      });
      this.downloadMedia(raw);
      await this.markRead();
      if (assignedToMe && conversation.status === "human_active") void this.publishPresence(true, Boolean(this.data.input.trim()), true);
    } catch {
      if (this.data.pageAlive && this.data.visible && this.lifecycleEpoch === epoch) this.setData({ loading: false, error: "会话暂时无法同步，请重试。" });
    }
  },
  async poll() {
    if (this.pollInFlight || !this.data.pageAlive || !this.data.visible || this.data.loading || this.data.busy || !this.data.conversation) {
      this.schedulePoll();
      return;
    }
    const epoch = this.lifecycleEpoch;
    const ownerToken = sessionToken();
    const after = this.data.syncCursor;
    this.pollInFlight = true;
    try {
      const page = await request<any>({ path: `/v1/management/support/conversations/${this.data.id}/messages?after=${after}&limit=50`, cacheTags: ["support"] });
      if (!this.owns(epoch, ownerToken)) return;
      const conversation = (page.conversation ?? this.data.conversation) as Conversation;
      const presence = { ...emptyPresence, ...(page.presence ?? this.data.presence) } as Presence;
      const incoming = this.normalize(page.messages || []);
      const knownIds = new Set(this.data.messages.map((item) => item.id));
      const freshCount = incoming.filter((item) => !knownIds.has(item.id)).length;
      const assignedToMe = page.assignedToMe === undefined ? this.data.assignedToMe : page.assignedToMe === true;
      const lostAssignment = this.data.assignedToMe && !assignedToMe;
      if (lostAssignment) {
        void this.publishPresence(false, false, true);
        this.clearPresenceTimer();
        this.inputRevision += 1;
      }
      const state = mergeSyncPage(this.threadState(), this.present(incoming, conversation, presence), page.latestCursor ?? after);
      const newest = state.messages[state.messages.length - 1];
      const shouldFollow = this.data.atBottom;
      if (freshCount || presence.memberTyping) this.lastActivityAt = Date.now();
      this.applyThreadState(state, {
        conversation,
        assignedToMe,
        ...(lostAssignment ? { input: "", sendAttempt: null, pendingMessage: null, composerCapped: false, composerLineCount: 1, composerSendEnabled: false } : {}),
        ...this.headerPatch(conversation, presence, assignedToMe),
        anchor: freshCount && shouldFollow && newest ? `operator-${newest.sequence}` : this.data.anchor,
        newMessagesBelowCount: shouldFollow ? 0 : (this.data.newMessagesBelowCount ?? 0) + freshCount,
        newMessagesBelow: shouldFollow ? false : this.data.newMessagesBelow || freshCount > 0
      });
      if (incoming.length) this.downloadMedia(incoming);
      this.pollFailures = 0;
      await this.markRead();
      if (assignedToMe && conversation.status === "human_active") void this.publishPresence(true, Boolean(this.data.input.trim()));
    } catch {
      this.pollFailures += 1;
    } finally {
      this.pollInFlight = false;
      this.schedulePoll();
    }
  },
  async loadOlder() {
    if (this.data.loadingOlder || this.data.olderCursor === null) return;
    const epoch = this.lifecycleEpoch;
    const ownerToken = sessionToken();
    const preserve = this.data.messages[0]?.sequence;
    this.setData({ loadingOlder: true, atBottom: false });
    try {
      const page = await request<any>({ path: `/v1/management/support/conversations/${this.data.id}/messages?before=${this.data.olderCursor}&limit=50`, cacheTags: ["support"] });
      if (!this.owns(epoch, ownerToken)) return;
      const older = this.normalize(page.messages || []);
      this.applyThreadState(mergeHistoryPage(this.threadState(), this.present(older)), { olderCursor: page.olderCursor ?? null, anchor: preserve ? `operator-${preserve}` : "" });
      this.downloadMedia(older);
    } catch {
      if (this.data.visible) wx.showToast({ title: "更早消息暂时无法加载", icon: "none" });
    } finally {
      if (this.data.pageAlive && this.data.visible && this.lifecycleEpoch === epoch) this.setData({ loadingOlder: false });
    }
  },
  onThreadScroll(event: WechatMiniprogram.ScrollViewScroll) {
    const top = Number(event.detail.scrollTop) || 0;
    if (top + 8 < this.lastScrollTop && this.data.atBottom) this.setData({ atBottom: false, anchor: "" });
    this.lastScrollTop = top;
  },
  onThreadBottom() {
    if (!this.data.atBottom || this.data.newMessagesBelowCount) this.setData({ atBottom: true, newMessagesBelow: false, newMessagesBelowCount: 0 });
    void this.markRead();
  },
  jumpToLatest() {
    const newest = this.data.messages[this.data.messages.length - 1];
    this.setData({ atBottom: true, newMessagesBelow: false, newMessagesBelowCount: 0, anchor: newest ? `operator-${newest.sequence}` : "" });
    wx.nextTick(() => void this.markRead());
  },
  append(fresh: RawMessage[]) {
    let state = this.threadState();
    for (const item of this.present(fresh)) state = mergeAcknowledgement(state, item);
    const newest = state.messages[state.messages.length - 1];
    this.applyThreadState(state, {
      anchor: this.data.atBottom && newest ? `operator-${newest.sequence}` : this.data.anchor,
      newMessagesBelow: !this.data.atBottom,
      newMessagesBelowCount: this.data.atBottom ? 0 : (this.data.newMessagesBelowCount ?? 0) + fresh.length
    });
  },
  async markRead() {
    const candidate = readableSequence(this.threadState(), "admin", this.data.visible, this.data.atBottom);
    if (candidate === null) return;
    const epoch = this.lifecycleEpoch;
    const ownerToken = sessionToken();
    try {
      await request({ path: `/v1/management/support/conversations/${this.data.id}/read`, method: "POST", data: { lastSeenSequence: candidate }, cacheTags: ["support"] });
      if (!this.owns(epoch, ownerToken)) return;
      this.applyThreadState(withReadCursor(this.threadState(), candidate));
    } catch {}
  },
  async publishPresence(online: boolean, typing: boolean, force = false) {
    if (!this.data.conversation || !this.data.assignedToMe || this.data.conversation.status !== "human_active") return;
    const elapsed = Date.now() - this.lastPresenceSentAt;
    if (!force && elapsed < 3_000) {
      this.clearPresenceTimer();
      this.presenceTimer = setTimeout(() => {
        this.presenceTimer = null;
        if (this.data.visible) void this.publishPresence(true, Boolean(this.data.input.trim()), true);
      }, 3_000 - elapsed);
      return;
    }
    this.lastPresenceSentAt = Date.now();
    try {
      await request({ path: `/v1/management/support/conversations/${this.data.id}/presence`, method: "POST", data: { online, typing }, cacheTags: ["support"] });
    } catch {}
  },

  async claim() {
    if (!this.data.canAssign || this.data.busy || !this.data.conversation) return;
    const epoch = this.lifecycleEpoch;
    const ownerToken = sessionToken();
    let claimed = false;
    this.setData({ busy: true, error: "" });
    try {
      const conversation = await request<Conversation>({ path: `/v1/management/support/conversations/${this.data.id}/claim`, method: "POST", data: { expectedVersion: this.data.conversation.version }, cacheTags: ["support"] });
      if (!this.owns(epoch, ownerToken)) return;
      claimed = true;
      this.setData({ conversation, assignedToMe: true, ...this.headerPatch(conversation, this.data.presence, true) });
    } catch {
      if (this.owns(epoch, ownerToken)) this.setData({ error: "接管失败，会话可能已被其他客服处理，请刷新。" });
    } finally {
      if (this.owns(epoch, ownerToken)) this.setData({ busy: false });
    }
    if (claimed && this.owns(epoch, ownerToken)) {
      await this.load();
      this.startPolling();
    }
  },
  updateInput(event: WechatMiniprogram.TextareaInput) {
    this.inputRevision += 1;
    this.lastActivityAt = Date.now();
    const input = event.detail.value;
    this.setData({
      input,
      composerSendEnabled: Boolean(input.trim()),
      sendAttempt: this.data.sendAttempt?.body === input.trim() ? this.data.sendAttempt : null,
      pendingMessage: this.data.pendingMessage?.deliveryLabel === "发送失败" ? null : this.data.pendingMessage
    });
    void this.publishPresence(true, Boolean(input.trim()), !input.trim());
  },
  async suggest() {
    if (!this.data.aiProviderAvailable || !this.data.assignedToMe || this.data.busy) return;
    const draftRevision = this.inputRevision;
    const epoch = this.lifecycleEpoch;
    const ownerToken = sessionToken();
    this.setData({ busy: true, error: "" });
    try {
      const draft = await request<any>({ path: `/v1/management/support/conversations/${this.data.id}/suggested-reply`, method: "POST", data: {}, cacheTags: ["support"] });
      if (this.owns(epoch, ownerToken) && this.inputRevision === draftRevision) {
        this.inputRevision += 1;
        const input = String(draft.text || "");
        this.setData({ input, composerSendEnabled: Boolean(input.trim()), sendAttempt: null });
      }
    } catch {
      if (this.owns(epoch, ownerToken)) this.setData({ error: "AI 建议回复不可用，请继续人工处理。草稿不会自动发送。" });
    } finally {
      if (this.owns(epoch, ownerToken)) this.setData({ busy: false });
    }
  },
  pendingFrom(attempt: SendAttempt, state: "pending" | "failed"): Message {
    const raw = {
      id: `local-${attempt.id}`,
      sequence: this.data.maxSeenSequence + 1,
      senderType: "admin" as const,
      body: attempt.body,
      contentType: "text",
      createdAt: new Date().toISOString(),
      attachments: [],
      orderCard: null,
      deliveryState: "server_accepted" as const,
      localState: state
    };
    return this.present([raw])[0]! as Message;
  },
  async send() {
    const body = this.data.input.trim();
    if (!body || !this.data.canReply || !this.data.assignedToMe || this.data.busy) return;
    const draftRevision = this.inputRevision;
    const epoch = this.lifecycleEpoch;
    const ownerToken = sessionToken();
    const sendAttempt = this.data.sendAttempt?.body === body ? this.data.sendAttempt : { id: `wx-agent-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`, body };
    this.lastActivityAt = Date.now();
    this.setData({ busy: true, error: "", sendAttempt, pendingMessage: this.pendingFrom(sendAttempt, "pending") });
    void this.publishPresence(true, false, true);
    try {
      const result = await request<any>({ path: `/v1/management/support/conversations/${this.data.id}/messages`, method: "POST", data: { body, clientMessageId: sendAttempt.id }, cacheTags: ["support"] });
      if (!this.owns(epoch, ownerToken)) return;
      const normalized = this.normalize([result.message]);
      if (!this.data.messages.some((item) => item.id === result.message.id)) this.append(normalized);
      const clearDraft = this.inputRevision === draftRevision && this.data.input.trim() === body;
      this.setData({
        ...(clearDraft ? { input: "", sendAttempt: null, composerCapped: false, composerLineCount: 1, composerSendEnabled: false } : {}),
        pendingMessage: null,
        conversation: result.conversation,
        ...this.headerPatch(result.conversation, this.data.presence, true)
      });
      if (clearDraft) this.inputRevision += 1;
      await this.markRead();
      wx.nextTick(() => this.measureActions());
    } catch {
      if (this.owns(epoch, ownerToken)) this.setData({ error: "回复尚未获得服务端确认，文字仍保留。", pendingMessage: this.pendingFrom(sendAttempt, "failed") });
    } finally {
      if (this.owns(epoch, ownerToken)) this.setData({ busy: false });
    }
  },
  retrySend() { void this.send(); },
  async resolve() {
    if (!this.data.canReply || !this.data.assignedToMe || this.data.busy || !this.data.conversation) return;
    const epoch = this.lifecycleEpoch;
    const ownerToken = sessionToken();
    const draftWarning = this.data.input.trim() ? "当前未发送的回复草稿会清除。" : "";
    const decision = await wx.showModal({ title: "确认解决这次问题？", content: `${draftWarning}会话历史会保留。用户再次发送消息时会重新进入待人工队列。`, confirmText: "标记已解决" });
    if (!decision.confirm || !this.owns(epoch, ownerToken)) return;
    this.setData({ busy: true, error: "" });
    try {
      const conversation = await request<Conversation>({ path: `/v1/management/support/conversations/${this.data.id}/resolve`, method: "POST", data: { expectedVersion: this.data.conversation.version }, cacheTags: ["support"] });
      if (!this.owns(epoch, ownerToken)) return;
      this.clearPresenceTimer();
      this.inputRevision += 1;
      this.setData({ conversation, assignedToMe: false, input: "", sendAttempt: null, pendingMessage: null, composerCapped: false, composerLineCount: 1, composerSendEnabled: false, ...this.headerPatch(conversation, emptyPresence, false) });
    } catch {
      if (this.owns(epoch, ownerToken)) this.setData({ error: "状态已变化，请刷新后再确认。" });
    } finally {
      if (this.owns(epoch, ownerToken)) this.setData({ busy: false });
    }
  },
  async openContext() {
    if (!this.data.canViewContext || this.data.busy) return;
    const epoch = this.lifecycleEpoch;
    const ownerToken = sessionToken();
    this.setData({ busy: true, error: "" });
    try {
      const memberContext = await request<any>({ path: `/v1/management/support/conversations/${this.data.id}/member-context`, method: "POST", data: {}, cacheTags: ["support"] });
      if (this.owns(epoch, ownerToken)) this.setData({ memberContext, contextOpen: true });
    } catch {
      if (this.owns(epoch, ownerToken)) this.setData({ error: "必要用户信息暂时无法读取或当前账号无权限。" });
    } finally {
      if (this.owns(epoch, ownerToken)) this.setData({ busy: false });
    }
  },
  closeContext() { this.setData({ contextOpen: false }); },
  stopPropagation() {},

  downloadMedia(messages: readonly RawMessage[]) {
    const epoch = this.lifecycleEpoch;
    const ownerToken = sessionToken();
    const downloads = this.mediaDownloads ?? [];
    this.mediaDownloads = downloads;
    for (const message of messages) for (const attachment of message.attachments ?? []) {
      if (attachment.localPath || !attachment.previewPath) continue;
      const download = downloadPrivateMedia(attachment.previewPath);
      const abort = () => download.abort();
      downloads.push(abort);
      void download.promise.then((localPath) => {
        if (!this.owns(epoch, ownerToken)) return;
        const messageIndex = this.data.messages.findIndex((item) => item.id === message.id);
        const attachmentIndex = this.data.messages[messageIndex]?.attachments?.findIndex((item) => item.id === attachment.id) ?? -1;
        if (messageIndex < 0 || attachmentIndex < 0) return;
        this.data.messages[messageIndex]!.attachments![attachmentIndex]!.localPath = localPath;
        this.setData({ [`messages[${messageIndex}].attachments[${attachmentIndex}].localPath`]: localPath });
      }).catch(() => {}).finally(() => { this.mediaDownloads = this.mediaDownloads.filter((candidate) => candidate !== abort); });
    }
  },
  previewImage(event: WechatMiniprogram.TouchEvent) {
    const id = String(event.currentTarget.dataset.mediaId ?? "");
    const attachments = this.data.messages.flatMap((message) => message.attachments ?? []).filter((attachment) => attachment.localPath);
    const current = attachments.find((attachment) => attachment.id === id)?.localPath;
    if (!current) {
      wx.showToast({ title: "图片仍在安全加载，请稍后重试", icon: "none" });
      return;
    }
    wx.previewImage({ current, urls: attachments.map((attachment) => attachment.localPath!) });
  },
  openOrder(event: WechatMiniprogram.TouchEvent) {
    const id = String(event.currentTarget.dataset.id ?? "");
    if (id) wx.navigateTo({ url: `/pages/management-order-detail/index?id=${encodeURIComponent(id)}` });
  },
  retry() { void this.load(); },
  back() {
    wx.navigateBack({ fail: () => wx.redirectTo({ url: "/pages/management-support/index" }) });
  }
});
