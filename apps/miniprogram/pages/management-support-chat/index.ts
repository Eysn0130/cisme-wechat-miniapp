import { SupportIdentityCache, supportOwnIdentity, type SupportSender } from '../../services/support-identity';
import { defaultMemberAvatar } from '../../services/member-avatar';
import { memberIdentity } from '../../services/member-identity';
import { pageRead, cancelPageReads } from "../../services/page-requests";
import { commerceContextRevision } from "../../services/commerce-command-store";
import { authorityProjection, hasCapability } from "../../services/authority";
import { downloadPrivateMedia, request, retainMemberSnapshot } from "../../services/api";
import { centsToYuan } from "../../services/commerce";
import { clientOperationKey } from "../../services/orders";
import { currentChromeStyle } from "../../services/layout";
import {
  createSupportThreadState,
  mergeAcknowledgement,
  mergeHistoryPage,
  mergeSyncPage,
  newestSupportConversation,
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
type RawMessage = { id: string; sequence: number; senderType: "user" | "ai" | "admin" | "system"; body: string; contentType?: string; createdAt?: string; attachments?: Attachment[]; orderCard?: OrderCard | null;
  replyToMessageId?: string | null; sender?: SupportSender; avatarPath?: string;
  returnInstruction?:{caseId:string;version:number;recipientName:string;phone:string;region:string;address:string;freightPayer:string;instructions:string}|null;
  deliveryState?: "server_accepted" | "read" };
type Message = PresentedSupportMessage<RawMessage>;
type Conversation = { id: string; status: "ai_active" | "waiting_human" | "human_active" | "resolved"; version: number; memberReadSequence?: number; teamReadSequence?: number };
type Presence = { agentDisplayName: string; operatorOnline: boolean; operatorTyping: boolean; memberOnline: boolean; memberTyping: boolean; serverTime: string };
type HumanRequest = { generation: number; status: "waiting_human" | "human_active"; anchorKnown: boolean; anchorMessageId: string | null; anchorSequence: number | null; anchorSummary: string | null };
type ReplyTarget = { id: string; sequence: number | null; summary: string; generation: number; contextVersion: number };
type SendAttempt = { id: string; body: string; replyToMessageId: string; expectedHumanRequestGeneration: number; contextVersion: number };
type AftersaleCase = {id:string;state:string;kind:string;version:number;orderId:string;returnDestination:null|{version:number};claimBasis:string};
type ReturnForm = {recipientName:string;phone:string;region:string;address:string;freightPayer:string;instructions:string};

const emptyPresence: Presence = { agentDisplayName: "CISME 客服", operatorOnline: false, operatorTyping: false, memberOnline: false, memberTyping: false, serverTime: "" };
const orderStatusLabels: Record<string, string> = { pending_payment: "待支付", cancelled: "已取消", expired: "已超时" };
function sessionToken(): string { return getApp<IAppOption>().globalData.sessionToken; }

Page({
  identityCache: null as SupportIdentityCache | null,
  readRevision:commerceContextRevision(),
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
    ownAvatar: defaultMemberAvatar, ownDisplayName: "CISME 会员", memberAvatar: defaultMemberAvatar, agentAvatar: defaultMemberAvatar, identityMemberKey: "", identityAgentKey: "",
    chromeStyle: currentChromeStyle(),
    id: "",
    memberDisplayName: "CISME 会员",
    statusLabel: "正在加载",
    statusTone: "neutral",
    conversation: null as Conversation | null,
    presence: emptyPresence,
    messages: [] as Message[],
    syncCursor: 0,
    maxSeenSequence: 0,
    readCursor: 0,
    olderCursor: null as number | null,
    contextStartSequence: 0,
    contextVersion: 0,
    humanRequest: null as HumanRequest | null,
    humanIssueSummary: "",
    replyTarget: null as ReplyTarget | null,
    replyTargetNeedsRefresh: false,
    assignedToMe: false,
    canAssign: false,
    canReply: false,
    canViewContext: false,
    canManageAftersale:false,aftersaleCases:[] as AftersaleCase[],aftersaleOpen:false,aftersaleError:"",returnFormCaseId:"",
    returnForm:{recipientName:"",phone:"",region:"",address:"",freightPayer:"",instructions:""} as ReturnForm,
    freightOptions:['商家承担','用户承担'],
    returnAttempt:null as {key:string;caseId:string;payload:Record<string,unknown>}|null,
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
    this.stopPolling();
    this.readRevision=commerceContextRevision();
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
    this.setData({ loading: true, busy: false, statusLabel: "正在加载", statusTone: "neutral" });
    try {
      const authority = await authorityProjection(this);
      if (!this.owns(epoch, ownerToken)) return;
      if (authority.version !== 1 || !authority.managementAvailable || !hasCapability(authority, "support.read")) {
        this.clearSensitiveThread();
        this.data.visible = false;
        this.setData({ loading:false, error:"当前账号没有客服访问权限，请返回管理中心或重试。" });
        return;
      }
      const canAssign = hasCapability(authority, "support.assign");
      const canReply = hasCapability(authority, "support.reply");
      const canViewContext = hasCapability(authority, "member.support_view");
      const canManageAftersale = hasCapability(authority,"commerce.aftersale.review");
      if (!canReply) {
        this.inputRevision += 1;
        this.setData({ input: "", sendAttempt: null, pendingMessage: null, composerCapped: false, composerLineCount: 1, composerSendEnabled: false });
      }
      this.setData({ canAssign, canReply, canViewContext,canManageAftersale,
        ...(!canViewContext ? { contextOpen: false, memberContext: null } : {}),
        ...(!canManageAftersale?{aftersaleOpen:false,aftersaleCases:[],returnFormCaseId:"",returnAttempt:null}:{}) });
      void this.loadOwnIdentity();
      await Promise.all([this.load(), this.loadAiStatus()]);
      if(canManageAftersale&&this.owns(epoch,ownerToken))void this.loadAftersales();
      if (this.owns(epoch, ownerToken)) this.startPolling();
      wx.nextTick(() => { if (this.owns(epoch, ownerToken)) this.measureActions(); });
    } catch {
      if (this.owns(epoch, ownerToken)) {
        this.clearSensitiveThread();
        this.data.visible = false;
        this.setData({ loading:false, error:"客服权限或会话暂时无法核验，请重试。" });
      }
    }
  },
  onHide() {
    cancelPageReads(this);
    void this.publishPresence(false, false, true);
    if (this.data.sendAttempt) this.setData({ busy: false, pendingMessage: this.pendingFrom(this.data.sendAttempt, "unknown"),
      error: "回复是否发送成功还未确认，文字和回复对象已保留，请重试核对。" });
    this.data.visible = false;
    this.lifecycleEpoch += 1;
    this.stopPolling();
    this.clearPresenceTimer();
    this.abortDownloads();
    this.setData({ composerFocused: false, keyboardHeight: 0 });
  },
  onUnload() { cancelPageReads(this);
    void this.publishPresence(false, false, true);
    this.data.pageAlive = false;
    this.data.visible = false;
    this.lifecycleEpoch += 1;
    this.stopPolling();
    this.clearPresenceTimer();
    this.abortDownloads();
  },

  owns(epoch: number, ownerToken: string) {
    return this.data.pageAlive && this.data.visible && this.lifecycleEpoch === epoch && sessionToken() === ownerToken && this.readRevision === commerceContextRevision();
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
    this.identityCache?.reset();
    this.setData({ ownAvatar: defaultMemberAvatar, ownDisplayName: "CISME 会员", memberAvatar: defaultMemberAvatar, agentAvatar: defaultMemberAvatar });
    this.clearPresenceTimer();
    this.abortDownloads();
    this.setData({
      memberDisplayName: "CISME 会员",
      statusLabel: "",
      statusTone: "neutral",
      conversation: null,
      presence: emptyPresence,
      messages: [],
      syncCursor: 0,
      maxSeenSequence: 0,
      readCursor: 0,
      olderCursor: null,
      contextStartSequence: 0,
      contextVersion: 0,
      humanRequest: null,
      humanIssueSummary: "",
      replyTarget: null,
      replyTargetNeedsRefresh: false,
      assignedToMe: false,
      canAssign: false,
      canReply: false,
      canViewContext: false,
      canManageAftersale:false,aftersaleCases:[],aftersaleOpen:false,aftersaleError:"",returnFormCaseId:"",
      returnForm:{recipientName:"",phone:"",region:"",address:"",freightPayer:"",instructions:""},returnAttempt:null,
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
  identityPage(page: any) {
    const epoch = this.lifecycleEpoch, token = sessionToken();
    if (!this.identityCache) this.identityCache = new SupportIdentityCache();
    const cache = this.identityCache;
    const changed = () => {
      if (!this.owns(epoch, token) || this.identityCache !== cache) return;
      this.applyThreadState(this.threadState(), { memberAvatar: cache.avatar(cache.memberKey), agentAvatar: cache.avatar(cache.agentKey) });
    };
    cache.absorb(page, changed);
    for (const message of page.messages ?? []) cache.accept(message.sender, changed);
    this.setData({ memberAvatar: cache.avatar(cache.memberKey), agentAvatar: cache.avatar(cache.agentKey), identityMemberKey: cache.memberKey, identityAgentKey: cache.agentKey, memberDisplayName: cache.name(cache.memberKey) || page.memberDisplayName || this.data.memberDisplayName });
  },
  async loadOwnIdentity() {
    const epoch = this.lifecycleEpoch, token = sessionToken();
    const current = () => this.owns(epoch, token);
    const cached = memberIdentity();
    this.setData({ ownAvatar: cached?.avatarUrl || defaultMemberAvatar, ownDisplayName: cached?.display_name || 'CISME 会员' });
    const identity = await supportOwnIdentity(current);
    if (current() && identity) this.setData({ ownAvatar: identity.avatarUrl || defaultMemberAvatar, ownDisplayName: identity.display_name });
  },
  onAvatarError(event: WechatMiniprogram.TouchEvent) {
    const key = event.currentTarget.dataset.key as string | undefined;
    if (key) { this.identityCache?.fail(key); this.applyThreadState(this.threadState(), {
      memberAvatar: this.identityCache?.avatar(this.identityCache.memberKey), agentAvatar: this.identityCache?.avatar(this.identityCache.agentKey) }); }
    else this.setData({ ownAvatar: defaultMemberAvatar });
  },
  threadState(): SupportThreadState<Message> {
    return { messages: this.data.messages, syncCursor: this.data.syncCursor, maxSeenSequence: this.data.maxSeenSequence, readCursor: this.data.readCursor };
  },
  topicMetadata(page: {conversation?:Conversation|null;contextStartSequence?:unknown;contextVersion?:unknown}) {
    const same = page.conversation?.id === this.data.conversation?.id;
    const version = Number(page.contextVersion ?? 0), boundary = Number(page.contextStartSequence ?? 0);
    const contextVersion = Number.isSafeInteger(version) && version >= 0 ? version : 0;
    const contextStartSequence = Number.isSafeInteger(boundary) && boundary >= 0 ? boundary : 0;
    return { contextVersion, contextStartSequence,
      stale: same && contextVersion < this.data.contextVersion,
      changed: Boolean(this.data.conversation && (!same || contextVersion > this.data.contextVersion || contextStartSequence > this.data.contextStartSequence)) };
  },
  clearRetiredTopic() {
    this.clearPresenceTimer(); this.abortDownloads(); this.inputRevision += 1;
    this.lastScrollTop = 0; this.lastPresenceSentAt = 0;
    this.setData({ input: "", sendAttempt: null, pendingMessage: null, replyTarget: null, humanIssueSummary: "", composerCapped: false, composerLineCount: 1, composerSendEnabled: false,
      presence: emptyPresence, olderCursor: null, loadingOlder: false, anchor: "", atBottom: true, newMessagesBelow: false, newMessagesBelowCount: 0 });
  },
  questionSummary(message: RawMessage | undefined) {
    return (message?.body?.trim() || (message?.attachments?.length ? "图片咨询" : message?.orderCard ? "订单咨询" : "人工申请中的问题")).slice(0, 80);
  },
  humanRequestFrom(page: { humanRequest?: unknown }): HumanRequest | null {
    const value = page.humanRequest as Partial<HumanRequest> | null | undefined;
    if (!value || !Number.isSafeInteger(value.generation) || Number(value.generation) < 0
      || value.status !== "waiting_human" && value.status !== "human_active") return null;
    return { generation: Number(value.generation), status: value.status, anchorKnown: value.anchorKnown === true,
      anchorMessageId: typeof value.anchorMessageId === "string" ? value.anchorMessageId : null,
      anchorSequence: Number.isSafeInteger(value.anchorSequence) && Number(value.anchorSequence) > 0 ? Number(value.anchorSequence) : null,
      anchorSummary: value.anchorKnown === true && typeof value.anchorSummary === "string" ? value.anchorSummary.trim() || null : null };
  },
  staleHumanRequest(page: { humanRequest?: unknown }) {
    const incoming = this.humanRequestFrom(page);
    return Boolean(incoming && this.data.humanRequest && incoming.generation < this.data.humanRequest.generation);
  },
  olderConversationMetadata(page: { conversation?: Conversation | null }) {
    const current = this.data.conversation, incoming = page.conversation;
    return Boolean(current && incoming?.id === current.id && incoming.version < current.version);
  },
  mergeOlderConversationMessages(page: { messages?: RawMessage[]; latestCursor?: number }) {
    this.identityPage(page);
    const incoming = this.normalize(page.messages || []).filter(item => item.sequence > this.data.contextStartSequence);
    const knownIds = new Set(this.data.messages.map(item => item.id));
    const freshCount = incoming.filter(item => !knownIds.has(item.id)).length;
    const state = mergeSyncPage(this.threadState(), this.present(incoming), page.latestCursor ?? this.data.syncCursor);
    const newest = state.messages[state.messages.length - 1];
    this.applyThreadState(state, { loading: false, ...this.headerPatch(this.data.conversation, this.data.presence, this.data.assignedToMe),
      anchor: freshCount && this.data.atBottom && newest ? `operator-${newest.sequence}` : this.data.anchor,
      newMessagesBelowCount: this.data.atBottom ? 0 : this.data.newMessagesBelowCount + freshCount,
      newMessagesBelow: this.data.atBottom ? false : this.data.newMessagesBelow || freshCount > 0 });
    if (incoming.length) this.downloadMedia(incoming);
  },
  replyContextPatch(page: { humanRequest?: unknown }, messages: readonly RawMessage[], contextVersion: number, topicChanged = false): Record<string, unknown> {
    const humanRequest = this.humanRequestFrom(page), generation = humanRequest?.generation ?? 0;
    const original = humanRequest?.anchorMessageId ? messages.find(item => item.id === humanRequest.anchorMessageId && item.senderType === "user") : undefined;
    const humanIssueSummary = humanRequest?.anchorSummary || (original ? this.questionSummary(original) : "");
    const changed = topicChanged || Boolean(this.data.humanRequest && generation !== this.data.humanRequest.generation)
      || Boolean(this.data.replyTarget && (this.data.replyTarget.generation !== generation || this.data.replyTarget.contextVersion !== contextVersion));
    if (changed) {
      this.inputRevision += 1;
      return { humanRequest, humanIssueSummary, replyTarget: null, replyTargetNeedsRefresh: true, input: "", sendAttempt: null, pendingMessage: null,
        composerCapped: false, composerLineCount: 1, composerSendEnabled: false, error: "人工事项已变化，请刷新后确认要回复的问题。" };
    }
    if (this.data.replyTargetNeedsRefresh) return { humanRequest, humanIssueSummary, replyTarget: null, composerSendEnabled: false };
    let replyTarget = this.data.replyTarget;
    if (!replyTarget && humanRequest?.anchorKnown && humanRequest.anchorMessageId) {
      const question = messages.find(item => item.id === humanRequest.anchorMessageId && item.senderType === "user");
      replyTarget = { id: humanRequest.anchorMessageId, sequence: humanRequest.anchorSequence,
        summary: humanRequest.anchorSummary || this.questionSummary(question), generation, contextVersion };
    } else if (replyTarget) {
      const question = messages.find(item => item.id === replyTarget!.id && item.senderType === "user");
      if (question) replyTarget = { ...replyTarget, summary: this.questionSummary(question) };
      else if (replyTarget.id === humanRequest?.anchorMessageId && humanRequest.anchorSummary) replyTarget = { ...replyTarget, summary: humanRequest.anchorSummary };
    }
    return { humanRequest, humanIssueSummary, replyTarget, composerSendEnabled: Boolean(this.data.input.trim() && replyTarget) };
  },
  async selectReplyTarget(event: WechatMiniprogram.TouchEvent) {
    if (!this.data.canReply || !this.data.assignedToMe || this.data.busy || this.data.sendAttempt || this.data.conversation?.status !== "human_active") return;
    if (this.data.replyTargetNeedsRefresh) { wx.showToast({ title: "请先刷新人工事项", icon: "none" }); return; }
    const id = String(event.currentTarget.dataset.id ?? "");
    const message = this.data.messages.find(item => item.id === id && item.senderType === "user" && item.sequence > this.data.contextStartSequence);
    if (!message || this.data.replyTarget?.id === id) return;
    if (this.data.input.trim()) {
      const epoch = this.lifecycleEpoch, token = sessionToken(), revision = this.inputRevision;
      const generation = this.data.humanRequest?.generation ?? 0, contextVersion = this.data.contextVersion;
      let answer: WechatMiniprogram.ShowModalSuccessCallbackResult;
      try { answer = await wx.showModal({ title: "更换回复问题？", content: "当前未发送的回复会清空，请针对新选择的问题重新填写。", confirmText: "更换问题" }); }
      catch { if (this.owns(epoch, token)) this.setData({ error: "确认窗口暂时无法打开，回复问题和草稿已保留，请重试。" }); return; }
      if (!answer.confirm || !this.owns(epoch, token) || this.data.busy || this.data.sendAttempt || revision !== this.inputRevision
        || generation !== (this.data.humanRequest?.generation ?? 0) || contextVersion !== this.data.contextVersion || this.data.replyTargetNeedsRefresh) return;
    }
    this.inputRevision += 1;
    this.setData({ replyTarget: { id, sequence: message.sequence, summary: this.questionSummary(message),
      generation: this.data.humanRequest?.generation ?? 0, contextVersion: this.data.contextVersion }, input: "", composerSendEnabled: false,
      composerCapped: false, composerLineCount: 1, error: "" });
    wx.nextTick(() => this.measureActions());
  },
  present(messages: readonly RawMessage[], conversation?: Conversation | null, presence?: Presence, memberDisplayName?: string): Message[] {
    const activeConversation = conversation === undefined ? this.data.conversation : conversation;
    const activePresence = presence ?? this.data.presence ?? emptyPresence;
    const activeMemberName = this.identityCache?.name(this.identityCache.memberKey) || memberDisplayName || this.data.memberDisplayName;
    const identityEpoch = this.lifecycleEpoch, identityToken = sessionToken(), cache = this.identityCache;
    return presentSupportMessages(messages.map(item => {
      this.identityCache?.accept(item.sender, () => { if (this.owns(identityEpoch, identityToken) && cache === this.identityCache) this.applyThreadState(this.threadState()); });
      return this.identityCache?.resolve(item) ?? item;
    }), {
      ownSenderType: "admin",
      counterpartyReadSequence: activeConversation?.memberReadSequence ?? 0,
      memberDisplayName: activeMemberName,
      agentDisplayName: activePresence.agentDisplayName
    });
  },
  headerPatch(conversation: Conversation | null, presence: Presence, assignedToMe?: boolean) {
    const owned = assignedToMe ?? this.data.assignedToMe;
    if (!conversation) return { statusLabel: "", statusTone: "neutral", presence };
    if (conversation.status === "waiting_human") return { statusLabel: "等待接管", statusTone: "waiting", presence };
    if (conversation.status === "ai_active") return { statusLabel: "AI 助手处理中", statusTone: "ai", presence };
    if (conversation.status === "resolved") return { statusLabel: "本次服务已结束", statusTone: "resolved", presence };
    if (!owned) return { statusLabel: "其他客服处理中", statusTone: "neutral", presence };
    return { statusLabel: presence.memberOnline ? "处理中 · 会员在线" : "处理中 · 会员未在线", statusTone: presence.memberOnline ? "online" : "neutral", presence };
  },
  applyThreadState(state: SupportThreadState<Message>, patch: Record<string, unknown> = {}) {
    const beforeLayout = this.actionsLayoutKey();
    const conversation = (patch.conversation as Conversation | undefined) ?? this.data.conversation;
    const presence = (patch.presence as Presence | undefined) ?? this.data.presence;
    const memberDisplayName = (patch.memberDisplayName as string | undefined) ?? this.data.memberDisplayName;
    const messages = this.present(state.messages, conversation, presence, memberDisplayName);
    const messagePatch = supportMessageSetDataPatch(this.data.messages, messages);
    this.setData({ ...messagePatch, syncCursor: state.syncCursor, maxSeenSequence: state.maxSeenSequence, readCursor: state.readCursor, ...patch });
    if (Object.keys(messagePatch).length) this.data.messages = messages;
    if (beforeLayout !== this.actionsLayoutKey()) {
      const epoch = this.lifecycleEpoch, token = sessionToken();
      wx.nextTick(() => { if (this.owns(epoch, token)) this.measureActions(); });
    }
  },
  actionsLayoutKey() {
    return JSON.stringify([this.data.loading, this.data.conversation?.status, this.data.assignedToMe,
      this.data.humanIssueSummary, this.data.replyTarget?.summary, this.data.replyTargetNeedsRefresh]);
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
      const status = await pageRead<any>(this,{ path: "/v1/management/support/ai/status", cacheTags: ["support"] });
      if (this.owns(epoch, ownerToken)) this.setData({ aiStatus: status.status || "PROVIDER INTEGRATION PENDING", aiProviderAvailable: status.providerAvailable === true });
    } catch {
      if (this.owns(epoch, ownerToken)) this.setData({ aiStatus: "PROVIDER INTEGRATION PENDING", aiProviderAvailable: false });
    }
  },
  async load() {
    if (!this.data.id) {
      this.setData({ loading: false, statusLabel: "", statusTone: "neutral", error: "未找到这次会话，请返回客服列表重新进入。" });
      return;
    }
    const epoch = this.lifecycleEpoch;
    const ownerToken = sessionToken();
    this.setData({ loading: true, error: "", statusLabel: "正在加载", statusTone: "neutral" });
    try {
      const page = await pageRead<any>(this,{ path: `/v1/management/support/conversations/${this.data.id}/messages`, cacheTags: ["support"] });
      if (!this.owns(epoch, ownerToken)) return;
      const topic = this.topicMetadata(page);
      if (topic.stale) { this.setData({ loading: false }); return; }
      if (!topic.changed && this.olderConversationMetadata(page)) { this.mergeOlderConversationMessages(page); await this.markRead(); return; }
      if (this.staleHumanRequest(page)) { this.setData({ loading: false }); return; }
      this.identityPage(page);
      const memberDisplayName = this.identityCache?.name(this.identityCache.memberKey) || page.memberDisplayName || "CISME 会员";
      const conversation = newestSupportConversation(this.data.conversation, page.conversation) as Conversation;
      const assignedToMe = page.assignedToMe === true;
      const presence = { ...emptyPresence, ...(page.presence ?? {}) } as Presence;
      const raw = this.normalize(page.messages || []).filter(item => item.sequence > topic.contextStartSequence);
      const messages = this.present(raw, conversation, presence, memberDisplayName);
      const state = createSupportThreadState(messages, page.latestCursor || 0);
      if (topic.changed) this.clearRetiredTopic();
      this.applyThreadState(state, {
        memberDisplayName,
        conversation,
        assignedToMe,
        olderCursor: page.olderCursor ?? null,
        contextStartSequence: topic.contextStartSequence,
        contextVersion: topic.contextVersion,
        loading: false,
        atBottom: true,
        newMessagesBelow: false,
        newMessagesBelowCount: 0,
        anchor: messages.length ? `operator-${messages[messages.length - 1]!.sequence}` : "",
        ...this.replyContextPatch(page, messages, topic.contextVersion, topic.changed),
        ...this.headerPatch(conversation, presence, assignedToMe)
      });
      this.downloadMedia(raw);
      await this.markRead();
      if (assignedToMe && conversation.status === "human_active") void this.publishPresence(true, Boolean(this.data.input.trim()), true);
    } catch {
      if (this.data.pageAlive && this.data.visible && this.lifecycleEpoch === epoch) this.setData({ loading: false, statusLabel: "", statusTone: "neutral", error: "会话暂时无法同步，请重试。" });
    }
  },
  async loadAftersales(){
    if(!this.data.canManageAftersale||!this.data.visible||!this.data.id)return;
    const epoch=this.lifecycleEpoch,token=sessionToken();
    try{
      const page=await pageRead<{items:AftersaleCase[]}>(this,{path:`/v1/management/support/conversations/${this.data.id}/aftersales`});
      if(this.owns(epoch,token))this.setData({aftersaleCases:page.items,aftersaleError:""});
    }catch(error){if(this.owns(epoch,token)){
      if([401,403].includes((error as {status?:number})?.status??0))this.setData({canManageAftersale:false,aftersaleCases:[],aftersaleOpen:false,returnFormCaseId:"",returnAttempt:null});
      else this.setData({aftersaleError:"售后记录暂时无法核对，请稍后刷新。"});
    }}
  },
  openAftersales(){if(this.data.canManageAftersale&&!this.data.busy){this.setData({aftersaleOpen:true,contextOpen:false});void this.loadAftersales();}},
  closeAftersales(){if(!this.data.busy)this.setData({aftersaleOpen:false});},
  openManageAftersale(event:WechatMiniprogram.TouchEvent){
    const id=String(event.currentTarget.dataset.id??'');
    if(!this.data.canManageAftersale||!this.data.visible||this.data.busy||!this.data.aftersaleCases.some(item=>item.id===id))return;
    wx.navigateTo({url:`/pages/aftersale/index?mode=management&caseId=${id}`});
  },
  selectReturnCase(event:WechatMiniprogram.TouchEvent){
    if(!this.data.assignedToMe||this.data.busy||this.data.returnAttempt)return;
    const id=String(event.currentTarget.dataset.id??""),row=this.data.aftersaleCases.find(item=>item.id===id);
    if(!row||!['awaiting_instruction','awaiting_return'].includes(row.state))return;
    this.setData({returnFormCaseId:id,aftersaleError:"",returnForm:{recipientName:"",phone:"",region:"",address:"",freightPayer:"",instructions:""}});
  },
  editReturnField(event:WechatMiniprogram.Input){
    if(!this.data.assignedToMe||this.data.busy||this.data.returnAttempt)return;
    const field=String(event.currentTarget.dataset.field??"");
    if(!['recipientName','phone','region','address','instructions'].includes(field))return;
    this.setData({[`returnForm.${field}`]:event.detail.value});
  },
  chooseFreight(event:WechatMiniprogram.PickerChange){
    if(this.data.assignedToMe&&!this.data.busy&&!this.data.returnAttempt)this.setData({'returnForm.freightPayer':String(event.detail.value)==='0'?'merchant':'member'});
  },
  async approveReturn(event:WechatMiniprogram.TouchEvent){
    const id=String(event.currentTarget.dataset.id??""),row=this.data.aftersaleCases.find(item=>item.id===id);
    if(!row||row.state!=='requested'||row.kind!=='return_refund')return;
    const epoch=this.lifecycleEpoch,token=sessionToken();
    let decision:WechatMiniprogram.ShowModalSuccessCallbackResult;
    try{decision=await wx.showModal({title:'确认需寄回核对？',content:'这只记录退货处理决定。发送本案真实收件信息后，才会请用户寄回。',confirmText:'确认处理'});}
    catch{if(this.owns(epoch,token))this.setData({aftersaleError:'确认窗口暂时无法打开，原处理状态已保留，请重试。'});return;}
    if(!decision.confirm||!this.owns(epoch,token))return;
    await this.runAftersaleAction(row,{action:'approve_return',expectedVersion:row.version,note:'已确认本案需寄回核对，待发送收件指引'});
  },
  async sendReturnInstruction(){
    if(!this.data.assignedToMe||!this.data.canManageAftersale||this.data.busy)return;
    const row=this.data.aftersaleCases.find(item=>item.id===this.data.returnFormCaseId);
    if(!row||!['awaiting_instruction','awaiting_return'].includes(row.state))return;
    if(this.data.returnAttempt){await this.runAftersaleAction(row,this.data.returnAttempt.payload);return;}
    const form=this.data.returnForm;
    if(!form.recipientName.trim()||!/^\+?[0-9-]{7,20}$/.test(form.phone.trim())||!form.region.trim()||!form.address.trim()||!form.freightPayer){
      this.setData({aftersaleError:'请完整填写收件人、电话、地区、地址和运费承担。'});return;
    }
    const payer=form.freightPayer==='merchant'?'商家':'用户';
    const epoch=this.lifecycleEpoch,token=sessionToken();
    let decision:WechatMiniprogram.ShowModalSuccessCallbackResult;
    try{decision=await wx.showModal({title:row.state==='awaiting_return'?'发送新版本退货指引？':'发送本案退货指引？',
      content:`${form.recipientName} · ${form.phone}\n${form.region} ${form.address}\n运费：${payer}承担。发送后会保留这一版指引，修改时需再发送新版本。`,confirmText:'确认发送'});}
    catch{if(this.owns(epoch,token))this.setData({aftersaleError:'确认窗口暂时无法打开，收件指引草稿已保留，请重试。'});return;}
    if(!decision.confirm||!this.owns(epoch,token))return;
    await this.runAftersaleAction(row,{action:'send_return_instruction',expectedVersion:row.version,note:'本案退货收件信息和运费承担已核对并发送',
      recipientName:form.recipientName.trim(),phone:form.phone.trim(),region:form.region.trim(),address:form.address.trim(),
      freightPayer:form.freightPayer,instructions:form.instructions.trim()});
  },
  async runAftersaleAction(row:AftersaleCase,payload:Record<string,unknown>){
    if(!this.data.assignedToMe||!this.data.canManageAftersale||this.data.busy||!this.data.visible)return;
    const attempt=this.data.returnAttempt??{key:clientOperationKey('aftersale-chat'),caseId:row.id,payload};
    if(attempt.caseId!==row.id)return;
    const epoch=this.lifecycleEpoch,token=sessionToken();this.setData({busy:true,aftersaleError:'',returnAttempt:attempt});
    try{
      await request({path:`/v1/management/support/conversations/${this.data.id}/aftersales/${row.id}/actions`,method:'POST',
        idempotencyKey:attempt.key,data:attempt.payload,cacheTags:['support']});
      if(!this.owns(epoch,token))return;
      this.setData({returnAttempt:null,returnFormCaseId:'',returnForm:{recipientName:'',phone:'',region:'',address:'',freightPayer:'',instructions:''}});
      await Promise.all([this.loadAftersales(),this.load()]);
    }catch(error){if(this.owns(epoch,token))this.setData({aftersaleError:[401,403,409,422].includes((error as {status?:number})?.status??0)
      ?'本案或权限已变化。请先刷新核对，原请求记录会保留。':'提交结果未核实；可用原请求重试，避免重复发送。'});
    }finally{if(this.owns(epoch,token))this.setData({busy:false});}
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
      const page = await pageRead<any>(this,{ path: `/v1/management/support/conversations/${this.data.id}/messages?after=${after}&limit=50`, cacheTags: ["support"] });
      if (!this.owns(epoch, ownerToken)) return;
      const topic = this.topicMetadata(page);
      if (topic.stale) return;
      if (!topic.changed && this.olderConversationMetadata(page)) { this.mergeOlderConversationMessages(page); this.pollFailures = 0; await this.markRead(); return; }
      if (this.staleHumanRequest(page)) return;
      this.identityPage(page);
      const conversation = newestSupportConversation(this.data.conversation, page.conversation) as Conversation;
      const presence = { ...emptyPresence, ...(page.presence ?? (topic.changed ? emptyPresence : this.data.presence)) } as Presence;
      const incoming = this.normalize(page.messages || []).filter(item => item.sequence > topic.contextStartSequence);
      const knownIds = new Set(this.data.messages.map((item) => item.id));
      const freshCount = incoming.filter((item) => !knownIds.has(item.id)).length;
      const assignedToMe = page.assignedToMe === undefined ? this.data.assignedToMe : page.assignedToMe === true;
      const lostAssignment = this.data.assignedToMe && !assignedToMe;
      if (lostAssignment) {
        void this.publishPresence(false, false, true);
        this.clearPresenceTimer();
        this.inputRevision += 1;
      }
      const state = mergeSyncPage(topic.changed ? createSupportThreadState<Message>([], topic.contextStartSequence) : this.threadState(), this.present(incoming, conversation, presence), page.latestCursor ?? after);
      const newest = state.messages[state.messages.length - 1];
      const shouldFollow = this.data.atBottom;
      if (freshCount || presence.memberTyping) this.lastActivityAt = Date.now();
      if (topic.changed) this.clearRetiredTopic();
      this.applyThreadState(state, {
        conversation,
        contextStartSequence: topic.contextStartSequence, contextVersion: topic.contextVersion,
        ...(topic.changed ? { olderCursor: page.olderCursor ?? null, atBottom: true } : {}),
        assignedToMe,
        ...this.replyContextPatch(page, state.messages, topic.contextVersion, topic.changed),
        ...(lostAssignment ? { input: "", sendAttempt: null, pendingMessage: null, replyTarget: null, composerCapped: false, composerLineCount: 1, composerSendEnabled: false } : {}),
        ...this.headerPatch(conversation, presence, assignedToMe),
        anchor: topic.changed ? newest ? `operator-${newest.sequence}` : "" : freshCount && shouldFollow && newest ? `operator-${newest.sequence}` : this.data.anchor,
        newMessagesBelowCount: shouldFollow || topic.changed ? 0 : (this.data.newMessagesBelowCount ?? 0) + freshCount,
        newMessagesBelow: shouldFollow || topic.changed ? false : this.data.newMessagesBelow || freshCount > 0
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
    const contextVersion = this.data.contextVersion, boundary = this.data.contextStartSequence;
    const preserve = this.data.messages[0]?.sequence;
    this.setData({ loadingOlder: true, atBottom: false });
    try {
      const page = await pageRead<any>(this,{ path: `/v1/management/support/conversations/${this.data.id}/messages?before=${this.data.olderCursor}&limit=50`, cacheTags: ["support"] });
      if (!this.owns(epoch, ownerToken) || contextVersion !== this.data.contextVersion || boundary !== this.data.contextStartSequence) return;
      const topic = this.topicMetadata(page);
      const olderMetadata = this.olderConversationMetadata(page);
      if (topic.stale || !olderMetadata && this.staleHumanRequest(page)) return;
      if (topic.changed) { await this.load(); return; }
      this.identityPage(page);
      const older = this.normalize(page.messages || []).filter(item => item.sequence > boundary);
      const state = mergeHistoryPage(this.threadState(), this.present(older));
      this.applyThreadState(state, { olderCursor: page.olderCursor ?? null, anchor: preserve ? `operator-${preserve}` : "",
        ...(!olderMetadata ? this.replyContextPatch(page, state.messages, topic.contextVersion) : {}) });
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
    const contextVersion = this.data.contextVersion;
    try {
      await request({ path: `/v1/management/support/conversations/${this.data.id}/read`, method: "POST", data: { lastSeenSequence: candidate }, cacheTags: ["support"] });
      if (!this.owns(epoch, ownerToken) || contextVersion !== this.data.contextVersion) return;
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
    if (this.data.busy || this.data.sendAttempt) return;
    this.inputRevision += 1;
    this.lastActivityAt = Date.now();
    const input = event.detail.value;
    this.setData({
      input,
      composerSendEnabled: Boolean(input.trim() && this.data.replyTarget && !this.data.replyTargetNeedsRefresh),
      sendAttempt: null,
      pendingMessage: null
    });
    void this.publishPresence(true, Boolean(input.trim()), !input.trim());
  },
  async suggest() {
    if (!this.data.aiProviderAvailable || !this.data.assignedToMe || this.data.busy || this.data.sendAttempt || !this.data.replyTarget || this.data.replyTargetNeedsRefresh) return;
    const draftRevision = this.inputRevision;
    const epoch = this.lifecycleEpoch;
    const ownerToken = sessionToken();
    const contextVersion = this.data.contextVersion;
    const replyTarget = this.data.replyTarget;
    this.setData({ busy: true, error: "" });
    try {
      const draft = await request<any>({ path: `/v1/management/support/conversations/${this.data.id}/suggested-reply`, method: "POST", data: { replyToMessageId: replyTarget.id,
        expectedHumanRequestGeneration: replyTarget.generation, contextVersion: replyTarget.contextVersion }, cacheTags: ["support"] });
      if (this.owns(epoch, ownerToken) && contextVersion === this.data.contextVersion && this.inputRevision === draftRevision && this.data.replyTarget?.id === replyTarget.id) {
        this.inputRevision += 1;
        const input = String(draft.text || "");
        this.setData({ input, composerSendEnabled: Boolean(input.trim() && this.data.replyTarget), sendAttempt: null });
      }
    } catch {
      if (this.owns(epoch, ownerToken)) this.setData({ error: "AI 建议回复不可用，请继续人工处理。草稿不会自动发送。" });
    } finally {
      if (this.owns(epoch, ownerToken)) this.setData({ busy: false });
    }
  },
  pendingFrom(attempt: SendAttempt, state: "pending" | "unknown"): Message {
    const raw = {
      id: `local-${attempt.id}`,
      sequence: this.data.maxSeenSequence + 1,
      senderType: "admin" as const,
      body: attempt.body,
      replyToMessageId: attempt.replyToMessageId,
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
    const previous = this.data.sendAttempt;
    const body = previous?.body ?? this.data.input.trim();
    if (!body || !this.data.canReply || !this.data.assignedToMe || this.data.busy || this.data.conversation?.status !== "human_active") return;
    const target = this.data.replyTarget;
    if (!previous && (!target || this.data.replyTargetNeedsRefresh || target.contextVersion !== this.data.contextVersion || target.generation !== (this.data.humanRequest?.generation ?? 0))) {
      this.setData({ composerSendEnabled: false, error: this.data.replyTargetNeedsRefresh ? "人工事项已变化，请刷新后确认要回复的问题。" : "请先点选要回复的用户消息。" }); return;
    }
    const draftRevision = this.inputRevision;
    const epoch = this.lifecycleEpoch;
    const ownerToken = sessionToken();
    const contextVersion = this.data.contextVersion;
    const sendAttempt = previous ?? { id: `wx-agent-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`, body,
      replyToMessageId: target!.id, expectedHumanRequestGeneration: target!.generation, contextVersion: target!.contextVersion };
    this.lastActivityAt = Date.now();
    this.setData({ busy: true, error: "", sendAttempt, pendingMessage: this.pendingFrom(sendAttempt, "pending") });
    void this.publishPresence(true, false, true);
    try {
      const result = await request<any>({ path: `/v1/management/support/conversations/${this.data.id}/messages`, method: "POST", data: { body, clientMessageId: sendAttempt.id,
        replyToMessageId: sendAttempt.replyToMessageId, expectedHumanRequestGeneration: sendAttempt.expectedHumanRequestGeneration, contextVersion: sendAttempt.contextVersion }, cacheTags: ["support"] });
      if (!this.owns(epoch, ownerToken) || contextVersion !== this.data.contextVersion || this.data.sendAttempt?.id !== sendAttempt.id) return;
      if (result.contextSyncRequired) {
        const clearDraft = this.inputRevision === draftRevision && this.data.input.trim() === body;
        if (clearDraft) this.inputRevision += 1;
        this.setData({ sendAttempt: null, pendingMessage: null, ...(clearDraft ? { input: "", composerCapped: false, composerLineCount: 1, composerSendEnabled: false } : {}) });
        await this.load(); return;
      }
      const topic = this.topicMetadata(result);
      if (topic.stale) { this.setData({ sendAttempt: null, pendingMessage: null }); return; }
      if (topic.changed) { this.clearRetiredTopic(); await this.load(); return; }
      const normalized = this.normalize([result.message]).filter(item => item.sequence > topic.contextStartSequence);
      if (normalized.length && !this.data.messages.some((item) => item.id === result.message.id)) this.append(normalized);
      const clearDraft = this.inputRevision === draftRevision && this.data.input.trim() === body;
      this.setData({
        ...(clearDraft ? { input: "", sendAttempt: null, composerCapped: false, composerLineCount: 1, composerSendEnabled: false } : {}),
        pendingMessage: null,
        conversation: result.conversation,
        contextStartSequence: topic.contextStartSequence, contextVersion: topic.contextVersion,
        ...this.headerPatch(result.conversation, this.data.presence, true)
      });
      if (clearDraft) this.inputRevision += 1;
      await this.markRead();
      wx.nextTick(() => this.measureActions());
    } catch (error) {
      if (this.owns(epoch, ownerToken) && contextVersion === this.data.contextVersion && this.data.sendAttempt?.id === sendAttempt.id) {
        if (["SUPPORT_CONTEXT_CHANGED", "SUPPORT_HUMAN_REQUEST_CHANGED", "SUPPORT_REPLY_TARGET_INVALID"].includes(String((error as {code?:string})?.code))) {
          this.clearRetiredTopic(); this.setData({ replyTargetNeedsRefresh: true, error: "人工事项已变化，原回复未发送。请刷新后确认要回复的问题。" });
        } else {
          const status = (error as {status?:number})?.status;
          if (status && status >= 400 && status < 500 && status !== 408 && status !== 429)
            this.setData({ sendAttempt: null, pendingMessage: null, error: "回复未发送，请核对问题或刷新后重试。" });
          else this.setData({ error: "回复是否发送成功还未确认，文字和回复对象已保留，请重试核对。", pendingMessage: this.pendingFrom(sendAttempt, "unknown") });
        }
      }
    } finally {
      if (this.owns(epoch, ownerToken)) this.setData({ busy: false });
    }
  },
  retrySend() { void this.send(); },
  async resolve() {
    if (!this.data.canReply || !this.data.assignedToMe || this.data.busy || this.data.conversation?.status !== "human_active") return;
    if (this.data.sendAttempt) { this.setData({ error: "请先核对上条回复，再结束人工事项。" }); return; }
    const epoch = this.lifecycleEpoch;
    const ownerToken = sessionToken();
    const conversationId = this.data.conversation.id, expectedVersion = this.data.conversation.version, contextVersion = this.data.contextVersion;
    const humanGeneration = this.data.humanRequest?.generation ?? 0;
    const draftWarning = this.data.input.trim() ? "当前未发送的回复草稿会清除。" : "";
    let submitted = false;
    try {
      const decision = await wx.showModal({ title: "确认解决这次问题？", content: `${draftWarning}会话历史会保留。用户再次发送消息时会重新开启咨询。`, confirmText: "确认解决" });
      if (!decision.confirm || !this.owns(epoch, ownerToken)) return;
      if (this.data.busy || this.data.sendAttempt || !this.data.canReply || !this.data.assignedToMe || this.data.conversation?.status !== "human_active"
        || this.data.conversation.id !== conversationId || this.data.conversation.version !== expectedVersion
        || this.data.contextVersion !== contextVersion || (this.data.humanRequest?.generation ?? 0) !== humanGeneration) {
        this.setData({ error: "会话已变化，请刷新后再确认解决。" }); return;
      }
      this.setData({ busy: true, error: "" }); submitted = true;
      const conversation = await request<Conversation>({ path: `/v1/management/support/conversations/${conversationId}/resolve`, method: "POST", data: { expectedVersion }, cacheTags: ["support"] });
      if (!this.owns(epoch, ownerToken)) return;
      if (conversation.id !== conversationId || conversation.status !== "resolved"
        || this.data.conversation?.id !== conversationId || this.data.contextVersion !== contextVersion
        || (this.data.humanRequest?.generation ?? 0) !== humanGeneration
        || newestSupportConversation(this.data.conversation, conversation) !== conversation) {
        await this.load(); return;
      }
      this.clearPresenceTimer();
      this.inputRevision += 1;
      this.setData({ conversation, assignedToMe: false, humanRequest: null, humanIssueSummary: "", replyTarget: null, replyTargetNeedsRefresh: false,
        input: "", sendAttempt: null, pendingMessage: null, composerCapped: false, composerLineCount: 1, composerSendEnabled: false, ...this.headerPatch(conversation, emptyPresence, false) });
      wx.nextTick(() => { if (this.owns(epoch, ownerToken)) this.measureActions(); });
    } catch {
      if (this.owns(epoch, ownerToken)) this.setData({ error: submitted ? "状态已变化，请刷新后再确认。" : "确认窗口暂时无法打开，人工接待和草稿已保留，请重试。" });
    } finally {
      if (submitted && this.owns(epoch, ownerToken)) this.setData({ busy: false });
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
    const contextVersion = this.data.contextVersion;
    const downloads = this.mediaDownloads ?? [];
    this.mediaDownloads = downloads;
    for (const message of messages) for (const attachment of message.attachments ?? []) {
      if (attachment.localPath || !attachment.previewPath) continue;
      const download = downloadPrivateMedia(attachment.previewPath);
      const abort = () => download.abort();
      downloads.push(abort);
      void download.promise.then((localPath) => {
        if (!this.owns(epoch, ownerToken) || contextVersion !== this.data.contextVersion) return;
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
      wx.showToast({ title: "图片仍在加载，请稍后重试", icon: "none" });
      return;
    }
    wx.previewImage({ current, urls: attachments.map((attachment) => attachment.localPath!) });
  },
  openOrder(event: WechatMiniprogram.TouchEvent) {
    const id = String(event.currentTarget.dataset.id ?? "");
    if (id) wx.navigateTo({ url: `/pages/management-order-detail/index?id=${encodeURIComponent(id)}` });
  },
  retry() { this.setData({ replyTargetNeedsRefresh: false }); return this.onShow(); },
  back() {
    wx.navigateBack({ fail: () => wx.redirectTo({ url: "/pages/management-support/index" }) });
  }
});
