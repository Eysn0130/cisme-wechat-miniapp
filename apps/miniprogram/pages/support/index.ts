import { pageRead, cancelPageReads } from "../../services/page-requests";
import { commerceContextRevision } from "../../services/commerce-command-store";
import { downloadPrivateMedia, historicalCommerceClosed, historicalCommerceToken, requireHistoricalCommerceAccess, requireMemberAccess, request, retainMemberSnapshot, uploadAuthorized } from "../../services/api";
import { centsToYuan } from "../../services/commerce";
import { nativeCatalogImage } from "../../services/catalog";
import { myOrder, myOrders, type CommerceOrderSummary } from "../../services/orders";
import { currentChromeStyle } from "../../services/layout";
import { GENERAL_SUPPORT_SCOPE, stageSupportDraft, takeSupportDraft, stageSupportSendAttempt, takeSupportSendAttempt } from "../../services/support-draft-handoff";
import {
  createSupportThreadState,
  mergeAcknowledgement,
  mergeHistoryPage,
  mergeSyncPage,
  newestSupportConversation,
  presentSupportMessages,
  readableSequence,
  supportHeaderPresentation,
  supportMessageSetDataPatch,
  supportPollDelay,
  withReadCursor,
  type PresentedSupportMessage,
  type SupportThreadState
} from "../../services/support-thread-state";

type Attachment = { id: string; mimeType: string; sizeBytes: number; previewPath: string; localPath?: string };
type OrderCard = { orderId: string; orderNumberTail: string; status: string; currency: "CNY"; totalCents: number; productName: string; productImage: string | null; itemSummary: string; statusLabel?: string; totalYuan?: string };
type RawMessage = { id: string; sequence: number; senderType: "user" | "ai" | "admin" | "system"; body: string; contentType: string; createdAt: string; attachments: Attachment[]; orderCard: OrderCard | null;
  replyToMessageId?: string | null;
  returnInstruction?:{caseId:string;version:number;recipientName:string;phone:string;region:string;address:string;freightPayer:string;instructions:string}|null;
  deliveryState: "server_accepted" | "read" };
type Message = PresentedSupportMessage<RawMessage>;
type Conversation = { id: string; status: "ai_active" | "waiting_human" | "human_active" | "resolved"; version: number; memberReadSequence?: number; teamReadSequence?: number };
type Presence = { agentDisplayName: string; operatorOnline: boolean; operatorTyping: boolean; memberOnline: boolean; memberTyping: boolean; serverTime: string };
type SelectedImage = { localPath: string; size: number; mimeType: string; status: "uploading" | "ready" | "failed"; progress: number; mediaId: string; error: string };
type OrderChoice = { id: string; orderNumberTail: string; status: string; statusLabel: string; totalYuan: string; totalCents: number; currency: "CNY"; productName: string; productImage: string | null; itemSummary: string };
type SendAttempt = { id: string; signature: string; body: string; mediaIds: string[]; linkedOrderId: string | null; expectedConversationId: string | null; contextVersion: number };
type NewTopicAttempt = { conversationId: string; expectedVersion: number; requestId: string };
type HandoffAttempt = { contextVersion: number; questionMessageId: string | null; expectedConversationId?: string };
type TopicMetadata = { contextStartSequence?: unknown; contextVersion?: unknown; conversation?: Conversation | null };
type AiCapabilities = { supportAiAvailable?: unknown; supportAiCanRespond?: unknown };

const emptyPresence: Presence = { agentDisplayName: "CISME 客服", operatorOnline: false, operatorTyping: false, memberOnline: false, memberTyping: false, serverTime: "" };
const orderStatusLabels: Record<string, string> = { pending_payment: "待支付", paid:"已付款", shipped:"已发货", delivered:"已签收", completed:"已完成", cancelled: "已取消", expired: "已超时" };
function sessionToken(): string { return historicalCommerceToken(); }
function isCancellation(error: unknown): boolean { return /cancel|abort/i.test(String((error as {errMsg?:string})?.errMsg ?? (error as {code?:string})?.code ?? error)); }
function newTopicRequestId(): string { return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, char => { const n = Math.floor(Math.random() * 16); return (char === 'x' ? n : n & 3 | 8).toString(16); }); }
function memberComposerCanSend(input: string, image: SelectedImage | null, order: OrderChoice | null): boolean {
  if (image && (image.status !== "ready" || !image.mediaId)) return false;
  return Boolean(input.trim() || image?.mediaId || order);
}

Page({
  linkedOrderId:"",
  snapshotToken:"",
  readRevision:commerceContextRevision(),
  pollTimer: null as ReturnType<typeof setTimeout> | null,
  pollInFlight: false,
  pollFailures: 0,
  lifecycleEpoch: 0,
  aiWaitRevision: 0,
  newTopicRevision: 0,
  handoffRevision: 0,
  inputRevision: 0,
  orderSelectionRevision: 0,
  linkedOrderAttempt: 0,
  linkedOrderDismissed: false,
  orderPickerRevision: 0,
  orderPickerToken: "",
  lastScrollTop: 0,
  lastActivityAt: 0,
  lastPresenceSentAt: 0,
  presenceTimer: null as ReturnType<typeof setTimeout> | null,
  uploadAttempt: 0,
  choosingImage: false,
  nativePickerReturn: null as (() => void) | null,
  uploadAbort: null as (() => void) | null,
  mediaDownloads: [] as Array<() => void>,
  data: {
    chromeStyle: currentChromeStyle(), closedRights:false, conversation: null as Conversation | null, messages: [] as Message[], syncCursor: 0, maxSeenSequence: 0, readCursor: 0,
    olderCursor: null as number | null, historyStartLoaded: false, presence: emptyPresence, statusLabel: "联系客服", statusTone: "neutral", input: "", sendAttempt: null as SendAttempt | null,
    contextStartSequence: 0, contextVersion: 0, newTopicAvailable: false, newTopicBusy: false, newTopicAttempt: null as NewTopicAttempt | null,
    pendingMessage: null as Message | null, loading: true, historyLoaded: false, loadingOlder: false, sending: false, handoffBusy: false, handoffFailed: false, handoffAttempt: null as HandoffAttempt | null, aiReplyWaiting: false, supportAiAvailable:false, supportAiCanRespond: null as boolean | null, error: "", errorAction: "" as "" | "sync" | "handoff", anchor: "", pageAlive: false, visible: false,
    atBottom: true, newMessagesBelowCount: 0, newMessagesBelow: false, threadBottomStyle: "bottom:calc(env(safe-area-inset-bottom) + 244rpx)",
    newMessageBottomStyle: "bottom:calc(env(safe-area-inset-bottom) + 266rpx)", composerFocused: false, keyboardHeight: 0, composerCapped: false, composerLineCount: 1, composerSendEnabled: false,
    attachmentSheetOpen: false, attachmentSheetMode: "image" as "image" | "attachment", orderPickerOpen: false, orderPickerLoading: false, orderPickerMoreBusy: false, orderPickerNextCursor: null as string | null, orderPickerError: "", orderChoices: [] as OrderChoice[], selectedOrder: null as OrderChoice | null,
    selectedImage: null as SelectedImage | null, uploadBusy: false
  },
  onLoad(options:Record<string,string>) { this.data.pageAlive = true;
    const orderId=options.orderId??'';
    this.linkedOrderId=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(orderId)?orderId:''; },
  onReady() { this.measureComposer(); },
  onResize() { this.setData({ chromeStyle: currentChromeStyle() }); this.scheduleComposerMeasure(); },
  onShow() {
    const previousRevision = this.readRevision;
    this.readRevision=commerceContextRevision();
    const token=sessionToken(),closedRights=historicalCommerceClosed();
    const preserve = (retainMemberSnapshot(this)||Boolean(token&&this.snapshotToken===token)) && previousRevision===this.readRevision;
    this.snapshotToken=token;
    this.lifecycleEpoch += 1;
    this.newTopicRevision += 1;
    this.stopAiReplyWait();
    this.data.pageAlive = true;
    this.data.visible = true;
    this.nativePickerReturn?.();
    this.nativePickerReturn = null;
    this.lastActivityAt = Date.now();
    this.orderPickerRevision += 1;
    this.orderPickerToken = "";
    this.setData({ sending: false, handoffBusy: false, newTopicBusy: false, closedRights, orderPickerOpen: false, orderPickerLoading: false, orderPickerMoreBusy: false, orderPickerNextCursor: null, orderChoices: [], orderPickerError: "" });
    if (!preserve) {
      this.inputRevision += 1;
      this.orderSelectionRevision += 1;
      this.linkedOrderDismissed = false;
      this.abortTransientWork();
      this.setData({ conversation: null, messages: [], syncCursor: 0, maxSeenSequence: 0, readCursor: 0, olderCursor: null, presence: emptyPresence,
        historyLoaded: false, historyStartLoaded: false, supportAiAvailable: false, supportAiCanRespond: null, statusLabel: "联系客服", statusTone: "neutral", handoffFailed: false, handoffAttempt: null,
        contextStartSequence: 0, contextVersion: 0, newTopicAvailable: false, newTopicAttempt: null,
        input: "", sendAttempt: null, pendingMessage: null, error: "", errorAction: "", anchor: "", atBottom: true, newMessagesBelowCount: 0, newMessagesBelow: false,
        attachmentSheetOpen: false, attachmentSheetMode: "image", orderPickerOpen: false, orderChoices: [], selectedOrder: null, selectedImage: null, uploadBusy: false,
        composerFocused: false, keyboardHeight: 0, composerCapped: false, composerLineCount: 1, composerSendEnabled: false });
    }
    if(closedRights&&!this.linkedOrderId){this.data.visible=false;wx.redirectTo({url:'/pages/privacy-rights/index'});return;}
    if (!(closedRights?requireHistoricalCommerceAccess(`/pages/support/index?orderId=${this.linkedOrderId}`):requireMemberAccess("/pages/support/index"))) { this.data.visible = false; return; }
    const draftScope=this.linkedOrderId||GENERAL_SUPPORT_SCOPE;
    if(!this.data.sendAttempt){
      const pending=takeSupportSendAttempt(sessionToken(),draftScope);
      if(pending){
        const sendAttempt:SendAttempt={id:pending.id,body:pending.body,mediaIds:[],linkedOrderId:pending.linkedOrderId,
          signature:this.sendSignature(pending.body,[],pending.linkedOrderId),expectedConversationId:pending.expectedConversationId??null,contextVersion:pending.contextVersion??0};
        this.setData({input:pending.body,sendAttempt,pendingMessage:this.pendingFrom(sendAttempt,'unknown'),
          composerSendEnabled:true,error:'发送结果尚未确认，重试不会重复发送。'});
      }
    }
    if(!this.data.input&&!this.data.sendAttempt){
      const draft=takeSupportDraft(sessionToken(),draftScope);
      if(draft)this.setData({input:draft,composerSendEnabled:closedRights?Boolean(draft.trim()):memberComposerCanSend(draft,this.data.input?this.data.selectedImage:this.data.selectedImage,this.data.selectedOrder)});
    }
    if (preserve && this.data.conversation && !this.data.loading) {
      // Keep the existing scroll-view and its reading position through native
      // image preview, privacy authorization and temporary page navigation.
      this.downloadMedia(this.data.messages);
      void this.poll();
    } else void this.load();
    if(this.linkedOrderId)void this.loadLinkedOrder();
    wx.nextTick(() => this.measureComposer());
  },
  onHide() {
    this.newTopicRevision += 1;
    this.stopAiReplyWait();
    cancelPageReads(this);
    if (this.data.newTopicBusy) this.setData({ newTopicBusy: false, ...(this.data.newTopicAttempt ? { error: "新对话结果待确认，请点击「重试新对话」。", errorAction: "" } : {}) });
    void this.publishPresence(false, false, true);
    if (this.data.sending && this.data.sendAttempt) this.setData({
      sending: false, pendingMessage: this.pendingFrom(this.data.sendAttempt, "unknown"),
      error: "发送结果尚未确认，内容已保留，请重试。", errorAction: ""
    });
    const interruptedUpload = this.data.uploadBusy && this.data.selectedImage
      ? { ...this.data.selectedImage, status: "failed" as const, error: "刚才的图片上传已中断，图片和文字都已保留。" }
      : null;
    this.data.visible = false;
    this.lifecycleEpoch += 1;
    // The system album/camera can hide this page. Its result is checked again
    // against the live identity after onShow instead of being discarded here.
    this.stopPolling();
    this.clearPresenceTimer();
    this.abortTransientWork();
    this.orderPickerRevision += 1;
    this.orderPickerToken = "";
    this.setData({ composerFocused: false, keyboardHeight: 0, orderPickerOpen: false, orderPickerLoading: false, orderPickerMoreBusy: false, orderPickerNextCursor: null, orderChoices: [] });
    if (interruptedUpload) this.setData({ uploadBusy: false, selectedImage: interruptedUpload, composerSendEnabled: false, error: interruptedUpload.error, errorAction: "" });
  },
  onUnload() { this.newTopicRevision += 1; this.stopAiReplyWait(); const draftScope=this.linkedOrderId||GENERAL_SUPPORT_SCOPE;
    if(!this.data.selectedImage&&this.data.sendAttempt?.linkedOrderId===(this.linkedOrderId||null)&&
      !this.data.sendAttempt.mediaIds.length)stageSupportSendAttempt(sessionToken(),draftScope,{id:this.data.sendAttempt.id,body:this.data.sendAttempt.body,linkedOrderId:this.linkedOrderId||null,
        expectedConversationId:this.data.sendAttempt.expectedConversationId,contextVersion:this.data.sendAttempt.contextVersion});
    else if(!this.linkedOrderDismissed&&!this.data.sendAttempt&&!this.data.selectedImage&&this.data.input.trim())
      stageSupportDraft(sessionToken(),draftScope,this.data.input);
    cancelPageReads(this); void this.publishPresence(false, false, true); this.data.pageAlive = false; this.data.visible = false; this.lifecycleEpoch += 1; this.stopPolling(); this.clearPresenceTimer(); this.abortTransientWork(); this.choosingImage = false; this.nativePickerReturn?.(); this.nativePickerReturn = null; },
  openAftersaleCase(event:WechatMiniprogram.TouchEvent){
    const id=String(event.currentTarget.dataset.id??'');
    if(!this.data.visible||!this.data.messages.some(item=>item.returnInstruction?.caseId===id))return;
    wx.navigateTo({url:`/pages/aftersale/index?caseId=${id}`});
  },
  owns(epoch: number, ownerToken: string) { return this.data.pageAlive && this.data.visible && this.lifecycleEpoch === epoch && sessionToken() === ownerToken && this.readRevision === commerceContextRevision(); },
  stopAiReplyWait() { this.aiWaitRevision += 1; if (this.data.aiReplyWaiting) this.setData({ aiReplyWaiting: false }); },
  currentConversation(incoming: Conversation | null | undefined) { return newestSupportConversation(this.data.conversation, incoming); },
  responseContextVersion(page: TopicMetadata) {
    const value = Number(page.contextVersion ?? 0);
    return Number.isSafeInteger(value) && value >= 0 ? value : 0;
  },
  staleTopic(page: TopicMetadata) {
    return Boolean(this.data.conversation && page.conversation?.id === this.data.conversation.id
      && this.responseContextVersion(page) < this.data.contextVersion);
  },
  topicVersion(page: TopicMetadata, current: Conversation | null) {
    const prior = this.data.conversation?.id === current?.id ? this.data.contextVersion : 0;
    return page.conversation?.id === current?.id ? Math.max(prior, this.responseContextVersion(page)) : prior;
  },
  topicBoundary(page: TopicMetadata, current: Conversation | null) {
    const prior = this.data.conversation?.id === current?.id ? this.data.contextStartSequence : 0;
    if (page.conversation?.id !== current?.id || this.staleTopic(page)) return prior;
    const value = Number(page.contextStartSequence ?? 0);
    return Math.max(prior, Number.isSafeInteger(value) && value >= 0 ? value : 0);
  },
  changedTopic(conversation: Conversation | null, contextVersion: number, boundary: number) {
    return Boolean(this.data.conversation && (conversation?.id !== this.data.conversation.id
      || contextVersion > this.data.contextVersion || boundary > this.data.contextStartSequence));
  },
  clearRetiredTopic(contextVersion?: number, conversationId?: string) {
    const attempt = this.data.sendAttempt;
    const keepAttempt = Boolean(attempt && (attempt.contextVersion??0) === contextVersion
      && (attempt.expectedConversationId === conversationId || !attempt.expectedConversationId && contextVersion === 0));
    this.stopAiReplyWait(); this.clearPresenceTimer(); this.abortTransientWork();
    this.handoffRevision += 1;
    if (!keepAttempt) this.clearTopicDraft();
    this.lastScrollTop = 0; this.lastPresenceSentAt = 0;
    this.orderPickerRevision += 1; this.orderPickerToken = "";
    this.setComposerState({ ...(!keepAttempt ? { pendingMessage: null, sendAttempt: null, sending: false } : {}), uploadBusy: false, handoffBusy: false,
      presence: emptyPresence, anchor: "", olderCursor: null, historyStartLoaded: false, loadingOlder: false, handoffFailed: false, handoffAttempt: null,
      atBottom: true, newMessagesBelow: false, newMessagesBelowCount: 0 });
  },
  abortDownloads() {
    const downloads = this.mediaDownloads ?? [];
    this.mediaDownloads = [];
    for (const abort of downloads) abort();
  },
  abortTransientWork() {
    this.abortDownloads();
    this.uploadAttempt = (this.uploadAttempt ?? 0) + 1;
    this.uploadAbort?.();
    this.uploadAbort = null;
  },
  async loadLinkedOrder(){
    const epoch=this.lifecycleEpoch,token=sessionToken(),id=this.linkedOrderId,revision=this.orderSelectionRevision;
    if(!id||this.linkedOrderDismissed||this.data.selectedOrder)return;
    const attempt=++this.linkedOrderAttempt;
    const current=()=>this.owns(epoch,token)&&attempt===this.linkedOrderAttempt&&revision===this.orderSelectionRevision&&!this.linkedOrderDismissed;
    try{const order=await myOrder(id,this);if(!current()||order.id!==id||this.data.selectedOrder)return;
      const selected:OrderChoice={id,orderNumberTail:order.orderNumber.slice(-4),status:order.status,
        statusLabel:orderStatusLabels[order.status]??"状态待更新",totalYuan:centsToYuan(order.totalCents),totalCents:order.totalCents,
        currency:order.currency,productName:order.lines[0]?.productName??'订单商品',productImage:nativeCatalogImage(order.lines[0]?.image),
        itemSummary:order.lines.map(line=>`${line.productName} · ${line.skuLabel} × ${line.quantity}`).join('；')};
      this.setData({selectedOrder:selected,composerSendEnabled:this.data.closedRights?Boolean(this.data.input.trim()):memberComposerCanSend(this.data.input,this.data.selectedImage,selected)});
      this.scheduleComposerMeasure();
    }catch{if(current())this.setComposerState({error:this.data.closedRights?'订单暂时无法同步，请返回历史订单重试。':'关联订单暂时无法同步，可在下方选择订单。',errorAction:'sync'});}
  },
  clearPresenceTimer() { if (this.presenceTimer) clearTimeout(this.presenceTimer); this.presenceTimer = null; },
  threadState(): SupportThreadState<Message> { return { messages: this.data.messages, syncCursor: this.data.syncCursor, maxSeenSequence: this.data.maxSeenSequence, readCursor: this.data.readCursor }; },
  present(messages: readonly RawMessage[], conversation?: Conversation | null, presence?: Presence): Message[] {
    const activeConversation = conversation === undefined ? this.data.conversation : conversation;
    const activePresence = presence ?? this.data.presence ?? emptyPresence;
    return presentSupportMessages(messages, { ownSenderType: "user", counterpartyReadSequence: activeConversation?.teamReadSequence ?? 0, agentDisplayName: activePresence.agentDisplayName });
  },
  headerPatch(conversation: Conversation | null, presence: Presence, aiAvailable?: boolean) {
    if (!conversation) return (aiAvailable ?? this.data.supportAiAvailable) && !this.data.closedRights
      ? { statusLabel: "CISME AI 客服", statusTone: "ai", presence }
      : { statusLabel: "欢迎留言", statusTone: "neutral", presence };
    if (conversation.status === "ai_active" && !(aiAvailable ?? this.data.supportAiAvailable)) return { statusLabel: "AI 客服暂不可用", statusTone: "neutral", presence };
    const header = supportHeaderPresentation({ status: conversation?.status ?? "waiting_human", agentDisplayName: presence.agentDisplayName, operatorOnline: presence.operatorOnline });
    return { statusLabel: header.label, statusTone: header.tone, presence };
  },
  aiCapabilityPatch(page: AiCapabilities) {
    return { supportAiAvailable: page.supportAiAvailable === true,
      supportAiCanRespond: typeof page.supportAiCanRespond === "boolean" ? page.supportAiCanRespond : null };
  },
  confirmedHandoffPatch(conversation: Conversation | null): Record<string, unknown> {
    return conversation?.status === "waiting_human" || conversation?.status === "human_active"
      ? { handoffAttempt: null, handoffFailed: false, ...(this.data.errorAction === "handoff" ? { error: "", errorAction: "" } : {}) } : {};
  },
  canAwaitAiReply() {
    if (this.data.closedRights || !this.data.supportAiAvailable) return false;
    if (this.data.supportAiCanRespond !== null) return this.data.supportAiCanRespond;
    // Older services only support bot replies before a conversation handoff.
    const status = this.data.conversation?.status;
    return !status || status === "ai_active" || status === "resolved";
  },
  applyThreadState(state: SupportThreadState<Message>, patch: Record<string, unknown> = {}) {
    const conversation = (patch.conversation as Conversation | undefined) ?? this.data.conversation;
    const presence = (patch.presence as Presence | undefined) ?? this.data.presence;
    const messages = this.present(state.messages, conversation, presence);
    const messagePatch = supportMessageSetDataPatch(this.data.messages, messages);
    this.setComposerState({ ...messagePatch, syncCursor: state.syncCursor, maxSeenSequence: state.maxSeenSequence, readCursor: state.readCursor, ...patch });
    if (Object.keys(messagePatch).length) this.data.messages = messages;
  },
  composerControlKey() {
    if (this.data.closedRights) return "";
    const status = this.data.conversation?.status;
    const human = status === "waiting_human" || status === "human_active";
    const topic = this.data.newTopicAttempt || this.data.historyLoaded && !this.data.loading && (human || this.data.newTopicAvailable && (!status || status === "ai_active" || status === "resolved"))
      ? this.data.newTopicBusy ? ":topic-busy" : this.data.newTopicAttempt ? ":topic-retry" : ":topic" : "";
    if (human) return status + topic;
    if (!this.data.loading && this.data.errorAction !== "handoff" && (!status || status === "ai_active" || status === "resolved"))
      return (this.data.handoffBusy ? "handoff-busy" : "handoff") + topic;
    return topic;
  },
  setComposerState(patch: Record<string, unknown>) {
    const before = this.composerControlKey();
    const scopeChanged = "conversation" in patch && (patch.conversation as Conversation | null)?.id !== this.data.conversation?.id
      || "contextVersion" in patch && patch.contextVersion !== this.data.contextVersion
      || "contextStartSequence" in patch && patch.contextStartSequence !== this.data.contextStartSequence;
    if (scopeChanged && !("historyStartLoaded" in patch)) patch = { ...patch, historyStartLoaded: false };
    this.setData(patch);
    if (before !== this.composerControlKey()) this.scheduleComposerMeasure();
  },
  scheduleComposerMeasure() {
    const epoch = this.lifecycleEpoch, ownerToken = sessionToken();
    wx.nextTick(() => { if (this.owns(epoch, ownerToken)) this.measureComposer(); });
  },
  measureComposer() {
    if (!this.data.pageAlive || typeof wx.createSelectorQuery !== "function") return;
    const epoch = this.lifecycleEpoch, ownerToken = sessionToken();
    wx.createSelectorQuery().select(".support-composer").boundingClientRect((rect) => {
      if (!this.owns(epoch, ownerToken) || !rect || typeof rect.height !== "number") return;
      const height = Math.max(112, Math.ceil(rect.height));
      this.setData({ threadBottomStyle: `bottom:${height}px`, newMessageBottomStyle: `bottom:${height + 12}px` });
    }).exec();
  },
  onComposerLineChange(event: WechatMiniprogram.TextareaLineChange) {
    const lineCount = Math.max(1, Number(event.detail.lineCount) || 1);
    const composerCapped = lineCount > 6;
    if (lineCount !== this.data.composerLineCount || composerCapped !== this.data.composerCapped) this.setData({ composerLineCount: lineCount, composerCapped });
    wx.nextTick(() => this.measureComposer());
  },
  onKeyboardHeightChange(event: WechatMiniprogram.TextareaKeyboardHeightChange) {
    const keyboardHeight = Number(event.detail.height) || 0;
    if (keyboardHeight === this.data.keyboardHeight) return;
    this.setData({ keyboardHeight });
    wx.nextTick(() => this.measureComposer());
  },
  onComposerFocus() { this.lastActivityAt = Date.now(); this.setData({ composerFocused: true }); },
  onComposerBlur() { this.setData({ composerFocused: false }); void this.publishPresence(true, false, true); },
  activePolling() { return this.data.presence.operatorTyping || Date.now() - this.lastActivityAt < 30_000; },
  startPolling() { this.pollFailures = 0; this.schedulePoll(); },
  schedulePoll() {
    this.stopPolling();
    if (!this.data.pageAlive || !this.data.visible) return;
    this.pollTimer = setTimeout(() => void this.poll(), supportPollDelay(this.pollFailures, this.activePolling()));
  },
  stopPolling() { if (this.pollTimer) clearTimeout(this.pollTimer); this.pollTimer = null; },
  normalize(messages: RawMessage[], localImage?: SelectedImage | null) {
    return messages.map((item) => ({ ...item, attachments: (item.attachments ?? []).map((attachment) => ({ ...attachment,
      ...(localImage?.mediaId === attachment.id ? { localPath: localImage.localPath } : {}) })), orderCard: item.orderCard ? { ...item.orderCard, statusLabel: orderStatusLabels[item.orderCard.status] ?? "状态待更新", totalYuan: centsToYuan(item.orderCard.totalCents) } : null }));
  },
  async load() {
    const epoch = this.lifecycleEpoch;
    const ownerToken = sessionToken();
    const requestConversationId = this.data.conversation?.id;
    this.setComposerState({ loading: true, error: "", errorAction: "" });
    try {
      const page = await pageRead<any>(this,{ path: "/v1/me/support/messages", cacheTags: ["support"] });
      if (!this.owns(epoch, ownerToken)) return;
      if (requestConversationId !== this.data.conversation?.id && page.conversation?.id !== this.data.conversation?.id) return;
      if (this.staleTopic(page)) { this.setComposerState({ loading: false }); return; }
      const presence = { ...emptyPresence, ...(page.presence ?? {}) } as Presence;
      const conversation = this.currentConversation(page.conversation);
      const boundary = this.topicBoundary(page, conversation);
      const contextVersion = this.topicVersion(page, conversation);
      const changedTopic = this.changedTopic(conversation, contextVersion, boundary);
      const messages = this.normalize(page.messages || []).filter(item => item.sequence > boundary);
      const mergeExisting = !changedTopic && conversation !== (page.conversation ?? null);
      const state = mergeExisting
        ? mergeSyncPage(this.threadState(), this.present(messages, conversation, presence), page.latestCursor || 0)
        : createSupportThreadState(this.present(messages, conversation, presence), page.latestCursor || 0);
      // A stale empty read cannot prove the start of a later, longer thread.
      const historyStartLoaded = mergeExisting && this.data.historyStartLoaded || page.olderCursor == null
        && (messages.length > 0 || !state.messages.length || state.messages[0]!.sequence === boundary + 1);
      if (changedTopic) this.clearRetiredTopic(contextVersion, conversation?.id);
      this.applyThreadState(state, { conversation, olderCursor: page.olderCursor ?? null, historyStartLoaded, loading: false, historyLoaded: true, atBottom: true, newMessagesBelowCount: 0, newMessagesBelow: false,
        contextStartSequence: boundary, contextVersion, newTopicAvailable: page.newTopicAvailable === true,
        anchor: state.messages.length ? `support-${state.messages[state.messages.length - 1]!.sequence}` : "", ...this.aiCapabilityPatch(page),...this.confirmedHandoffPatch(conversation),...this.headerPatch(conversation, presence, page.supportAiAvailable===true) });
      this.downloadMedia(messages);
      await this.markRead();
      void this.publishPresence(true, Boolean(this.data.input.trim()), true);
      this.startPolling();
    } catch {
      if (this.owns(epoch, ownerToken)) this.setComposerState({ loading: false, error: "连接失败，请重试。", errorAction: "sync" });
    }
  },
  async poll() {
    if (this.pollInFlight || !this.data.pageAlive || !this.data.visible || this.data.loading || this.data.sending || this.data.newTopicBusy || !this.data.conversation) { this.schedulePoll(); return; }
    const epoch = this.lifecycleEpoch;
    const ownerToken = sessionToken();
    const after = this.data.syncCursor;
    const requestConversationId = this.data.conversation.id;
    this.pollInFlight = true;
    try {
      const page = await pageRead<any>(this,{ path: `/v1/me/support/messages?after=${after}&limit=50`, cacheTags: ["support"] });
      if (!this.owns(epoch, ownerToken)) return;
      if (requestConversationId !== this.data.conversation?.id) return;
      if (page.conversation?.id && page.conversation.id !== requestConversationId) { await this.load(); return; }
      if (this.staleTopic(page)) return;
      const conversation = this.currentConversation(page.conversation);
      const boundary = this.topicBoundary(page, conversation);
      const contextVersion = this.topicVersion(page, conversation);
      const changedTopic = this.changedTopic(conversation, contextVersion, boundary);
      const presence = { ...emptyPresence, ...(page.presence ?? (changedTopic ? emptyPresence : this.data.presence)) } as Presence;
      const incoming = this.normalize(page.messages || []).filter(item => item.sequence > boundary);
      const knownIds = new Set(this.data.messages.map((item) => item.id));
      const freshCount = incoming.filter((item) => !knownIds.has(item.id)).length;
      const state = mergeSyncPage(changedTopic ? createSupportThreadState<Message>([], boundary) : this.threadState(), this.present(incoming, conversation, presence), page.latestCursor ?? after);
      const historyStartLoaded = !changedTopic && this.data.historyStartLoaded || after <= boundary
        && (incoming.length > 0 || !state.messages.length || state.messages[0]!.sequence === boundary + 1);
      const newest = state.messages[state.messages.length - 1];
      const shouldFollow = this.data.atBottom;
      if (freshCount || presence.operatorTyping) this.lastActivityAt = Date.now();
      if (changedTopic) this.clearRetiredTopic(contextVersion, conversation?.id);
      this.applyThreadState(state, {
        conversation,
        contextStartSequence: boundary, contextVersion, historyStartLoaded, newTopicAvailable: page.newTopicAvailable === true,
        ...(changedTopic ? { olderCursor: page.olderCursor ?? null, atBottom: true } : {}),
        ...this.aiCapabilityPatch(page),...this.confirmedHandoffPatch(conversation),...this.headerPatch(conversation, presence, page.supportAiAvailable===true),
        anchor: changedTopic ? newest ? `support-${newest.sequence}` : "" : freshCount && shouldFollow && newest ? `support-${newest.sequence}` : this.data.anchor,
        newMessagesBelowCount: shouldFollow || changedTopic ? 0 : (this.data.newMessagesBelowCount ?? 0) + freshCount,
        newMessagesBelow: shouldFollow || changedTopic ? false : this.data.newMessagesBelow || freshCount > 0
      });
      if (incoming.length) this.downloadMedia(incoming);
      this.pollFailures = 0;
      await this.markRead();
      void this.publishPresence(true, Boolean(this.data.input.trim()));
    } catch { this.pollFailures += 1; }
    finally { this.pollInFlight = false; this.schedulePoll(); }
  },
  async loadOlder() {
    if (this.data.loadingOlder || this.data.olderCursor === null || this.data.newTopicBusy || this.data.newTopicAttempt) return;
    const epoch = this.lifecycleEpoch;
    const ownerToken = sessionToken();
    const boundary = this.data.contextStartSequence;
    const contextVersion = this.data.contextVersion;
    const conversationId = this.data.conversation?.id;
    const preserve = this.data.messages[0]?.sequence;
    this.setData({ loadingOlder: true, atBottom: false });
    try {
      const page = await pageRead<any>(this,{ path: `/v1/me/support/messages?before=${this.data.olderCursor}&limit=50`, cacheTags: ["support"] });
      if (!this.owns(epoch, ownerToken) || contextVersion !== this.data.contextVersion || boundary !== this.data.contextStartSequence || conversationId !== this.data.conversation?.id) return;
      if (page.conversation && page.conversation.id !== conversationId) { await this.load(); return; }
      if (this.staleTopic(page)) return;
      if (this.topicVersion(page, this.currentConversation(page.conversation)) > contextVersion || this.topicBoundary(page, this.currentConversation(page.conversation)) > boundary) { await this.load(); return; }
      const older = this.normalize(page.messages || []).filter(item => item.sequence > boundary);
      this.applyThreadState(mergeHistoryPage(this.threadState(), this.present(older)), { olderCursor: page.olderCursor ?? null,
        historyStartLoaded: this.data.historyStartLoaded || page.olderCursor == null, anchor: preserve ? `support-${preserve}` : "" });
      this.downloadMedia(older);
    } catch { if (this.data.visible) wx.showToast({ title: "更早消息暂时无法加载", icon: "none" }); }
    finally { if (this.data.pageAlive && this.data.visible && this.lifecycleEpoch === epoch) this.setData({ loadingOlder: false }); }
  },
  onThreadScroll(event: WechatMiniprogram.ScrollViewScroll) {
    const top = Number(event.detail.scrollTop) || 0;
    if (top + 8 < this.lastScrollTop && this.data.atBottom) this.setData({ atBottom: false, anchor: "" });
    this.lastScrollTop = top;
  },
  onThreadBottom() { if (!this.data.atBottom || this.data.newMessagesBelowCount) this.setData({ atBottom: true, newMessagesBelowCount: 0, newMessagesBelow: false }); void this.markRead(); },
  jumpToLatest() {
    const newest = this.data.messages[this.data.messages.length - 1];
    this.setData({ atBottom: true, newMessagesBelowCount: 0, newMessagesBelow: false, anchor: newest ? `support-${newest.sequence}` : "" });
    wx.nextTick(() => void this.markRead());
  },
  append(fresh: RawMessage[]) {
    let state = this.threadState();
    for (const item of this.present(fresh)) state = mergeAcknowledgement(state, item);
    const newest = state.messages[state.messages.length - 1];
    this.applyThreadState(state, { anchor: this.data.atBottom && newest ? `support-${newest.sequence}` : this.data.anchor,
      newMessagesBelowCount: this.data.atBottom ? 0 : (this.data.newMessagesBelowCount ?? 0) + fresh.length,
      newMessagesBelow: this.data.atBottom ? false : this.data.newMessagesBelow || fresh.length > 0 });
  },
  async markRead() {
    if(this.data.closedRights)return;
    const candidate = readableSequence(this.threadState(), "user", this.data.visible, this.data.atBottom);
    if (candidate === null) return;
    const epoch = this.lifecycleEpoch;
    const ownerToken = sessionToken();
    const conversationId = this.data.conversation?.id, contextVersion = this.data.contextVersion;
    try {
      await request({ path: "/v1/me/support/read", method: "POST", data: { lastSeenSequence: candidate }, cacheTags: ["support"] });
      if (!this.owns(epoch, ownerToken) || conversationId !== this.data.conversation?.id || contextVersion !== this.data.contextVersion) return;
      this.applyThreadState(withReadCursor(this.threadState(), candidate));
    } catch {}
  },
  updateInput(event: WechatMiniprogram.TextareaInput) {
    if(this.data.sending||this.data.sendAttempt||this.data.newTopicBusy||this.data.newTopicAttempt)return;
    this.inputRevision += 1;
    this.lastActivityAt = Date.now();
    const input = event.detail.value;
    this.setData({ input, composerSendEnabled: this.data.closedRights?Boolean(input.trim()):memberComposerCanSend(input, this.data.selectedImage, this.data.selectedOrder) });
    void this.publishPresence(true, Boolean(input.trim()), !input.trim());
  },
  async publishPresence(online: boolean, typing: boolean, force = false) {
    if(this.data.closedRights)return;
    if (!this.data.conversation) return;
    const elapsed = Date.now() - this.lastPresenceSentAt;
    if (!force && elapsed < 3_000) {
      this.clearPresenceTimer();
      this.presenceTimer = setTimeout(() => { this.presenceTimer = null; if (this.data.visible) void this.publishPresence(true, Boolean(this.data.input.trim()), true); }, 3_000 - elapsed);
      return;
    }
    this.lastPresenceSentAt = Date.now();
    try { await request({ path: "/v1/me/support/presence", method: "POST", data: { online, typing }, cacheTags: ["support"] }); } catch {}
  },
  sendSignature(body: string, mediaIds: string[], linkedOrderId: string | null) { return JSON.stringify([body, mediaIds, linkedOrderId]); },
  pendingFrom(attempt: SendAttempt, state: "pending" | "unknown"): Message {
    const raw = {
      id: `local-${attempt.id}`, sequence: this.data.maxSeenSequence + 1, senderType: "user" as const, body: attempt.body,
      contentType: attempt.mediaIds.length || attempt.linkedOrderId ? "mixed" : "text", createdAt: new Date().toISOString(), deliveryState: "server_accepted" as const,
      attachments: this.data.selectedImage && attempt.mediaIds.includes(this.data.selectedImage.mediaId) ? [{ id: this.data.selectedImage.mediaId, mimeType: this.data.selectedImage.mimeType, sizeBytes: this.data.selectedImage.size, previewPath: "", localPath: this.data.selectedImage.localPath }] : [],
      orderCard: this.data.selectedOrder?.id === attempt.linkedOrderId ? { orderId:this.data.selectedOrder.id,orderNumberTail:this.data.selectedOrder.orderNumberTail,status:this.data.selectedOrder.status,currency:this.data.selectedOrder.currency,totalCents:this.data.selectedOrder.totalCents,productName:this.data.selectedOrder.productName,productImage:this.data.selectedOrder.productImage,itemSummary:this.data.selectedOrder.itemSummary,statusLabel:this.data.selectedOrder.statusLabel,totalYuan:this.data.selectedOrder.totalYuan } : null,
      localState: state
    };
    return presentSupportMessages([raw], { ownSenderType: "user", counterpartyReadSequence: 0 })[0]! as Message;
  },
  async send() {
    const previous = this.data.sendAttempt;
    const body = previous?.body ?? this.data.input.trim();
    const mediaIds = previous?.mediaIds ?? (this.data.selectedImage?.status === "ready" && this.data.selectedImage.mediaId ? [this.data.selectedImage.mediaId] : []);
    const linkedOrderId = previous ? previous.linkedOrderId : (this.data.closedRights?this.linkedOrderId:(this.data.selectedOrder?.id ?? (!this.linkedOrderDismissed&&this.linkedOrderId?this.linkedOrderId:null)));
    if ((this.data.closedRights?(!body||!linkedOrderId||mediaIds.length>0):previous?!Boolean(body||mediaIds.length||linkedOrderId):!memberComposerCanSend(body, this.data.selectedImage, this.data.selectedOrder)) || this.data.sending || this.data.uploadBusy || this.data.newTopicBusy || this.data.newTopicAttempt) return;
    const signature = previous?.signature ?? this.sendSignature(body, mediaIds, linkedOrderId);
    const draftRevision = this.inputRevision;
    const epoch = this.lifecycleEpoch;
    const ownerToken = sessionToken();
    const sendAttempt = previous ?? { id: `wx-user-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`, signature, body, mediaIds, linkedOrderId,
      expectedConversationId: this.data.conversation?.id ?? null, contextVersion: this.data.contextVersion };
    const waitRevision = ++this.aiWaitRevision;
    const aiReplyWaiting = !previous && this.canAwaitAiReply() && !mediaIds.length && !linkedOrderId;
    this.lastActivityAt = Date.now();
    this.setComposerState({ sending: true, aiReplyWaiting, error: "", errorAction: "", sendAttempt, pendingMessage: this.pendingFrom(sendAttempt, "pending"),
      ...(aiReplyWaiting && this.data.atBottom ? { anchor: "support-ai-wait" } : {}) });
    void this.publishPresence(true, false, true);
    try {
      const result = await request<any>({ path: "/v1/me/support/messages", method: "POST", data: { body, clientMessageId: sendAttempt.id,
        ...(this.data.closedRights?{}:{mediaIds,contextVersion:sendAttempt.contextVersion??0,
          ...(sendAttempt.expectedConversationId?{expectedConversationId:sendAttempt.expectedConversationId}:{})}),linkedOrderId }, cacheTags: ["support"] });
      if (!this.owns(epoch, ownerToken) || this.data.sendAttempt?.id !== sendAttempt.id) return;
      if (this.aiWaitRevision === waitRevision) this.stopAiReplyWait();
      const priorConversationId = this.data.conversation?.id;
      const staleTopic = this.staleTopic(result);
      const conversation = staleTopic ? this.data.conversation : this.currentConversation(result.conversation);
      const boundary = this.topicBoundary(result, conversation);
      const contextVersion = this.topicVersion(result, conversation);
      const changedConversation = conversation?.id !== this.data.conversation?.id;
      const changedTopic = this.changedTopic(conversation, contextVersion, boundary);
      const sameConversation = !staleTopic && !result.contextSyncRequired && (sendAttempt.contextVersion??0) === contextVersion
        && (!result.acknowledgedConversationId || result.acknowledgedConversationId === conversation?.id);
      if (changedTopic) this.clearRetiredTopic();
      if (changedConversation || changedTopic) this.applyThreadState(createSupportThreadState<Message>([], boundary), {
        contextStartSequence: boundary, contextVersion, olderCursor: null, conversation,
        historyStartLoaded: sameConversation && result.message?.sequence === boundary + 1,
        newMessagesBelow: false, newMessagesBelowCount: 0, anchor: "", atBottom: true, loading: false, historyLoaded: true
      });
      const normalized = sameConversation ? this.normalize([result.message], this.data.selectedImage).filter(item => item.sequence > boundary) : [];
      if (normalized.length && !this.data.messages.some((item) => item.id === result.message.id)) this.append(normalized);
      if(sameConversation && Array.isArray(result.aiMessages)&&result.aiMessages.length)this.append(this.normalize(result.aiMessages).filter(item => item.sequence > boundary));
      const clearInput = this.inputRevision === draftRevision && this.data.input.trim() === body;
      const clearImage = this.data.selectedImage?.mediaId === mediaIds[0];
      const clearOrder = !this.data.closedRights && this.data.selectedOrder?.id === linkedOrderId;
      this.setComposerState({ ...(clearInput ? { input: "", composerCapped: false, composerLineCount: 1 } : {}),
        ...(clearImage ? { selectedImage: null } : {}), ...(clearOrder ? { selectedOrder: null } : {}),
        sendAttempt: null, composerSendEnabled: false, pendingMessage: null,
        ...(!staleTopic && typeof result.newTopicAvailable === 'boolean' ? { newTopicAvailable: result.newTopicAvailable } : {}),
        ...(!staleTopic && typeof result.supportAiCanRespond === 'boolean' ? { supportAiCanRespond: result.supportAiCanRespond } : {}),
        conversation, ...this.confirmedHandoffPatch(conversation), ...this.headerPatch(conversation, this.data.presence),
        ...(sameConversation && result.aiStatus==='pending' && result.message.sequence > boundary
          ? conversation?.status==='waiting_human' || conversation?.status==='human_active'
            ? {error:"消息已收到，回复暂未确认，请稍后刷新查看。",errorAction:"sync"}
            : !this.data.handoffBusy && !this.data.handoffFailed
              ? {error:"消息已收到，AI 回复暂未确认。你可以继续留言，或申请人工客服。",errorAction:"handoff",handoffFailed:false} : {} : {}) });
      if (clearInput) {
        this.inputRevision += 1;
        // Clearing a sent card must not silently reattach the route order.
        if (!this.data.closedRights) { this.linkedOrderDismissed = true; this.orderSelectionRevision += 1; }
      }
      this.setData({ composerSendEnabled: this.data.closedRights?Boolean(this.data.input.trim()):memberComposerCanSend(this.data.input,this.data.selectedImage,this.data.selectedOrder) });
      this.uploadAbort = null;
      this.startPolling();
      if (changedTopic || changedConversation && (priorConversationId || !sameConversation) || result.contextSyncRequired) {
        await this.load();
        if (this.owns(epoch, ownerToken) && this.data.error) this.setData({ error: "消息已收到，对话暂未同步，请刷新查看。", errorAction: "sync" });
      }
      await this.markRead();
      wx.nextTick(() => this.measureComposer());
    } catch (error) {
      if (this.owns(epoch, ownerToken) && this.data.sendAttempt?.id === sendAttempt.id) {
        if ((error as {code?:string})?.code === "SUPPORT_CONTEXT_CHANGED") {
          this.stopPolling(); cancelPageReads(this); const recoveryEpoch = ++this.lifecycleEpoch;
          this.clearRetiredTopic(); this.applyThreadState(createSupportThreadState<Message>([], this.data.contextStartSequence), { historyLoaded: false });
          await this.load();
          if (this.owns(recoveryEpoch, ownerToken))
            this.setComposerState({ error: "会话已更新，原消息未发送，请重新输入。", errorAction: "sync" });
        } else this.setComposerState({ error: "发送结果尚未确认，内容已保留，请重试。", errorAction: "", pendingMessage: this.pendingFrom(sendAttempt, "unknown") });
      }
    } finally {
      // A changed identity can invalidate ownership before another onShow.
      // The attempt revision prevents an old completion clearing a newer wait.
      if (this.aiWaitRevision === waitRevision) this.stopAiReplyWait();
      if (this.owns(epoch, ownerToken) && (!this.data.sendAttempt || this.data.sendAttempt.id === sendAttempt.id)) this.setData({ sending: false });
    }
  },
  retrySend() { void this.send(); },
  prepareAttachmentSheet(attachmentSheetMode: "image" | "attachment") {
    if(this.data.closedRights)return;
    if (this.data.sending || this.data.sendAttempt || this.data.uploadBusy || this.choosingImage || this.data.newTopicBusy || this.data.newTopicAttempt) return;
    if (typeof wx.hideKeyboard === "function") wx.hideKeyboard();
    this.setData({ attachmentSheetOpen: true, attachmentSheetMode, composerFocused: false });
  },
  openImageSheet() { this.prepareAttachmentSheet("image"); },
  openAttachmentSheet() { this.prepareAttachmentSheet("attachment"); },
  closeAttachmentSheet() { this.setData({ attachmentSheetOpen: false }); },
  stopPropagation() {},
  mimeForPath(path: string): string | null { const lower = path.toLowerCase(); return /\.(jpg|jpeg)$/.test(lower) ? "image/jpeg" : lower.endsWith(".png") ? "image/png" : lower.endsWith(".webp") ? "image/webp" : null; },
  async chooseImage(event: WechatMiniprogram.TouchEvent) {
    if (this.choosingImage || !this.data.pageAlive || !this.data.visible || this.data.newTopicBusy || this.data.newTopicAttempt) return;
    const source = event.currentTarget.dataset.source === "camera" ? "camera" : "album";
    const ownerToken = sessionToken();
    const revision = commerceContextRevision();
    const current = () => this.data.pageAlive && this.data.visible && sessionToken() === ownerToken && commerceContextRevision() === revision;
    const returned = async () => {
      while (this.data.pageAlive && !this.data.visible && sessionToken() === ownerToken && commerceContextRevision() === revision)
        await new Promise<void>(resolve => { this.nativePickerReturn = resolve; });
    };
    this.choosingImage = true;
    this.setComposerState({ attachmentSheetOpen: false, error: "", errorAction: "" });
    try {
      await new Promise<void>((resolve, reject) => wx.requirePrivacyAuthorize({ success: () => resolve(), fail: reject }));
      if (!this.data.visible) await returned();
      if (!current()) return;
      const chosen = await wx.chooseMedia({ count: 1, mediaType: ["image"], sourceType: [source] });
      if (!this.data.visible) await returned();
      if (!current()) return;
      const file = chosen.tempFiles[0];
      if (!file) return;
      let localPath = file.tempFilePath;
      let size = file.size;
      if (size > 1024 * 1024 && typeof wx.compressImage === "function") {
        try {
          const compressed = await wx.compressImage({ src: localPath, quality: 82 });
          if (!this.data.visible) await returned();
          if (!current()) return;
          const info = await new Promise<WechatMiniprogram.GetFileInfoSuccessCallbackResult>((resolve, reject) => wx.getFileSystemManager().getFileInfo({ filePath: compressed.tempFilePath, success: resolve, fail: reject }));
          if (!this.data.visible) await returned();
          if (!current()) return;
          if (info.size > 0 && info.size < size) { localPath = compressed.tempFilePath; size = info.size; }
        } catch {}
      }
      if (!current()) return;
      const mimeType = this.mimeForPath(localPath) ?? this.mimeForPath(file.tempFilePath);
      if (!mimeType) { this.setComposerState({ error: "仅支持 JPG、PNG 或 WEBP 图片。", errorAction: "" }); return; }
      if (!size || size > 5 * 1024 * 1024) { this.setComposerState({ error: "图片需小于 5MB，请压缩或重新选择。", errorAction: "" }); return; }
      const replacedMediaId = this.data.selectedImage?.mediaId;
      if (replacedMediaId) void request({ path: `/v1/me/support/media/${replacedMediaId}`, method: "DELETE", data: {}, cacheTags: ["support"] }).catch(() => {});
      this.inputRevision += 1;
      const candidate: SelectedImage = { localPath, size, mimeType, status: "uploading", progress: 0, mediaId: "", error: "" };
      this.setData({ selectedImage: candidate, composerSendEnabled: false });
      wx.nextTick(() => this.measureComposer());
      await this.uploadImage(candidate);
    } catch (error) { if (current() && !isCancellation(error)) this.setComposerState({ error: "无法读取所选图片，请检查微信隐私权限后重试。", errorAction: "" }); }
    finally { this.choosingImage = false; }
  },
  async uploadImage(candidate?: SelectedImage | null) {
    const selected = candidate ?? this.data.selectedImage;
    if (!selected || this.data.uploadBusy || this.data.newTopicBusy || this.data.newTopicAttempt) return;
    const attempt = ++this.uploadAttempt;
    const epoch = this.lifecycleEpoch;
    const ownerToken = sessionToken();
    const current = () => this.owns(epoch, ownerToken) && attempt === this.uploadAttempt;
    if (selected.mediaId) void request({ path: `/v1/me/support/media/${selected.mediaId}`, method: "DELETE", data: {}, cacheTags: ["support"] }).catch(() => {});
    this.setComposerState({ uploadBusy: true, selectedImage: { ...selected, status: "uploading", progress: 0, mediaId: "", error: "" }, composerSendEnabled: false, error: "", errorAction: "" });
    try {
      const authorization = await request<any>({ path: "/v1/me/support/media/authorize", method: "POST", data: { mimeType: selected.mimeType, maxBytes: selected.size }, cacheTags: ["support"] });
      if (!current()) return;
      const mediaId = authorization.mediaId as string;
      this.setData({ "selectedImage.mediaId": mediaId });
      if (this.data.selectedImage) this.data.selectedImage.mediaId = mediaId;
      await uploadAuthorized(selected.localPath, authorization, {
        registerAbort: (abort) => { this.uploadAbort = abort; },
        onProgress: (progress) => { if (current()) { this.setData({ "selectedImage.progress": progress }); if (this.data.selectedImage) this.data.selectedImage.progress = progress; } }
      });
      if (!current()) return;
      await request({ path: `/v1/me/support/media/${mediaId}/complete`, method: "POST", data: {}, cacheTags: ["support"] });
      if (!current()) return;
      const ready = { ...selected, status: "ready" as const, progress: 100, mediaId, error: "" };
      this.setData({ selectedImage: ready, composerSendEnabled: memberComposerCanSend(this.data.input, ready, this.data.selectedOrder) });
      this.data.selectedImage = ready;
      if (!this.data.conversation) await this.load();
    } catch (error) {
      if (current() && !isCancellation(error)) {
        const failed = { ...(this.data.selectedImage ?? selected), status: "failed" as const, error: "上传未完成，图片和正文仍保留。" };
        this.setComposerState({ selectedImage: failed, composerSendEnabled: false, error: failed.error, errorAction: "" });
      }
    } finally {
      if (current()) { this.uploadAbort = null; this.setData({ uploadBusy: false }); wx.nextTick(() => this.measureComposer()); }
    }
  },
  retryImageUpload() { if(!this.data.sendAttempt)void this.uploadImage(); },
  removeImage() {
    if(this.data.sendAttempt||this.data.newTopicBusy||this.data.newTopicAttempt)return;
    const mediaId = this.data.selectedImage?.mediaId;
    this.uploadAttempt += 1;
    this.uploadAbort?.(); this.uploadAbort = null;
    if (mediaId) void request({ path: `/v1/me/support/media/${mediaId}`, method: "DELETE", data: {}, cacheTags: ["support"] }).catch(() => {});
    this.inputRevision += 1;
    this.setData({ selectedImage: null, uploadBusy: false, composerSendEnabled: memberComposerCanSend(this.data.input, null, this.data.selectedOrder) });
    wx.nextTick(() => this.measureComposer());
  },
  async openOrderPicker() {
    if (!this.data.pageAlive || !this.data.visible || this.data.closedRights || this.data.sending || this.data.sendAttempt) return;
    const epoch = this.lifecycleEpoch, token = sessionToken(), attempt = ++this.orderPickerRevision;
    this.orderPickerToken = token;
    const current = () => this.owns(epoch, token) && attempt === this.orderPickerRevision && this.data.orderPickerOpen;
    this.setData({ attachmentSheetOpen: false, orderPickerOpen: true, orderPickerLoading: true, orderPickerMoreBusy: false, orderPickerNextCursor: null, orderPickerError: "", orderChoices: [] });
    try {
      const page = await myOrders();
      if (!current()) return;
      const choices = page.items.map((order: CommerceOrderSummary): OrderChoice => ({ id: order.id, orderNumberTail: order.orderNumber.slice(-4), status: order.status,
        statusLabel: orderStatusLabels[order.status] ?? "状态待更新", totalYuan: centsToYuan(order.totalCents), totalCents: order.totalCents, currency: order.currency,
        productName: order.lines[0]?.productName ?? "订单商品", productImage: nativeCatalogImage(order.lines[0]?.image),
        itemSummary: order.lines.map((line) => `${line.productName} · ${line.skuLabel} × ${line.quantity}`).join("；") }));
      this.setData({ orderChoices: choices, orderPickerNextCursor: page.nextCursor ?? null, orderPickerLoading: false });
    } catch { if (current()) this.setData({ orderPickerLoading: false, orderPickerError: "订单暂时无法加载，请重试。" }); }
  },
  async loadMoreOrders() {
    const cursor = this.data.orderPickerNextCursor;
    if (!cursor || !this.data.orderPickerOpen || this.data.orderPickerLoading || this.data.orderPickerMoreBusy) return;
    const epoch = this.lifecycleEpoch, token = sessionToken(), attempt = this.orderPickerRevision;
    const current = () => this.owns(epoch, token) && attempt === this.orderPickerRevision && this.data.orderPickerOpen;
    this.setData({ orderPickerMoreBusy: true, orderPickerError: "" });
    try {
      const page = await myOrders(cursor);
      if (!current()) return;
      const seen = new Set(this.data.orderChoices.map(order => order.id));
      const choices = page.items.filter(order => !seen.has(order.id)).map((order: CommerceOrderSummary): OrderChoice => ({
        id: order.id, orderNumberTail: order.orderNumber.slice(-4), status: order.status,
        statusLabel: orderStatusLabels[order.status] ?? "状态待更新", totalYuan: centsToYuan(order.totalCents), totalCents: order.totalCents,
        currency: order.currency, productName: order.lines[0]?.productName ?? "订单商品", productImage: nativeCatalogImage(order.lines[0]?.image),
        itemSummary: order.lines.map(line => `${line.productName} · ${line.skuLabel} × ${line.quantity}`).join("；")
      }));
      this.setData({ orderChoices: [...this.data.orderChoices, ...choices], orderPickerNextCursor: page.nextCursor ?? null });
    } catch { if (current()) this.setData({ orderPickerError: "后续订单暂时无法加载，请重试。" }); }
    finally { if (current()) this.setData({ orderPickerMoreBusy: false }); }
  },
  closeOrderPicker() {
    this.orderPickerRevision += 1; this.orderPickerToken = "";
    this.setData({ orderPickerOpen: false, orderPickerLoading: false, orderPickerMoreBusy: false, orderPickerNextCursor: null, orderChoices: [], orderPickerError: "" });
  },
  selectOrder(event: WechatMiniprogram.TouchEvent) {
    if(this.data.closedRights||this.data.sendAttempt||this.data.sending||this.data.newTopicBusy||this.data.newTopicAttempt||this.data.orderPickerLoading||!this.data.orderPickerOpen||!this.owns(this.lifecycleEpoch,this.orderPickerToken))return;
    const selected = this.data.orderChoices.find((order) => order.id === String(event.currentTarget.dataset.id ?? ""));
    if (!selected) return;
    this.inputRevision += 1; this.orderSelectionRevision += 1; this.linkedOrderDismissed = true;
    this.closeOrderPicker();
    this.setData({ selectedOrder: selected, composerSendEnabled: memberComposerCanSend(this.data.input, this.data.selectedImage, selected) });
    wx.nextTick(() => this.measureComposer());
  },
  removeOrder() {
    if(this.data.closedRights||this.data.sendAttempt||this.data.sending||this.data.newTopicBusy||this.data.newTopicAttempt)return;
    this.inputRevision += 1; this.orderSelectionRevision += 1; this.linkedOrderDismissed = true;
    this.setData({ selectedOrder: null, composerSendEnabled: memberComposerCanSend(this.data.input, this.data.selectedImage, null) });
    wx.nextTick(() => this.measureComposer());
  },
  openOrder(event: WechatMiniprogram.TouchEvent) { const id = String(event.currentTarget.dataset.id ?? ""); if (id) wx.navigateTo({ url: `/pages/order-detail/index?id=${encodeURIComponent(id)}` }); },
  downloadMedia(messages: readonly RawMessage[]) {
    const epoch = this.lifecycleEpoch;
    const ownerToken = sessionToken();
    const conversationId = this.data.conversation?.id, contextVersion = this.data.contextVersion;
    for (const message of messages) for (const attachment of message.attachments ?? []) {
      if (attachment.localPath || !attachment.previewPath) continue;
      const download = downloadPrivateMedia(attachment.previewPath,this.data.closedRights);
      const abort = () => download.abort();
      this.mediaDownloads.push(abort);
      void download.promise.then((localPath) => {
        if (!this.owns(epoch, ownerToken) || conversationId !== this.data.conversation?.id || contextVersion !== this.data.contextVersion) return;
        const messageIndex = this.data.messages.findIndex((item) => item.id === message.id);
        const attachmentIndex = this.data.messages[messageIndex]?.attachments.findIndex((item) => item.id === attachment.id) ?? -1;
        if (messageIndex < 0 || attachmentIndex < 0) return;
        this.data.messages[messageIndex]!.attachments[attachmentIndex]!.localPath = localPath;
        this.setData({ [`messages[${messageIndex}].attachments[${attachmentIndex}].localPath`]: localPath });
      }).catch(() => {}).finally(() => { this.mediaDownloads = this.mediaDownloads.filter((candidate) => candidate !== abort); });
    }
  },
  previewImage(event: WechatMiniprogram.TouchEvent) {
    const id = String(event.currentTarget.dataset.mediaId ?? "");
    const attachments = this.data.messages.flatMap((message) => message.attachments).filter((attachment) => attachment.localPath);
    const current = attachments.find((attachment) => attachment.id === id)?.localPath;
    if (!current) { wx.showToast({ title: "图片正在加载，请稍后重试", icon: "none" }); return; }
    wx.previewImage({ current, urls: attachments.map((attachment) => attachment.localPath!) });
  },
  async requestHuman() {
    if(this.data.closedRights || this.data.newTopicBusy || this.data.newTopicAttempt)return;
    if (this.data.handoffBusy || this.data.conversation?.status === "waiting_human" || this.data.conversation?.status === "human_active") return;
    const epoch = this.lifecycleEpoch;
    const ownerToken = sessionToken();
    const conversationId = this.data.conversation?.id;
    const question = this.data.messages.filter(item => item.senderType === "user" && item.sequence > this.data.contextStartSequence).slice(-1)[0];
    const attempt = this.data.handoffAttempt ?? { contextVersion: this.data.contextVersion, questionMessageId: question?.id ?? null,
      ...(conversationId ? { expectedConversationId: conversationId } : {}) };
    const contextVersion = attempt.contextVersion;
    const revision = ++this.handoffRevision;
    this.setComposerState({ handoffBusy: true, handoffFailed: false, handoffAttempt: attempt, error: "", errorAction: "" });
    try {
      const result = await request<Conversation>({ path: "/v1/me/support/handoff", method: "POST", data: attempt, cacheTags: ["support"] });
      if (this.owns(epoch, ownerToken) && revision === this.handoffRevision && contextVersion === this.data.contextVersion) {
        const conversation = this.currentConversation(result);
        this.setComposerState({ conversation, handoffAttempt: null, ...this.headerPatch(conversation, this.data.presence) });
      }
    } catch (error) {
      if (this.owns(epoch, ownerToken) && revision === this.handoffRevision && contextVersion === this.data.contextVersion) {
        const observedConversation = this.data.conversation as Conversation | null;
        if (observedConversation?.status === "waiting_human" || observedConversation?.status === "human_active") {
          this.setComposerState(this.confirmedHandoffPatch(observedConversation));
        } else if (["SUPPORT_CONTEXT_CHANGED", "SUPPORT_HANDOFF_QUESTION_INVALID"].includes(String((error as {code?:string})?.code))) {
          this.stopPolling(); cancelPageReads(this); const recoveryEpoch = ++this.lifecycleEpoch;
          this.clearRetiredTopic(); this.applyThreadState(createSupportThreadState<Message>([], this.data.contextStartSequence), { historyLoaded: false });
          await this.load();
          if (this.owns(recoveryEpoch, ownerToken))
            this.setComposerState({ error: "会话已更新，请核对后再申请人工客服。", errorAction: "sync" });
        } else this.setComposerState({ error: "人工申请结果暂未确认，请重试申请。", errorAction: "handoff", handoffFailed: true });
      }
    }
    finally { if (this.owns(epoch, ownerToken) && revision === this.handoffRevision) this.setComposerState({ handoffBusy: false }); }
  },
  retryHandoff() { void this.requestHuman(); },
  clearTopicDraft() {
    this.inputRevision += 1; this.orderSelectionRevision += 1; this.linkedOrderAttempt += 1;
    this.linkedOrderDismissed = true;
    takeSupportDraft(sessionToken(), this.linkedOrderId || GENERAL_SUPPORT_SCOPE);
    this.setData({ input: "", selectedImage: null, selectedOrder: null, composerSendEnabled: false,
      composerCapped: false, composerLineCount: 1, attachmentSheetOpen: false, orderPickerOpen: false });
    this.scheduleComposerMeasure();
  },
  async startNewTopic() {
    if (!this.data.pageAlive || !this.data.visible || this.data.closedRights || this.data.newTopicBusy || this.data.sending
      || this.data.sendAttempt || this.data.uploadBusy || this.choosingImage || this.data.handoffBusy) return;
    const previous = this.data.newTopicAttempt;
    const status = this.data.conversation?.status;
    if (!previous && (status === "waiting_human" || status === "human_active")) {
      const epoch = this.lifecycleEpoch, token = sessionToken();
      try { await wx.showModal({ title: "人工事项处理中", content: "人工申请会继续保留，你可以直接咨询其他问题。人工事项结束后可开启新对话。", showCancel: false, confirmText: "知道了" }); }
      catch { if (this.owns(epoch, token)) this.setData({ error: "提示暂时无法打开，请稍后重试。人工申请会继续保留。", errorAction: "" }); }
      return;
    }
    if (!previous && (!this.data.historyLoaded || this.data.loading || !this.data.newTopicAvailable
      || status && status !== "ai_active" && status !== "resolved")) return;
    let epoch = this.lifecycleEpoch;
    const ownerToken = sessionToken();
    if (this.snapshotToken && this.snapshotToken !== ownerToken) return;
    const revision = ++this.newTopicRevision;
    const draft = () => JSON.stringify([this.inputRevision, this.data.input, this.data.selectedImage?.localPath, this.data.selectedImage?.mediaId, this.data.selectedOrder?.id]);
    const reviewedDraft = draft();
    let submitted = false;
    this.setComposerState({ newTopicBusy: true });
    try {
      if (!previous && (this.data.conversation || this.data.messages.length || this.data.input.trim() || this.data.selectedImage || this.data.selectedOrder)) {
        const answer = await wx.showModal({ title: "开始新对话？", content: "之前的聊天和未发送内容会清空。订单、售后凭证仍按规则保留。", confirmText: "清空重开" });
        if (!answer.confirm || !this.owns(epoch, ownerToken)) return;
        if (draft() !== reviewedDraft) { wx.showToast({ title: "内容已变化，请重新开启", icon: "none" }); return; }
      }
      if (!this.owns(epoch, ownerToken)) return;
      const current = this.data.conversation;
      if (!previous && !current) { this.clearTopicDraft(); return; }
      const attempt = previous ?? { conversationId: current!.id, expectedVersion: current!.version, requestId: newTopicRequestId() };
      this.stopPolling(); cancelPageReads(this); this.stopAiReplyWait(); this.abortDownloads();
      epoch = ++this.lifecycleEpoch;
      this.setComposerState({ newTopicAttempt: attempt, error: "", errorAction: "", loadingOlder: false });
      submitted = true;
      const page = await request<any>({ path: "/v1/me/support/new-topic", method: "POST", data: attempt, cacheTags: ["support"] });
      if (!this.owns(epoch, ownerToken)) return;
      if (page.conversation?.id !== attempt.conversationId || !Number.isSafeInteger(page.contextStartSequence) || page.contextStartSequence < 0
        || !Number.isSafeInteger(page.contextVersion) || page.contextVersion < 0 || this.staleTopic(page))
        throw new Error("NEW_TOPIC_RECEIPT_UNCONFIRMED");
      const conversation = this.currentConversation(page.conversation), boundary = this.topicBoundary(page, conversation), contextVersion = this.topicVersion(page, conversation);
      const presence = { ...emptyPresence, ...(page.presence ?? {}) } as Presence;
      const messages = this.normalize(page.messages || []).filter(item => item.sequence > boundary);
      this.clearRetiredTopic();
      this.applyThreadState(createSupportThreadState(this.present(messages, conversation, presence), page.latestCursor ?? boundary), {
        conversation, contextStartSequence: boundary, contextVersion, newTopicAvailable: page.newTopicAvailable === true,
        ...this.aiCapabilityPatch(page), ...this.headerPatch(conversation, presence, page.supportAiAvailable === true),
        newTopicAttempt: null, handoffFailed: false, olderCursor: page.olderCursor ?? null, historyStartLoaded: page.olderCursor == null, loading: false, historyLoaded: true,
        atBottom: true, anchor: messages.length ? `support-${messages[messages.length - 1]!.sequence}` : "",
        newMessagesBelow: false, newMessagesBelowCount: 0, error: "", errorAction: ""
      });
      this.downloadMedia(messages); await this.markRead();
    } catch (error) {
      if (this.owns(epoch, ownerToken)) {
        const status = (error as { status?: number })?.status;
        if (!submitted) this.setData({ error: "确认窗口暂时无法打开，聊天和未发送内容已保留，请重试。", errorAction: "" });
        else if (status && status >= 400 && status < 500) {
          this.setComposerState({ newTopicAttempt: null });
          await this.load();
          if (this.owns(epoch, ownerToken)) this.setData({ error: "会话已变化，请核对后再开启新对话。", errorAction: "sync" });
        } else this.setData({ error: "新对话结果待确认，请点击「重试新对话」。", errorAction: "" });
      }
    } finally {
      if (this.data.pageAlive && this.newTopicRevision === revision) this.setComposerState({ newTopicBusy: false });
      if (this.owns(epoch, ownerToken)) this.startPolling();
    }
  },
  retry() { void this.load(); if(this.linkedOrderId&&!this.linkedOrderDismissed)void this.loadLinkedOrder(); },
  back() { wx.navigateBack({ fail: () => this.data.closedRights
    ?wx.redirectTo({url:'/pages/orders/index'}):wx.switchTab({ url: "/pages/profile/index" }) }); }
});
