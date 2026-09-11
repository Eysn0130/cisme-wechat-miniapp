import { requireMemberAccess } from "../../services/api";
import { clearAuthenticationRedirectSuppression, request, submissionReturnUrl } from "../../services/api";
import { currentChromeStyle, motionDuration } from "../../services/layout";

function scrollToProgressError() {
  wx.pageScrollTo({ selector: "#progress-error-summary", duration: motionDuration(200) });
}

function progressLoadFailure(error: unknown): { action: "load" | "missing"; title: string; copy: string } {
  const problem = error as { status?: number; code?: string };
  if (problem.status === 404 || problem.code === "SUBMISSION_NOT_FOUND") {
    return {
      action: "missing",
      title: "未找到这份投稿记录",
      copy: "这份编号不存在、已失效，或不属于当前微信身份。请从原任务或有效邀请重新进入。"
    };
  }
  return {
    action: "load",
    title: "审核进度暂时未同步",
    copy: "请检查网络后重试。页面不会把加载失败误显示成审核结论。"
  };
}

function progressTimeline(status: string) {
  const materialDone = status !== "draft";
  const reviewDone = status === "approved";
  const reviewActive = ["submitted", "appealed", "needs_changes"].includes(status);
  const reviewAlert = status === "rejected";
  const reviewState = status === "needs_changes" ? "待补件" : status === "rejected" ? "未通过" : status === "appealed" ? "复核中" : reviewDone ? "完成" : reviewActive ? "进行中" : "等待";
  const resultState = status === "approved" ? "已处理" : status === "rejected" ? "待申诉决定" : status === "needs_changes" ? "等待补件" : "等待";
  return {
    materialDone,
    materialState: materialDone ? "完成" : "待提交",
    reviewRowClass: reviewDone ? "is-done" : reviewActive ? "is-current" : reviewAlert ? "is-alert" : "",
    reviewDotClass: reviewDone ? "progress-dot--done" : reviewActive ? "progress-dot--current" : reviewAlert ? "progress-dot--alert" : "",
    reviewState,
    resultRowClass: status === "approved" ? "is-done" : reviewAlert ? "is-alert" : "",
    resultDotClass: status === "approved" ? "progress-dot--done" : reviewAlert ? "progress-dot--alert" : "",
    resultState
  };
}

function appealFailure(error: unknown): { blocked: boolean; title: string; copy: string } {
  const problem = error as { status?: number; code?: string };
  const authorityChanged = problem.status === 404 || ["APPEAL_STATE_INVALID", "SUBMISSION_STATE_INVALID", "SUBMISSION_NOT_FOUND", "VERSION_CONFLICT"].includes(problem.code ?? "");
  if (authorityChanged) {
    return {
      blocked: true,
      title: "申诉资格已变化",
      copy: "审核状态已在其他位置更新。请先刷新权威状态，再决定是否申诉。"
    };
  }
  return {
    blocked: false,
    title: "申诉暂未提交",
    copy: "网络结果尚未确认；可使用同一请求重试，或先刷新审核状态。"
  };
}

Page({
  data: { chromeStyle: currentChromeStyle(), submissionId: "", submission: null as any, statusTitle: "", statusSubtitle: "", statusLabel: "", reviewReason: "", timeline: progressTimeline("draft"), appealReason: "", appealValid: false, appealBlocked: false, loading: true, working: false, navigatingToRevision: false, navigatingAway: false, loadAttempt: 0, pageAlive: true, errorAction: "load" as "load" | "missing" | "appeal" | "revise", errorTitle: "", error: "" },
  onResize() { this.setData({ chromeStyle: currentChromeStyle() }); },
  onLoad(query: Record<string, string | undefined>) { this.setData({ submissionId: query.id ?? "", pageAlive: true }); },
  onShow() { if (!requireMemberAccess()) return; this.data.pageAlive = true; void this.load(); },
  onHide() { this.data.loadAttempt += 1; },
  onUnload() { this.data.pageAlive = false; this.data.loadAttempt += 1; wx.disableAlertBeforeUnload(); },
  async load(event?: WechatMiniprogram.TouchEvent) {
    if (event?.type) clearAuthenticationRedirectSuppression();
    if (!this.data.submissionId) {
      this.setData({ submission: null, statusTitle: "", statusSubtitle: "", statusLabel: "", reviewReason: "", timeline: progressTimeline("draft"), loading: false, errorAction: "missing", errorTitle: "无法打开审核进度", error: "链接中缺少投稿编号，请从有效邀请或投稿记录重新进入。" }, scrollToProgressError);
      return;
    }
    const attempt = this.data.loadAttempt + 1;
    this.setData({ loadAttempt: attempt, submission: null, statusTitle: "", statusSubtitle: "", statusLabel: "", reviewReason: "", timeline: progressTimeline("draft"), loading: true, errorAction: "load", errorTitle: "", error: "" });
    try {
      const submission = await request<any>({ path: `/v1/submissions/${this.data.submissionId}` });
      if (!this.data.pageAlive || this.data.loadAttempt !== attempt) return;
      const views: Record<string, { title: string; subtitle: string }> = {
        draft: { title: "投稿材料仍在草稿中", subtitle: "提交后才会进入人工审核" },
        submitted: { title: "发布证明已提交", subtitle: "已进入人工审核，结果将在站内更新" },
        needs_changes: { title: "需要补充材料", subtitle: "按审核说明补件后将沿用原编号" },
        rejected: { title: "本次审核未通过", subtitle: "可查看原因并提交一次申诉" },
        appealed: { title: "申诉已进入复核", subtitle: "复核结论会保留完整审计记录" },
        approved: { title: "真实护理故事已通过", subtitle: "积分与展示仍按各自准入门独立处理" }
      };
      const labels: Record<string, string> = { draft: "草稿", submitted: "审核中", needs_changes: "待补件", rejected: "未通过", appealed: "复核中", approved: "已通过" };
      const status = String(submission.status ?? "");
      const view = views[status];
      const statusLabel = labels[status];
      if (!view || !statusLabel) throw new Error("SUBMISSION_STATUS_INVALID");
      this.setData({ submission, statusTitle: view.title, statusSubtitle: view.subtitle, timeline: progressTimeline(status), statusLabel, reviewReason: submission.review?.reason_summary ?? "", appealBlocked: false, loading: false, errorTitle: "", error: "" });
    }
    catch (error) {
      if (this.data.pageAlive && this.data.loadAttempt === attempt) {
        const failure = progressLoadFailure(error);
        this.setData({ submission: null, statusTitle: "", statusSubtitle: "", statusLabel: "", reviewReason: "", timeline: progressTimeline("draft"), loading: false, errorAction: failure.action, errorTitle: failure.title, error: failure.copy }, scrollToProgressError);
      }
    }
  },
  updateAppeal(event: WechatMiniprogram.Input) {
    const appealReason = event.detail.value;
    this.setData({ appealReason, appealValid: appealReason.trim().length > 0 });
  },
  async appeal() {
    if (this.data.working || this.data.navigatingAway || this.data.appealBlocked || !this.data.appealValid) return;
    this.setData({ working: true, appealBlocked: false, error: "" });
    wx.enableAlertBeforeUnload({ message: "申诉正在提交并确认权威状态，请等待结果后再离开。" });
    try {
      await request({ path: `/v1/submissions/${this.data.submissionId}/appeal`, method: "POST", idempotencyKey: `appeal-${this.data.submissionId}-v${this.data.submission.version}`, data: { reason: this.data.appealReason.trim(), expectedVersion: this.data.submission.version } });
      if (this.data.pageAlive) await this.load();
    } catch (error) {
      if (this.data.pageAlive) {
        const failure = appealFailure(error);
        this.setData({ appealBlocked: failure.blocked, errorAction: "appeal", errorTitle: failure.title, error: failure.copy }, scrollToProgressError);
      }
    }
    finally {
      if (this.data.pageAlive) this.setData({ working: false });
      wx.disableAlertBeforeUnload();
    }
  },
  revise() {
    if (this.data.working || this.data.navigatingToRevision || this.data.navigatingAway) return;
    this.setData({ navigatingToRevision: true, error: "" });
    wx.redirectTo({
      url: `/pages/submit/index?id=${this.data.submissionId}`,
      fail: () => {
        if (this.data.pageAlive) this.setData({ navigatingToRevision: false, errorAction: "revise", errorTitle: "补件页面暂未打开", error: "请再次点击“按补件要求修改”；当前审核状态不会改变。" }, scrollToProgressError);
      }
    });
  },
  back() {
    if (this.data.working || this.data.navigatingToRevision || this.data.navigatingAway) { wx.showToast({ title: this.data.working ? "申诉提交中，请稍候" : this.data.navigatingToRevision ? "正在打开补件页面" : "正在返回投稿来源", icon: "none" }); return; }
    const returnUrl = submissionReturnUrl(this.data.submissionId);
    const expectedTaskId = decodeURIComponent(returnUrl.match(/[?&]id=([^&]+)/)?.[1] ?? "");
    const pages = getCurrentPages();
    const previous = pages[pages.length - 2] as { route?: string; options?: Record<string, string> } | undefined;
    const previousIsSource = returnUrl.startsWith("/pages/task/index") && expectedTaskId && previous?.route === "pages/task/index" && previous.options?.id === expectedTaskId;
    this.setData({ navigatingAway: true });
    const failed = () => {
      if (this.data.pageAlive) this.setData({ navigatingAway: false });
      wx.showToast({ title: "投稿来源暂时无法打开", icon: "none" });
    };
    const community = () => wx.switchTab({ url: "/pages/community/index", fail: failed });
    const openSource = () => {
      if (returnUrl.startsWith("/pages/task/index") && expectedTaskId) wx.redirectTo({ url: returnUrl, fail: community });
      else community();
    };
    if (previousIsSource) wx.navigateBack({ delta: 1, fail: openSource });
    else openSource();
  },
  goCommunity() {
    if (this.data.working || this.data.navigatingToRevision || this.data.navigatingAway) { wx.showToast({ title: this.data.working ? "申诉提交中，请稍候" : this.data.navigatingToRevision ? "正在打开补件页面" : "正在返回社区首页", icon: "none" }); return; }
    this.setData({ navigatingAway: true });
    wx.switchTab({ url: "/pages/community/index", fail: () => {
      if (this.data.pageAlive) this.setData({ navigatingAway: false });
      wx.showToast({ title: "社区首页暂时无法打开", icon: "none" });
    } });
  }
});
