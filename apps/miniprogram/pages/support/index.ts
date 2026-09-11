import { requireMemberAccess, request, retainMemberSnapshot } from "../../services/api";
import { currentChromeStyle } from "../../services/layout";
import {
  createSupportThreadState,
  mergeAcknowledgement,
  mergeHistoryPage,
  mergeSyncPage,
  readableSequence,
  supportPollDelay,
  withReadCursor,
  type SupportThreadState
} from "../../services/support-thread-state";

type Message = { id: string; sequence: number; senderType: "user" | "ai" | "admin" | "system"; body: string; createdAt: string; senderLabel?: string };
type Conversation = { id: string; status: "ai_active" | "waiting_human" | "human_active" | "resolved"; version: number };
const labels = { ai_active: "AI 助手", waiting_human: "等待客服", human_active: "人工处理中", resolved: "已解决" };

function sessionToken(): string { return getApp<IAppOption>().globalData.sessionToken; }

Page({
  pollTimer: null as ReturnType<typeof setTimeout> | null,
  pollInFlight: false,
  pollFailures: 0,
  lifecycleEpoch: 0,
  inputRevision: 0,
  lastScrollTop: 0,
  data: {
    chromeStyle: currentChromeStyle(), conversation: null as Conversation | null, messages: [] as Message[], syncCursor: 0, maxSeenSequence: 0, readCursor: 0,
    olderCursor: null as number | null, statusLabel: "等待客服", input: "", sendAttempt: null as { id: string; body: string } | null,
    loading: true, loadingOlder: false, sending: false, handoffBusy: false, error: "", anchor: "", pageAlive: false, visible: false,
    atBottom: true, newMessagesBelow: false, threadBottomStyle: "bottom:calc(env(safe-area-inset-bottom) + 132rpx)",
    newMessageBottomStyle: "bottom:calc(env(safe-area-inset-bottom) + 154rpx)"
  },
  onLoad() { this.data.pageAlive = true; },
  onReady() { this.measureComposer(); },
  onResize() { this.setData({ chromeStyle: currentChromeStyle() }); this.measureComposer(); },
  onShow() {
    const preserve = retainMemberSnapshot(this);
    this.lifecycleEpoch += 1;
    this.data.pageAlive = true;
    this.data.visible = true;
    this.setData({ sending: false, handoffBusy: false });
    if (!preserve) {
      this.inputRevision += 1;
      this.setData({ conversation: null, messages: [], syncCursor: 0, maxSeenSequence: 0, readCursor: 0, olderCursor: null, input: "", sendAttempt: null, error: "", anchor: "", atBottom: true, newMessagesBelow: false });
    }
    if (!requireMemberAccess("/pages/support/index")) { this.data.visible = false; return; }
    void this.load();
    wx.nextTick(() => this.measureComposer());
  },
  onHide() { this.data.visible = false; this.lifecycleEpoch += 1; this.stopPolling(); },
  onUnload() { this.data.pageAlive = false; this.data.visible = false; this.lifecycleEpoch += 1; this.stopPolling(); },
  owns(epoch: number, ownerToken: string) {
    return this.data.pageAlive && this.data.visible && this.lifecycleEpoch === epoch && sessionToken() === ownerToken;
  },
  threadState(): SupportThreadState<Message> {
    return { messages: this.data.messages, syncCursor: this.data.syncCursor, maxSeenSequence: this.data.maxSeenSequence, readCursor: this.data.readCursor };
  },
  applyThreadState(state: SupportThreadState<Message>, patch: Record<string, unknown> = {}) {
    this.setData({ messages: state.messages, syncCursor: state.syncCursor, maxSeenSequence: state.maxSeenSequence, readCursor: state.readCursor, ...patch });
  },
  measureComposer() {
    if (!this.data.pageAlive || typeof wx.createSelectorQuery !== "function") return;
    wx.createSelectorQuery().select(".support-composer").boundingClientRect((rect) => {
      if (!this.data.pageAlive || !rect || typeof rect.height !== "number") return;
      const height = Math.max(66, Math.ceil(rect.height));
      this.setData({ threadBottomStyle: `bottom:${height}px`, newMessageBottomStyle: `bottom:${height + 12}px` });
    }).exec();
  },
  onComposerLineChange() { wx.nextTick(() => this.measureComposer()); },
  startPolling() { this.pollFailures = 0; this.schedulePoll(); },
  schedulePoll() {
    this.stopPolling();
    if (!this.data.pageAlive || !this.data.visible) return;
    this.pollTimer = setTimeout(() => void this.poll(), supportPollDelay(this.pollFailures));
  },
  stopPolling() { if (this.pollTimer) clearTimeout(this.pollTimer); this.pollTimer = null; },
  normalize(messages: Message[]) { return messages.map((item) => ({ ...item, senderLabel: item.senderType === "user" ? "你" : item.senderType === "admin" ? "人工客服" : item.senderType === "ai" ? "AI 助手" : "系统" })); },
  async load() {
    const epoch = this.lifecycleEpoch;
    const ownerToken = sessionToken();
    this.setData({ loading: true, error: "" });
    try {
      const page = await request<any>({ path: "/v1/me/support/messages", cacheTags: ["support"] });
      if (!this.owns(epoch, ownerToken)) return;
      const messages = this.normalize(page.messages || []);
      const state = createSupportThreadState(messages, page.latestCursor || 0);
      this.applyThreadState(state, { conversation: page.conversation, olderCursor: page.olderCursor ?? null, statusLabel: page.conversation ? labels[page.conversation.status as keyof typeof labels] : "等待客服", loading: false, atBottom: true, newMessagesBelow: false, anchor: messages.length ? `support-${messages[messages.length - 1]!.sequence}` : "" });
      await this.markRead();
      this.startPolling();
    } catch {
      if (this.data.pageAlive && this.data.visible && this.lifecycleEpoch === epoch) this.setData({ loading: false, error: "客服会话暂时无法同步，请检查网络后重试。" });
    }
  },
  async poll() {
    if (this.pollInFlight || !this.data.pageAlive || !this.data.visible || this.data.loading || this.data.sending || !this.data.conversation) { this.schedulePoll(); return; }
    const epoch = this.lifecycleEpoch;
    const ownerToken = sessionToken();
    const after = this.data.syncCursor;
    this.pollInFlight = true;
    try {
      const page = await request<any>({ path: `/v1/me/support/messages?after=${after}&limit=50`, cacheTags: ["support"] });
      if (!this.owns(epoch, ownerToken)) return;
      const incoming = this.normalize(page.messages || []);
      const state = mergeSyncPage(this.threadState(), incoming, page.latestCursor ?? after);
      const newest = state.messages[state.messages.length - 1];
      const shouldFollow = this.data.atBottom;
      this.setData({
        ...(incoming.length ? { messages: state.messages } : {}),
        syncCursor: state.syncCursor,
        maxSeenSequence: state.maxSeenSequence,
        readCursor: state.readCursor,
        conversation: page.conversation ?? this.data.conversation,
        statusLabel: page.conversation ? labels[page.conversation.status as keyof typeof labels] : this.data.statusLabel,
        anchor: incoming.length && shouldFollow && newest ? `support-${newest.sequence}` : this.data.anchor,
        newMessagesBelow: shouldFollow ? false : this.data.newMessagesBelow || incoming.length > 0
      });
      this.pollFailures = 0;
      await this.markRead();
    } catch { this.pollFailures += 1; }
    finally { this.pollInFlight = false; this.schedulePoll(); }
  },
  async loadOlder() {
    if (this.data.loadingOlder || this.data.olderCursor === null) return;
    const epoch = this.lifecycleEpoch;
    const ownerToken = sessionToken();
    const preserve = this.data.messages[0]?.sequence;
    this.setData({ loadingOlder: true, atBottom: false });
    try {
      const page = await request<any>({ path: `/v1/me/support/messages?before=${this.data.olderCursor}&limit=50`, cacheTags: ["support"] });
      if (!this.owns(epoch, ownerToken)) return;
      this.applyThreadState(mergeHistoryPage(this.threadState(), this.normalize(page.messages || [])), { olderCursor: page.olderCursor ?? null, anchor: preserve ? `support-${preserve}` : "" });
    } catch { if (this.data.visible) wx.showToast({ title: "更早消息暂时无法加载", icon: "none" }); }
    finally { if (this.data.pageAlive && this.data.visible && this.lifecycleEpoch === epoch) this.setData({ loadingOlder: false }); }
  },
  onThreadScroll(event: WechatMiniprogram.ScrollViewScroll) {
    const top = Number(event.detail.scrollTop) || 0;
    if (top + 8 < this.lastScrollTop && this.data.atBottom) this.setData({ atBottom: false, anchor: "" });
    this.lastScrollTop = top;
  },
  onThreadBottom() { if (!this.data.atBottom || this.data.newMessagesBelow) this.setData({ atBottom: true, newMessagesBelow: false }); void this.markRead(); },
  jumpToLatest() {
    const newest = this.data.messages[this.data.messages.length - 1];
    this.setData({ atBottom: true, newMessagesBelow: false, anchor: newest ? `support-${newest.sequence}` : "" });
    wx.nextTick(() => void this.markRead());
  },
  append(fresh: Message[]) {
    let state = this.threadState();
    for (const item of fresh) state = mergeAcknowledgement(state, item);
    const newest = state.messages[state.messages.length - 1];
    this.applyThreadState(state, { anchor: this.data.atBottom && newest ? `support-${newest.sequence}` : this.data.anchor, newMessagesBelow: !this.data.atBottom });
  },
  async markRead() {
    const candidate = readableSequence(this.threadState(), "user", this.data.visible, this.data.atBottom);
    if (candidate === null) return;
    const epoch = this.lifecycleEpoch;
    const ownerToken = sessionToken();
    try {
      await request({ path: "/v1/me/support/read", method: "POST", data: { lastSeenSequence: candidate }, cacheTags: ["support"] });
      if (!this.owns(epoch, ownerToken)) return;
      this.applyThreadState(withReadCursor(this.threadState(), candidate));
    } catch {}
  },
  updateInput(event: WechatMiniprogram.TextareaInput) {
    this.inputRevision += 1;
    const input = event.detail.value;
    this.setData({ input, sendAttempt: this.data.sendAttempt?.body === input.trim() ? this.data.sendAttempt : null });
  },
  async send() {
    const body = this.data.input.trim();
    if (!body || this.data.sending) return;
    const draftRevision = this.inputRevision;
    const epoch = this.lifecycleEpoch;
    const ownerToken = sessionToken();
    const sendAttempt = this.data.sendAttempt?.body === body ? this.data.sendAttempt : { id: `wx-user-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`, body };
    this.setData({ sending: true, error: "", sendAttempt });
    try {
      const result = await request<any>({ path: "/v1/me/support/messages", method: "POST", data: { body, clientMessageId: sendAttempt.id }, cacheTags: ["support"] });
      if (!this.owns(epoch, ownerToken)) return;
      if (!this.data.messages.some((item) => item.id === result.message.id)) this.append(this.normalize([result.message]));
      const clearDraft = this.inputRevision === draftRevision && this.data.input.trim() === body;
      this.setData({ ...(clearDraft ? { input: "", sendAttempt: null } : {}), conversation: result.conversation, statusLabel: labels[result.conversation.status as keyof typeof labels] });
      if (clearDraft) this.inputRevision += 1;
      this.startPolling();
      await this.markRead();
    } catch { if (this.owns(epoch, ownerToken)) this.setData({ error: "消息没有确认送达，请保留文字并重试。" }); }
    finally { if (this.owns(epoch, ownerToken)) this.setData({ sending: false }); }
  },
  async requestHuman() {
    if (this.data.handoffBusy) return;
    const epoch = this.lifecycleEpoch;
    const ownerToken = sessionToken();
    this.setData({ handoffBusy: true, error: "" });
    try {
      const conversation = await request<Conversation>({ path: "/v1/me/support/handoff", method: "POST", data: {}, cacheTags: ["support"] });
      if (this.owns(epoch, ownerToken)) this.setData({ conversation, statusLabel: labels[conversation.status] });
    } catch { if (this.owns(epoch, ownerToken)) this.setData({ error: "暂时无法提交人工请求，请重试。" }); }
    finally { if (this.owns(epoch, ownerToken)) this.setData({ handoffBusy: false }); }
  },
  retry() { void this.load(); },
  back() { wx.navigateBack({ fail: () => wx.switchTab({ url: "/pages/profile/index" }) }); }
});
