import { authorityProjection, hasCapability, requireCapability } from "../../services/authority";
import { request, retainMemberSnapshot } from "../../services/api";
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

type Message = { id: string; sequence: number; senderType: "user" | "ai" | "admin" | "system"; body: string; senderLabel?: string };
const labels: Record<string, string> = { waiting_human: "等待客服", human_active: "人工处理中", ai_active: "AI 助手", resolved: "已解决" };
function sessionToken(): string { return getApp<IAppOption>().globalData.sessionToken; }

Page({
  pollTimer: null as ReturnType<typeof setTimeout> | null,
  pollInFlight: false,
  pollFailures: 0,
  lifecycleEpoch: 0,
  inputRevision: 0,
  lastScrollTop: 0,
  data: {
    chromeStyle: currentChromeStyle(), id: "", memberDisplayName: "CISME 会员", statusLabel: "同步中", conversation: null as any,
    messages: [] as Message[], syncCursor: 0, maxSeenSequence: 0, readCursor: 0, olderCursor: null as number | null,
    assignedToMe: false, canAssign: false, canReply: false, canViewContext: false, aiStatus: "PROVIDER INTEGRATION PENDING",
    aiProviderAvailable: false, input: "", sendAttempt: null as { id: string; body: string } | null, loading: true, loadingOlder: false,
    busy: false, error: "", anchor: "", contextOpen: false, memberContext: null as any, pageAlive: false, visible: false,
    atBottom: true, newMessagesBelow: false, threadBottomStyle: "bottom:calc(env(safe-area-inset-bottom) + 150rpx)",
    newMessageBottomStyle: "bottom:calc(env(safe-area-inset-bottom) + 172rpx)"
  },
  onLoad(query: Record<string, string | undefined>) { this.data.pageAlive = true; this.setData({ id: query.id || "" }); },
  onReady() { this.measureActions(); },
  onResize() { this.setData({ chromeStyle: currentChromeStyle() }); this.measureActions(); },
  async onShow() {
    this.lifecycleEpoch += 1;
    const epoch = this.lifecycleEpoch;
    this.data.pageAlive = true;
    this.data.visible = true;
    const preserve = retainMemberSnapshot(this);
    const ownerToken = sessionToken();
    if (!preserve) {
      this.inputRevision += 1;
      this.clearSensitiveThread();
    }
    this.setData({ loading: true, busy: false });
    if (!await requireCapability("support.read")) { this.clearSensitiveThread(); this.data.visible = false; return; }
    if (!this.owns(epoch, ownerToken)) return;
    const authority = await authorityProjection();
    if (!this.owns(epoch, ownerToken)) return;
    const canAssign = hasCapability(authority, "support.assign");
    const canReply = hasCapability(authority, "support.reply");
    const canViewContext = hasCapability(authority, "member.support_view");
    if (!canReply) { this.inputRevision += 1; this.setData({ input: "", sendAttempt: null }); }
    this.setData({ canAssign, canReply, canViewContext, ...(!canViewContext ? { contextOpen: false, memberContext: null } : {}) });
    await Promise.all([this.load(), this.loadAiStatus()]);
    if (this.owns(epoch, ownerToken)) this.startPolling();
    wx.nextTick(() => { if (this.owns(epoch, ownerToken)) this.measureActions(); });
  },
  onHide() { this.data.visible = false; this.lifecycleEpoch += 1; this.stopPolling(); },
  onUnload() { this.data.pageAlive = false; this.data.visible = false; this.lifecycleEpoch += 1; this.stopPolling(); },
  owns(epoch: number, ownerToken: string) {
    return this.data.pageAlive && this.data.visible && this.lifecycleEpoch === epoch && sessionToken() === ownerToken;
  },
  clearSensitiveThread() {
    this.setData({
      conversation: null, messages: [], syncCursor: 0, maxSeenSequence: 0, readCursor: 0, olderCursor: null,
      assignedToMe: false, canAssign: false, canReply: false, canViewContext: false, input: "", sendAttempt: null,
      contextOpen: false, memberContext: null, anchor: "", atBottom: true, newMessagesBelow: false, busy: false
    });
  },
  threadState(): SupportThreadState<Message> {
    return { messages: this.data.messages, syncCursor: this.data.syncCursor, maxSeenSequence: this.data.maxSeenSequence, readCursor: this.data.readCursor };
  },
  applyThreadState(state: SupportThreadState<Message>, patch: Record<string, unknown> = {}) {
    this.setData({ messages: state.messages, syncCursor: state.syncCursor, maxSeenSequence: state.maxSeenSequence, readCursor: state.readCursor, ...patch });
  },
  measureActions() {
    if (!this.data.pageAlive || typeof wx.createSelectorQuery !== "function") return;
    wx.createSelectorQuery().select(".operator-actions").boundingClientRect((rect) => {
      if (!this.data.pageAlive || !rect || typeof rect.height !== "number") return;
      const height = Math.max(66, Math.ceil(rect.height));
      this.setData({ threadBottomStyle: `bottom:${height}px`, newMessageBottomStyle: `bottom:${height + 12}px` });
    }).exec();
  },
  onComposerLineChange() { wx.nextTick(() => this.measureActions()); },
  startPolling() { this.pollFailures = 0; this.schedulePoll(); },
  schedulePoll() {
    this.stopPolling();
    if (!this.data.pageAlive || !this.data.visible) return;
    this.pollTimer = setTimeout(() => void this.poll(), supportPollDelay(this.pollFailures));
  },
  stopPolling() { if (this.pollTimer) clearTimeout(this.pollTimer); this.pollTimer = null; },
  normalize(messages: Message[], displayName?: string) {
    const memberDisplayName = displayName ?? this.data.memberDisplayName;
    return messages.map((item) => ({ ...item, senderLabel: item.senderType === "user" ? memberDisplayName : item.senderType === "admin" ? "人工客服" : item.senderType === "ai" ? "AI 助手" : "系统" }));
  },
  async loadAiStatus() {
    const epoch = this.lifecycleEpoch;
    const ownerToken = sessionToken();
    try {
      const status = await request<any>({ path: "/v1/management/support/ai/status", cacheTags: ["support"] });
      if (this.owns(epoch, ownerToken)) this.setData({ aiStatus: status.status || "PROVIDER INTEGRATION PENDING", aiProviderAvailable: status.providerAvailable === true && status.autoSendEnabled === false });
    } catch { if (this.owns(epoch, ownerToken)) this.setData({ aiStatus: "PROVIDER INTEGRATION PENDING", aiProviderAvailable: false }); }
  },
  async load() {
    if (!this.data.id) { this.setData({ loading: false, error: "会话编号缺失。" }); return; }
    const epoch = this.lifecycleEpoch;
    const ownerToken = sessionToken();
    this.setData({ loading: true, error: "" });
    try {
      const page = await request<any>({ path: `/v1/management/support/conversations/${this.data.id}/messages`, cacheTags: ["support"] });
      if (!this.owns(epoch, ownerToken)) return;
      const memberDisplayName = page.memberDisplayName || "CISME 会员";
      const messages = this.normalize(page.messages || [], memberDisplayName);
      const state = createSupportThreadState(messages, page.latestCursor || 0);
      this.applyThreadState(state, {
        memberDisplayName, statusLabel: labels[page.conversation?.status] || "同步中", conversation: page.conversation,
        olderCursor: page.olderCursor ?? null, assignedToMe: page.assignedToMe === true, loading: false, atBottom: true,
        newMessagesBelow: false, anchor: messages.length ? `operator-${messages[messages.length - 1]!.sequence}` : ""
      });
      await this.markRead();
    } catch { if (this.data.pageAlive && this.data.visible && this.lifecycleEpoch === epoch) this.setData({ loading: false, error: "会话暂时无法同步，请重试。" }); }
  },
  async poll() {
    if (this.pollInFlight || !this.data.pageAlive || !this.data.visible || this.data.loading || this.data.busy || !this.data.conversation) { this.schedulePoll(); return; }
    const epoch = this.lifecycleEpoch;
    const ownerToken = sessionToken();
    const after = this.data.syncCursor;
    this.pollInFlight = true;
    try {
      const page = await request<any>({ path: `/v1/management/support/conversations/${this.data.id}/messages?after=${after}&limit=50`, cacheTags: ["support"] });
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
        statusLabel: labels[page.conversation?.status] || this.data.statusLabel,
        assignedToMe: page.assignedToMe === undefined ? this.data.assignedToMe : page.assignedToMe === true,
        anchor: incoming.length && shouldFollow && newest ? `operator-${newest.sequence}` : this.data.anchor,
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
      const page = await request<any>({ path: `/v1/management/support/conversations/${this.data.id}/messages?before=${this.data.olderCursor}&limit=50`, cacheTags: ["support"] });
      if (!this.owns(epoch, ownerToken)) return;
      this.applyThreadState(mergeHistoryPage(this.threadState(), this.normalize(page.messages || [])), { olderCursor: page.olderCursor ?? null, anchor: preserve ? `operator-${preserve}` : "" });
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
    this.setData({ atBottom: true, newMessagesBelow: false, anchor: newest ? `operator-${newest.sequence}` : "" });
    wx.nextTick(() => void this.markRead());
  },
  append(fresh: Message[]) {
    let state = this.threadState();
    for (const item of fresh) state = mergeAcknowledgement(state, item);
    const newest = state.messages[state.messages.length - 1];
    this.applyThreadState(state, { anchor: this.data.atBottom && newest ? `operator-${newest.sequence}` : this.data.anchor, newMessagesBelow: !this.data.atBottom });
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
  async claim() {
    if (!this.data.canAssign || this.data.busy || !this.data.conversation) return;
    const epoch = this.lifecycleEpoch;
    const ownerToken = sessionToken();
    this.setData({ busy: true, error: "" });
    try {
      const conversation = await request<any>({ path: `/v1/management/support/conversations/${this.data.id}/claim`, method: "POST", data: { expectedVersion: this.data.conversation.version }, cacheTags: ["support"] });
      if (this.owns(epoch, ownerToken)) this.setData({ conversation, statusLabel: labels[conversation.status], assignedToMe: true });
    } catch { if (this.owns(epoch, ownerToken)) this.setData({ error: "接管失败，会话可能已被其他客服处理，请刷新。" }); }
    finally { if (this.owns(epoch, ownerToken)) this.setData({ busy: false }); }
  },
  updateInput(event: WechatMiniprogram.TextareaInput) {
    this.inputRevision += 1;
    const input = event.detail.value;
    this.setData({ input, sendAttempt: this.data.sendAttempt?.body === input.trim() ? this.data.sendAttempt : null });
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
        this.setData({ input: String(draft.text || ""), sendAttempt: null });
      }
    } catch { if (this.owns(epoch, ownerToken)) this.setData({ error: "AI 建议回复不可用，请继续人工处理。草稿不会自动发送。" }); }
    finally { if (this.owns(epoch, ownerToken)) this.setData({ busy: false }); }
  },
  async send() {
    const body = this.data.input.trim();
    if (!body || !this.data.canReply || !this.data.assignedToMe || this.data.busy) return;
    const draftRevision = this.inputRevision;
    const epoch = this.lifecycleEpoch;
    const ownerToken = sessionToken();
    const sendAttempt = this.data.sendAttempt?.body === body ? this.data.sendAttempt : { id: `wx-agent-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`, body };
    this.setData({ busy: true, error: "", sendAttempt });
    try {
      const result = await request<any>({ path: `/v1/management/support/conversations/${this.data.id}/messages`, method: "POST", data: { body, clientMessageId: sendAttempt.id }, cacheTags: ["support"] });
      if (!this.owns(epoch, ownerToken)) return;
      if (!this.data.messages.some((item) => item.id === result.message.id)) this.append(this.normalize([result.message]));
      const clearDraft = this.inputRevision === draftRevision && this.data.input.trim() === body;
      this.setData({ ...(clearDraft ? { input: "", sendAttempt: null } : {}), conversation: result.conversation });
      if (clearDraft) this.inputRevision += 1;
      await this.markRead();
    } catch { if (this.owns(epoch, ownerToken)) this.setData({ error: "回复未确认送达，请保留文字并重试。" }); }
    finally { if (this.owns(epoch, ownerToken)) { this.setData({ busy: false }); this.measureActions(); } }
  },
  async resolve() {
    if (!this.data.canReply || !this.data.assignedToMe || this.data.busy || !this.data.conversation) return;
    const epoch = this.lifecycleEpoch;
    const ownerToken = sessionToken();
    const decision = await wx.showModal({ title: "确认解决这次问题？", content: "会话历史会保留。用户再次发送消息时会重新进入待人工队列。", confirmText: "标记已解决" });
    if (!decision.confirm || !this.owns(epoch, ownerToken)) return;
    this.setData({ busy: true, error: "" });
    try {
      const conversation = await request<any>({ path: `/v1/management/support/conversations/${this.data.id}/resolve`, method: "POST", data: { expectedVersion: this.data.conversation.version }, cacheTags: ["support"] });
      if (this.owns(epoch, ownerToken)) this.setData({ conversation, statusLabel: labels[conversation.status], assignedToMe: true });
    } catch { if (this.owns(epoch, ownerToken)) this.setData({ error: "状态已变化，请刷新后再确认。" }); }
    finally { if (this.owns(epoch, ownerToken)) this.setData({ busy: false }); }
  },
  async openContext() {
    if (!this.data.canViewContext || this.data.busy) return;
    const epoch = this.lifecycleEpoch;
    const ownerToken = sessionToken();
    this.setData({ busy: true, error: "" });
    try {
      const memberContext = await request<any>({ path: `/v1/management/support/conversations/${this.data.id}/member-context`, method: "POST", data: {}, cacheTags: ["support"] });
      if (this.owns(epoch, ownerToken)) this.setData({ memberContext, contextOpen: true });
    } catch { if (this.owns(epoch, ownerToken)) this.setData({ error: "必要用户信息暂时无法读取或当前账号无权限。" }); }
    finally { if (this.owns(epoch, ownerToken)) this.setData({ busy: false }); }
  },
  closeContext() { this.setData({ contextOpen: false }); },
  stopPropagation() {},
  retry() { void this.load(); },
  back() { wx.navigateBack({ fail: () => wx.redirectTo({ url: "/pages/management-support/index" }) }); }
});
