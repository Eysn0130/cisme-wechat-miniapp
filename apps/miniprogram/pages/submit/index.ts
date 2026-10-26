import { requireMemberAccess } from "../../services/api";
import { clearAuthenticationRedirectSuppression, request, retainMemberSnapshot, submissionReturnUrl, uploadAuthorized } from "../../services/api";
import { currentChromeStyle, motionDuration } from "../../services/layout";

let draftSaveTimer: ReturnType<typeof setTimeout> | undefined;
let keyboardListener: WechatMiniprogram.OnKeyboardHeightChangeCallback | undefined;

function enableDraftExitGuard(): void {
  wx.enableAlertBeforeUnload({ message: "草稿还未保存。离开时会尝试保存，请回来确认是否成功。" });
}

function disableDraftExitGuard(): void {
  wx.disableAlertBeforeUnload();
}

function scrollToSubmitError(): void {
  wx.pageScrollTo({ selector: "#submit-error-summary", duration: motionDuration(200) });
}

function submitLoadFailure(error: unknown): { action: "load" | "missing"; title: string; copy: string } {
  const problem = error as { status?: number; code?: string };
  if (problem.status === 404 || problem.code === "SUBMISSION_NOT_FOUND") {
    return { action: "missing", title: "未找到这份投稿草稿", copy: "暂时无法查看这份草稿，请从原活动重新进入。" };
  }
  return { action: "load", title: "暂时无法加载草稿", copy: "请检查网络后重新加载。" };
}

function formReady(data: {
  submission: any; originalReady: boolean; screenshotReady: boolean; postUrl: string; platformAccount: string; disclosure: string;
  permissions: { content_storage: boolean; human_review: boolean }; working: boolean; savingDraft: boolean; uploadingKind: string; submissionBlocked?: boolean;
}): boolean {
  return Boolean(
    data.submission
    && ["draft", "needs_changes", "appealed"].includes(data.submission.status)
    && data.originalReady
    && data.screenshotReady
    && data.postUrl.trim().startsWith("https://")
    && data.platformAccount.trim()
    && data.disclosure.trim()
    && data.permissions.content_storage
    && data.permissions.human_review
    && !data.submissionBlocked
    && !data.working
    && !data.savingDraft
    && !data.uploadingKind
  );
}

function isUserCancellation(error: unknown): boolean {
  const problem = error as { errMsg?: string; code?: string };
  return /cancel/i.test(problem.errMsg ?? "") || problem.code === "CANCEL";
}

function draftFailure(error: unknown): { recovery: "retry" | "conflict" | "edit" | "reload"; state: string; copy: string } {
  const problem = error as { code?: string };
  if (problem.code === "VERSION_CONFLICT") return { recovery: "conflict", state: "草稿版本已变化", copy: "草稿已在别处更新。请核对最新内容，再保存本页修改。" };
  if (problem.code === "POST_URL_INVALID") return { recovery: "edit", state: "内容链接需修正", copy: "内容链接必须以 https:// 开头。修改链接后会自动重新保存草稿。" };
  if (problem.code === "SUBMISSION_LOCKED" || problem.code === "SUBMISSION_STATE_INVALID") return { recovery: "reload", state: "投稿状态已变化", copy: "这份投稿已不能继续编辑，请重新加载并查看审核进度。" };
  return { recovery: "retry", state: "草稿保存待确认", copy: "草稿保存结果尚未确认，请检查网络后重试保存。已保存的内容仍会保留。" };
}

function mediaFailure(error: unknown): { recovery: "privacy" | "settings" | "reload" | "retry"; copy: string } {
  const problem = error as { errMsg?: string; code?: string };
  if (["SUBMISSION_LOCKED", "SUBMISSION_STATE_INVALID", "SUBMISSION_NOT_FOUND"].includes(problem.code ?? "")) return { recovery: "reload", copy: "投稿状态已有更新。请重新加载，查看是否需要补充材料。" };
  const message = String(problem.errMsg ?? problem.code ?? "").toLowerCase();
  if (message.includes("privacy")) return { recovery: "privacy", copy: "请先完成微信隐私授权，再选择需要上传的图片。" };
  if (/(deny|denied|auth|permission|scope)/.test(message)) return { recovery: "settings", copy: "相册或相机权限未开启。请前往设置授权后重新选择图片。" };
  return { recovery: "retry", copy: "图片上传未完成，原有图片仍保留。请检查网络后重新选择。" };
}

function submissionFailure(error: unknown): { recovery: "retry" | "reload" | "edit"; copy: string } {
  const problem = error as { code?: string };
  if (problem.code === "VERSION_CONFLICT" || problem.code === "SUBMISSION_STATE_INVALID" || problem.code === "SUBMISSION_LOCKED") return { recovery: "reload", copy: "投稿状态已有更新，请先重新加载后查看。" };
  if (problem.code === "POST_URL_INVALID") return { recovery: "edit", copy: "内容链接必须是可公开访问的 HTTPS 地址，请修改并重新保存草稿。" };
  if (problem.code === "MEDIA_REQUIRED") return { recovery: "reload", copy: "原图或发布截图的上传结果尚未确认，请重新加载后核对。" };
  if (problem.code === "LICENSE_REQUIRED") return { recovery: "reload", copy: "请重新加载，确认已同意保存投稿材料和人工审核。精选展示由你自愿选择。" };
  return { recovery: "retry", copy: "投稿结果尚未确认，请先刷新进度，确认后再重试。" };
}

Page({
  mediaUploadAbort: null as (() => void) | null,
  data: {
    chromeStyle: currentChromeStyle(),
    submissionId: "", submission: null as any, originalReady: false, screenshotReady: false,
    mediaUploadsEnabled: false,
    postUrl: "", platformAccount: "", disclosure: "",
    permissions: { content_storage: false, human_review: false, feed_readonly: false },
    loading: true, working: false, uploadingKind: "", lastUploadKind: "original" as "original" | "screenshot", uploadAttempt: 0, savingDraft: false, resolvingDraftConflict: false, confirmingExit: false, draftDirty: false, draftRevision: 0, loadAttempt: 0, pageAlive: true, hasShown: false,
    draftState: "输入后自动保存草稿", keyboardActionStyle: "", canSubmit: false, editable: false, submissionBlocked: false, draftSaveFailed: false, draftRecovery: "" as "" | "retry" | "conflict" | "edit" | "reload", uploadRecovery: "" as "" | "privacy" | "settings" | "reload" | "retry", submitRecovery: "" as "" | "retry" | "reload" | "edit", postUrlFocus: false, navigatingToProgress: false,
    errorAction: "load" as "load" | "missing", errorTitle: "", error: ""
  },
  onLoad(query: Record<string, string | undefined>) {
    this.setData({ submissionId: query.id ?? "", pageAlive: true });
    keyboardListener = ({ height }) => { if (this.data.pageAlive) this.setData({ keyboardActionStyle: height > 0 ? `bottom:${height}px` : "" }); };
    wx.onKeyboardHeightChange(keyboardListener);
  },
  onResize() { this.setData({ chromeStyle: currentChromeStyle() }); },
  clearMemberSnapshot() {
    if (draftSaveTimer) clearTimeout(draftSaveTimer);
    draftSaveTimer = undefined;
    this.data.loadAttempt += 1;
    this.data.uploadAttempt += 1;
    this.setData({
      submission: null, mediaUploadsEnabled: false, originalReady: false, screenshotReady: false,
      postUrl: "", platformAccount: "", disclosure: "",
      permissions: { content_storage: false, human_review: false, feed_readonly: false },
      loading: false, working: false, uploadingKind: "", savingDraft: false, resolvingDraftConflict: false,
      confirmingExit: false, draftDirty: false, draftRevision: this.data.draftRevision + 1,
      draftState: "登录后重新加载草稿", canSubmit: false, editable: false,
      submissionBlocked: false, draftSaveFailed: false, draftRecovery: "", uploadRecovery: "", submitRecovery: "",
      navigatingToProgress: false, errorTitle: "", error: ""
    });
    disableDraftExitGuard();
  },
  onShow() {
    const hasMemberAccess = requireMemberAccess();
    if (!retainMemberSnapshot(this)) this.clearMemberSnapshot();
    if (!hasMemberAccess) return;
    if (!this.data.hasShown) { this.data.hasShown = true; void this.load(); return; }
    this.setData({ navigatingToProgress: false });
    if (!this.data.draftDirty && !this.data.savingDraft && !this.data.working && !this.data.uploadingKind) void this.load();
  },
  onHide() {
    const interrupted = Boolean(this.data.uploadingKind);
    this.data.uploadAttempt += 1;
    this.mediaUploadAbort?.();
    this.mediaUploadAbort = null;
    if (interrupted) this.setData({ uploadingKind: "", uploadRecovery: "retry", canSubmit: false,
      error: "离开页面后，图片上传已中断。已保存的文字和图片仍保留，请重新选择图片。" });
    if (this.data.draftDirty && !this.data.working) void this.saveDraft();
  },
  onUnload() {
    this.data.pageAlive = false;
    this.data.loadAttempt += 1;
    this.data.uploadAttempt += 1;
    this.mediaUploadAbort?.();
    this.mediaUploadAbort = null;
    if (draftSaveTimer) clearTimeout(draftSaveTimer);
    draftSaveTimer = undefined;
    if (keyboardListener) wx.offKeyboardHeightChange(keyboardListener);
    keyboardListener = undefined;
    disableDraftExitGuard();
  },
  async load(event?: WechatMiniprogram.TouchEvent) {
    if (event?.type) clearAuthenticationRedirectSuppression();
    if (!this.data.submissionId) {
      this.setData({ submission: null, loading: false, editable: false, errorAction: "missing", errorTitle: "无法打开投稿草稿", error: "投稿链接不完整，请从原邀请重新进入。", canSubmit: false });
      return;
    }
    const attempt = this.data.loadAttempt + 1;
    const revisionAtLoad = this.data.draftRevision;
    this.setData({ loadAttempt: attempt, loading: true, editable: false, submissionBlocked: false, errorAction: "load", errorTitle: "", error: "", canSubmit: false, draftRecovery: "", uploadRecovery: "", submitRecovery: "" });
    try {
      const submission = await request<any>({ path: `/v1/submissions/${this.data.submissionId}` });
      if (!this.data.pageAlive || this.data.loadAttempt !== attempt || this.data.draftRevision !== revisionAtLoad) return;
      const license = submission.license_payload ?? {};
      const originalReady = submission.media.some((m: any) => m.kind === "original" && m.upload_state === "uploaded");
      const screenshotReady = submission.media.some((m: any) => m.kind === "screenshot" && m.upload_state === "uploaded");
      const postUrl = submission.post_url ?? this.data.postUrl;
      const platformAccount = submission.platform_account ?? this.data.platformAccount;
      const disclosure = submission.disclosure ?? "";
      const permissions = {
        content_storage: license.content_storage === true,
        human_review: license.human_review === true,
        feed_readonly: license.feed_readonly === true
      };
      const editable = ["draft", "needs_changes", "appealed"].includes(submission.status);
      const next = {
        submission,
        mediaUploadsEnabled: submission.media_uploads_enabled === true,
        originalReady, screenshotReady, postUrl, platformAccount, disclosure, permissions,
        editable,
        submissionBlocked: false,
        draftDirty: false,
        draftSaveFailed: false,
        draftRecovery: "" as const,
        uploadRecovery: "" as const,
        submitRecovery: "" as const,
        draftState: editable ? "草稿已保存" : "投稿已进入审核",
        errorTitle: "",
        error: ""
      };
      this.setData({ ...next, canSubmit: formReady({ ...this.data, ...next }) });
      disableDraftExitGuard();
    } catch (error) {
      if (this.data.pageAlive && this.data.loadAttempt === attempt && this.data.draftRevision === revisionAtLoad) {
        const failure = submitLoadFailure(error);
        this.setData({ submission: null, editable: false, errorAction: failure.action, errorTitle: failure.title, error: failure.copy, canSubmit: false });
      }
    } finally {
      if (this.data.pageAlive && this.data.loadAttempt === attempt) this.setData({ loading: false });
    }
  },
  updateField(event: WechatMiniprogram.Input) {
    if (!this.data.editable) return;
    const field = String(event.currentTarget.dataset.field);
    this.setData({
      [field]: event.detail.value,
      draftDirty: true,
      draftRevision: this.data.draftRevision + 1,
      draftState: "正在保存草稿…",
      draftSaveFailed: false,
      draftRecovery: "",
      submitRecovery: "",
      submissionBlocked: false,
      postUrlFocus: field === "postUrl" ? false : this.data.postUrlFocus,
      error: ""
    }, () => this.refreshCanSubmit());
    enableDraftExitGuard();
    this.scheduleDraftSave();
  },
  updatePermission(event: WechatMiniprogram.SwitchChange) {
    if (!this.data.editable) return;
    const key = String(event.currentTarget.dataset.key);
    this.setData({
      [`permissions.${key}`]: event.detail.value,
      draftDirty: true,
      draftRevision: this.data.draftRevision + 1,
      draftState: "正在保存草稿…",
      draftSaveFailed: false,
      draftRecovery: "",
      submitRecovery: "",
      submissionBlocked: false,
      error: ""
    }, () => this.refreshCanSubmit());
    enableDraftExitGuard();
    this.scheduleDraftSave();
  },
  copySubmissionId() { wx.setClipboardData({ data: this.data.submissionId }); },
  refreshCanSubmit() { this.setData({ canSubmit: formReady(this.data) }); },
  scheduleDraftSave(delay = 650) {
    if (!this.data.pageAlive) return;
    if (draftSaveTimer) clearTimeout(draftSaveTimer);
    draftSaveTimer = setTimeout(() => void this.saveDraft(), delay);
  },
  async saveDraft() {
    if (!this.data.pageAlive || !this.data.editable || !this.data.submission || !this.data.draftDirty || this.data.savingDraft || this.data.working) return;
    if (draftSaveTimer) clearTimeout(draftSaveTimer);
    draftSaveTimer = undefined;
    const revision = this.data.draftRevision;
    const normalized = { postUrl: this.data.postUrl.trim(), platformAccount: this.data.platformAccount.trim(), disclosure: this.data.disclosure.trim() };
    this.setData({ savingDraft: true, draftSaveFailed: false, draftRecovery: "", uploadRecovery: "", submitRecovery: "", draftState: "正在保存草稿…", canSubmit: false });
    try {
      const saved = await request<any>({
        path: `/v1/submissions/${this.data.submissionId}/draft`,
        method: "PUT",
        data: {
          ...normalized,
          license: this.data.permissions,
          expectedVersion: this.data.submission.version
        }
      });
      if (!this.data.pageAlive) return;
      const changedWhileSaving = this.data.draftRevision !== revision;
      const next = {
        "submission.version": saved.version,
        savingDraft: false,
        draftDirty: changedWhileSaving,
        draftSaveFailed: false,
        draftRecovery: "" as const,
        draftState: changedWhileSaving ? "正在保存草稿…" : "草稿已保存",
        error: ""
      };
      if (!changedWhileSaving) Object.assign(next, normalized);
      this.setData(next, () => this.refreshCanSubmit());
      if (changedWhileSaving) this.scheduleDraftSave(120);
      else disableDraftExitGuard();
    } catch (error) {
      if (!this.data.pageAlive) return;
      const failure = draftFailure(error);
      this.setData({
        savingDraft: false,
        draftDirty: true,
        draftSaveFailed: failure.recovery === "retry",
        draftRecovery: failure.recovery,
        draftState: failure.state,
        error: failure.copy
      }, scrollToSubmitError);
    }
  },
  retryDraftSave() { if (!this.data.savingDraft && this.data.draftDirty) void this.saveDraft(); },
  focusPostUrl() { this.setData({ postUrlFocus: true }); },
  async resolveDraftConflict() {
    if (this.data.savingDraft || this.data.resolvingDraftConflict || !this.data.draftDirty) return;
    this.setData({ resolvingDraftConflict: true, uploadRecovery: "", submitRecovery: "", error: "" });
    let choice: { confirm: boolean };
    try {
      choice = await wx.showModal({ title: "核对草稿版本", content: "将先读取最新草稿，再保存本页文字和授权选择。已上传图片会保留。", confirmText: "核对并保存", cancelText: "继续编辑" });
    } catch {
      if (this.data.pageAlive) this.setData({ error: "暂时无法核对草稿，请稍后重试。" }, scrollToSubmitError);
      return;
    } finally {
      if (this.data.pageAlive) this.setData({ resolvingDraftConflict: false });
    }
    if (!choice.confirm || !this.data.pageAlive) return;
    this.setData({ savingDraft: true, canSubmit: false, error: "" });
    try {
      const latest = await request<any>({ path: `/v1/submissions/${this.data.submissionId}` });
      if (!this.data.pageAlive) return;
      if (!["draft", "needs_changes", "appealed"].includes(latest.status)) {
        this.setData({ submission: latest, editable: false, savingDraft: false, draftRecovery: "reload", error: "投稿状态已变化，当前草稿不能继续编辑。请打开审核进度核对。" }, scrollToSubmitError);
        return;
      }
      this.setData({ submission: latest, mediaUploadsEnabled: latest.media_uploads_enabled === true, editable: true, savingDraft: false, draftRecovery: "", error: "" });
      await this.saveDraft();
    } catch {
      if (this.data.pageAlive) this.setData({ savingDraft: false, draftRecovery: "conflict", error: "最新草稿暂时无法读取，请检查网络后再次核对。" }, scrollToSubmitError);
    }
  },
  mimeForPath(path: string): string | null {
    const lower = path.toLowerCase();
    if (/\.(jpg|jpeg)$/.test(lower)) return "image/jpeg";
    if (lower.endsWith(".png")) return "image/png";
    if (lower.endsWith(".webp")) return "image/webp";
    return null;
  },
  async chooseMedia(event: WechatMiniprogram.TouchEvent) {
    const kind = event.currentTarget.dataset.kind as "original" | "screenshot";
    if (!this.data.editable || this.data.working || this.data.uploadingKind || this.data.savingDraft) return;
    if (!this.data.mediaUploadsEnabled) {
      this.setData({ uploadRecovery: "", error: "图片上传暂未开放，请稍后再来。" }, scrollToSubmitError);
      return;
    }
    if (this.data.draftDirty) await this.saveDraft();
    if (!this.data.pageAlive) return;
    if (this.data.draftDirty || this.data.savingDraft) {
      this.setData({ error: "请先保存草稿，再上传图片" }, scrollToSubmitError);
      return;
    }
    const uploadAttempt = this.data.uploadAttempt + 1;
    const ownerToken = getApp<IAppOption>().globalData.sessionToken;
    const uploadIsCurrent = () => this.data.pageAlive && this.data.uploadAttempt === uploadAttempt
      && ownerToken === getApp<IAppOption>().globalData.sessionToken;
    this.setData({ uploadAttempt, uploadingKind: kind, lastUploadKind: kind, canSubmit: false, draftRecovery: "", uploadRecovery: "", submitRecovery: "", submissionBlocked: false, error: "" });
    wx.enableAlertBeforeUnload({ message: "图片正在上传并校验，离开可能中断本次上传。" });
    try {
      await new Promise<void>((resolve, reject) => wx.requirePrivacyAuthorize({ success: () => resolve(), fail: reject }));
      if (!uploadIsCurrent()) return;
      const chosen = await wx.chooseMedia({ count: 1, mediaType: ["image"], sourceType: ["album", "camera"] });
      if (!uploadIsCurrent()) return;
      const file = chosen.tempFiles[0];
      if (!file) return;
      const mimeType = this.mimeForPath(file.tempFilePath);
      if (!mimeType) {
        this.setData({ uploadRecovery: "retry", error: "该图片格式不受支持。请选择 JPG、PNG 或 WEBP 图片。" }, scrollToSubmitError);
        return;
      }
      if (file.size > 10 * 1024 * 1024) {
        this.setData({ uploadRecovery: "retry", error: "图片超过 10MB，请压缩或重新选择后上传。" }, scrollToSubmitError);
        return;
      }
      const existing = this.data.submission?.media.find((item: any) => item.kind === kind && item.upload_state === "uploaded");
      if (existing) {
        const confirmation = await wx.showModal({
          title: "替换已上传图片？",
          content: "新图片上传成功前，原有图片会保留。",
          confirmText: "替换图片"
        });
        if (!uploadIsCurrent()) return;
        if (!confirmation.confirm) return;
      }
      if (!uploadIsCurrent()) return;
      const authorization = await request<any>({
        path: `/v1/submissions/${this.data.submissionId}/media/authorize`,
        method: "POST",
        data: { kind, mimeType, maxBytes: file.size }
      });
      if (!uploadIsCurrent()) return;
      await uploadAuthorized(file.tempFilePath, authorization, {
        registerAbort: abort => { if (uploadIsCurrent()) this.mediaUploadAbort = abort; else abort(); }
      });
      if (!uploadIsCurrent()) return;
      await request({ path: `/v1/submissions/${this.data.submissionId}/media/${authorization.mediaId}/complete`, method: "POST" });
      if (!uploadIsCurrent()) return;
      await this.load();
    } catch (error) {
      if (uploadIsCurrent() && !isUserCancellation(error)) {
        const failure = mediaFailure(error);
        this.setData({ uploadRecovery: failure.recovery, submissionBlocked: failure.recovery === "reload", error: failure.copy }, scrollToSubmitError);
      }
    } finally {
      if (uploadIsCurrent()) {
        this.mediaUploadAbort = null;
        this.setData({ uploadingKind: "" }, () => this.refreshCanSubmit());
        if (this.data.draftDirty) enableDraftExitGuard();
        else disableDraftExitGuard();
      }
    }
  },
  openMediaSettings() { wx.openSetting({ fail: () => this.setData({ error: "系统设置暂时无法打开，请在微信设置中允许相册或相机权限后重试。" }, scrollToSubmitError) }); },
  openMediaPrivacy() { wx.openPrivacyContract({ fail: () => this.setData({ error: "隐私保护指引暂时无法打开，请稍后重试。" }, scrollToSubmitError) }); },
  async openProgress() {
    if (this.data.navigatingToProgress || !this.data.submissionId) return;
    this.setData({ navigatingToProgress: true, error: "" });
    try {
      await new Promise<void>((resolve, reject) => wx.redirectTo({ url: `/pages/progress/index?id=${this.data.submissionId}`, success: () => resolve(), fail: reject }));
    } catch {
      if (this.data.pageAlive) this.setData({ navigatingToProgress: false, error: "审核进度页暂时无法打开，请再次点击“查看审核进度”。" }, scrollToSubmitError);
    }
  },
  async submit() {
    if (!this.data.editable || this.data.working || this.data.savingDraft || !this.data.submission || !["draft", "needs_changes", "appealed"].includes(this.data.submission.status)) return;
    if (!formReady(this.data)) {
      this.setData({ error: "请补齐原图、发布截图、内容链接、平台账号和利益关系，并确认两项必要授权。" }, scrollToSubmitError);
      return;
    }
    if (this.data.draftDirty) await this.saveDraft();
    if (this.data.draftDirty || this.data.savingDraft) return;
    this.setData({ working: true, canSubmit: false, draftRecovery: "", uploadRecovery: "", submitRecovery: "", submissionBlocked: false, error: "" });
    wx.enableAlertBeforeUnload({ message: "正在提交投稿，请确认结果后再离开。" });
    try {
      let submitted: any;
      try {
        submitted = await request({
        path: `/v1/submissions/${this.data.submissionId}/submit`,
        method: "POST",
        idempotencyKey: `submit-${this.data.submissionId}-v${this.data.submission.version}`,
        data: {
          postUrl: this.data.postUrl,
          platformAccount: this.data.platformAccount,
          disclosure: this.data.disclosure,
          license: this.data.permissions,
          expectedVersion: this.data.submission.version
        }
        });
      } catch (error) {
        if (this.data.pageAlive) {
          const failure = submissionFailure(error);
          this.setData({ submitRecovery: failure.recovery, submissionBlocked: failure.recovery !== "retry", error: failure.copy }, scrollToSubmitError);
        }
        return;
      }
      if (!this.data.pageAlive) return;
      this.setData({ "submission.status": submitted.status, "submission.version": submitted.version, editable: false, draftDirty: false, draftState: "投稿已提交，正在打开审核进度" });
      disableDraftExitGuard();
      await this.openProgress();
    } finally {
      if (this.data.pageAlive) {
        this.setData({ working: false }, () => this.refreshCanSubmit());
        if (this.data.draftDirty) enableDraftExitGuard();
        else disableDraftExitGuard();
      }
    }
  },
  async back() {
    if (this.data.working || this.data.uploadingKind || this.data.navigatingToProgress || this.data.confirmingExit) {
      wx.showToast({ title: this.data.uploadingKind ? "图片上传中，请稍候" : "投稿提交中，请稍候", icon: "none" });
      return;
    }
    if (this.data.savingDraft || this.data.resolvingDraftConflict) { wx.showToast({ title: "正在保存草稿，请稍候", icon: "none" }); return; }
    if (this.data.draftDirty || this.data.savingDraft) {
      this.setData({ confirmingExit: true });
      try {
        const choice = await wx.showModal({ title: "先保存草稿？", content: "保存后返回，或放弃本次未保存的修改。", confirmText: "保存并返回", cancelText: "放弃修改" });
        if (choice.confirm) {
          await this.saveDraft();
          if (this.data.draftDirty || this.data.savingDraft) return;
        } else {
          const discard = await wx.showModal({ title: "放弃未保存修改？", content: "已保存的草稿和图片会保留，本次未保存的修改将丢失。", confirmText: "放弃并返回", cancelText: "继续编辑" });
          if (!discard.confirm) return;
          if (draftSaveTimer) clearTimeout(draftSaveTimer);
          draftSaveTimer = undefined;
          this.setData({ draftDirty: false, draftState: "已放弃本次未保存修改" });
          disableDraftExitGuard();
        }
      } catch {
        if (this.data.pageAlive) this.setData({ error: "暂时无法确认离开，本页未保存的修改仍保留。" }, scrollToSubmitError);
        return;
      } finally {
        if (this.data.pageAlive) this.setData({ confirmingExit: false });
      }
    }
    this.leavePage();
  },
  leavePage() {
    wx.navigateBack({ fail: () => {
      const returnUrl = submissionReturnUrl(this.data.submissionId);
      if (returnUrl.startsWith("/pages/task/")) wx.redirectTo({ url: returnUrl, fail: () => wx.switchTab({ url: "/pages/community/index" }) });
      else wx.switchTab({ url: "/pages/community/index" });
    } });
  }
});
