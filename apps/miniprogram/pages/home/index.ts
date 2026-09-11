import { memberIdentity } from "../../services/member-identity";
import { requireMemberAccess, retainMemberSnapshot, request } from "../../services/api";
import { currentChromeStyle, shouldReduceMotion } from "../../services/layout";
import { registerIncomingShare } from "../../services/share";
import { careDaypart, careGreeting, careProtocolSteps, careSelfAssessments, type CareProtocolStepView, type CareSelfAssessmentValue } from "../../services/care-protocol";
import { careHomeSchedule } from "../../services/care-home-state";

interface CareRecord { milestone: string; completedAt: string; stepCodes?: string[]; selfAssessment?: CareSelfAssessmentValue | null }
interface CareView { id: string; version: number; phase: string; startedOn: string | null; timezone: string; due: string | null; next: string | null; completed: string[]; records: CareRecord[]; scheduleOffsetDays: number }
interface MemberView { id?: string; profile_revision?: number; display_name: string }
interface CareCompletionResponse { task?: { id: string; reward_enabled?: boolean; reward_points?: number | null } | null }

let daypartTimer: ReturnType<typeof setInterval> | null = null;
let careSessionCloseTimer: ReturnType<typeof setTimeout> | null = null;
const careSessionExitMs = 300;

function boundedStepIndex(index: number): number {
  return Number.isInteger(index) && index >= 0 && index < careProtocolSteps.length ? index : 0;
}

function sessionRail(currentIndex: number, completedCount: number, assessment = false, justCompletedCode = "") {
  return careProtocolSteps.map((step, index) => ({
    ...step,
    done: index < completedCount,
    current: !assessment && index === currentIndex,
    justDone: step.code === justCompletedCode
  }));
}

function progressStyle(completedCount: number): string {
  const progress = Math.min(100, Math.max(0, completedCount) / (careProtocolSteps.length - 1) * 100);
  return `transform:scaleX(${progress / 100});`;
}

function lightHaptic(reducedMotion: boolean) {
  if (reducedMotion || typeof wx.vibrateShort !== "function") return;
  wx.vibrateShort({ type: "light", fail: () => {} });
}

function homeView(care: CareView | null, displayName = "CISME 会员", selectedIndex = 0, now = new Date(), transientCompletedCodes: readonly string[] = [], justCompletedCode = "") {
  const phase = care?.phase ?? "waiting";
  const selected = boundedStepIndex(selectedIndex);
  const completed = phase === "completed";
  const transientCompleted = new Set(transientCompletedCodes);
  const activeStep = careProtocolSteps[selected];
  const steps = careProtocolSteps.map((step, index) => ({ ...step, done: completed || transientCompleted.has(step.code), active: index === selected, justDone: step.code === justCompletedCode }));
  const completedStepCount = completed ? careProtocolSteps.length : transientCompleted.size;
  const daypart = careDaypart(now, care?.timezone || "Asia/Shanghai");
  const greeting = careGreeting(displayName, daypart);
  const greetingClass = displayName.length > 24 ? "care-greeting--very-long" : greeting.length > 16 ? "care-greeting--long" : "";
  const protocol = {
    protocolCode: activeStep.code,
    protocolLabel: activeStep.title,
    protocolAria: `护理步骤，${activeStep.code} ${activeStep.label}，${activeStep.title}${completed ? "，本周期已完成" : ""}`,
    protocolHint: completed ? `${activeStep.cue}，本周期已完成` : activeStep.cue,
    progressStyle: progressStyle(completedStepCount)
  };
  if (!care) return { greeting, greetingClass, schedule: "日常护理", action: daypart.careAction, actionable: true, signalTitle: "从四步护理开始", signalMeta: "当前护理可以完整进行；专属周期开通后才会生成 D1 等节点记录", signalIcon: "/assets/icons/clipboard-text-muted.svg", steps, ...protocol };
  if (phase === "planned") return { greeting, greetingClass, schedule: "待你确认开始", action: "确认开始护理周期", actionable: true, signalTitle: "由你决定开始日", signalMeta: "确认后才生成 D1，不会替你自动打卡", signalIcon: "/assets/icons/clock-plum.svg", steps, ...protocol };
  if (phase === "paused") return { greeting, greetingClass, schedule: "护理周期已暂停", action: "查看周期管理", actionable: true, signalTitle: "已保存记录不会丢失", signalMeta: "恢复后再继续安排后续护理节点", signalIcon: "/assets/icons/clock-plum.svg", steps, ...protocol };
  if (phase === "terminated") return { greeting, greetingClass, schedule: "护理周期已终止", action: "查看护理记录", actionable: true, signalTitle: "历史护理事实已归档", signalMeta: "你仍可随时回看已完成记录", signalIcon: "/assets/icons/clipboard-text-muted.svg", steps, ...protocol };
  if (phase === "completed") return { greeting, greetingClass, schedule: "D28 · 周期完成", action: "查看护理记录", actionable: true, signalTitle: "4 条里程碑记录已点亮", signalMeta: "时间、步骤与自我感受均已保存", signalIcon: "/assets/icons/star-active.svg", steps, ...protocol };
  const scheduleFact = careHomeSchedule(care, now);
  const milestone = care.due ?? care.next ?? "日常";
  const completedMilestoneCount = Math.max(care.records?.length ?? 0, care.completed?.length ?? 0);
  const nextRecordNumber = Math.min(4, completedMilestoneCount + 1);
  if (care.due) return {
    greeting, greetingClass, schedule: scheduleFact.state === "overdue" ? `${milestone} · 待补做` : `${milestone} · 今日护理`,
    action: daypart.careAction, actionable: true,
    signalTitle: scheduleFact.state === "overdue" ? `完成逾期的 ${milestone} 护理` : `完成后点亮第 ${nextRecordNumber} 条记录`,
    signalMeta: "四个步骤与护理后感受会一起保存", signalIcon: "/assets/icons/star-active.svg", steps, ...protocol
  };
  if (scheduleFact.completedToday) return {
    greeting, greetingClass, schedule: scheduleFact.schedule, action: "查看护理进度", actionable: true,
    signalTitle: "今天的护理事实已保存", signalMeta: care.next ? `下一护理节点为 ${care.next}` : "本周期已没有后续节点",
    signalIcon: "/assets/icons/check-circle-plum.svg", steps, ...protocol
  };
  return {
    greeting, greetingClass, schedule: scheduleFact.schedule, action: "查看护理进度", actionable: true,
    signalTitle: "今天没有待完成节点", signalMeta: care.next ? `到 ${scheduleFact.nextDueOn ?? "计划日期"} 再完成 ${care.next}` : "等待新周期安排",
    signalIcon: "/assets/icons/clock-plum.svg", steps, ...protocol
  };
}

function visitorView() {
  return { ...homeView(null, "CISME 会员", 0), greeting: "欢迎来到 CISME", action: "授权身份并开始", signalTitle: "先看看今天的护理方法", signalMeta: "确认身份后可保存你的专属周期与记录" };
}

Page({
  data: {
    chromeStyle: currentChromeStyle(), accountOpening: false, supportUnread: 0, care: null as CareView | null, view: homeView(null), selectedProtocolIndex: 0,
    loading: true, working: false, activationConfirming: false, authorityAvailable: false, needsAuthentication: false,
    loadAttempt: 0, snapshotVersion: 0, pageAlive: true, error: "", reducedMotion: shouldReduceMotion(),
    sessionMounted: false, sessionOpen: false, sessionVisible: false, sessionClosing: false, sessionRecordable: false, sessionLabel: "DAILY CARE", sessionSubmitLabel: "完成本次护理", sessionStage: "steps" as "steps" | "assessment", sessionStepIndex: 0, sessionStep: careProtocolSteps[0] as CareProtocolStepView,
    sessionSteps: sessionRail(0, 0), sessionProgressStyle: progressStyle(0), sessionProgressLabel: "0 / 4", sessionCompletedCodes: [] as string[], sessionAssessment: "" as CareSelfAssessmentValue | "", assessments: careSelfAssessments
  },
  onLoad(query: Record<string, string | undefined>) { this.data.pageAlive = true; void registerIncomingShare(query.share_id, "invite", "home"); },
  onResize() { this.setData({ chromeStyle: currentChromeStyle(), reducedMotion: shouldReduceMotion() }); },
  onShow() {
    this.setData({ accountOpening: false });
    const tab = this.getTabBar?.(); if (tab) tab.setData({ active: 0 }); tab?.syncActive?.(0);
    tab?.setPresentation?.("care-sheet", this.data.sessionMounted);
    const identity = memberIdentity();
    if (identity) this.setData({ view: homeView(this.data.care, identity.display_name, this.data.selectedProtocolIndex, new Date(), this.data.sessionCompletedCodes) });
    this.startDaypartClock();
    void this.load(retainMemberSnapshot(this));
  },
  onHide() {
    this.data.loadAttempt += 1;
    this.stopDaypartClock();
    this.getTabBar?.()?.setPresentation?.("care-sheet", false);
    if (this.data.sessionClosing) this.finishCareSessionClose();
  },
  onUnload() { this.data.pageAlive = false;
    this.data.loadAttempt += 1;
    this.stopDaypartClock();
    this.clearCareSessionCloseTimer();
    wx.disableAlertBeforeUnload();
  },
  startDaypartClock() {
    this.stopDaypartClock();
    daypartTimer = setInterval(() => this.refreshDaypart(), 60_000);
  },
  stopDaypartClock() { if (daypartTimer) clearInterval(daypartTimer); daypartTimer = null; },
  refreshDaypart() {
    if (!this.data.pageAlive || this.data.loading) return;
    const identity = memberIdentity();
    this.setData({ view: this.data.needsAuthentication ? visitorView() : homeView(this.data.care, identity?.display_name || "CISME 会员", this.data.selectedProtocolIndex, new Date(), this.data.sessionCompletedCodes) });
  },
  async load(preserveSnapshot = false): Promise<boolean> {
    const attempt = this.data.loadAttempt + 1;
    this.setData(preserveSnapshot && this.data.authorityAvailable
      ? { loadAttempt: attempt, loading: true, error: "" }
      : { loadAttempt: attempt, care: null, supportUnread: 0, view: homeView(null, memberIdentity()?.display_name, this.data.selectedProtocolIndex), loading: true, authorityAvailable: false, needsAuthentication: false, error: "" });
    if (!getApp<IAppOption>().globalData.sessionToken) {
      this.setData({ care: null, supportUnread: 0, view: visitorView(), loading: false, authorityAvailable: false, needsAuthentication: true, error: "" });
      return false;
    }
    try {
      const [snapshot,support] = await Promise.all([
        request<{ member: MemberView; care: CareView | null; businessVersion: number }>({ path: "/v1/bootstrap/home", cacheTags: ["member", "care"] }),
        request<{unreadCount:number}>({path:"/v1/me/support/summary",cacheTags:["support"]}).catch(()=>({unreadCount:0}))
      ]);
      const { member, care } = snapshot;
      if (!this.data.pageAlive || this.data.loadAttempt !== attempt) return false;
      if (snapshot.businessVersion < this.data.snapshotVersion) return true;
      const known = memberIdentity();
      const displayName = known && known.id === member.id && known.profile_revision > (member.profile_revision || 0) ? known.display_name : member.display_name;
      this.setData({ care, supportUnread:Math.max(0,Number(support.unreadCount)||0), snapshotVersion: snapshot.businessVersion, view: homeView(care, displayName || "CISME 会员", this.data.selectedProtocolIndex, new Date(), this.data.sessionCompletedCodes), authorityAvailable: true, needsAuthentication: false });
      return true;
    } catch {
      if (this.data.pageAlive && this.data.loadAttempt === attempt) this.setData({ care: null, supportUnread: 0, view: homeView(null), authorityAvailable: false, needsAuthentication: false, error: "护理状态暂时无法同步，请检查网络后重试。页面不会用旧状态开放护理操作。" });
      return false;
    } finally { if (this.data.pageAlive && this.data.loadAttempt === attempt) this.setData({ loading: false }); }
  },
  openAccount() {
    if (this.data.accountOpening) return;
    this.setData({ accountOpening: true });
    wx.navigateTo({ url: "/pages/account/index", fail: () => { this.setData({ accountOpening: false }); wx.showToast({ title: "会员账号暂时无法打开，请重试", icon: "none" }); } });
  },
  openSupport(){
    if(this.data.accountOpening)return;
    if(!requireMemberAccess("/pages/support/index"))return;
    this.setData({accountOpening:true});
    wx.navigateTo({url:"/pages/support/index",fail:()=>{this.setData({accountOpening:false});wx.showToast({title:"客服暂时无法打开，请重试",icon:"none"});}});
  },
  retryLoad() { void this.load(); },
  selectProtocolStep(event: WechatMiniprogram.TouchEvent) {
    if (this.data.sessionOpen) return;
    const index = boundedStepIndex(Number(event.currentTarget.dataset.index));
    this.setData({ selectedProtocolIndex: index, view: homeView(this.data.care, memberIdentity()?.display_name || "CISME 会员", index, new Date(), this.data.sessionCompletedCodes) });
  },
  async primaryAction() {
    if (this.data.needsAuthentication) { this.openAccount(); return; }
    if (this.data.loading || !this.data.authorityAvailable) { wx.showToast({ title: "护理状态尚未确认，请重试", icon: "none" }); return; }
    const care = this.data.care;
    if (!care) { this.openCareSession(); return; }
    if (care.phase === "planned") { await this.confirmCycleStart(); return; }
    if (care.phase === "active" && care.due) { this.openCareSession(); return; }
    wx.switchTab({ url: "/pages/records/index", fail: () => wx.showToast({ title: "护理记录页暂时无法打开", icon: "none" }) });
  },
  async confirmCycleStart() {
    const care = this.data.care;
    if (!care || this.data.activationConfirming || this.data.working) return;
    this.setData({ activationConfirming: true });
    try {
      const result = await wx.showModal({ title: "从今天开始护理周期？", content: "确认后，今天将记为开始日并开放 D1。护理记录只在你完成四个步骤后保存。", confirmText: "确认开始" });
      if (!this.data.pageAlive || !result.confirm) return;
      if (!this.data.care || this.data.care.id !== care.id || this.data.care.version !== care.version) { this.setData({ error: "护理周期状态已变化，请刷新后重新确认。" }); return; }
      await this.act(`/v1/care-cycles/${care.id}/activate`, `care-activate-${care.id}-v${care.version}`, { expectedVersion: care.version });
    } catch {
      if (this.data.pageAlive) this.setData({ error: "开始确认窗口暂时无法打开，请重试。" });
    } finally { if (this.data.pageAlive) this.setData({ activationConfirming: false }); }
  },
  openCareSession() {
    const care = this.data.care;
    const recordable = Boolean(care && care.phase === "active" && care.due);
    if (this.data.working || this.data.sessionMounted || (care && !recordable)) return;
    this.clearCareSessionCloseTimer();
    wx.enableAlertBeforeUnload({ message: "本次四步护理尚未保存，离开后需要重新确认未提交的步骤。" });
    this.getTabBar?.()?.setPresentation?.("care-sheet", true);
    this.setData({ sessionMounted: true, sessionOpen: true, sessionVisible: this.data.reducedMotion, sessionClosing: false, sessionRecordable: recordable, sessionLabel: recordable ? `${care!.due} CARE` : "DAILY CARE", sessionSubmitLabel: recordable ? `点亮 ${care!.due} 护理记录` : "完成本次护理", sessionStage: "steps", sessionStepIndex: 0, sessionStep: careProtocolSteps[0], sessionSteps: sessionRail(0, 0), sessionProgressStyle: progressStyle(0), sessionProgressLabel: "0 / 4", sessionCompletedCodes: [], sessionAssessment: "", selectedProtocolIndex: 0, view: homeView(care, memberIdentity()?.display_name || "CISME 会员", 0), error: "" }, () => {
      if (this.data.reducedMotion) return;
      wx.nextTick(() => {
        if (this.data.sessionMounted && !this.data.sessionClosing) this.setData({ sessionVisible: true });
      });
    });
  },
  stopPropagation() {},
  async closeCareSession() {
    if (this.data.working || this.data.sessionClosing) return;
    if (this.data.sessionCompletedCodes.length > 0) {
      try {
        const result = await wx.showModal({ title: "退出本次护理？", content: "尚未提交的步骤只保存在当前页面，退出后需要重新开始。", confirmText: "确认退出" });
        if (!result.confirm) return;
      } catch { this.setData({ error: "退出确认窗口暂时无法打开，请继续护理或稍后再试。" }); return; }
    }
    this.resetCareSession();
  },
  clearCareSessionCloseTimer() {
    if (careSessionCloseTimer) clearTimeout(careSessionCloseTimer);
    careSessionCloseTimer = null;
  },
  resetCareSession() {
    if (!this.data.sessionMounted || this.data.sessionClosing) return;
    wx.disableAlertBeforeUnload();
    this.clearCareSessionCloseTimer();
    this.getTabBar?.()?.setPresentation?.("care-sheet", false);
    this.setData({ sessionOpen: false, sessionVisible: false, sessionClosing: true });
    if (this.data.reducedMotion) { this.finishCareSessionClose(); return; }
    careSessionCloseTimer = setTimeout(() => this.finishCareSessionClose(), careSessionExitMs);
  },
  finishCareSessionClose() {
    this.clearCareSessionCloseTimer();
    this.setData({ sessionMounted: false, sessionOpen: false, sessionVisible: false, sessionClosing: false, sessionRecordable: false, sessionLabel: "DAILY CARE", sessionSubmitLabel: "完成本次护理", sessionStage: "steps", sessionStepIndex: 0, sessionStep: careProtocolSteps[0], sessionSteps: sessionRail(0, 0), sessionProgressStyle: progressStyle(0), sessionProgressLabel: "0 / 4", sessionCompletedCodes: [], sessionAssessment: "" });
  },
  advanceCareStep() {
    if (!this.data.sessionOpen || this.data.sessionStage !== "steps" || this.data.working) return;
    const index = this.data.sessionStepIndex;
    const completedCodes = careProtocolSteps.slice(0, index + 1).map((step) => step.code);
    const completedCode = careProtocolSteps[index]!.code;
    lightHaptic(this.data.reducedMotion);
    if (index === careProtocolSteps.length - 1) {
      this.setData({ sessionCompletedCodes: completedCodes, sessionSteps: sessionRail(index, completedCodes.length, true, completedCode), sessionProgressStyle: progressStyle(completedCodes.length), sessionProgressLabel: "4 / 4", sessionStage: "assessment", view: homeView(this.data.care, memberIdentity()?.display_name || "CISME 会员", index, new Date(), completedCodes, completedCode) });
      return;
    }
    const nextIndex = index + 1;
    this.setData({ sessionCompletedCodes: completedCodes, sessionStepIndex: nextIndex, sessionStep: careProtocolSteps[nextIndex], sessionSteps: sessionRail(nextIndex, completedCodes.length, false, completedCode), sessionProgressStyle: progressStyle(completedCodes.length), sessionProgressLabel: `${completedCodes.length} / 4`, selectedProtocolIndex: nextIndex, view: homeView(this.data.care, memberIdentity()?.display_name || "CISME 会员", nextIndex, new Date(), completedCodes, completedCode) });
  },
  selectAssessment(event: WechatMiniprogram.TouchEvent) {
    const value = String(event.currentTarget.dataset.value) as CareSelfAssessmentValue;
    if (!careSelfAssessments.some((item) => item.value === value)) return;
    lightHaptic(this.data.reducedMotion);
    this.setData({ sessionAssessment: value });
  },
  async submitCareSession() {
    const care = this.data.care;
    if (this.data.sessionCompletedCodes.length !== careProtocolSteps.length || !this.data.sessionAssessment || this.data.working) return;
    if (!this.data.sessionRecordable) {
      this.resetCareSession();
      lightHaptic(this.data.reducedMotion);
      wx.showToast({ title: "本次护理已完成", icon: "success" });
      return;
    }
    if (!care || !care.due) return;
    const completed = await this.act<CareCompletionResponse>(`/v1/care-cycles/${care.id}/milestones/${care.due}/complete`, `care-milestone-${care.id}-${care.due}-v${care.version}`, { expectedVersion: care.version, stepCodes: this.data.sessionCompletedCodes, selfAssessment: this.data.sessionAssessment });
    if (!completed || !this.data.pageAlive) return;
    this.resetCareSession();
    lightHaptic(this.data.reducedMotion);
    if (!completed.task?.id) {
      wx.showToast({ title: `${care.due} 护理记录已点亮`, icon: "success" });
      return;
    }
    const rewardCopy = completed.task.reward_enabled && typeof completed.task.reward_points === "number" && Number.isFinite(completed.task.reward_points)
      ? `通过审核后可获得 ${completed.task.reward_points} 积分。`
      : "是否参与完全由你决定。";
    try {
      const decision = await wx.showModal({ title: "护理记录已点亮", content: `你已解锁一项自愿分享邀请。${rewardCopy}`, confirmText: "查看邀请", cancelText: "稍后再说" });
      if (this.data.pageAlive && decision.confirm) wx.navigateTo({ url: `/pages/task/index?id=${completed.task.id}`, fail: () => wx.showToast({ title: "邀请暂时无法打开", icon: "none" }) });
    } catch { wx.showToast({ title: `${care.due} 护理记录已点亮`, icon: "success" }); }
  },
  async act<T = Record<string, unknown>>(path: string, idempotencyKey: string, data: WechatMiniprogram.IAnyObject): Promise<T | null> {
    if (this.data.working || !this.data.authorityAvailable) return null;
    this.setData({ working: true, error: "" });
    const tab = this.getTabBar?.(); if (tab) tab.setData({ externalBusy: true });
    wx.enableAlertBeforeUnload({ message: "护理操作已经发送，离开不会撤回服务端处理。请等待最新周期状态确认。" });
    try {
      const response = await request({ path, method: "POST", idempotencyKey, data }) as T;
      if (!this.data.pageAlive) return null;
      const refreshed = await this.load(true);
      if (this.data.pageAlive && !refreshed) this.setData({ error: "护理操作已受理，但最新周期暂时无法确认。页面已锁定护理动作，请刷新后核对。" });
      return refreshed ? response : null;
    } catch {
      if (!this.data.pageAlive) return null;
      const refreshed = await this.load(true);
      if (this.data.pageAlive) this.setData({ error: refreshed ? "护理操作未完成。已重新核对当前周期，请确认状态后再试。" : "护理操作结果与最新周期均暂时无法确认。页面已锁定护理动作，请刷新后核对。" });
      return null;
    } finally {
      if (this.data.pageAlive) this.setData({ working: false });
      const currentTab = this.getTabBar?.(); if (currentTab) currentTab.setData({ externalBusy: false });
      wx.disableAlertBeforeUnload();
    }
  }
});
