import { cancelPageReads, pageRead } from "../../services/page-requests";
import { commerceContextRevision } from "../../services/commerce-command-store";
import { requireMemberAccess, retainMemberSnapshot } from "../../services/api";
import { clearAuthenticationRedirectSuppression, request, resumeAuthentication } from "../../services/api";
import { currentChromeStyle, motionDuration, shouldReduceMotion } from "../../services/layout";
import { careProtocolSteps, careSelfAssessments, type CareSelfAssessmentValue } from "../../services/care-protocol";

function scrollToRecordsError() {
  wx.pageScrollTo({ selector: "#records-error-summary", duration: motionDuration(200) });
}

function isAuthenticationFailure(error: unknown): boolean {
  const problem = error as { status?: number; statusCode?: number; code?: string };
  return [401, 403, 404].includes(problem.status ?? problem.statusCode ?? 0) || problem.code === "AUTHENTICATION_REQUIRED" || problem.code === "MEMBER_NOT_FOUND";
}

function syncedAtLabel(): string {
  const value = new Date();
  return `${String(value.getHours()).padStart(2, "0")}:${String(value.getMinutes()).padStart(2, "0")} 已同步`;
}

const archivePageSize = 3;
const recordDetailExitMs = 240;
const careMilestones = ["D1", "D7", "D14", "D28"] as const;
const detailTimers = new WeakMap<object, ReturnType<typeof setTimeout>>();

const emptySummary = { completed: 0, totalRecords: 0, cycleCount: 0, recordCountClass: "", headlineLine1: "你的护理档案，", headlineLine2: "等待第一个周期。", phaseLabel: "尚无护理周期", protocol: "", cycleSummary: "" };

type CarePhase = "planned" | "active" | "paused" | "terminated" | "completed";

interface CareRecordApi {
  milestone: string;
  completedAt?: string;
  protocolVersion?: string;
  stepCodes?: string[];
  selfAssessment?: CareSelfAssessmentValue | null;
}

interface CareCycleApi {
  id: string;
  phase: CarePhase;
  startedOn?: string | null;
  timezone?: string;
  protocolVersion?: string;
  completed?: string[];
  due?: string | null;
  next?: string | null;
  scheduleOffsetDays?: number;
  pausePolicy?: { enabled?: boolean; maxDays?: number; version?: string | null };
  records?: CareRecordApi[];
  history?: CareCycleApi[];
  version?: number;
}

interface RecordView {
  recordKey: string;
  milestone: string;
  index: string;
  completedAt: string;
  completedDate: string;
  completedTime: string;
  assessmentLabel: string;
  assessmentNote: string;
  assessmentAvailable: boolean;
  assessmentIcon: string;
  steps: Array<{ code: string; label: string; title: string }>;
  stepSummary: string;
  hasDetails: boolean;
  cycleLabel: string;
  protocolVersion: string;
}

interface RecordGroupView {
  key: string;
  label: string;
  meta: string;
  phaseLabel: string;
  records: RecordView[];
  emptyCopy: string;
}

function addCalendarDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return `${String(value.getUTCMonth() + 1).padStart(2, "0")}/${String(value.getUTCDate()).padStart(2, "0")}`;
}

function phaseLabel(phase: CarePhase | undefined): string {
  return phase === "active" ? "护理进行中" : phase === "completed" ? "本周期已完成" : phase === "paused" ? "周期已暂停" : phase === "terminated" ? "周期已终止" : "待确认开始";
}

function headlineForPhase(phase: CarePhase | undefined): [string, string] {
  if (phase === "completed") return ["这个护理周期，", "已经完整保存。"];
  if (phase === "paused") return ["护理暂时停下，", "已完成的都在这里。"];
  if (phase === "terminated") return ["这个周期已经结束，", "记录仍为你保留。"];
  if (phase === "planned") return ["护理周期已就绪，", "等你确认开始。"];
  return ["你的头皮护理，", "正在成为一种习惯。"];
}

function zonedCompletion(completedAt: string | undefined, timezone: string): { short: string; date: string; time: string } {
  if (!completedAt) return { short: "未记录", date: "完成时间未记录", time: "时间未记录" };
  const value = new Date(completedAt);
  if (Number.isNaN(value.getTime())) return { short: "未记录", date: "完成时间未记录", time: "时间未记录" };
  try {
    const parts = new Intl.DateTimeFormat("zh-CN", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(value);
    const part = (type: string) => parts.find((item) => item.type === type)?.value ?? "";
    const year = part("year"); const month = part("month"); const day = part("day"); const hour = part("hour"); const minute = part("minute");
    if (year && month && day && hour && minute) return { short: `${month}/${day}`, date: `${year}年${Number(month)}月${Number(day)}日`, time: `${hour}:${minute}` };
  } catch { /* Older WeChat runtimes fall back to device-local formatting. */ }
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return { short: `${month}/${day}`, date: `${value.getFullYear()}年${value.getMonth() + 1}月${value.getDate()}日`, time: `${String(value.getHours()).padStart(2, "0")}:${String(value.getMinutes()).padStart(2, "0")}` };
}

function recordView(record: CareRecordApi, cycle: CareCycleApi, cycleLabel: string): RecordView {
  const completion = zonedCompletion(record.completedAt, cycle.timezone || "Asia/Shanghai");
  const assessment = careSelfAssessments.find((item) => item.value === record.selfAssessment);
  const stepCodes = Array.isArray(record.stepCodes) ? record.stepCodes : [];
  const steps = careProtocolSteps.filter((step) => stepCodes.includes(step.code)).map((step) => ({ code: step.code, label: step.label, title: step.title }));
  const stepSummary = steps.length === careProtocolSteps.length
    ? ""
    : steps.length === 0
      ? "这条历史记录保存了里程碑与完成时间，但当时尚未记录分步事实。"
      : `这条历史记录只保存了 ${steps.length} / 4 个步骤，未显示的步骤没有可核对事实。`;
  return {
    recordKey: `${cycle.id}:${record.milestone}`,
    milestone: record.milestone,
    index: record.milestone.replace("D", "").padStart(2, "0"),
    completedAt: completion.short,
    completedDate: completion.date,
    completedTime: completion.time,
    assessmentLabel: assessment?.label ?? "旧记录未包含护理后感受",
    assessmentNote: assessment?.note ?? "该记录生成于详细护理事实启用之前。",
    assessmentAvailable: Boolean(assessment),
    assessmentIcon: assessment ? "/assets/icons/check-circle-plum.svg" : "/assets/icons/clock-plum.svg",
    steps,
    stepSummary,
    hasDetails: steps.length === careProtocolSteps.length && Boolean(assessment),
    cycleLabel,
    protocolVersion: record.protocolVersion || cycle.protocolVersion || "版本未记录"
  };
}

function cycleStartedLabel(cycle: CareCycleApi): string {
  if (!cycle.startedOn) return "尚未开始";
  const [year, month, day] = cycle.startedOn.split("-");
  return year && month && day ? `${year}年${Number(month)}月${Number(day)}日开始` : "开始日期未记录";
}

function emptyRecordCopy(cycle: CareCycleApi, isCurrent: boolean): string {
  if (!isCurrent) return "本周期未留下里程碑记录";
  if (cycle.phase === "planned") return "确认开始周期后才会出现 D1";
  if (cycle.phase === "paused") return "已暂停，恢复后才会继续生成里程碑";
  if (cycle.phase === "terminated") return "本周期终止前没有保存里程碑记录";
  return "当前没有已完成的里程碑";
}

function recordGroups(care: CareCycleApi): { groups: RecordGroupView[]; records: RecordView[] } {
  const cycles = [care, ...(Array.isArray(care.history) ? care.history : [])].filter((cycle, index, all) => all.findIndex((item) => item.id === cycle.id) === index);
  const groups = cycles.map((cycle, index) => {
    const order = cycles.length - index;
    const label = index === 0 ? "当前周期" : `第 ${order} 个护理周期`;
    const records = (Array.isArray(cycle.records) ? cycle.records.slice() : [])
      .sort((left, right) => String(right.completedAt ?? "").localeCompare(String(left.completedAt ?? "")))
      .map((record) => recordView(record, cycle, label));
    return { key: cycle.id, label, meta: cycleStartedLabel(cycle), phaseLabel: phaseLabel(cycle.phase), records, emptyCopy: emptyRecordCopy(cycle, index === 0) };
  });
  return { groups, records: groups.flatMap((group) => group.records) };
}

function timelineStatus(care: CareCycleApi, milestone: string, done: boolean, current: boolean, startedOn: string | null | undefined): string {
  if (done) return "已完成";
  if (care.phase === "planned") return "待确认";
  if (care.phase === "paused") return milestone === care.next ? "暂停中" : "恢复后安排";
  if (care.phase === "terminated") return "已终止";
  if (current) return "今日";
  const milestoneOffsets: Record<string, number> = { D1: 0, D7: 6, D14: 13, D28: 27 };
  const offset = milestoneOffsets[milestone];
  return startedOn && offset !== undefined ? addCalendarDays(startedOn, offset + (care.scheduleOffsetDays ?? 0)) : "待安排";
}

function cycleSummary(care: CareCycleApi): string {
  if (care.phase === "planned") return "确认开始后生成 D1、D7、D14、D28";
  if (care.phase === "paused") return "已完成记录保留，恢复后重新安排未完成节点";
  if (care.phase === "terminated") return "周期已终止，历史护理记录仍可查看";
  if (care.phase === "completed") return "四个里程碑已完成并保存";
  return care.startedOn ? `${cycleStartedLabel(care)}，按护理日程自动更新` : "开始日期未记录";
}

function recordCountClass(total: number): string {
  if (total >= 1000) return "record-streak--dense";
  if (total >= 100) return "record-streak--compact";
  return "";
}

Page({
  lastSessionToken: undefined as string | undefined,
  lastSessionRevision: 0,
  data: {
    care: null as any,
    timeline: [] as Array<{ milestone: string; done: boolean; current: boolean; status: string }>,
    records: [] as RecordView[],
    recordGroups: [] as RecordGroupView[],
    visibleRecordGroups: [] as RecordGroupView[],
    visibleCycleCount: archivePageSize,
    hiddenCycleCount: 0,
    selectedRecord: null as RecordView | null,
    recordDetailOpen: false,
    recordDetailMounted: false,
    recordDetailVisible: false,
    recordDetailClosing: false,
    chromeStyle: currentChromeStyle(),
    reducedMotion: shouldReduceMotion(),
    summary: emptySummary,
    loading: true,
    refreshing: false,
    working: false,
    workingAction: "",
    confirmingCycleAction: false,
    authorityAvailable: false,
    accessRequired: false,
    lastSyncedLabel: "",
    loadAttempt: 0,
    pageAlive: true,
    visible: true,
    writeReady: false,
    refreshOnShow: false,
    operationStatus: "",
    error: ""
  },
  syncSession() {
    const token = getApp<IAppOption>().globalData.sessionToken, revision = commerceContextRevision();
    if (this.lastSessionToken !== undefined && (this.lastSessionToken !== token || this.lastSessionRevision !== revision)) {
      cancelPageReads(this); this.data.loadAttempt += 1; this.dismissRecordDetailImmediately();
      this.setData({ care: null, timeline: [], records: [], recordGroups: [], visibleRecordGroups: [],
        visibleCycleCount: archivePageSize, hiddenCycleCount: 0, summary: emptySummary, selectedRecord: null,
        working: false, workingAction: "", confirmingCycleAction: false, writeReady: false,
        authorityAvailable: false, accessRequired: !token, operationStatus: "", error: "", lastSyncedLabel: "" });
      this.getTabBar?.()?.setData({ externalBusy: false }); wx.disableAlertBeforeUnload();
    }
    this.lastSessionToken = token; this.lastSessionRevision = revision;
  },
  sameSession(token: string, revision: number) {
    return this.data.pageAlive && token === getApp<IAppOption>().globalData.sessionToken && revision === commerceContextRevision();
  },
  onLoad() { this.data.pageAlive = true; },
  onResize() { this.setData({ chromeStyle: currentChromeStyle(), reducedMotion: shouldReduceMotion() }); },
  onShow() {
    this.data.pageAlive = true; this.data.visible = true; this.syncSession();
    const tab = this.getTabBar?.();
    if (tab) tab.setData({ active: 1, externalBusy: this.data.working });
    tab?.syncActive?.(1);
    tab?.setPresentation?.("record-detail", false);
    if (!requireMemberAccess()) {
      this.dismissRecordDetailImmediately();
      this.setData({ care: null, timeline: [], records: [], recordGroups: [], visibleRecordGroups: [], visibleCycleCount: archivePageSize, hiddenCycleCount: 0, summary: emptySummary, selectedRecord: null, loading: false, refreshing: false, authorityAvailable: false, accessRequired: true, operationStatus: "", error: "" });
      return;
    }
    if (this.data.working) { this.data.refreshOnShow = true; return; }
    this.setData({ operationStatus: "" });
    void this.load(retainMemberSnapshot(this));
  },
  onHide() {
    this.data.visible = false; this.data.loadAttempt += 1; this.data.refreshOnShow = true;
    cancelPageReads(this); this.dismissRecordDetailImmediately();
    this.getTabBar?.()?.setData({ externalBusy: false });
    this.setData({ writeReady: false, confirmingCycleAction: false });
  },
  onUnload() { this.onHide(); this.data.pageAlive = false; wx.disableAlertBeforeUnload(); },
  async onPullDownRefresh() {
    try {
      if (!this.data.visible) return;
      this.syncSession();
      if (!requireMemberAccess()) {
        this.setData({ loading: false, refreshing: false, authorityAvailable: false, accessRequired: true, error: "" });
        return;
      }
      await this.load(retainMemberSnapshot(this));
    } finally { wx.stopPullDownRefresh(); }
  },
  async load(preserveSnapshot = false, failClosed = false): Promise<boolean> {
    this.syncSession();
    if (!this.data.pageAlive || !this.data.visible || this.data.working && !failClosed) { this.data.refreshOnShow = true; return false; }
    cancelPageReads(this); this.data.refreshOnShow = false;
    const token = getApp<IAppOption>().globalData.sessionToken, revision = commerceContextRevision();
    this.setData({ writeReady: false, confirmingCycleAction: false }); this.dismissRecordDetailImmediately();
    const attempt = this.data.loadAttempt + 1;
    this.setData(preserveSnapshot && this.data.authorityAvailable
      ? { loadAttempt: attempt, loading: true, refreshing: true, accessRequired: false, error: "" }
      : { loadAttempt: attempt, care: null, timeline: [], records: [], recordGroups: [], visibleRecordGroups: [], visibleCycleCount: archivePageSize, hiddenCycleCount: 0, summary: emptySummary, selectedRecord: null, recordDetailOpen: false, loading: true, refreshing: false, authorityAvailable: false, accessRequired: false, error: "" });
    try {
      const care = await pageRead<CareCycleApi | null>(this, { path: "/v1/me/care" });
      if (!this.sameSession(token, revision) || !this.data.visible || this.data.loadAttempt !== attempt) return false;
      const completed = care ? careMilestones.filter((milestone) => (care.completed ?? []).includes(milestone)) : [];
      const timeline = careMilestones.map((milestone) => ({
        milestone,
        done: completed.includes(milestone),
        current: care?.due === milestone,
        status: care ? timelineStatus(care, milestone, completed.includes(milestone), care.due === milestone, care.startedOn) : "待确认"
      }));
      const currentPhaseLabel = care ? phaseLabel(care.phase) : "尚无护理周期";
      const headline: [string, string] = care ? headlineForPhase(care.phase) : [emptySummary.headlineLine1, emptySummary.headlineLine2];
      const archive = care ? recordGroups(care) : { groups: [], records: [] };
      const cycleCount = care ? archive.groups.length : 0;
      const visibleCycleCount = Math.min(cycleCount, Math.max(archivePageSize, this.data.visibleCycleCount || archivePageSize));
      this.setData({ care, timeline, records: archive.records, recordGroups: archive.groups, visibleRecordGroups: archive.groups.slice(0, visibleCycleCount), visibleCycleCount, hiddenCycleCount: Math.max(0, cycleCount - visibleCycleCount), selectedRecord: null, recordDetailOpen: false, summary: { completed: completed.length, totalRecords: archive.records.length, cycleCount, recordCountClass: recordCountClass(archive.records.length), headlineLine1: headline[0], headlineLine2: headline[1], phaseLabel: currentPhaseLabel, protocol: care?.protocolVersion ?? "", cycleSummary: care ? cycleSummary(care) : "" }, authorityAvailable: true, writeReady: true, accessRequired: false, lastSyncedLabel: syncedAtLabel(), error: "" });
      return true;
    }
    catch (error) {
      if (!this.sameSession(token, revision) || !this.data.visible || this.data.loadAttempt !== attempt) return false;
      if (isAuthenticationFailure(error)) {
        this.setData({ care: null, timeline: [], records: [], recordGroups: [], visibleRecordGroups: [], visibleCycleCount: archivePageSize, hiddenCycleCount: 0, summary: emptySummary, selectedRecord: null, recordDetailOpen: false, authorityAvailable: false, accessRequired: true, error: "" });
      } else if (preserveSnapshot && this.data.authorityAvailable && !failClosed) {
        this.setData({ error: `暂时无法更新护理档案。下方保留${this.data.lastSyncedLabel || "上次确认"}的记录，请检查网络后重试。` }, scrollToRecordsError);
      } else {
        this.setData({ care: null, timeline: [], records: [], recordGroups: [], visibleRecordGroups: [], visibleCycleCount: archivePageSize, hiddenCycleCount: 0, summary: emptySummary, selectedRecord: null, recordDetailOpen: false, authorityAvailable: false, accessRequired: false, error: "护理档案暂时无法同步，请检查网络后重试。旧记录不会被当作当前周期状态。" }, scrollToRecordsError);
      }
      return false;
    }
    finally { if (this.sameSession(token, revision) && this.data.visible && this.data.loadAttempt === attempt) this.setData({ loading: false, refreshing: false }); }
  },
  retryLoad() { if (!this.data.visible) return; clearAuthenticationRedirectSuppression(); if (this.data.accessRequired) { this.authenticate(); return; } if (this.data.authorityAvailable) void this.load(true); else void this.load(); },
  authenticate() { resumeAuthentication("/pages/records/index"); },
  showEarlierCycles() {
    if (this.data.hiddenCycleCount <= 0) return;
    const visibleCycleCount = Math.min(this.data.recordGroups.length, this.data.visibleCycleCount + archivePageSize);
    this.setData({ visibleCycleCount, visibleRecordGroups: this.data.recordGroups.slice(0, visibleCycleCount), hiddenCycleCount: this.data.recordGroups.length - visibleCycleCount });
  },
  openRecordDetail(event: WechatMiniprogram.TouchEvent) {
    if (!this.data.visible || !this.data.pageAlive || this.lastSessionToken !== undefined &&
      !this.sameSession(this.lastSessionToken, this.lastSessionRevision)) return;
    const token = getApp<IAppOption>().globalData.sessionToken, revision = commerceContextRevision(), attempt = this.data.loadAttempt;
    const recordKey = String(event.currentTarget.dataset.key || "");
    const record = this.data.records.find((item) => item.recordKey === recordKey);
    if (!record) return;
    this.clearRecordDetailCloseTimer();
    this.getTabBar?.()?.setPresentation?.("record-detail", true);
    this.setData({ selectedRecord: record, recordDetailMounted: true, recordDetailOpen: true, recordDetailVisible: this.data.reducedMotion, recordDetailClosing: false }, () => {
      if (this.data.reducedMotion) return;
      wx.nextTick(() => {
        if (this.sameSession(token, revision) && this.data.visible && this.data.loadAttempt === attempt && this.data.recordDetailMounted && !this.data.recordDetailClosing) this.setData({ recordDetailVisible: true });
      });
    });
  },
  closeRecordDetail() {
    if (!this.data.recordDetailMounted || this.data.recordDetailClosing) return;
    this.getTabBar?.()?.setPresentation?.("record-detail", false);
    this.setData({ recordDetailOpen: false, recordDetailVisible: false, recordDetailClosing: true });
    if (this.data.reducedMotion) { this.finishRecordDetailClose(); return; }
    this.clearRecordDetailCloseTimer();
    detailTimers.set(this, setTimeout(() => this.finishRecordDetailClose(), recordDetailExitMs));
  },
  clearRecordDetailCloseTimer() {
    const timer = detailTimers.get(this); if (timer) clearTimeout(timer);
    detailTimers.delete(this);
  },
  finishRecordDetailClose() {
    this.clearRecordDetailCloseTimer();
    if (this.data.pageAlive) this.setData({ selectedRecord: null, recordDetailMounted: false, recordDetailOpen: false, recordDetailVisible: false, recordDetailClosing: false });
  },
  dismissRecordDetailImmediately() {
    this.clearRecordDetailCloseTimer();
    this.getTabBar?.()?.setPresentation?.("record-detail", false);
    if (this.data.recordDetailMounted || this.data.recordDetailOpen || this.data.selectedRecord) this.setData({ selectedRecord: null, recordDetailMounted: false, recordDetailOpen: false, recordDetailVisible: false, recordDetailClosing: false });
  },
  stopPropagation() {},
  goHome() {
    if (this.data.working || this.data.confirmingCycleAction) { wx.showToast({ title: "周期操作确认中，请稍候", icon: "none" }); return; }
    wx.switchTab({ url: "/pages/home/index", fail: () => wx.showToast({ title: "护理首页暂时无法打开", icon: "none" }) });
  },
  goShop() {
    if (this.data.working || this.data.confirmingCycleAction) { wx.showToast({ title: "周期操作确认中，请稍候", icon: "none" }); return; }
    wx.navigateTo({ url: "/pages/shop/index", fail: () => wx.showToast({ title: "护理商品暂时无法打开", icon: "none" }) });
  },
  async changeCycle(event: WechatMiniprogram.TouchEvent) {
    if (!this.data.visible || !this.data.pageAlive || !this.data.writeReady || !this.data.care || !this.data.authorityAvailable || this.data.working || this.data.confirmingCycleAction) return;
    const token = getApp<IAppOption>().globalData.sessionToken, revision = commerceContextRevision(), attempt = this.data.loadAttempt;
    if (this.lastSessionToken !== token || this.lastSessionRevision !== revision) return;
    const current = () => this.sameSession(token, revision);
    const confirmationCurrent = () => current() && this.data.visible && this.data.loadAttempt === attempt;
    const action = String(event.currentTarget.dataset.action) as "pause" | "resume" | "terminate";
    if (!["pause", "resume", "terminate"].includes(action)) return;
    const care = this.data.care;
    if (action === "pause" ? care.phase !== "active" || !care.pausePolicy?.enabled :
      action === "resume" ? care.phase !== "paused" : !["active", "paused"].includes(care.phase)) return;
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
      if (confirmationCurrent()) this.setData({ error: "周期操作确认弹层暂时无法打开，请重新选择操作。" }, scrollToRecordsError);
      return;
    } finally {
      if (confirmationCurrent()) this.setData({ confirmingCycleAction: false });
    }
    if (!confirmationCurrent() || !confirmation.confirm) return;
    if (this.data.working || !this.data.writeReady || !this.data.authorityAvailable || !this.data.care || this.data.care.id !== care.id || this.data.care.version !== care.version) {
      this.setData({ operationStatus: "", error: "护理周期状态已变化，请核对最新状态后重新选择操作。" }, scrollToRecordsError);
      return;
    }
    this.setData({ working: true, workingAction: action, operationStatus: "正在更新护理周期状态…", error: "" });
    const tab = this.getTabBar?.(); if (tab) tab.setData({ externalBusy: true });
    wx.enableAlertBeforeUnload({ message: "护理周期操作已经发送，离开不会撤回服务端处理。请等待最新状态确认。" });
    const reasonCode = action === "pause" ? "MEMBER_REQUEST" : action === "resume" ? "MEMBER_RESUME" : "MEMBER_TERMINATION";
    const successCopy = action === "pause" ? "护理周期已暂停" : action === "resume" ? "护理周期已恢复" : "护理周期已终止";
    let acknowledged = false;
    try {
      try {
        await request({ path: `/v1/care-cycles/${care.id}/${action}`, method: "POST", idempotencyKey: `care-${care.id}-${action}-v${care.version}`, data: { reasonCode, expectedVersion: care.version } });
        acknowledged = true;
      } catch { /* A lost write response is unknown, not proof of failure. */ }
      if (!current()) return;
      if (!this.data.visible) {
        this.data.refreshOnShow = true;
        this.setData({ writeReady: false, operationStatus: "原周期操作结果待核对，请返回后刷新。" }); return;
      }
      const refreshed = await this.load(true, true);
      if (!current() || !this.data.visible) return;
      const target = action === "pause" ? "paused" : action === "resume" ? "active" : "terminated";
      const verified = refreshed && this.data.care?.id === care.id && this.data.care.phase === target &&
        Number.isSafeInteger(this.data.care.version) && this.data.care.version > care.version;
      this.setData({ operationStatus: verified ? successCopy : "", writeReady: Boolean(refreshed),
        error: verified ? "" : acknowledged ? "周期操作已受理，但预期状态尚未核实。请核对当前周期后再操作。" :
          "原周期操作结果暂未核实。当前显示最新可确认事实，不表示原操作未执行。" }, verified ? undefined : scrollToRecordsError);
    } finally {
      if (current()) {
        this.setData({ working: false, workingAction: "" });
        if (this.data.visible) { this.getTabBar?.()?.setData({ externalBusy: false }); wx.disableAlertBeforeUnload(); }
        if (this.data.visible && this.data.refreshOnShow) void this.load(true, true);
      }
    }
  }
});
