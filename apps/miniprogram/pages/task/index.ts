import { requireMemberAccess, retainMemberSnapshot } from "../../services/api";
import { clearAuthenticationRedirectSuppression, rememberSubmissionReturn, request } from "../../services/api";
import { currentChromeStyle } from "../../services/layout";

function taskLoadFailure(error: unknown): { action: "load" | "missing"; title: string; copy: string } {
  const problem = error as { status?: number; code?: string };
  if (problem.status === 404 || problem.code === "TASK_NOT_FOUND") {
    return { action: "missing", title: "这份邀请不可用", copy: "邀请不存在、已失效，或不属于当前微信身份。请返回品牌精选社区重新进入。" };
  }
  return { action: "load", title: "邀请资格暂时未同步", copy: "请检查网络后重试。页面不会把加载失败误显示成邀请已失效。" };
}

Page({
  data: { chromeStyle: currentChromeStyle(), task: null as any, taskId: "", continuationSubmissionId: "", loading: true, working: false, loadAttempt: 0, pageAlive: true, leaving: false, errorAction: "load" as "load" | "missing" | "claim" | "continue", errorTitle: "", error: "" },
  onResize() { this.setData({ chromeStyle: currentChromeStyle() }); },
  onLoad(query: Record<string, string | undefined>) {
    const taskId = query.id ?? "";
    this.setData({ taskId, pageAlive: true, ...(taskId ? {} : { loading: false, errorAction: "missing", errorTitle: "无法打开邀请详情", error: "链接中缺少邀请编号，请返回品牌精选社区重新进入。" }) });
  },
  onHide() { this.data.loadAttempt += 1; },
  onUnload() { this.data.pageAlive = false; this.data.loadAttempt += 1; wx.disableAlertBeforeUnload(); },
  onShow() {
    this.data.pageAlive = true;
    if (!retainMemberSnapshot(this)) this.setData({ task: null, continuationSubmissionId: "", working: false,
      loadAttempt: this.data.loadAttempt + 1, loading: false, errorTitle: "", error: "" });
    if (!requireMemberAccess()) { this.setData({ loading: false, errorAction: "load", errorTitle: "请先确认身份", error: "登录后才能查看自己的邀请资格。" }); return; }
    this.setData({ pageAlive: true, leaving: false });
    void this.load();
  },
  async load(event?: WechatMiniprogram.TouchEvent): Promise<boolean> {
    if (event?.type) clearAuthenticationRedirectSuppression();
    if (!this.data.taskId) { this.setData({ task: null, loading: false, errorAction: "missing", errorTitle: "无法打开邀请详情", error: "链接中缺少邀请编号，请返回品牌精选社区重新进入。" }); return false; }
    const attempt = this.data.loadAttempt + 1;
    const token = getApp<IAppOption>().globalData.sessionToken;
    this.setData({ loadAttempt: attempt, task: null, loading: true, errorAction: "load", errorTitle: "", error: "" });
    try {
      const task = await request({ path: `/v1/tasks/${this.data.taskId}` });
      if (this.data.pageAlive && this.data.loadAttempt === attempt && token === getApp<IAppOption>().globalData.sessionToken) {
        this.setData({ task, loading: false, errorTitle: "", error: "" });
        return true;
      }
      return false;
    }
    catch (error) {
      if (this.data.pageAlive && this.data.loadAttempt === attempt && token === getApp<IAppOption>().globalData.sessionToken) {
        const failure = taskLoadFailure(error);
        this.setData({ task: null, loading: false, errorAction: failure.action, errorTitle: failure.title, error: failure.copy });
      }
      return false;
    }
  },
  async claim() {
    if (!this.data.pageAlive || this.data.leaving || this.data.working) return;
    this.setData({ working: true, error: "" });
    wx.enableAlertBeforeUnload({ message: "任务正在领取并生成唯一投稿编号，请等待结果后再离开。" });
    try {
      let claim: { submissionId: string };
      try {
        claim = await request<{ submissionId: string }>({ path: `/v1/tasks/${this.data.taskId}/claim`, method: "POST", idempotencyKey: `claim-${this.data.taskId}` });
      } catch (error) {
        if (!this.data.pageAlive) return;
        const refreshed = await this.load();
        if (!this.data.pageAlive || !refreshed) return;
        if (this.data.task?.submission_id) {
          this.data.continuationSubmissionId = this.data.task.submission_id;
          this.setData({ errorAction: "continue", errorTitle: "投稿编号已生成", error: "领取结果已从服务端恢复，请继续完成当前投稿；不会重复领取。" });
        } else if (!this.data.task?.claimable) {
          this.setData({ errorAction: "claim", errorTitle: "邀请资格已更新", error: this.data.task?.claim_block_reason || "当前邀请已不可领取，请返回投稿与邀请列表选择其他可用任务。" });
        } else {
          this.setData({ errorAction: "claim", errorTitle: "邀请暂未领取", error: "已重新核对当前资格。请检查网络后重试；失败不会生成第二份投稿。" });
        }
        return;
      }
      if (!this.data.pageAlive) return;
      rememberSubmissionReturn({ submissionId: claim.submissionId, taskId: this.data.taskId, returnUrl: `/pages/task/index?id=${encodeURIComponent(this.data.taskId)}` });
      this.data.continuationSubmissionId = claim.submissionId;
      wx.disableAlertBeforeUnload();
      try {
        await new Promise<void>((resolve, reject) => wx.navigateTo({ url: `/pages/submit/index?id=${claim.submissionId}`, success: () => resolve(), fail: reject }));
      } catch {
        if (this.data.pageAlive) {
          await this.load();
          if (this.data.pageAlive) this.setData({ errorAction: "continue", errorTitle: "草稿已生成", error: "投稿页面暂未打开，请点击“继续完成投稿”再次进入；不会重复领取。" });
        }
      }
    }
    finally {
      if (this.data.pageAlive) this.setData({ working: false });
      wx.disableAlertBeforeUnload();
    }
  },
  async continueSubmission() {
    const id = this.data.task?.submission_id || this.data.continuationSubmissionId;
    if (!id || !this.data.pageAlive || this.data.leaving || this.data.working) return;
    this.setData({ working: true, error: "" });
    try {
      rememberSubmissionReturn({ submissionId: id, taskId: this.data.taskId, returnUrl: `/pages/task/index?id=${encodeURIComponent(this.data.taskId)}` });
      const status = this.data.task?.submission_status ?? "draft";
      await new Promise<void>((resolve, reject) => wx.navigateTo({ url: `/pages/${["draft", "needs_changes"].includes(status) ? "submit" : "progress"}/index?id=${id}`, success: () => resolve(), fail: reject }));
    } catch (error) {
      if (this.data.pageAlive) this.setData({ errorAction: "continue", errorTitle: "页面暂未打开", error: "请再次点击下方按钮进入当前投稿；不会重复生成投稿编号。" });
    } finally {
      if (this.data.pageAlive) this.setData({ working: false });
    }
  },
  back() {
    if (!this.data.pageAlive || this.data.leaving) return;
    if (this.data.working) { wx.showToast({ title: "领取结果确认中，请稍候", icon: "none" }); return; }
    this.setData({ leaving: true });
    wx.navigateBack({ fail: () => {
      if (this.data.pageAlive) wx.switchTab({ url: "/pages/community/index", fail: () => {
      if (!this.data.pageAlive) return;
      this.setData({ leaving: false });
      wx.showToast({ title: "暂时无法返回，请重试", icon: "none" });
    } });
    } });
  },
  goCommunity() {
    if (!this.data.pageAlive || this.data.leaving || this.data.working) return;
    this.setData({ leaving: true });
    wx.switchTab({ url: "/pages/community/index", fail: () => {
      if (!this.data.pageAlive) return;
      this.setData({ leaving: false });
      wx.showToast({ title: "暂时无法返回，请重试", icon: "none" });
    } });
  }
});
