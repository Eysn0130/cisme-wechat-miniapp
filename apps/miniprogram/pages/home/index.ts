import { careCommandConfirmed, type CareCommand } from "../../services/care-command-state";
import { pageRead, cancelPageReads } from "../../services/page-requests";
import { measurementClock, recordClientMetric } from "../../services/performance-metrics";
import { memberIdentity } from "../../services/member-identity";
import { requireMemberAccess, retainMemberSnapshot, request } from "../../services/api";
import { currentChromeStyle, shouldReduceMotion } from "../../services/layout";
import { registerIncomingShare } from "../../services/share";
import { careDaypart, careGreeting, careProtocolSteps, careSelfAssessments, type CareProtocolStepView, type CareSelfAssessmentValue } from "../../services/care-protocol";
import { careHomeSchedule } from "../../services/care-home-state";
import { saveDailyCareRecord, dailyCarePath, readDailyCareRecords, dailyCareCommandConfirmed, isDailyCarePath, type DailyCareInput, type DailyCareRecord, type DailyCarePage } from "../../services/daily-care";
import { clientOperationKey } from "../../services/orders";
import { commerceContextRevision } from "../../services/commerce-command-store";

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
  const activeStep = careProtocolSteps[selected] ?? careProtocolSteps[0];
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
  if (!care) return { greeting, greetingClass, schedule: "日常护理", action: daypart.careAction, actionable: true, signalTitle: "从四步护理开始", signalMeta: "完成四步并记录感受，保存本次日常护理", signalIcon: "/assets/icons/clipboard-text-muted.svg", steps, ...protocol };
  if (phase === "planned") return { greeting, greetingClass, schedule: "待你确认开始", action: "确认开始护理周期", actionable: true, signalTitle: "开始日由你决定", signalMeta: "确认后，今天将作为 D1", signalIcon: "/assets/icons/clock-plum.svg", steps, ...protocol };
  if (phase === "paused") return { greeting, greetingClass, schedule: "护理周期已暂停", action: "查看周期管理", actionable: true, signalTitle: "已完成的护理仍可回看", signalMeta: "恢复周期后，可继续后续护理", signalIcon: "/assets/icons/clock-plum.svg", steps, ...protocol };
  if (phase === "terminated") return { greeting, greetingClass, schedule: "护理周期已终止", action: "查看护理记录", actionable: true, signalTitle: "已完成的护理可在记录中查看", signalMeta: "你仍可随时回看已完成记录", signalIcon: "/assets/icons/clipboard-text-muted.svg", steps, ...protocol };
  if (phase === "completed") return { greeting, greetingClass, schedule: "D28 · 周期完成", action: "查看护理记录", actionable: true, signalTitle: "已完成本周期四次护理", signalMeta: "时间、步骤与自我感受均已保存", signalIcon: "/assets/icons/star-active.svg", steps, ...protocol };
  const scheduleFact = careHomeSchedule(care, now);
  const milestone = care.due ?? care.next ?? "日常";
  const completedMilestoneCount = Math.max(care.records?.length ?? 0, care.completed?.length ?? 0);
  const nextRecordNumber = Math.min(4, completedMilestoneCount + 1);
  if (care.due) return {
    greeting, greetingClass, schedule: scheduleFact.state === "overdue" ? `${milestone} · 待补做` : `${milestone} · 今日护理`,
    action: daypart.careAction, actionable: true,
    signalTitle: scheduleFact.state === "overdue" ? `完成待做的 ${milestone} 护理` : `完成后保存第 ${nextRecordNumber} 次护理`,
    signalMeta: "四个步骤与护理后感受会一起保存", signalIcon: "/assets/icons/star-active.svg", steps, ...protocol
  };
  if (scheduleFact.completedToday) return {
    greeting, greetingClass, schedule: scheduleFact.schedule, action: "查看护理进度", actionable: true,
    signalTitle: "今天的护理已保存", signalMeta: care.next ? `下次护理：${care.next}` : "本周期的护理已全部完成",
    signalIcon: "/assets/icons/check-circle-plum.svg", steps, ...protocol
  };
  return {
    greeting, greetingClass, schedule: scheduleFact.schedule, action: "查看护理进度", actionable: true,
    signalTitle: "今天暂无护理安排", signalMeta: care.next ? `到 ${scheduleFact.nextDueOn ?? "计划日期"} 再完成 ${care.next}` : "等待下一周期安排",
    signalIcon: "/assets/icons/clock-plum.svg", steps, ...protocol
  };
}

const snapshotOwners = new WeakMap<object, string>();
type HomeCareCommand = CareCommand & { method?: "POST" | "PUT" };
const pendingCareCommands = new WeakMap<object, HomeCareCommand>();
const writeOwners = new WeakMap<object, object>();
const careSessionTargets = new WeakMap<object, { token: string; cycleId: string | null; version: number | null; due: string | null; dailyOperationKey?: string; careDay?: string; dailyRecord?: DailyCareRecord | null }>();

function visitorView(selectedIndex = 0) {
  return { ...homeView(null, "CISME 会员", selectedIndex), greeting: "欢迎来到 CISME", action: "授权身份并开始", signalTitle: "先了解四步护理", signalMeta: "登录后查看你的护理安排与记录" };
}

Page({
  data: {
    dailyReady: false, dailyLoading: false, dailyError: "", serverDay: "", dailyToday: null as DailyCareRecord | null, dailyAttempt: 0,
    chromeStyle: currentChromeStyle(), accountOpening: false, supportUnread: null as number | null, supportState: "unknown" as "unknown" | "loading" | "ready" | "error", care: null as CareView | null, view: homeView(null), selectedProtocolIndex: 0,
    loading: true, working: false, activationConfirming: false, authorityAvailable: false, needsAuthentication: false,
    loadAttempt: 0, snapshotVersion: 0, pageAlive: true, pageVisible: true, lifecycleEpoch: 0, mutationState: "idle" as "idle" | "sending" | "unknown" | "confirmed", error: "", reducedMotion: shouldReduceMotion(),
    sessionMounted: false, sessionOpen: false, sessionVisible: false, sessionClosing: false, sessionRecordable: false, sessionLabel: "DAILY CARE", sessionSubmitLabel: "完成本次护理", sessionStage: "steps" as "steps" | "assessment", sessionStepIndex: 0, sessionStep: careProtocolSteps[0] as CareProtocolStepView,
    sessionSteps: sessionRail(0, 0), sessionProgressStyle: progressStyle(0), sessionProgressLabel: "0 / 4", sessionCompletedCodes: [] as string[], sessionAssessment: "" as CareSelfAssessmentValue | "", assessments: careSelfAssessments
  },
  onLoad(query: Record<string, string | undefined>) { this.data.pageAlive = true; void registerIncomingShare(query.share_id, "invite", "home"); },
  onResize() { this.setData({ chromeStyle: currentChromeStyle(), reducedMotion: shouldReduceMotion() }); },
  syncDailyHomeView() {
    if (this.data.care || this.data.needsAuthentication || !this.data.authorityAvailable) return;
    const today = this.data.dailyToday;
    const projection = this.data.dailyLoading ? { action: "正在读取今日记录…", actionable: false, signalTitle: "正在读取日常护理记录", signalMeta: "" }
      : !this.data.dailyReady ? { action: "重新加载今日记录", actionable: true, signalTitle: "今日记录暂未确认", signalMeta: "请重新加载后开始护理" }
      : today ? { schedule: "今日已记录", action: "调整今日记录", actionable: true, signalTitle: "今天的护理已记录", signalMeta: `${careSelfAssessments.find(item => item.value === today.selfAssessment)!.label}，再次保存会更新今天的记录`, signalIcon: "/assets/icons/check-circle-plum.svg" }
      : { schedule: "日常护理", action: careDaypart(new Date(), "Asia/Shanghai").careAction, actionable: true, signalTitle: "今天还未记录", signalMeta: "完成四步并记录感受，保存今天的护理", signalIcon: "/assets/icons/clipboard-text-muted.svg" };
    this.setData({ view: { ...this.data.view, ...projection } });
  },
  async loadDailyCare(attempt?: number, token = getApp<IAppOption>().globalData.sessionToken): Promise<DailyCarePage | null> {
    const loadAttempt = attempt ?? this.data.loadAttempt;
    const revision = commerceContextRevision();
    const dailyAttempt = ++this.data.dailyAttempt;
    const current = () => this.isCurrentLoad(loadAttempt, token) && this.data.dailyAttempt === dailyAttempt && commerceContextRevision() === revision;
    this.setData({ dailyLoading: true, dailyError: "" }); this.syncDailyHomeView();
    try {
      const result = await readDailyCareRecords(this);
      if (!current()) return null;
      this.setData({ dailyReady: true, dailyLoading: false, serverDay: result.serverDay, dailyToday: result.today }); this.syncDailyHomeView();
      return result;
    } catch {
      if (current()) { this.setData({ dailyReady: false, dailyLoading: false, dailyError: "日常护理记录暂未加载，请重试。" }); this.syncDailyHomeView(); }
      return null;
    }
  },
  onShow() {
    const pending = pendingCareCommands.get(this);
    this.setData({ pageVisible: true, accountOpening: false, working: false, activationConfirming: false,
      mutationState: pending?.token === getApp<IAppOption>().globalData.sessionToken ? "unknown" : "idle" });
    const tab = this.getTabBar?.(); if (tab) tab.setData({ active: 0 }); tab?.syncActive?.(0);
    tab?.setPresentation?.("care-sheet", this.data.sessionMounted);
    const identity = memberIdentity();
    if (identity) this.setData({ view: homeView(this.data.care, identity.display_name, this.data.selectedProtocolIndex, new Date(), this.data.sessionCompletedCodes) });
    this.syncDailyHomeView();
    this.startDaypartClock();
    void this.load(retainMemberSnapshot(this));
  },
  onHide() {
    cancelPageReads(this);
    this.data.pageVisible = false; this.data.lifecycleEpoch++;
    writeOwners.delete(this);
    this.data.loadAttempt += 1;
    this.stopDaypartClock();
    this.getTabBar?.()?.setPresentation?.("care-sheet", false);
    if (this.data.sessionClosing) this.finishCareSessionClose();
  },
  onUnload() { cancelPageReads(this); this.data.pageAlive = false; this.data.pageVisible = false; this.data.lifecycleEpoch++; writeOwners.delete(this);
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
    this.setData({ view: this.data.needsAuthentication ? visitorView(this.data.selectedProtocolIndex) : homeView(this.data.care, identity?.display_name || "CISME 会员", this.data.selectedProtocolIndex, new Date(), this.data.sessionCompletedCodes) });
    this.syncDailyHomeView();
  },
  isCurrentUi(epoch: number, token: string): boolean {
    return this.data.pageAlive && this.data.pageVisible && this.data.lifecycleEpoch === epoch && getApp<IAppOption>().globalData.sessionToken === token;
  },
  isCurrentLoad(attempt: number, token: string): boolean {
    return this.data.pageAlive && this.data.loadAttempt === attempt && getApp<IAppOption>().globalData.sessionToken === token;
  },
  restoreGuestIfExpired(attempt: number) {
    if (!this.data.pageAlive || this.data.loadAttempt !== attempt || getApp<IAppOption>().globalData.sessionToken) return;
    this.setData({ care: null, snapshotVersion: 0, supportUnread: null, supportState: "unknown", view: visitorView(this.data.selectedProtocolIndex), loading: false, authorityAvailable: false, needsAuthentication: true, error: "" });
  },
  async loadSupport(attempt: number, token: string) {
    this.setData({ supportUnread: null, supportState: "loading" });
    try {
      const support = await pageRead<{ unreadCount: number }>(this, { path: "/v1/me/support/summary", authMode: "optional", cacheTags: ["support"] });
      if (!Number.isSafeInteger(support.unreadCount) || support.unreadCount < 0) throw new Error("INVALID_UNREAD_COUNT");
      if (this.isCurrentLoad(attempt, token)) this.setData({ supportUnread: support.unreadCount, supportState: "ready" });
      else this.restoreGuestIfExpired(attempt);
    } catch {
      if (this.isCurrentLoad(attempt, token)) this.setData({ supportUnread: null, supportState: "error" });
      else this.restoreGuestIfExpired(attempt);
    }
  },
  async load(preserveSnapshot = false): Promise<boolean> {
    cancelPageReads(this);
    const loadStarted = measurementClock();
    const attempt = this.data.loadAttempt + 1;
    const token = getApp<IAppOption>().globalData.sessionToken;
    const sameSession = snapshotOwners.get(this) === token;
    snapshotOwners.set(this, token);
    if (!sameSession) {
      this.data.lifecycleEpoch++;
      writeOwners.delete(this); pendingCareCommands.delete(this); careSessionTargets.delete(this);
      this.setData({ working: false, activationConfirming: false, mutationState: "idle" });
      wx.disableAlertBeforeUnload();
      this.getTabBar?.()?.setPresentation?.("care-sheet", false);
      this.finishCareSessionClose();
      this.setData({ snapshotVersion: 0, dailyReady: false, dailyLoading: false, dailyError: "", serverDay: "", dailyToday: null });
    }
    this.setData(preserveSnapshot && sameSession && this.data.authorityAvailable
      ? { loadAttempt: attempt, loading: true, error: "" }
      : { loadAttempt: attempt, care: null, supportUnread: null, supportState: "unknown", view: token ? homeView(null, memberIdentity()?.display_name, this.data.selectedProtocolIndex) : visitorView(this.data.selectedProtocolIndex), loading: true, authorityAvailable: false, needsAuthentication: !token, error: "" });
    if (!token) { this.restoreGuestIfExpired(attempt); return false; }
    // Unread is independent: it must neither hold the care snapshot nor invent zero.
    void this.loadSupport(attempt, token);
    const dailyRead = this.loadDailyCare(attempt, token);
    try {
      const snapshot = await pageRead<{ member: MemberView; care: CareView | null; businessVersion: number }>(this, { path: "/v1/bootstrap/home", authMode: "optional", cacheTags: ["member", "care"] });
      if (!this.isCurrentLoad(attempt, token)) { this.restoreGuestIfExpired(attempt); return false; }
      if (!Number.isSafeInteger(snapshot.businessVersion) || snapshot.businessVersion < 0 || !snapshot.member?.id
        || (snapshot.care && (!snapshot.care.id || !Number.isSafeInteger(snapshot.care.version)))) throw new Error("INVALID_CARE_SNAPSHOT");
      if (snapshot.care && snapshot.care.id === this.data.care?.id && snapshot.businessVersion < this.data.snapshotVersion) return this.data.authorityAvailable;
      const processingStarted = measurementClock();
      const { member, care } = snapshot;
      const known = memberIdentity();
      const displayName = known && known.id === member.id && known.profile_revision > (member.profile_revision || 0) ? known.display_name : member.display_name;
      const core = { care, snapshotVersion: snapshot.businessVersion, view: homeView(care, displayName || "CISME 会员", this.data.selectedProtocolIndex, new Date(), this.data.sessionCompletedCodes), authorityAvailable: true, needsAuthentication: false, loading: false };
      recordClientMetric({ action: "home", stage: "data_processing", durationMs: measurementClock() - processingStarted });
      const bridgeStarted = measurementClock();
      this.setData(core, () => {
        if (this.isCurrentLoad(attempt, token)) {
          recordClientMetric({ action: "home", stage: "set_data", durationMs: measurementClock() - bridgeStarted });
          recordClientMetric({ action: "home", stage: "critical_ready", durationMs: measurementClock() - loadStarted });
        }
      });
      this.syncDailyHomeView();
      const pending = pendingCareCommands.get(this);
      let dailyPage: DailyCarePage | null = null;
      if (pending?.token === token && isDailyCarePath(pending.path)) {
        dailyPage = await dailyRead;
        if (!this.isCurrentLoad(attempt, token)) { this.restoreGuestIfExpired(attempt); return false; }
      }
      if (pending?.token === token && (isDailyCarePath(pending.path)
        ? dailyCareCommandConfirmed(pending.key, pending.data as DailyCareInput, dailyPage ? [...dailyPage.items, ...(dailyPage.today ? [dailyPage.today] : [])] : [], pending.path === dailyCarePath ? undefined : pending.path.slice(dailyCarePath.length + 1))
        : careCommandConfirmed(pending, care))) {
        pendingCareCommands.delete(this);
        this.setData({ mutationState: "confirmed", error: pending.path.endsWith("/activate") ? "护理周期已开始，请按今日安排进行护理。" : "护理已保存，可到记录中查看。" });
        if (!this.data.working) this.resetCareSession();
      }
      return true;
    } catch {
      if (this.isCurrentLoad(attempt, token)) this.setData({ care: null, view: homeView(null), authorityAvailable: false, needsAuthentication: false, error: "护理状态暂时无法加载，请检查网络后重试。" });
      else this.restoreGuestIfExpired(attempt);
      return false;
    } finally { if (this.isCurrentLoad(attempt, token)) this.setData({ loading: false }); }
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
    this.setData({ selectedProtocolIndex: index, view: this.data.needsAuthentication ? visitorView(index) : homeView(this.data.care, memberIdentity()?.display_name || "CISME 会员", index, new Date(), this.data.sessionCompletedCodes) });
    this.syncDailyHomeView();
  },
  async primaryAction() {
    if (!this.data.pageAlive || !this.data.pageVisible) return;
    if (this.data.needsAuthentication) { this.openAccount(); return; }
    if (this.data.mutationState === "unknown") { void this.retryCareMutation(); return; }
    if (this.data.loading || !this.data.authorityAvailable) { wx.showToast({ title: "护理状态尚未确认，请重试", icon: "none" }); return; }
    const care = this.data.care;
    if (!care) { if (this.data.dailyLoading || !this.data.dailyReady && !(await this.loadDailyCare())) return; this.openCareSession(); return; }
    if (care.phase === "planned") { await this.confirmCycleStart(); return; }
    if (care.phase === "active" && care.due) { this.openCareSession(); return; }
    wx.switchTab({ url: "/pages/records/index", fail: () => wx.showToast({ title: "护理记录页暂时无法打开", icon: "none" }) });
  },
  async confirmCycleStart() {
    const care = this.data.care;
    if (!care || this.data.activationConfirming || this.data.working) return;
    const epoch = this.data.lifecycleEpoch, token = getApp<IAppOption>().globalData.sessionToken;
    this.setData({ activationConfirming: true });
    try {
      const result = await wx.showModal({ title: "从今天开始护理周期？", content: "今天将作为 D1。完成四步护理并记录感受后，即可保存本次记录。", confirmText: "确认开始" });
      if (!this.isCurrentUi(epoch, token) || !result.confirm) return;
      if (!this.data.care || this.data.care.id !== care.id || this.data.care.version !== care.version) { this.setData({ error: "护理周期状态已变化，请刷新后重新确认。" }); return; }
      await this.act(`/v1/care-cycles/${care.id}/activate`, `care-activate-${care.id}-v${care.version}`, { expectedVersion: care.version });
    } catch {
      if (this.isCurrentUi(epoch, token)) this.setData({ error: "开始确认窗口暂时无法打开，请重试。" });
    } finally { if (this.isCurrentUi(epoch, token)) this.setData({ activationConfirming: false }); }
  },
  openCareSession() {
    if (!this.data.pageAlive || !this.data.pageVisible) return;
    const care = this.data.care;
    const recordable = Boolean(care && care.phase === "active" && care.due);
    if (this.data.working || this.data.mutationState === "unknown" || this.data.sessionMounted || (care && !recordable)) return;
    if (!care && (!this.data.dailyReady || this.data.dailyLoading || !this.data.serverDay)) return;
    careSessionTargets.set(this, { token: getApp<IAppOption>().globalData.sessionToken, cycleId: care?.id ?? null, version: care?.version ?? null, due: care?.due ?? null, ...(!care ? { dailyOperationKey: clientOperationKey("daily-care"), careDay: this.data.serverDay, dailyRecord: this.data.dailyToday } : {}) });
    this.clearCareSessionCloseTimer();
    wx.enableAlertBeforeUnload({ message: "本次护理尚未保存，离开后需要重新开始。" });
    this.getTabBar?.()?.setPresentation?.("care-sheet", true);
    this.setData({ sessionMounted: true, sessionOpen: true, sessionVisible: this.data.reducedMotion, sessionClosing: false, sessionRecordable: true, sessionLabel: recordable ? `${care!.due} CARE` : "DAILY CARE", sessionSubmitLabel: recordable ? `点亮 ${care!.due} 护理记录` : this.data.dailyToday ? "更新今日记录" : "保存今日记录", sessionStage: "steps", sessionStepIndex: 0, sessionStep: careProtocolSteps[0], sessionSteps: sessionRail(0, 0), sessionProgressStyle: progressStyle(0), sessionProgressLabel: "0 / 4", sessionCompletedCodes: [], sessionAssessment: "", selectedProtocolIndex: 0, view: homeView(care, memberIdentity()?.display_name || "CISME 会员", 0), error: "" }, () => {
      if (this.data.reducedMotion) return;
      wx.nextTick(() => {
        if (this.data.sessionMounted && !this.data.sessionClosing) this.setData({ sessionVisible: true });
      });
    });
  },
  stopPropagation() {},
  async closeCareSession() {
    if (this.data.working || this.data.sessionClosing) return;
    const epoch = this.data.lifecycleEpoch, token = getApp<IAppOption>().globalData.sessionToken, target = careSessionTargets.get(this);
    if (this.data.sessionCompletedCodes.length > 0) {
      try {
        const result = await wx.showModal({ title: "退出本次护理？", content: this.data.mutationState === "unknown" ? "保存结果尚未确认。退出后，请先查看护理记录，再决定是否重试。" : "本次护理尚未保存，退出后需要重新开始。", confirmText: "确认退出" });
        if (!this.isCurrentUi(epoch, token) || careSessionTargets.get(this) !== target || !result.confirm) return;
      } catch { if (this.isCurrentUi(epoch, token)) this.setData({ error: "退出确认窗口暂时无法打开，请继续护理或稍后再试。" }); return; }
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
    careSessionTargets.delete(this);
    this.clearCareSessionCloseTimer();
    this.setData({ sessionMounted: false, sessionOpen: false, sessionVisible: false, sessionClosing: false, sessionRecordable: false, sessionLabel: "DAILY CARE", sessionSubmitLabel: "完成本次护理", sessionStage: "steps", sessionStepIndex: 0, sessionStep: careProtocolSteps[0], sessionSteps: sessionRail(0, 0), sessionProgressStyle: progressStyle(0), sessionProgressLabel: "0 / 4", sessionCompletedCodes: [], sessionAssessment: "", view: this.data.needsAuthentication ? visitorView(this.data.selectedProtocolIndex) : homeView(this.data.care, memberIdentity()?.display_name || "CISME 会员", this.data.selectedProtocolIndex) });
    this.syncDailyHomeView();
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
    this.setData({ sessionCompletedCodes: completedCodes, sessionStepIndex: nextIndex, sessionStep: careProtocolSteps[nextIndex] ?? careProtocolSteps[0], sessionSteps: sessionRail(nextIndex, completedCodes.length, false, completedCode), sessionProgressStyle: progressStyle(completedCodes.length), sessionProgressLabel: `${completedCodes.length} / 4`, selectedProtocolIndex: nextIndex, view: homeView(this.data.care, memberIdentity()?.display_name || "CISME 会员", nextIndex, new Date(), completedCodes, completedCode) });
  },
  selectAssessment(event: WechatMiniprogram.TouchEvent) {
    if (this.data.working || this.data.mutationState === "unknown") return;
    const value = String(event.currentTarget.dataset.value) as CareSelfAssessmentValue;
    if (!careSelfAssessments.some((item) => item.value === value)) return;
    lightHaptic(this.data.reducedMotion);
    this.setData({ sessionAssessment: value });
  },
  async submitCareSession() {
    const care = this.data.care;
    if (this.data.sessionCompletedCodes.length !== careProtocolSteps.length || !this.data.sessionAssessment || this.data.working || this.data.mutationState === "unknown") return;
    const target = careSessionTargets.get(this), token = getApp<IAppOption>().globalData.sessionToken, epoch = this.data.lifecycleEpoch;
    if (!target || target.token !== token || target.cycleId !== (care?.id ?? null) || target.version !== (care?.version ?? null) || target.due !== (care?.due ?? null)) {
      this.setData({ error: "护理安排已有更新。请先退出本次步骤，查看最新安排后再开始。" }); return;
    }
    if (!care && target.dailyOperationKey) {
      const completed = await this.act(dailyCarePath + (target.dailyRecord ? "/" + target.dailyRecord.id : ""), target.dailyOperationKey, { careDay: target.careDay, stepCodes: this.data.sessionCompletedCodes, selfAssessment: this.data.sessionAssessment, ...(target.dailyRecord ? { expectedVersion: target.dailyRecord.version } : {}) }, false, target.dailyRecord ? "PUT" : "POST");
      if (!completed || !this.isCurrentUi(epoch, token)) return;
      this.resetCareSession();
      lightHaptic(this.data.reducedMotion);
      wx.showToast({ title: "护理已保存", icon: "success" });
      return;
    }
    if (!care || !care.due) return;
    const completed = await this.act<CareCompletionResponse>(`/v1/care-cycles/${care.id}/milestones/${care.due}/complete`, `care-milestone-${care.id}-${care.due}-v${care.version}`, { expectedVersion: care.version, stepCodes: this.data.sessionCompletedCodes, selfAssessment: this.data.sessionAssessment });
    if (!completed || !this.isCurrentUi(epoch, token)) return;
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
      if (this.isCurrentUi(epoch, token) && decision.confirm) wx.navigateTo({ url: `/pages/task/index?id=${completed.task.id}`, fail: () => wx.showToast({ title: "邀请暂时无法打开", icon: "none" }) });
    } catch { if (this.isCurrentUi(epoch, token)) wx.showToast({ title: `${care.due} 护理记录已点亮`, icon: "success" }); }
  },
  async retryCareMutation() {
    const pending = pendingCareCommands.get(this);
    if (!pending || pending.token !== getApp<IAppOption>().globalData.sessionToken || this.data.working) return;
    const epoch = this.data.lifecycleEpoch, token = pending.token;
    const refreshed = await this.load(true);
    if (!this.isCurrentUi(epoch, token) || (!refreshed && !isDailyCarePath(pending.path)) || pendingCareCommands.get(this) !== pending) return;
    // Explicit user action replays exactly the original key and payload. It
    // never invents a new write intent after a lost response.
    const result = await this.act(pending.path, pending.key, pending.data, true, pending.method);
    if (result && this.isCurrentUi(epoch, token)) {
      this.resetCareSession();
      wx.showToast({ title: pending.path.endsWith("/activate") ? "护理周期已开始" : "本次护理已保存", icon: "success" });
    }
  },
  async act<T = Record<string, unknown>>(path: string, idempotencyKey: string, data: WechatMiniprogram.IAnyObject, replay = false, method: "POST" | "PUT" = "POST"): Promise<T | null> {
    const dailyReplay = replay && isDailyCarePath(path) && pendingCareCommands.get(this)?.key === idempotencyKey;
    if (this.data.working || (!this.data.authorityAvailable && !dailyReplay) || (this.data.mutationState === "unknown" && !replay)) return null;
    const epoch = this.data.lifecycleEpoch, token = getApp<IAppOption>().globalData.sessionToken;
    if (!token || !this.isCurrentUi(epoch, token)) return null;
    const owner = {}, command: HomeCareCommand = { path, key: idempotencyKey, method, data: { ...data, ...(Array.isArray(data.stepCodes) ? { stepCodes: [...data.stepCodes] } : {}) }, token };
    writeOwners.set(this, owner); pendingCareCommands.set(this, command);
    const current = () => writeOwners.get(this) === owner && this.isCurrentUi(epoch, token);
    this.setData({ working: true, mutationState: "sending", error: "" });
    wx.enableAlertBeforeUnload({ message: "正在提交。离开后，请先查看最新护理安排，再决定是否重试。" });
    try {
      const response = isDailyCarePath(path) ? await saveDailyCareRecord(command.data as DailyCareInput, idempotencyKey, method === "PUT" ? { id: path.slice(dailyCarePath.length + 1), version: data.expectedVersion } : undefined) as T : await request<T>({ path, method: "POST", idempotencyKey, data: command.data });
      if (!current()) return null;
      pendingCareCommands.delete(this);
      this.setData({ mutationState: "confirmed" });
      const refreshed = await this.load(true);
      if (!current()) return null;
      if (!refreshed) this.setData({ error: path.endsWith("/activate") ? "护理周期已开始，最新安排暂时无法加载，请稍后刷新。" : "护理已保存，最新进度暂时无法加载。请刷新或查看护理记录。" });
      return refreshed || isDailyCarePath(path) ? response : null;
    } catch (error) {
      if (!current()) return null;
      const status = (error as { status?: number } | null)?.status;
      const rejected = typeof status === "number" && status >= 400 && status < 500;
      if (rejected) pendingCareCommands.delete(this);
      this.setData({ mutationState: rejected ? "idle" : "unknown" });
      const refreshed = await this.load(true);
      if (!current()) return null;
      if (this.data.mutationState === "confirmed") {
        this.resetCareSession();
      } else this.setData({ error: rejected
        ? isDailyCarePath(path) ? (error as { code?: string }).code === "DAILY_CARE_DAY_CHANGED" ? "日期已更新，请退出本次步骤，重新查看今天的护理记录。" : "记录已有变化，请退出本次步骤，查看最新记录后再操作。" : "本次操作未完成，请查看最新护理安排后再试。"
        : refreshed ? "操作结果尚未确认，请先查看最新护理安排，暂勿再次提交。"
          : "操作结果尚未确认，最新护理安排也暂时无法加载。请恢复网络后核对，暂勿重复提交。" });
      return null;
    } finally {
      if (current()) { writeOwners.delete(this); this.setData({ working: false }); wx.disableAlertBeforeUnload(); }
    }
  }
});
