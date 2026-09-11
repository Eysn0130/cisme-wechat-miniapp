import { downloadPrivateMedia, requireMemberAccess, request, retainMemberSnapshot, uploadAuthorized } from "../../services/api";
import { centsToYuan } from "../../services/commerce";
import { myOrders, type CommerceOrderSummary } from "../../services/orders";
import { currentChromeStyle } from "../../services/layout";
import {
  createSupportThreadState,
  mergeAcknowledgement,
  mergeHistoryPage,
  mergeSyncPage,
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
type RawMessage = { id: string; sequence: number; senderType: "user" | "ai" | "admin" | "system"; body: string; contentType: string; createdAt: string; attachments: Attachment[]; orderCard: OrderCard | null; deliveryState: "server_accepted" | "read" };
type Message = PresentedSupportMessage<RawMessage>;
type Conversation = { id: string; status: "ai_active" | "waiting_human" | "human_active" | "resolved"; version: number; memberReadSequence?: number; teamReadSequence?: number };
type Presence = { agentDisplayName: string; operatorOnline: boolean; operatorTyping: boolean; memberOnline: boolean; memberTyping: boolean; serverTime: string };
type SelectedImage = { localPath: string; size: number; mimeType: string; status: "uploading" | "ready" | "failed"; progress: number; mediaId: string; error: string };
type OrderChoice = { id: string; orderNumberTail: string; status: string; statusLabel: string; totalYuan: string; totalCents: number; currency: "CNY"; productName: string; productImage: string | null; itemSummary: string };
type SendAttempt = { id: string; signature: string; body: string; mediaIds: string[]; linkedOrderId: string | null };

const emptyPresence: Presence = { agentDisplayName: "CISME 客服", operatorOnline: false, operatorTyping: false, memberOnline: false, memberTyping: false, serverTime: "" };
const orderStatusLabels: Record<string, string> = { pending_payment: "待支付", cancelled: "已取消", expired: "已超时" };
function sessionToken(): string { return getApp<IAppOption>().globalData.sessionToken; }
function isCancellation(error: unknown): boolean { return /cancel|abort/i.test(String((error as {errMsg?:string})?.errMsg ?? (error as {code?:string})?.code ?? error)); }

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
  uploadAttempt: 0,
  uploadAbort: null as (() => void) | null,
  mediaDownloads: [] as Array<() => void>,
  data: {
    chromeStyle: currentChromeStyle(), conversation: null as Conversation | null, messages: [] as Message[], syncCursor: 0, maxSeenSequence: 0, readCursor: 0,
    olderCursor: null as number | null, presence: emptyPresence, statusLabel: "等待人工客服", statusTone: "waiting", input: "", sendAttempt: null as SendAttempt | null,
    pendingMessage: null as Message | null, loading: true, loadingOlder: false, sending: false, handoffBusy: false, error: "", errorAction: "" as "" | "sync" | "handoff", anchor: "", pageAlive: false, visible: false,
    atBottom: true, newMessagesBelowCount: 0, newMessagesBelow: false, threadBottomStyle: "bottom:calc(env(safe-area-inset-bottom) + 132rpx)",
    newMessageBottomStyle: "bottom:calc(env(safe-area-inset-bottom) + 154rpx)", composerFocused: false, keyboardHeight: 0,
    attachmentSheetOpen: false, orderPickerOpen: false, orderPickerLoading: false, orderPickerError: "", orderChoices: [] as OrderChoice[], selectedOrder: null as OrderChoice | null,
    selectedImage: null as SelectedImage | null, uploadBusy: false
  },
  onLoad() { this.data.pageAlive = true; },
  onReady() { this.measureComposer(); },
  onResize() { this.setData({ chromeStyle: currentChromeStyle() }); this.measureComposer(); },
  onShow() {
    const preserve = retainMemberSnapshot(this);
    this.lifecycleEpoch += 1;
    this.data.pageAlive = true;
    this.data.visible = true;
    this.lastActivityAt = Date.now();
    this.setData({ sending: false, handoffBusy: false });
    if (!preserve) {
      this.inputRevision += 1;
      this.abortTransientWork();
      this.setData({ conversation: null, messages: [], syncCursor: 0, maxSeenSequence: 0, readCursor: 0, olderCursor: null, presence: emptyPresence,
        input: "", sendAttempt: null, pendingMessage: null, error: "", errorAction: "", anchor: "", atBottom: true, newMessagesBelowCount: 0, newMessagesBelow: false,
        attachmentSheetOpen: false, orderPickerOpen: false, orderChoices: [], selectedOrder: null, selectedImage: null, uploadBusy: false });
    }
    if (!requireMemberAccess("/pages/support/index")) { this.data.visible = false; return; }
    void this.load();
    wx.nextTick(() => this.measureComposer());
  },
  onHide() {
    void this.publishPresence(false, false, true);
    const interruptedUpload = this.data.uploadBusy && this.data.selectedImage
      ? { ...this.data.selectedImage, status: "failed" as const, error: "页面离开时上传已中断，图片和正文仍保留。" }
      : null;
    this.data.visible = false;
    this.lifecycleEpoch += 1;
    this.stopPolling();
    this.clearPresenceTimer();
    this.abortTransientWork();
    if (interruptedUpload) this.setData({ uploadBusy: false, selectedImage: interruptedUpload, error: interruptedUpload.error, errorAction: "" });
  },
  onUnload() { void this.publishPresence(false, false, true); this.data.pageAlive = false; this.data.visible = false; this.lifecycleEpoch += 1; this.stopPolling(); this.clearPresenceTimer(); this.abortTransientWork(); },
  owns(epoch: number, ownerToken: string) { return this.data.pageAlive && this.data.visible && this.lifecycleEpoch === epoch && sessionToken() === ownerToken; },
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
  clearPresenceTimer() { if (this.presenceTimer) clearTimeout(this.presenceTimer); this.presenceTimer = null; },
  threadState(): SupportThreadState<Message> { return { messages: this.data.messages, syncCursor: this.data.syncCursor, maxSeenSequence: this.data.maxSeenSequence, readCursor: this.data.readCursor }; },
  present(messages: readonly RawMessage[], conversation?: Conversation | null, presence?: Presence): Message[] {
    const activeConversation = conversation === undefined ? this.data.conversation : conversation;
    const activePresence = presence ?? this.data.presence ?? emptyPresence;
    return presentSupportMessages(messages, { ownSenderType: "user", counterpartyReadSequence: activeConversation?.teamReadSequence ?? 0, agentDisplayName: activePresence.agentDisplayName });
  },
  headerPatch(conversation: Conversation | null, presence: Presence) {
    if (!conversation) return { statusLabel: "随时为你提供帮助", statusTone: "neutral", presence };
    const header = supportHeaderPresentation({ status: conversation?.status ?? "waiting_human", agentDisplayName: presence.agentDisplayName, operatorOnline: presence.operatorOnline });
    return { statusLabel: header.label, statusTone: header.tone, presence };
  },
  applyThreadState(state: SupportThreadState<Message>, patch: Record<string, unknown> = {}) {
    const conversation = (patch.conversation as Conversation | undefined) ?? this.data.conversation;
    const presence = (patch.presence as Presence | undefined) ?? this.data.presence;
    const messages = this.present(state.messages, conversation, presence);
    const messagePatch = supportMessageSetDataPatch(this.data.messages, messages);
    this.setData({ ...messagePatch, syncCursor: state.syncCursor, maxSeenSequence: state.maxSeenSequence, readCursor: state.readCursor, ...patch });
    if (Object.keys(messagePatch).length) this.data.messages = messages;
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
  onKeyboardHeightChange(event: WechatMiniprogram.CustomEvent<{height:number}>) { this.setData({ keyboardHeight: Number(event.detail.height) || 0 }); wx.nextTick(() => this.measureComposer()); },
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
      ...(localImage?.mediaId === attachment.id ? { localPath: localImage.localPath } : {}) })), orderCard: item.orderCard ? { ...item.orderCard, statusLabel: orderStatusLabels[item.orderCard.status] ?? item.orderCard.status, totalYuan: centsToYuan(item.orderCard.totalCents) } : null }));
  },
  async load() {
    const epoch = this.lifecycleEpoch;
    const ownerToken = sessionToken();
    this.setData({ loading: true, error: "", errorAction: "" });
    try {
      const page = await request<any>({ path: "/v1/me/support/messages", cacheTags: ["support"] });
      if (!this.owns(epoch, ownerToken)) return;
      const presence = { ...emptyPresence, ...(page.presence ?? {}) } as Presence;
      const messages = this.normalize(page.messages || []);
      const state = createSupportThreadState(this.present(messages, page.conversation, presence), page.latestCursor || 0);
      this.applyThreadState(state, { conversation: page.conversation, olderCursor: page.olderCursor ?? null, loading: false, atBottom: true, newMessagesBelowCount: 0, newMessagesBelow: false,
        anchor: messages.length ? `support-${messages[messages.length - 1]!.sequence}` : "", ...this.headerPatch(page.conversation, presence) });
      this.downloadMedia(messages);
      await this.markRead();
      void this.publishPresence(true, Boolean(this.data.input.trim()), true);
      this.startPolling();
    } catch {
      if (this.data.pageAlive && this.data.visible && this.lifecycleEpoch === epoch) this.setData({ loading: false, error: "客服会话暂时无法同步，请检查网络后重试。", errorAction: "sync" });
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
      const presence = { ...emptyPresence, ...(page.presence ?? this.data.presence) } as Presence;
      const incoming = this.normalize(page.messages || []);
      const knownIds = new Set(this.data.messages.map((item) => item.id));
      const freshCount = incoming.filter((item) => !knownIds.has(item.id)).length;
      const state = mergeSyncPage(this.threadState(), this.present(incoming, page.conversation ?? this.data.conversation, presence), page.latestCursor ?? after);
      const newest = state.messages[state.messages.length - 1];
      const shouldFollow = this.data.atBottom;
      if (freshCount || presence.operatorTyping) this.lastActivityAt = Date.now();
      this.applyThreadState(state, {
        conversation: page.conversation ?? this.data.conversation,
        ...this.headerPatch(page.conversation ?? this.data.conversation, presence),
        anchor: freshCount && shouldFollow && newest ? `support-${newest.sequence}` : this.data.anchor,
        newMessagesBelowCount: shouldFollow ? 0 : (this.data.newMessagesBelowCount ?? 0) + freshCount,
        newMessagesBelow: shouldFollow ? false : this.data.newMessagesBelow || freshCount > 0
      });
      if (incoming.length) this.downloadMedia(incoming);
      this.pollFailures = 0;
      await this.markRead();
      void this.publishPresence(true, Boolean(this.data.input.trim()));
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
      const older = this.normalize(page.messages || []);
      this.applyThreadState(mergeHistoryPage(this.threadState(), this.present(older)), { olderCursor: page.olderCursor ?? null, anchor: preserve ? `support-${preserve}` : "" });
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
    this.lastActivityAt = Date.now();
    const input = event.detail.value;
    this.setData({ input, sendAttempt: null, pendingMessage: this.data.pendingMessage?.deliveryLabel === "发送失败" ? null : this.data.pendingMessage });
    void this.publishPresence(true, Boolean(input.trim()), !input.trim());
  },
  async publishPresence(online: boolean, typing: boolean, force = false) {
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
  pendingFrom(attempt: SendAttempt, state: "pending" | "failed"): Message {
    const raw = {
      id: `local-${attempt.id}`, sequence: this.data.maxSeenSequence + 1, senderType: "user" as const, body: attempt.body,
      contentType: attempt.mediaIds.length || attempt.linkedOrderId ? "mixed" : "text", createdAt: new Date().toISOString(), deliveryState: "server_accepted" as const,
      attachments: this.data.selectedImage ? [{ id: this.data.selectedImage.mediaId || "local", mimeType: this.data.selectedImage.mimeType, sizeBytes: this.data.selectedImage.size, previewPath: "", localPath: this.data.selectedImage.localPath }] : [],
      orderCard: this.data.selectedOrder ? { orderId:this.data.selectedOrder.id,orderNumberTail:this.data.selectedOrder.orderNumberTail,status:this.data.selectedOrder.status,currency:this.data.selectedOrder.currency,totalCents:this.data.selectedOrder.totalCents,productName:this.data.selectedOrder.productName,productImage:this.data.selectedOrder.productImage,itemSummary:this.data.selectedOrder.itemSummary,statusLabel:this.data.selectedOrder.statusLabel,totalYuan:this.data.selectedOrder.totalYuan } : null,
      localState: state
    };
    return presentSupportMessages([raw], { ownSenderType: "user", counterpartyReadSequence: 0 })[0]! as Message;
  },
  async send() {
    const body = this.data.input.trim();
    const mediaIds = this.data.selectedImage?.status === "ready" && this.data.selectedImage.mediaId ? [this.data.selectedImage.mediaId] : [];
    const linkedOrderId = this.data.selectedOrder?.id ?? null;
    if ((!body && !mediaIds.length && !linkedOrderId) || this.data.sending || this.data.uploadBusy) return;
    const signature = this.sendSignature(body, mediaIds, linkedOrderId);
    const draftRevision = this.inputRevision;
    const epoch = this.lifecycleEpoch;
    const ownerToken = sessionToken();
    const sendAttempt = this.data.sendAttempt?.signature === signature ? this.data.sendAttempt : { id: `wx-user-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`, signature, body, mediaIds, linkedOrderId };
    this.lastActivityAt = Date.now();
    this.setData({ sending: true, error: "", errorAction: "", sendAttempt, pendingMessage: this.pendingFrom(sendAttempt, "pending") });
    void this.publishPresence(true, false, true);
    try {
      const result = await request<any>({ path: "/v1/me/support/messages", method: "POST", data: { body, clientMessageId: sendAttempt.id, mediaIds, linkedOrderId }, cacheTags: ["support"] });
      if (!this.owns(epoch, ownerToken)) return;
      const normalized = this.normalize([result.message], this.data.selectedImage);
      if (!this.data.messages.some((item) => item.id === result.message.id)) this.append(normalized);
      const clearDraft = this.inputRevision === draftRevision && this.sendSignature(this.data.input.trim(), mediaIds, linkedOrderId) === signature;
      this.setData({ ...(clearDraft ? { input: "", selectedImage: null, selectedOrder: null, sendAttempt: null } : {}), pendingMessage: null,
        conversation: result.conversation, ...this.headerPatch(result.conversation, this.data.presence) });
      if (clearDraft) this.inputRevision += 1;
      this.uploadAbort = null;
      this.startPolling();
      await this.markRead();
      wx.nextTick(() => this.measureComposer());
    } catch {
      if (this.owns(epoch, ownerToken)) this.setData({ error: "消息尚未获得服务端确认，正文和附件仍保留。", errorAction: "", pendingMessage: this.pendingFrom(sendAttempt, "failed") });
    } finally { if (this.owns(epoch, ownerToken)) this.setData({ sending: false }); }
  },
  retrySend() { void this.send(); },
  openAttachmentSheet() { if (this.data.sending || this.data.uploadBusy) return; this.setData({ attachmentSheetOpen: true }); },
  closeAttachmentSheet() { this.setData({ attachmentSheetOpen: false }); },
  stopPropagation() {},
  mimeForPath(path: string): string | null { const lower = path.toLowerCase(); return /\.(jpg|jpeg)$/.test(lower) ? "image/jpeg" : lower.endsWith(".png") ? "image/png" : lower.endsWith(".webp") ? "image/webp" : null; },
  async chooseImage(event: WechatMiniprogram.TouchEvent) {
    const source = event.currentTarget.dataset.source === "camera" ? "camera" : "album";
    this.setData({ attachmentSheetOpen: false, error: "", errorAction: "" });
    try {
      await new Promise<void>((resolve, reject) => wx.requirePrivacyAuthorize({ success: () => resolve(), fail: reject }));
      const chosen = await wx.chooseMedia({ count: 1, mediaType: ["image"], sourceType: [source] });
      const file = chosen.tempFiles[0];
      if (!file) return;
      let localPath = file.tempFilePath;
      let size = file.size;
      if (size > 1024 * 1024 && typeof wx.compressImage === "function") {
        try {
          const compressed = await wx.compressImage({ src: localPath, quality: 82 });
          const info = await new Promise<WechatMiniprogram.GetFileInfoSuccessCallbackResult>((resolve, reject) => wx.getFileSystemManager().getFileInfo({ filePath: compressed.tempFilePath, success: resolve, fail: reject }));
          if (info.size > 0 && info.size < size) { localPath = compressed.tempFilePath; size = info.size; }
        } catch {}
      }
      const mimeType = this.mimeForPath(localPath) ?? this.mimeForPath(file.tempFilePath);
      if (!mimeType) { this.setData({ error: "仅支持 JPG、PNG 或 WEBP 图片。", errorAction: "" }); return; }
      if (!size || size > 5 * 1024 * 1024) { this.setData({ error: "图片需小于 5MB，请压缩或重新选择。", errorAction: "" }); return; }
      const replacedMediaId = this.data.selectedImage?.mediaId;
      if (replacedMediaId) void request({ path: `/v1/me/support/media/${replacedMediaId}`, method: "DELETE", data: {}, cacheTags: ["support"] }).catch(() => {});
      this.inputRevision += 1;
      const candidate: SelectedImage = { localPath, size, mimeType, status: "uploading", progress: 0, mediaId: "", error: "" };
      this.setData({ selectedImage: candidate });
      wx.nextTick(() => this.measureComposer());
      await this.uploadImage(candidate);
    } catch (error) { if (!isCancellation(error)) this.setData({ error: "无法读取所选图片，请检查微信隐私权限后重试。", errorAction: "" }); }
  },
  async uploadImage(candidate?: SelectedImage | null) {
    const selected = candidate ?? this.data.selectedImage;
    if (!selected || this.data.uploadBusy) return;
    const attempt = ++this.uploadAttempt;
    const epoch = this.lifecycleEpoch;
    const ownerToken = sessionToken();
    const current = () => this.owns(epoch, ownerToken) && attempt === this.uploadAttempt;
    if (selected.mediaId) void request({ path: `/v1/me/support/media/${selected.mediaId}`, method: "DELETE", data: {}, cacheTags: ["support"] }).catch(() => {});
    this.setData({ uploadBusy: true, selectedImage: { ...selected, status: "uploading", progress: 0, mediaId: "", error: "" }, error: "", errorAction: "" });
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
      this.setData({ selectedImage: ready });
      this.data.selectedImage = ready;
      if (!this.data.conversation) await this.load();
    } catch (error) {
      if (current() && !isCancellation(error)) {
        const failed = { ...(this.data.selectedImage ?? selected), status: "failed" as const, error: "上传未完成，图片和正文仍保留。" };
        this.setData({ selectedImage: failed, error: failed.error, errorAction: "" });
      }
    } finally {
      if (current()) { this.uploadAbort = null; this.setData({ uploadBusy: false }); wx.nextTick(() => this.measureComposer()); }
    }
  },
  retryImageUpload() { void this.uploadImage(); },
  removeImage() {
    const mediaId = this.data.selectedImage?.mediaId;
    this.uploadAttempt += 1;
    this.uploadAbort?.(); this.uploadAbort = null;
    if (mediaId) void request({ path: `/v1/me/support/media/${mediaId}`, method: "DELETE", data: {}, cacheTags: ["support"] }).catch(() => {});
    this.inputRevision += 1;
    this.setData({ selectedImage: null, uploadBusy: false });
    wx.nextTick(() => this.measureComposer());
  },
  async openOrderPicker() {
    this.setData({ attachmentSheetOpen: false, orderPickerOpen: true, orderPickerLoading: true, orderPickerError: "" });
    try {
      const page = await myOrders();
      if (!this.data.visible) return;
      const choices = page.items.map((order: CommerceOrderSummary): OrderChoice => ({ id: order.id, orderNumberTail: order.orderNumber.slice(-4), status: order.status,
        statusLabel: orderStatusLabels[order.status] ?? order.status, totalYuan: centsToYuan(order.totalCents), totalCents: order.totalCents, currency: order.currency,
        productName: order.lines[0]?.productName ?? "订单商品", productImage: order.lines[0]?.image ?? null,
        itemSummary: order.lines.map((line) => `${line.productName} · ${line.skuLabel} × ${line.quantity}`).join("；") }));
      this.setData({ orderChoices: choices, orderPickerLoading: false });
    } catch { if (this.data.visible) this.setData({ orderPickerLoading: false, orderPickerError: "订单暂时无法同步，请重试。" }); }
  },
  closeOrderPicker() { this.setData({ orderPickerOpen: false }); },
  selectOrder(event: WechatMiniprogram.TouchEvent) {
    const selected = this.data.orderChoices.find((order) => order.id === String(event.currentTarget.dataset.id ?? ""));
    if (!selected) return;
    this.inputRevision += 1;
    this.setData({ selectedOrder: selected, orderPickerOpen: false });
    wx.nextTick(() => this.measureComposer());
  },
  removeOrder() { this.inputRevision += 1; this.setData({ selectedOrder: null }); wx.nextTick(() => this.measureComposer()); },
  openOrder(event: WechatMiniprogram.TouchEvent) { const id = String(event.currentTarget.dataset.id ?? ""); if (id) wx.navigateTo({ url: `/pages/order-detail/index?id=${encodeURIComponent(id)}` }); },
  downloadMedia(messages: readonly RawMessage[]) {
    const epoch = this.lifecycleEpoch;
    const ownerToken = sessionToken();
    for (const message of messages) for (const attachment of message.attachments ?? []) {
      if (attachment.localPath || !attachment.previewPath) continue;
      const download = downloadPrivateMedia(attachment.previewPath);
      const abort = () => download.abort();
      this.mediaDownloads.push(abort);
      void download.promise.then((localPath) => {
        if (!this.owns(epoch, ownerToken)) return;
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
    if (!current) { wx.showToast({ title: "图片仍在安全加载，请稍后重试", icon: "none" }); return; }
    wx.previewImage({ current, urls: attachments.map((attachment) => attachment.localPath!) });
  },
  async requestHuman() {
    if (this.data.handoffBusy) return;
    const epoch = this.lifecycleEpoch;
    const ownerToken = sessionToken();
    this.setData({ handoffBusy: true, error: "", errorAction: "" });
    try {
      const conversation = await request<Conversation>({ path: "/v1/me/support/handoff", method: "POST", data: {}, cacheTags: ["support"] });
      if (this.owns(epoch, ownerToken)) this.setData({ conversation, ...this.headerPatch(conversation, this.data.presence) });
    } catch { if (this.owns(epoch, ownerToken)) this.setData({ error: "暂时无法提交人工请求，请重试。", errorAction: "handoff" }); }
    finally { if (this.owns(epoch, ownerToken)) this.setData({ handoffBusy: false }); }
  },
  retryHandoff() { void this.requestHuman(); },
  retry() { void this.load(); },
  back() { wx.navigateBack({ fail: () => wx.switchTab({ url: "/pages/profile/index" }) }); }
});
