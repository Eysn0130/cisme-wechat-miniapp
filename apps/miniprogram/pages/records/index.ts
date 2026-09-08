import { clearAuthenticationRedirectSuppression, request } from "../../services/api";
import { currentChromeStyle, motionDuration } from "../../services/layout";

function scrollToRecordsError() {
  wx.pageScrollTo({ selector: "#records-error-summary", duration: motionDuration(200) });
}

const emptySummary = { day: 0, completed: 0, headlineLine1: "你的头皮护理，", headlineLine2: "正在成为一种习惯。", phaseLabel: "尚未开始", protocol: "", cycleSummary: "" };

Page({
  data: {
    care: null as any,
    timeline: [] as Array<{ milestone: string; done: boolean; current: boolean; status: string }>,
    records: [] as Array<{ milestone: string; index: string; completedAt: string }>,
    chromeStyle: currentChromeStyle(),
    summary: emptySummary,
    loading: true,
    working: false,
    workingAction: "",
    confirmingCycleAction: false,
    authorityAvailable: false,
    loadAttempt: 0,
    pageAlive: true,
    operationStatus: "",
    error: ""
  },
  onLoad() { this.data.pageAlive = true; },
  onResize() { this.setData({ chromeStyle: currentChromeStyle() }); },
  onShow() { const tab = this.getTabBar?.(); if (tab) tab.setData({ active: 1 }); tab?.syncActive?.(1); void this.load(); },
  onUnload() { this.data.pageAlive = false; this.data.loadAttempt += 1; wx.disableAlertBeforeUnload(); },
  async load(preserveSnapshot = false): Promise<boolean> {
    const attempt = this.data.loadAttempt + 1;
    this.setData(preserveSnapshot && this.data.authorityAvailable
      ? { loadAttempt: attempt, loading: false, error: "" }
      : { loadAttempt: attempt, care: null, timeline: [], records: [], summary: emptySummary, loading: true, authorityAvailable: false, error: "" });
    try {
      const care = await request<any>({ path: "/v1/me/care" });
      if (!this.data.pageAlive || this.data.loadAttempt !== attempt) return false;
      const completed = care?.completed ?? [];
      const currentMilestone = care?.due ?? care?.next ?? "D1";
      const day = Number(String(currentMilestone).replace("D", "")) || 1;
      const timeline = ["D1", "D7", "D14", "D28"].map((milestone) => ({
        milestone,
        done: completed.includes(milestone),
        current: care?.due === milestone,
        status: completed.includes(milestone) ? "已完成" : care?.due === milestone ? "今日" : "待开始"
      }));
      const phaseLabel = !care ? "等待体验资格确认" : care.phase === "active" ? "护理进行中" : care.phase === "completed" ? "本周期已完成" : care.phase === "paused" ? "周期已暂停" : care.phase === "terminated" ? "周期已终止" : "待用户确认开始";
      const cycleSummary = care?.startedOn ? `${care.startedOn} 开始 · 按护理日程自动更新` : "确认开始后生成 D1、D7、D14、D28";
      const headline = care?.phase === "completed" ? ["这个护理周期，", "已经完整保存。"] : ["你的头皮护理，", "正在成为一种习惯。"];
      const records = (Array.isArray(care?.records) ? care.records.slice() : []).sort((left: { completedAt?: string }, right: { completedAt?: string }) => String(right.completedAt ?? "").localeCompare(String(left.completedAt ?? ""))).map((record: { milestone: string; completedAt?: string }) => ({ milestone: record.milestone, index: record.milestone.replace("D", "").padStart(2, "0"), completedAt: record.completedAt ? String(record.completedAt).slice(5, 10).replace("-", "/") : "—" }));
      this.setData({ care, timeline, records, summary: { day, completed: completed.length, headlineLine1: headline[0], headlineLine2: headline[1], phaseLabel, protocol: care?.protocolVersion ?? "", cycleSummary }, authorityAvailable: true, error: "" });
      return true;
    }
    catch (error) {
      if (this.data.pageAlive && this.data.loadAttempt === attempt) this.setData({ care: null, timeline: [], records: [], summary: emptySummary, authorityAvailable: false, error: "护理档案暂时无法同步，请检查网络后重试。旧记录不会被当作当前周期状态。" }, scrollToRecordsError);
      return false;
    }
    finally { if (this.data.pageAlive && this.data.loadAttempt === attempt) this.setData({ loading: false }); }
  },
  retryLoad() { clearAuthenticationRedirectSuppression(); void this.load(); },
  goHome() {
    if (this.data.working || this.data.confirmingCycleAction) { wx.showToast({ title: "周期操作确认中，请稍候", icon: "none" }); return; }
    wx.switchTab({ url: "/pages/home/index", fail: () => wx.showToast({ title: "护理首页暂时无法打开", icon: "none" }) });
  },
  async changeCycle(event: WechatMiniprogram.TouchEvent) {
    if (!this.data.care || !this.data.authorityAvailable || this.data.working || this.data.confirmingCycleAction) return;
    const action = String(event.currentTarget.dataset.action) as "pause" | "resume" | "terminate";
    const care = this.data.care;
    const copy = action === "pause"
      ? { title: "暂停当前护理周期？", content: "已保存记录不会丢失；恢复后未来提醒将重新计算。" }
      : action === "resume"
        ? { title: "恢复当前护理周期？", content: "系统会按恢复事实重新安排后续里程碑。" }
        : { title: "终止当前护理周期？", content: "终止不会删除历史记录，也不会自动触发退款或积分变化。" };
    this.setData({ confirmingCycleAction: true });
    let confirmation: WechatMiniprogram.ShowModalSuccessCallbackResult;
    try {
      confirmation = await wx.showModal({ ...copy, confirmText: action === "pause" ? "确认暂停" : action === "resume" ? "确认恢复" : "确认终止" });
    } catch {
      if (this.data.pageAlive) this.setData({ error: "周期操作确认弹层暂时无法打开，请重新选择操作。" }, scrollToRecordsError);
      return;
    } finally {
      if (this.data.pageAlive) this.setData({ confirmingCycleAction: false });
    }
    if (!this.data.pageAlive || !confirmation.confirm) return;
    if (this.data.working || !this.data.authorityAvailable || !this.data.care || this.data.care.id !== care.id || this.data.care.version !== care.version) {
      this.setData({ operationStatus: "", error: "护理周期状态已变化，请核对最新状态后重新选择操作。" }, scrollToRecordsError);
      return;
    }
    this.setData({ working: true, workingAction: action, operationStatus: "正在更新护理周期状态…", error: "" });
    const tab = this.getTabBar?.(); if (tab) tab.setData({ externalBusy: true });
    wx.enableAlertBeforeUnload({ message: "护理周期操作已经发送，离开不会撤回服务端处理。请等待最新状态确认。" });
    const reasonCode = action === "pause" ? "MEMBER_REQUEST" : action === "resume" ? "MEMBER_RESUME" : "MEMBER_TERMINATION";
    const successCopy = action === "pause" ? "护理周期已暂停" : action === "resume" ? "护理周期已恢复" : "护理周期已终止";
    try {
      await request({ path: `/v1/care-cycles/${care.id}/${action}`, method: "POST", idempotencyKey: `care-${care.id}-${action}-v${care.version}`, data: { reasonCode, expectedVersion: care.version } });
      if (!this.data.pageAlive) return;
      const refreshed = await this.load(true);
      if (this.data.pageAlive) this.setData({ operationStatus: refreshed ? successCopy : "", ...(refreshed ? {} : { error: "周期操作已受理，但最新状态暂时无法确认。页面已锁定周期操作，请刷新后核对。" }) }, refreshed ? undefined : scrollToRecordsError);
    }
    catch (error) {
      if (!this.data.pageAlive) return;
      const refreshed = await this.load(true);
      if (this.data.pageAlive) this.setData({ operationStatus: "", error: refreshed ? "周期状态更新未完成。已重新核对当前状态，请确认后再试。" : "周期操作结果与最新状态均暂时无法确认。页面已锁定周期操作，请刷新后核对。" }, scrollToRecordsError);
    }
    finally {
      if (this.data.pageAlive) this.setData({ working: false, workingAction: "" });
      const currentTab = this.getTabBar?.(); if (currentTab) currentTab.setData({ externalBusy: false });
      wx.disableAlertBeforeUnload();
    }
  }
});
