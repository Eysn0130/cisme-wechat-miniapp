import { cancelPageReads, pageRead } from "../../services/page-requests";
import { commerceContextRevision } from "../../services/commerce-command-store";
import { requireMemberAccess, retainMemberSnapshot } from "../../services/api";
import { clearAuthenticationRedirectSuppression, request, resumeAuthentication } from "../../services/api";
import { currentChromeStyle, motionDuration, shouldReduceMotion } from "../../services/layout";
import { careProtocolSteps, careSelfAssessments, type CareSelfAssessmentValue } from "../../services/care-protocol";
import { readDailyCareRecords, changeDailyCareRecord, type DailyCareRecord, type DailyCareResult } from "../../services/daily-care";
import { clientOperationKey } from "../../services/orders";

function scrollToRecordsError() {
  wx.pageScrollTo({ selector: "#records-error-summary", duration: motionDuration(200) });
}

function isAuthenticationFailure(error: unknown): boolean {
  const problem = error as { status?: number; statusCode?: number; code?: string };
  return (problem.status ?? problem.statusCode) === 401 || problem.code === "AUTHENTICATION_REQUIRED" || problem.code === "MEMBER_NOT_FOUND";
}

function syncedAtLabel(): string {
  const value = new Date();
  return `${String(value.getHours()).padStart(2, "0")}:${String(value.getMinutes()).padStart(2, "0")} 已同步`;
}

const archivePageSize = 3;
const recordDetailExitMs = 240;
const careMilestones = ["D1", "D7", "D14", "D28"] as const;
const detailTimers = new WeakMap<object, ReturnType<typeof setTimeout>>();
type DailyMutation = { kind: "delete" | "restore"; record: DailyCareRecord; key: string; token: string; revision: number; inFlight: boolean; ack?: DailyCareResult };
const dailyMutations = new WeakMap<object, DailyMutation>();
const dailyDeleteConfirmations = new WeakMap<object, object>();
const dailyUndo = new WeakMap<object, { record: DailyCareRecord; token: string; revision: number }>();
type RowGesture = { key: string; token: string; revision: number; version: number; attempt: number; touchId: number | null; scrollTop: number;
  x: number; y: number; initial: number; offset: number; axis: "pending" | "horizontal" | "vertical"; moved: boolean; canceled: boolean; endedAt?: number };
const rowGestures = new WeakMap<object, RowGesture>();
const pageScrollPositions = new WeakMap<object, number>();
const dailyActionWidth = 72;
const dailyGestureThreshold = 12;

function sampleDailyGesture(gesture: RowGesture, touch: { clientX: number; clientY: number }): void {
  const dx = touch.clientX - gesture.x, dy = touch.clientY - gesture.y;
  if (gesture.axis === "vertical" || gesture.canceled) return;
  if (gesture.axis === "pending") {
    if (Math.max(Math.abs(dx), Math.abs(dy)) < dailyGestureThreshold) return;
    gesture.moved = true;
    gesture.axis = Math.abs(dx) < Math.abs(dy) * 1.3 ? "vertical" : "horizontal";
  }
  if (gesture.axis === "horizontal") gesture.offset = Math.max(0, Math.min(dailyActionWidth, gesture.initial - dx));
}

const emptySummary = { completed: 0, totalRecords: 0, cycleCount: 0, recordCountClass: "", headlineLine1: "护理记录", headlineLine2: "", phaseLabel: "尚无护理周期", protocol: "", cycleSummary: "" };

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
  source?: "daily";
  dailyRecord?: DailyCareRecord;
  swipeStyle?: string;
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

const emptyDaily = { dailyRecords: [] as RecordView[], dailyTotalCount: null as number | null, dailyReady: false, dailyLoading: false, dailyError: "", dailyCursor: null as string | null, dailyHasMore: false, dailyRetryAppend: false };

function dailyRecordView(record: DailyCareRecord): RecordView {
  const completion = zonedCompletion(record.completedAt, record.timezone);
  const assessment = careSelfAssessments.find(item => item.value === record.selfAssessment)!;
  return { source: record.source, dailyRecord: record, swipeStyle: "transform:translateX(0px);", recordKey: `daily:${record.id}`, milestone: "日常", index: "日", completedAt: completion.short,
    completedDate: completion.date, completedTime: completion.time, assessmentLabel: assessment.label,
    assessmentNote: assessment.note, assessmentAvailable: true, assessmentIcon: "/assets/icons/check-circle-plum.svg",
    steps: careProtocolSteps.map(step => ({ code: step.code, label: step.label, title: step.title })), stepSummary: "",
    hasDetails: true, cycleLabel: "日常护理", protocolVersion: record.protocolVersion };
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
  return ["你的日常护理，", "按自己的节奏继续。"];
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
      ? "这条旧记录只保存了护理阶段和完成时间，没有详细步骤。"
      : `这条旧记录只保存了 ${steps.length} / 4 个步骤，其余步骤没有记录。`;
  return {
    recordKey: `${cycle.id}:${record.milestone}`,
    milestone: record.milestone,
    index: record.milestone.replace("D", "").padStart(2, "0"),
    completedAt: completion.short,
    completedDate: completion.date,
    completedTime: completion.time,
    assessmentLabel: assessment?.label ?? "这条旧记录未保存护理后感受",
    assessmentNote: assessment?.note ?? "这条旧记录未保存更详细的护理内容。",
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
  if (!isCurrent) return "这个周期还没有护理记录";
  if (cycle.phase === "planned") return "确认开始后，就会安排 D1 护理";
  if (cycle.phase === "paused") return "周期已暂停，恢复后再继续安排护理";
  if (cycle.phase === "terminated") return "这个周期结束前没有保存护理记录";
  return "还没有完成阶段护理";
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
  if (care.phase === "planned") return "确认开始后，安排 D1、D7、D14、D28 护理";
  if (care.phase === "paused") return "已完成的记录会保留，恢复后继续安排剩余护理";
  if (care.phase === "terminated") return "周期已终止，历史护理记录仍可查看";
  if (care.phase === "completed") return "四次阶段护理均已完成并保存";
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
    openDailyKey: "", draggingDailyKey: "", dailyMutationState: "idle" as "idle" | "sending" | "unknown", dailyMutationError: "", confirmingDailyDelete: false, undoAvailable: false,
    ...emptyDaily, dailyAttempt: 0, loadedRecordCount: 0, loadedRecordCountClass: "",
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
      dailyMutations.delete(this); dailyDeleteConfirmations.delete(this); dailyUndo.delete(this); rowGestures.delete(this);
      cancelPageReads(this); this.data.loadAttempt += 1; this.data.dailyAttempt += 1; this.dismissRecordDetailImmediately();
      this.setData({ care: null, timeline: [], records: [], recordGroups: [], visibleRecordGroups: [],
        visibleCycleCount: archivePageSize, hiddenCycleCount: 0, summary: emptySummary, selectedRecord: null,
        working: false, workingAction: "", confirmingCycleAction: false, writeReady: false,
        authorityAvailable: false, accessRequired: !token, operationStatus: "", error: "", lastSyncedLabel: "",
        ...emptyDaily, loadedRecordCount: 0, loadedRecordCountClass: "", dailyMutationState: "idle", dailyMutationError: "", confirmingDailyDelete: false, undoAvailable: false, openDailyKey: "", draggingDailyKey: "" });
      this.getTabBar?.()?.setData({ externalBusy: false }); wx.disableAlertBeforeUnload();
    }
    this.lastSessionToken = token; this.lastSessionRevision = revision;
  },
  sameSession(token: string, revision: number) {
    return this.data.pageAlive && token === getApp<IAppOption>().globalData.sessionToken && revision === commerceContextRevision();
  },
  onLoad() { this.data.pageAlive = true; pageScrollPositions.set(this, 0); },
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
    const mutation = dailyMutations.get(this);
    if (mutation?.ack) this.finishDailyMutation(mutation, mutation.ack);
    this.setData({ operationStatus: "" });
    void this.load(retainMemberSnapshot(this));
  },
  onHide() {
    dailyDeleteConfirmations.delete(this);
    rowGestures.delete(this);
    this.closeDailySwipe(); this.setData({ confirmingDailyDelete: false });
    if (dailyMutations.has(this)) this.setData({ dailyMutationState: "unknown" });
    this.data.visible = false; this.data.loadAttempt += 1; this.data.refreshOnShow = true;
    this.data.dailyAttempt += 1; this.setData({ dailyLoading: false });
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
    this.dailyTouchCancel();
    cancelPageReads(this); this.data.refreshOnShow = false; this.data.dailyAttempt += 1; this.setData({ dailyLoading: false });
    const token = getApp<IAppOption>().globalData.sessionToken, revision = commerceContextRevision();
    dailyDeleteConfirmations.delete(this);
    this.setData({ writeReady: false, confirmingCycleAction: false, confirmingDailyDelete: false }); this.dismissRecordDetailImmediately();
    const attempt = this.data.loadAttempt + 1;
    this.setData(preserveSnapshot && this.data.authorityAvailable
      ? { loadAttempt: attempt, loading: true, refreshing: true, accessRequired: false, error: "" }
      : { loadAttempt: attempt, care: null, timeline: [], records: [], recordGroups: [], visibleRecordGroups: [], visibleCycleCount: archivePageSize, hiddenCycleCount: 0, summary: emptySummary, selectedRecord: null, recordDetailOpen: false, loading: true, refreshing: false, authorityAvailable: false, accessRequired: false, loadedRecordCount: this.data.dailyRecords.length, loadedRecordCountClass: recordCountClass(this.data.dailyRecords.length), error: "" });
    if (token) void this.loadDailyRecords();
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
      const loadedRecordCount = archive.records.length + this.data.dailyRecords.length;
      this.setData({ care, timeline, records: archive.records, recordGroups: archive.groups, visibleRecordGroups: archive.groups.slice(0, visibleCycleCount), visibleCycleCount, hiddenCycleCount: Math.max(0, cycleCount - visibleCycleCount), selectedRecord: null, recordDetailOpen: false, summary: { completed: completed.length, totalRecords: archive.records.length, cycleCount, recordCountClass: recordCountClass(archive.records.length), headlineLine1: headline[0], headlineLine2: headline[1], phaseLabel: currentPhaseLabel, protocol: care?.protocolVersion ?? "", cycleSummary: care ? cycleSummary(care) : "" }, loadedRecordCount, loadedRecordCountClass: recordCountClass(loadedRecordCount), authorityAvailable: true, writeReady: true, accessRequired: false, lastSyncedLabel: syncedAtLabel(), error: "" });
      return true;
    }
    catch (error) {
      if (this.recordReadAuthenticationFailed(error, token, revision, attempt)) return false;
      if (!this.sameSession(token, revision) || !this.data.visible || this.data.loadAttempt !== attempt) return false;
      if ((error as { status?: number })?.status === 403) {
        this.setData({ care: null, timeline: [], records: [], recordGroups: [], visibleRecordGroups: [], visibleCycleCount: archivePageSize, hiddenCycleCount: 0, summary: emptySummary, selectedRecord: null, recordDetailOpen: false, authorityAvailable: false, accessRequired: false, loadedRecordCount: this.data.dailyRecords.length, loadedRecordCountClass: recordCountClass(this.data.dailyRecords.length), error: "当前账号暂时无法查看护理周期，请稍后重试。" });
      } else if (preserveSnapshot && this.data.authorityAvailable && !failClosed) {
        this.setData({ error: `暂时无法更新护理档案。下方保留${this.data.lastSyncedLabel || "上次确认"}的记录，请检查网络后重试。` }, scrollToRecordsError);
      } else {
        this.setData({ care: null, timeline: [], records: [], recordGroups: [], visibleRecordGroups: [], visibleCycleCount: archivePageSize, hiddenCycleCount: 0, summary: emptySummary, selectedRecord: null, recordDetailOpen: false, authorityAvailable: false, accessRequired: false, loadedRecordCount: this.data.dailyRecords.length, loadedRecordCountClass: recordCountClass(this.data.dailyRecords.length), error: "护理档案暂未加载，请检查网络后重试，再查看当前周期进度。" }, scrollToRecordsError);
      }
      return false;
    }
    finally { if (this.sameSession(token, revision) && this.data.visible && this.data.loadAttempt === attempt) this.setData({ loading: false, refreshing: false }); }
  },
  recordReadAuthenticationFailed(error: unknown, token: string, revision: number, attempt: number, daily = false): boolean {
    const currentToken = getApp<IAppOption>().globalData.sessionToken;
    if (!isAuthenticationFailure(error) || !this.data.pageAlive || !this.data.visible
      || (daily ? this.data.dailyAttempt : this.data.loadAttempt) !== attempt
      || (!this.sameSession(token, revision) && currentToken !== "")) return false;
    this.syncSession(); cancelPageReads(this); this.data.loadAttempt += 1; this.data.dailyAttempt += 1; this.dismissRecordDetailImmediately();
    this.setData({ care: null, timeline: [], records: [], recordGroups: [], visibleRecordGroups: [], summary: emptySummary,
      selectedRecord: null, recordDetailOpen: false, authorityAvailable: false, writeReady: false, accessRequired: true,
      loading: false, refreshing: false, error: "", ...emptyDaily, loadedRecordCount: 0, loadedRecordCountClass: "" });
    return true;
  },
  async loadDailyRecords(more = false) {
    if (!this.data.pageAlive || !this.data.visible || this.data.dailyLoading || (more && (!this.data.dailyHasMore || !this.data.dailyCursor))) return;
    const token = getApp<IAppOption>().globalData.sessionToken, revision = commerceContextRevision();
    if (!token || this.lastSessionToken !== token || this.lastSessionRevision !== revision) return;
    const attempt = ++this.data.dailyAttempt, cursor = more ? this.data.dailyCursor : null;
    const current = () => this.sameSession(token, revision) && this.data.visible && this.data.dailyAttempt === attempt;
    this.setData({ dailyLoading: true, dailyError: "", dailyRetryAppend: more });
    try {
      const result = await readDailyCareRecords(this, cursor);
      if (!current()) return;
      const previousRows = new Map(this.data.dailyRecords.map(row => [row.recordKey, row]));
      const byId = new Map<string, RecordView>((more ? this.data.dailyRecords : []).map(record => [record.recordKey, record]));
      result.items.forEach(record => {
        const previous = byId.get(`daily:${record.id}`)?.dailyRecord;
        if (!previous || previous.version <= record.version) {
          const view = dailyRecordView(record), oldView = previousRows.get(view.recordKey);
          if (oldView?.dailyRecord?.version === record.version && oldView.swipeStyle !== undefined) view.swipeStyle = oldView.swipeStyle;
          byId.set(view.recordKey, view);
        }
      });
      const dailyRecords = [...byId.values()], loadedRecordCount = this.data.records.length + dailyRecords.length;
      const unchanged = (key: string) => Boolean(key && previousRows.get(key)?.dailyRecord?.version === byId.get(key)?.dailyRecord?.version
        && byId.has(key));
      const gesture = rowGestures.get(this);
      if (gesture && !unchanged(gesture.key)) this.dailyTouchCancel();
      const openDailyKey = unchanged(this.data.openDailyKey) ? this.data.openDailyKey : "";
      const draggingDailyKey = unchanged(this.data.draggingDailyKey) ? this.data.draggingDailyKey : "";
      this.setData({ dailyRecords, dailyTotalCount: result.totalCount, dailyReady: true, dailyCursor: result.nextCursor, dailyHasMore: result.hasMore, dailyRetryAppend: false,
        loadedRecordCount, loadedRecordCountClass: recordCountClass(loadedRecordCount), openDailyKey, draggingDailyKey });
    } catch (error) {
      if (this.recordReadAuthenticationFailed(error, token, revision, attempt, true)) return;
      if (!current()) return;
      if ((error as { status?: number })?.status === 403) {
        this.setData({ ...emptyDaily, loadedRecordCount: this.data.records.length, loadedRecordCountClass: recordCountClass(this.data.records.length), dailyError: "当前账号暂时无法查看日常护理记录，请稍后重试。" });
      } else this.setData({ dailyError: "日常护理记录暂时无法加载，请重试。" });
    } finally { if (current()) this.setData({ dailyLoading: false }); }
  },
  retryDailyRecords() { void this.loadDailyRecords(this.data.dailyRetryAppend); },
  loadMoreDailyRecords() { void this.loadDailyRecords(true); },
  closeDailySwipe() {
    if (this.data.openDailyKey || this.data.draggingDailyKey) this.setData({ openDailyKey: "", draggingDailyKey: "", dailyRecords: this.data.dailyRecords.map(row => ({ ...row, swipeStyle: "transform:translateX(0px);" })) });
  },
  setDailySwipe(key: string, offset: number, dragging = false) {
    this.setData({ openDailyKey: offset > 0 ? key : "", draggingDailyKey: dragging ? key : "", dailyRecords: this.data.dailyRecords.map(row => ({ ...row, swipeStyle: `transform:translateX(-${row.recordKey === key ? offset : 0}px);` })) });
  },
  onPageScroll(event?: { scrollTop: number }) {
    if (!event || !Number.isFinite(event.scrollTop)) return;
    const previous = pageScrollPositions.get(this) ?? 0;
    pageScrollPositions.set(this, event.scrollTop);
    if (event.scrollTop === previous) return;
    const gesture = rowGestures.get(this);
    if (gesture?.axis === "horizontal" && !gesture.canceled
      && Math.abs(event.scrollTop - gesture.scrollTop) < dailyGestureThreshold) return;
    this.dailyTouchCancel();
  },
  currentDailyGesture(gesture: RowGesture) {
    return this.data.visible && this.sameSession(gesture.token, gesture.revision) && this.data.loadAttempt === gesture.attempt
      && this.data.dailyRecords.find(row => row.recordKey === gesture.key)?.dailyRecord?.version === gesture.version;
  },
  dailyTouchStart(event: WechatMiniprogram.TouchEvent) {
    const key = String(event.currentTarget.dataset.key || ""), touch = event.touches[0];
    const row = this.data.dailyRecords.find(item => item.recordKey === key)?.dailyRecord;
    if (!this.data.visible || !this.data.pageAlive || this.data.recordDetailMounted || this.data.dailyMutationState !== "idle"
      || event.touches.length !== 1 || !touch || !Number.isFinite(touch.clientX) || !Number.isFinite(touch.clientY) || !row) { this.dailyTouchCancel(); return; }
    if (this.data.openDailyKey && this.data.openDailyKey !== key) this.closeDailySwipe();
    rowGestures.set(this, { key, token: getApp<IAppOption>().globalData.sessionToken, revision: commerceContextRevision(), version: row.version,
      attempt: this.data.loadAttempt, touchId: Number.isFinite(touch.identifier) ? touch.identifier : null, scrollTop: pageScrollPositions.get(this) ?? 0,
      x: touch.clientX, y: touch.clientY, initial: this.data.openDailyKey === key ? dailyActionWidth : 0,
      offset: this.data.openDailyKey === key ? dailyActionWidth : 0, axis: "pending", moved: false, canceled: false });
  },
  dailyTouchMove(event: WechatMiniprogram.TouchEvent) {
    const gesture = rowGestures.get(this), touch = event.touches[0];
    if (gesture?.endedAt !== undefined) return;
    if (!gesture || !touch || event.touches.length !== 1 || !this.currentDailyGesture(gesture)
      || !Number.isFinite(touch.clientX) || !Number.isFinite(touch.clientY)
      || gesture.touchId !== null && touch.identifier !== gesture.touchId) { this.dailyTouchCancel(); return; }
    if (String(event.currentTarget.dataset.key || "") !== gesture.key) return;
    const previous = gesture.offset;
    sampleDailyGesture(gesture, touch);
    if (gesture.axis === "vertical" || gesture.canceled) { this.closeDailySwipe(); return; }
    if (gesture.axis === "horizontal" && Math.abs(gesture.offset - previous) >= 2) this.setDailySwipe(gesture.key, gesture.offset, true);
  },
  dailyTouchEnd(event?: WechatMiniprogram.TouchEvent) {
    const gesture = rowGestures.get(this); if (!gesture) return;
    if (gesture.endedAt !== undefined) return;
    if (event && String(event.currentTarget.dataset.key || "") !== gesture.key) return;
    if (!this.currentDailyGesture(gesture) || gesture.canceled) { this.dailyTouchCancel(); return; }
    if (event) {
      const touch = event.changedTouches?.[0];
      if (event.touches.length || event.changedTouches?.length !== 1 || !touch
        || !Number.isFinite(touch.clientX) || !Number.isFinite(touch.clientY)
        || gesture.touchId !== null && touch.identifier !== gesture.touchId) { this.dailyTouchCancel(); return; }
      sampleDailyGesture(gesture, touch);
    }
    gesture.endedAt = Date.now();
    if (gesture.axis === "horizontal") this.setDailySwipe(gesture.key, gesture.offset >= dailyActionWidth / 2 ? dailyActionWidth : 0);
    else if (gesture.axis === "vertical") this.closeDailySwipe();
  },
  dailyTouchCancel() { const gesture = rowGestures.get(this); if (gesture) { gesture.canceled = true; gesture.moved = true; gesture.endedAt = Date.now(); } this.closeDailySwipe(); },
  async deleteDailyRecord(event?: WechatMiniprogram.TouchEvent) {
    if (!this.data.visible || !this.data.pageAlive || this.data.dailyMutationState !== "idle" || this.data.confirmingDailyDelete || this.data.working) return;
    const key = String(event?.currentTarget.dataset.key || this.data.selectedRecord?.recordKey || "");
    const row = this.data.dailyRecords.find(item => item.recordKey === key)?.dailyRecord;
    if (!row) return;
    const token = getApp<IAppOption>().globalData.sessionToken, revision = commerceContextRevision();
    const attempt = this.data.loadAttempt, owner = {};
    dailyDeleteConfirmations.set(this, owner);
    const current = () => dailyDeleteConfirmations.get(this) === owner && this.data.loadAttempt === attempt && this.sameSession(token, revision) && this.data.visible && this.lastSessionToken === token && this.lastSessionRevision === revision;
    this.closeDailySwipe(); this.setData({ confirmingDailyDelete: true, dailyMutationError: "" });
    try {
      const confirmation = await wx.showModal({ title: "删除这条护理记录？", content: "删除后不再显示，你可以撤销这次删除。", confirmText: "删除", cancelText: "保留" });
      if (!current() || !confirmation.confirm) return;
      if (this.data.dailyRecords.find(item => item.recordKey === key)?.dailyRecord?.version !== row.version) { this.setData({ dailyMutationError: "记录已更新，请查看最新内容后再删除。" }); return; }
      const command: DailyMutation = { kind: "delete", record: row, key: clientOperationKey("daily-care-delete"), token, revision, inFlight: false };
      dailyMutations.set(this, command); await this.runDailyMutation(command);
    } catch { if (current()) this.setData({ dailyMutationError: "删除确认暂时无法打开，请重试。" }); }
    finally { if (current()) { dailyDeleteConfirmations.delete(this); this.setData({ confirmingDailyDelete: false }); } }
  },
  async undoDailyDelete() {
    const undo = dailyUndo.get(this);
    if (!undo || !this.sameSession(undo.token, undo.revision) || !this.data.visible || this.data.dailyMutationState !== "idle") return;
    const command: DailyMutation = { kind: "restore", record: undo.record, key: clientOperationKey("daily-care-restore"), token: undo.token, revision: undo.revision, inFlight: false };
    dailyMutations.set(this, command); await this.runDailyMutation(command);
  },
  async retryDailyMutation() {
    const command = dailyMutations.get(this);
    if (!command || command.inFlight || !this.sameSession(command.token, command.revision) || !this.data.visible) return;
    if (command.ack) this.finishDailyMutation(command, command.ack);
    else await this.runDailyMutation(command);
  },
  async runDailyMutation(command: DailyMutation) {
    if (command.inFlight || !this.sameSession(command.token, command.revision) || !this.data.visible) return;
    command.inFlight = true;
    this.data.dailyAttempt += 1; this.setData({ dailyLoading: false, dailyMutationState: "sending", dailyMutationError: "" });
    const current = () => dailyMutations.get(this) === command && this.sameSession(command.token, command.revision);
    try {
      const result = await changeDailyCareRecord(command.record.id, command.record.version, command.key, command.kind === "restore");
      if (!current()) return;
      command.ack = result;
      if (this.data.visible) this.finishDailyMutation(command, result);
    } catch (error) {
      if (dailyMutations.get(this) === command && this.recordReadAuthenticationFailed(error, command.token, command.revision, this.data.dailyAttempt, true)) { dailyMutations.delete(this); dailyUndo.delete(this); this.setData({ dailyMutationState: "idle", undoAvailable: false, dailyMutationError: "" }); return; }
      if (!current() || !this.data.visible) return;
      const status = (error as { status?: number }).status;
      if (typeof status === "number" && status >= 400 && status < 500) {
        dailyMutations.delete(this);
        if (command.kind === "restore") dailyUndo.delete(this);
        this.setData({ dailyMutationState: "idle", ...(command.kind === "restore" ? { undoAvailable: false } : {}), dailyMutationError: command.kind === "restore" ? "记录已有变化，暂时无法撤销。请重新加载核对。" : "删除未完成，记录可能已更新。请重新加载后查看。" });
        void this.loadDailyRecords();
      } else this.setData({ dailyMutationState: "unknown", dailyMutationError: command.kind === "delete" ? "暂未确认是否删除。请重试核对。" : "暂未确认是否恢复。请重试核对。" });
    } finally { command.inFlight = false; }
  },
  finishDailyMutation(command: DailyMutation, result: DailyCareResult) {
    if (dailyMutations.get(this) !== command || !this.sameSession(command.token, command.revision) || !this.data.visible) return;
    dailyMutations.delete(this); this.dismissRecordDetailImmediately();
    this.data.dailyAttempt += 1;
    this.setData({ dailyLoading: false });
    let dailyRecords = this.data.dailyRecords;
    const newer = dailyRecords.find(row => row.recordKey === `daily:${result.record.id}`)?.dailyRecord;
    const currentResult = result.current && (!newer || newer.version <= result.record.version);
    if (currentResult) {
      dailyRecords = dailyRecords.filter(row => row.recordKey !== `daily:${result.record.id}`);
      if (!result.record.deleted) dailyRecords = [dailyRecordView(result.record), ...dailyRecords].sort((a, b) => b.dailyRecord!.careDay.localeCompare(a.dailyRecord!.careDay));
    }
    const undo = command.kind === "delete" && currentResult;
    if (undo) dailyUndo.set(this, { record: result.record, token: command.token, revision: command.revision }); else dailyUndo.delete(this);
    const loadedRecordCount = this.data.records.length + dailyRecords.length;
    this.setData({ dailyRecords, loadedRecordCount, loadedRecordCountClass: recordCountClass(loadedRecordCount), dailyMutationState: "idle", undoAvailable: undo,
      dailyMutationError: currentResult ? "" : "记录已有更新，请查看最新内容。" });
    wx.showToast({ title: !currentResult ? "操作已核对" : command.kind === "delete" ? "记录已删除" : "删除已撤销", icon: "success" });
    void this.loadDailyRecords();
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
    const gesture = rowGestures.get(this);
    if (gesture?.key === recordKey && gesture.moved) { rowGestures.delete(this); return; }
    if (this.data.openDailyKey) { this.closeDailySwipe(); return; }
    const record = [...this.data.records, ...this.data.dailyRecords].find((item) => item.recordKey === recordKey);
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
        ? { title: "恢复当前护理周期？", content: "恢复后，会按暂停天数顺延尚未完成的阶段护理。" }
        : { title: "终止当前护理周期？", content: "终止不会删除历史记录，也不会自动触发退款或积分变化。" };
    this.setData({ confirmingCycleAction: true });
    let confirmation: WechatMiniprogram.ShowModalSuccessCallbackResult;
    try {
      confirmation = await wx.showModal({ ...copy, confirmText: action === "pause" ? "确认暂停" : action === "resume" ? "确认恢复" : "确认终止" });
    } catch {
      if (confirmationCurrent()) this.setData({ error: "暂时无法确认这次操作，请重新选择。" }, scrollToRecordsError);
      return;
    } finally {
      if (confirmationCurrent()) this.setData({ confirmingCycleAction: false });
    }
    if (!confirmationCurrent() || !confirmation.confirm) return;
    if (this.data.working || !this.data.writeReady || !this.data.authorityAvailable || !this.data.care || this.data.care.id !== care.id || this.data.care.version !== care.version) {
      this.setData({ operationStatus: "", error: "护理周期已更新，请查看最新进度后重新操作。" }, scrollToRecordsError);
      return;
    }
    this.setData({ working: true, workingAction: action, operationStatus: "正在更新护理周期状态…", error: "" });
    const tab = this.getTabBar?.(); if (tab) tab.setData({ externalBusy: true });
    wx.enableAlertBeforeUnload({ message: "正在确认操作结果，请稍等。离开页面不会取消已提交的操作。" });
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
        error: verified ? "" : acknowledged ? "操作已提交，结果还需核对。请刷新当前周期后再操作。" :
          "上次操作的结果还未确认，请先刷新核对，避免重复操作。" }, verified ? undefined : scrollToRecordsError);
    } finally {
      if (current()) {
        this.setData({ working: false, workingAction: "" });
        if (this.data.visible) { this.getTabBar?.()?.setData({ externalBusy: false }); wx.disableAlertBeforeUnload(); }
        if (this.data.visible && this.data.refreshOnShow) void this.load(true, true);
      }
    }
  }
});
