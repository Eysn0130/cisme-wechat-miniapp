import { pageRead, cancelPageReads } from "../../services/page-requests";
import { measurementClock, recordClientMetric } from "../../services/performance-metrics";
import { defaultMemberAvatar, localMemberAvatar } from "../../services/member-avatar";
import { memberIdentity, publishMemberIdentity } from "../../services/member-identity";
import { requireMemberAccess, retainMemberSnapshot } from "../../services/api";
import { clearAuthenticationRedirectSuppression } from "../../services/api";
import { currentChromeStyle } from "../../services/layout";
import { consumerTaskEntries } from "../../services/task-entry";
import { authorityProjection, hasNativeManagementEntry, type AuthorityProjection } from "../../services/authority";
import { readDailyCareRecords, type DailyCarePage } from "../../services/daily-care";
import { commerceContextRevision } from "../../services/commerce-command-store";

function profileCareView(care: any): { title: string; copy: string; status: string; hasCycle: boolean; unavailable: boolean } {
  if (care === null) return { title: "尚无护理周期", copy: "可先查看日常护理指引。", status: "尚无护理周期", hasCycle: false, unavailable: false };
  const unavailable = { title: "护理状态暂不可用", copy: "请重新加载护理状态。", status: "护理状态暂不可用", hasCycle: false, unavailable: true };
  // CareCycleView has a real cycle id and one of these five server phases.
  // A client waiting placeholder or an unknown payload is not an eligibility fact.
  if (!care || typeof care.id !== "string" || !care.id || !Array.isArray(care.completed)) return unavailable;
  const available = { hasCycle: true, unavailable: false };
  const completed = care.completed.length;
  const next = care?.due || care?.next || "待安排";
  if (care.phase === "planned") return { ...available, title: "护理周期待开始", copy: `已完成 ${completed} / 4 次阶段护理，下一次 ${next}`, status: "等你确认开始" };
  if (care.phase === "active") return { ...available, title: "护理周期进行中", copy: `已完成 ${completed} / 4 次阶段护理，下一次 ${next}`, status: "护理进行中" };
  if (care.phase === "paused") return { ...available, title: "护理周期已暂停", copy: `已完成 ${completed} / 4 次阶段护理，恢复后继续 ${next}`, status: "护理已暂停" };
  if (care.phase === "terminated") return { ...available, title: "护理周期已终止", copy: `已完成 ${completed} / 4 次阶段护理，记录仍可查看`, status: "周期已终止" };
  if (care.phase === "completed") return { ...available, title: "护理周期已完成", copy: "4 次阶段护理已完成，记录都保存在这里", status: "周期已完成" };
  return unavailable;
}

const snapshotOwners = new WeakMap<object, string>();
type AuxiliaryState = "unknown" | "loading" | "ready" | "error";

Page({
  dailySnapshot: null as DailyCarePage | null,
  dailyStatusAttempt: 0,
  projectDailyCare() {
    if (!this.data.member || this.data.hasCareCycle || this.data.careUnavailable || this.data.care !== null) return;
    const daily = this.dailySnapshot;
    if (this.data.dailyStatusError) this.setData({ careTitle: "日常护理记录暂未更新", careCopy: "", careStatus: "日常记录待更新" });
    else if (!daily || this.data.dailyStatusLoading) this.setData({ careTitle: "正在读取日常护理记录…", careCopy: "", careStatus: "正在更新日常记录" });
    else if (daily.today) this.setData({ careTitle: "今日日常护理已记录", careCopy: "四步与感受已保存，点击查看记录。", careStatus: "今日已记录" });
    else {
      const day = daily.items[0]?.careDay, parts = day?.split("-");
      const label = parts ? `${parts[0] === daily.serverDay.slice(0, 4) ? "" : parts[0] + "年"}${Number(parts[1])}月${Number(parts[2])}日` : "";
      this.setData({ careTitle: "今天还未记录", careStatus: "今日日常护理未记录", careCopy: label ? `最近一次日常护理：${label}` : "完成四步并保存后，可在记录中查看。" });
    }
  },
  async loadDailyStatus(attempt: number, token: string) {
    const dailyAttempt = ++this.dailyStatusAttempt;
    const revision = commerceContextRevision();
    const current = () => this.isCurrentLoad(attempt, token) && this.dailyStatusAttempt === dailyAttempt && commerceContextRevision() === revision;
    this.setData({ dailyStatusError: "", dailyStatusLoading: true }); this.projectDailyCare();
    try {
      const result = await readDailyCareRecords(this);
      if (!current()) return;
      this.dailySnapshot = result; this.setData({ dailyStatusLoading: false }); this.projectDailyCare();
    } catch {
      if (current()) { this.setData({ dailyStatusLoading: false, dailyStatusError: "日常护理记录暂时无法加载，请重试。" }); this.projectDailyCare(); }
    }
  },
  retryDailyStatus() { const token = getApp<IAppOption>().globalData.sessionToken; if (token && this.data.member) void this.loadDailyStatus(this.data.loadAttempt, token); },
  data: { dailyStatusLoading: false, dailyStatusError: "", memberAvatar: defaultMemberAvatar, chromeStyle: currentChromeStyle(), member: null as any, points: null as any, care: null as any, coreUnavailable:false, authority:null as AuthorityProjection|null,managementEntryAvailable:false, commercialEligible:false,commercialAccessible:false, supportUnread:null as number | null, authorityState:"unknown" as AuxiliaryState, commercialState:"unknown" as AuxiliaryState, supportState:"unknown" as AuxiliaryState, avatarState:"unknown" as AuxiliaryState, tasks: [] as any[], tasksLoading: false, tasksError: "", progressPercent: 0, pointsBalanceClass: "", careTitle: "", careCopy: "", careStatus: "", hasCareCycle:false, careUnavailable:false, loading: true, navigating: false, loadAttempt: 0, snapshotVersion: 0, tasksAttempt: 0, auxiliaryAttempt: 0, pageAlive: true, error: "" },
  onLoad() { this.data.pageAlive = true; },
  onResize() { this.setData({ chromeStyle: currentChromeStyle() }); },
  onShow() { if (!requireMemberAccess()) { this.dailySnapshot=null; this.dailyStatusAttempt++; this.setData({dailyStatusError:"",dailyStatusLoading:false,hasCareCycle:false,careUnavailable:false,member:null,points:null,care:null,coreUnavailable:false,authority:null,managementEntryAvailable:false,commercialEligible:false,commercialAccessible:false,supportUnread:null,authorityState:"unknown",commercialState:"unknown",supportState:"unknown",avatarState:"unknown",tasks:[],loading:false}); return; } this.data.pageAlive = true; this.setData({ navigating: false }); const tab = this.getTabBar?.(); if (tab) tab.setData({ active: 3, externalBusy: false }); tab?.syncActive?.(3); const identity=memberIdentity(); if(identity && this.data.member?.id===identity.id)this.setData({member:{...this.data.member,...identity},memberAvatar:identity.avatarUrl}); void this.load(undefined, retainMemberSnapshot(this)); },
  onHide() { cancelPageReads(this); this.data.loadAttempt += 1; this.data.tasksAttempt += 1; },
  onUnload() { cancelPageReads(this); this.data.pageAlive = false; this.data.loadAttempt += 1; this.data.tasksAttempt += 1; },
  isCurrentLoad(attempt: number, token: string): boolean {
    return this.data.pageAlive && this.data.loadAttempt === attempt && getApp<IAppOption>().globalData.sessionToken === token;
  },
  loadAuxiliary(attempt: number, token: string) {
    const auxiliaryAttempt = ++this.data.auxiliaryAttempt;
    const current = () => this.isCurrentLoad(attempt, token) && this.data.auxiliaryAttempt === auxiliaryAttempt;
    // Clearing eligibility is fail-closed, not a statement that it is absent.
    this.setData({ authority:null,managementEntryAvailable:false, commercialEligible:false, commercialAccessible:false, supportUnread:null, authorityState:"loading", commercialState:"loading", supportState:"loading" });
    void (async () => {
      try {
        const authority = await authorityProjection(this);
        if (current()) this.setData({ authority, managementEntryAvailable:hasNativeManagementEntry(authority), authorityState:"ready" });
      } catch { if (current()) this.setData({ authority:null,managementEntryAvailable:false, authorityState:"error" }); }
    })();
    void (async () => {
      try {
        const commercial = await pageRead<{ eligible:boolean; membershipState:string; verifiedOrderCount:number; commission:{netEarnedCents:number} }>(this, { path:"/v1/me/commercial-membership", cacheTags:["member"] });
        if (typeof commercial.eligible !== "boolean" || !["none", "active", "suspended", "expired"].includes(commercial.membershipState)
          || !Number.isSafeInteger(commercial.verifiedOrderCount) || commercial.verifiedOrderCount < 0
          || !Number.isSafeInteger(commercial.commission?.netEarnedCents)) throw new Error("INVALID_COMMERCIAL_PROJECTION");
        if (current()) this.setData({ commercialEligible:commercial.eligible, commercialAccessible:commercial.eligible || commercial.membershipState !== "none" || commercial.verifiedOrderCount > 0 || commercial.commission.netEarnedCents > 0, commercialState:"ready" });
      } catch { if (current()) this.setData({ commercialEligible:false, commercialAccessible:false, commercialState:"error" }); }
    })();
    void (async () => {
      try {
        const support = await pageRead<{ unreadCount:number }>(this, { path:"/v1/me/support/summary", cacheTags:["support"] });
        if (!Number.isSafeInteger(support.unreadCount) || support.unreadCount < 0) throw new Error("INVALID_UNREAD_COUNT");
        if (current()) this.setData({ supportUnread:support.unreadCount, supportState:"ready" });
      } catch { if (current()) this.setData({ supportUnread:null, supportState:"error" }); }
    })();
  },
  retryAuxiliary() {
    const token = getApp<IAppOption>().globalData.sessionToken;
    if (token && (this.data.member || this.data.coreUnavailable) && !this.data.loading) this.loadAuxiliary(this.data.loadAttempt, token);
  },
  async loadAvatar(member: any, attempt: number, token: string, businessVersion: number) {
    try {
      const avatarUrl = await localMemberAvatar(member.avatar_data_url, member.avatar_revision);
      if (!this.isCurrentLoad(attempt, token) || this.data.snapshotVersion !== businessVersion || this.data.member?.id !== member.id) return;
      const known = memberIdentity();
      const normalizedMember = known && known.id === member.id && known.profile_revision > member.profile_revision ? { ...member, ...known } : member;
      const currentAvatar = normalizedMember === member ? avatarUrl : known!.avatarUrl;
      const { avatar_data_url: _rawAvatar, ...visibleMember } = normalizedMember;
      publishMemberIdentity({ id:member.id, display_name:normalizedMember.display_name, avatarUrl:currentAvatar, profile_revision:normalizedMember.profile_revision });
      this.setData({ member:visibleMember, memberAvatar:currentAvatar, avatarState:"ready" });
    } catch { if (this.isCurrentLoad(attempt, token)) this.setData({ avatarState:"error" }); }
  },
  async load(event?: WechatMiniprogram.TouchEvent, preserveSnapshot = false) {
    if (event?.type) clearAuthenticationRedirectSuppression();
    cancelPageReads(this);
    const loadStarted = measurementClock();
    const attempt = this.data.loadAttempt + 1;
    const token = getApp<IAppOption>().globalData.sessionToken;
    const sameSession = snapshotOwners.get(this) === token;
    snapshotOwners.set(this, token);
    if (!sameSession) { this.dailySnapshot = null; this.setData({ snapshotVersion:0, dailyStatusError: "" }); }
    this.setData(preserveSnapshot && sameSession
      ? { loadAttempt:attempt, coreUnavailable:false, loading:true, error:"" }
      : { hasCareCycle:false, careUnavailable:false, loadAttempt:attempt, memberAvatar:defaultMemberAvatar, member:null, points:null, care:null, coreUnavailable:false, authority:null,managementEntryAvailable:false, commercialEligible:false, commercialAccessible:false, supportUnread:null, tasks:[], tasksError:"", loading:true, error:"" });
    void this.loadTasks(attempt);
    this.loadAuxiliary(attempt, token);
    void this.loadDailyStatus(attempt, token);
    try {
      const snapshot = await pageRead<any>(this, { path: "/v1/bootstrap/profile", cacheTags: ["member", "care", "points"] });
      if (!this.isCurrentLoad(attempt, token)) return;
      if (!Number.isSafeInteger(snapshot.businessVersion) || snapshot.businessVersion < 0 || !snapshot.member?.id || !snapshot.points?.projection) throw new Error("INVALID_PROFILE_SNAPSHOT");
      if (snapshot.businessVersion < this.data.snapshotVersion) return;
      const processingStarted = measurementClock();
      const { member, points, care } = snapshot;
      const known = memberIdentity();
      const normalizedMember = known && known.id === member.id && known.profile_revision > member.profile_revision ? { ...member, ...known } : member;
      const { avatar_data_url: _rawAvatar, ...visibleMember } = normalizedMember;
      const currentAvatar = known && known.id === member.id ? known.avatarUrl : defaultMemberAvatar;
      publishMemberIdentity({ id: member.id, display_name: normalizedMember.display_name, profile_revision: normalizedMember.profile_revision, avatarUrl: currentAvatar });
      const careView = profileCareView(care);
      // One authoritative core snapshot; local file work is never on this path.
      const core = { member:visibleMember, memberAvatar:currentAvatar, avatarState:"loading" as AuxiliaryState, points, care:care??null, hasCareCycle:careView.hasCycle, careUnavailable:careView.unavailable, coreUnavailable:false, snapshotVersion:snapshot.businessVersion, progressPercent:careView.hasCycle?Math.min(100, care.completed.length * 25):0, pointsBalanceClass:String(points.projection.available).length >= 8 ? "pass-stat__value--compact" : "", careTitle:careView.title, careCopy:careView.copy, careStatus:careView.status, loading:false };
      recordClientMetric({ action: "profile", stage: "data_processing", durationMs: measurementClock() - processingStarted });
      const bridgeStarted = measurementClock();
      this.setData(core, () => {
        if (this.isCurrentLoad(attempt, token)) {
          recordClientMetric({ action: "profile", stage: "set_data", durationMs: measurementClock() - bridgeStarted });
          recordClientMetric({ action: "profile", stage: "critical_ready", durationMs: measurementClock() - loadStarted });
        }
      });
      this.projectDailyCare();
      void this.loadAvatar(member, attempt, token, snapshot.businessVersion);
    } catch {
      if (this.isCurrentLoad(attempt, token)) {
        this.setData({ hasCareCycle:false, careUnavailable:false, memberAvatar:defaultMemberAvatar, member:null, points:null, care:null, coreUnavailable:true, avatarState:"unknown", loading:false, error:"会员资料暂未加载，请重试。你仍可进入订单、客服和设置。" });
      }
    } finally { if (this.isCurrentLoad(attempt, token)) this.setData({ loading:false }); }
  },
  async loadTasks(profileAttempt?: number) {
    const ownerAttempt = profileAttempt ?? this.data.loadAttempt;
    const token = getApp<IAppOption>().globalData.sessionToken;
    const attempt = this.data.tasksAttempt + 1;
    this.setData({ tasksAttempt: attempt, tasks: [], tasksLoading: true, tasksError: "" });
    try {
      const taskHistory = await pageRead<any[]>(this, { path: "/v1/me/tasks" });
      if (!this.isCurrentLoad(ownerAttempt, token) || this.data.tasksAttempt !== attempt) return;
      const tasks = consumerTaskEntries(taskHistory);
      this.setData({ tasks, tasksError: "" });
    } catch (error) {
      if (this.isCurrentLoad(ownerAttempt, token) && this.data.tasksAttempt === attempt) this.setData({ tasks: [], tasksError: "活动暂未加载，请重试" });
    } finally {
      if (this.isCurrentLoad(ownerAttempt, token) && this.data.tasksAttempt === attempt) this.setData({ tasksLoading: false });
    }
  },
  retryTasks() { void this.loadTasks(); },
  openRoute(url: string, mode: "navigate" | "tab", failureCopy: string) {
    if (this.data.navigating) return;
    this.setData({ navigating: true });
    const tab = this.getTabBar?.(); if (tab) tab.setData({ externalBusy: true });
    const fail = () => { if (this.data.pageAlive) this.setData({ navigating: false }); const currentTab = this.getTabBar?.(); if (currentTab) currentTab.setData({ externalBusy: false }); wx.showToast({ title: failureCopy, icon: "none" }); };
    if (mode === "tab") wx.switchTab({ url, fail });
    else wx.navigateTo({ url, fail });
  },
  openAccount() { this.openRoute("/pages/settings/index", "navigate", "设置暂时无法打开"); },
  openRecords() { this.openRoute("/pages/records/index", "tab", "护理记录暂时无法打开"); },
  openPoints() { this.openRoute("/pages/points/index", "navigate", "积分账本暂时无法打开"); },
  openSettings() { this.openRoute("/pages/settings/index", "navigate", "设置与隐私暂时无法打开"); },
  openShop() { this.openRoute("/pages/shop/index", "navigate", "商品目录暂时无法打开"); },
  openOrders() { this.openRoute("/pages/orders/index", "navigate", "订单暂时无法打开"); },
  openSupport(){this.openRoute("/pages/support/index","navigate","客服暂时无法打开");},
  openManagement(){if(this.data.authorityState!=="ready"||!hasNativeManagementEntry(this.data.authority))return;this.openRoute("/pages/management/index","navigate","管理中心暂时无法打开");},
  openInvite() { this.openRoute("/pages/invite/index", "navigate", "邀请页面暂时无法打开"); },
  openCommission(){this.openRoute("/pages/commission/index","navigate","商业资格与佣金暂时无法打开");},
  openCommunityActivity(){this.openRoute("/pages/community-activity/index","navigate","社区记录暂时无法打开");},
  openMyPosts(){
    const url="/pages/community-compose/index";
    if(this.data.navigating||!requireMemberAccess(url))return;
    this.openRoute(url,"navigate","投稿与草稿暂时无法打开");
  },
  openTasks() {
    if (this.data.tasksLoading || this.data.navigating) return;
    if (this.data.tasksError) { void this.loadTasks(); return; }
    const task = this.data.tasks[0];
    if (this.data.tasks.length > 1) { this.openRoute("/pages/community/index", "tab", "投稿列表暂时无法打开"); return; }
    if (task) this.openRoute(`/pages/task/index?id=${task.id}`, "navigate", "投稿与邀请暂时无法打开");
    else this.openRoute("/pages/community/index", "tab", "社区暂时无法打开");
  },
});
