import { pageRead, cancelPageReads } from "../../services/page-requests";
import { measurementClock, recordClientMetric } from "../../services/performance-metrics";
import { defaultMemberAvatar, localMemberAvatar } from "../../services/member-avatar";
import { memberIdentity, publishMemberIdentity } from "../../services/member-identity";
import { requireMemberAccess, retainMemberSnapshot } from "../../services/api";
import { clearAuthenticationRedirectSuppression } from "../../services/api";
import { currentChromeStyle } from "../../services/layout";
import { consumerTaskEntries } from "../../services/task-entry";
import { authorityProjection, type AuthorityProjection } from "../../services/authority";

function profileCareView(care: any): { title: string; copy: string; status: string } {
  const completed = care?.completed?.length ?? 0;
  const next = care?.due || care?.next || "待安排";
  if (care?.phase === "planned") return { title: "护理周期待开始", copy: `${completed} / 4 个里程碑已完成，下一节点 ${next}`, status: "待用户确认开始" };
  if (care?.phase === "active") return { title: "护理周期进行中", copy: `${completed} / 4 个里程碑已完成，下一节点 ${next}`, status: "护理进行中" };
  if (care?.phase === "paused") return { title: "护理周期已暂停", copy: `${completed} / 4 个里程碑已完成，恢复后继续 ${next}`, status: "护理已暂停" };
  if (care?.phase === "terminated") return { title: "护理周期已终止", copy: `${completed} / 4 个里程碑已完成，历史护理事实已归档`, status: "周期已终止" };
  if (care?.phase === "completed") return { title: "护理周期已完成", copy: "4 / 4 个里程碑已完成，护理事实已归档", status: "周期已完成" };
  return { title: "护理周期待确认", copy: `${completed} / 4 个里程碑已完成，下一节点 ${next}`, status: "待资格确认" };
}

const snapshotOwners = new WeakMap<object, string>();
type AuxiliaryState = "unknown" | "loading" | "ready" | "error";

Page({
  data: { memberAvatar: defaultMemberAvatar, chromeStyle: currentChromeStyle(), member: null as any, points: null as any, care: null as any, authority:null as AuthorityProjection|null, commercialEligible:false,commercialAccessible:false, supportUnread:null as number | null, authorityState:"unknown" as AuxiliaryState, commercialState:"unknown" as AuxiliaryState, supportState:"unknown" as AuxiliaryState, avatarState:"unknown" as AuxiliaryState, tasks: [] as any[], tasksLoading: false, tasksError: "", progressPercent: 0, pointsBalanceClass: "", careTitle: "", careCopy: "", careStatus: "", loading: true, navigating: false, loadAttempt: 0, snapshotVersion: 0, tasksAttempt: 0, auxiliaryAttempt: 0, pageAlive: true, error: "" },
  onLoad() { this.data.pageAlive = true; },
  onResize() { this.setData({ chromeStyle: currentChromeStyle() }); },
  onShow() { if (!requireMemberAccess()) { this.setData({member:null,points:null,care:null,authority:null,commercialEligible:false,commercialAccessible:false,supportUnread:null,authorityState:"unknown",commercialState:"unknown",supportState:"unknown",avatarState:"unknown",tasks:[],loading:false}); return; } this.data.pageAlive = true; this.setData({ navigating: false }); const tab = this.getTabBar?.(); if (tab) tab.setData({ active: 3, externalBusy: false }); tab?.syncActive?.(3); const identity=memberIdentity(); if(identity && this.data.member?.id===identity.id)this.setData({member:{...this.data.member,...identity},memberAvatar:identity.avatarUrl}); void this.load(undefined, retainMemberSnapshot(this)); },
  onHide() { cancelPageReads(this); this.data.loadAttempt += 1; this.data.tasksAttempt += 1; },
  onUnload() { cancelPageReads(this); this.data.pageAlive = false; this.data.loadAttempt += 1; this.data.tasksAttempt += 1; },
  isCurrentLoad(attempt: number, token: string): boolean {
    return this.data.pageAlive && this.data.loadAttempt === attempt && getApp<IAppOption>().globalData.sessionToken === token;
  },
  loadAuxiliary(attempt: number, token: string) {
    const auxiliaryAttempt = ++this.data.auxiliaryAttempt;
    const current = () => this.isCurrentLoad(attempt, token) && this.data.auxiliaryAttempt === auxiliaryAttempt;
    // Clearing eligibility is fail-closed, not a statement that it is absent.
    this.setData({ authority:null, commercialEligible:false, commercialAccessible:false, supportUnread:null, authorityState:"loading", commercialState:"loading", supportState:"loading" });
    void (async () => {
      try {
        const authority = await authorityProjection(this);
        if (current()) this.setData({ authority, authorityState:"ready" });
      } catch { if (current()) this.setData({ authority:null, authorityState:"error" }); }
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
    if (token && this.data.member && !this.data.loading) this.loadAuxiliary(this.data.loadAttempt, token);
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
    if (!sameSession) this.setData({ snapshotVersion:0 });
    this.setData(preserveSnapshot && sameSession
      ? { loadAttempt:attempt, loading:true, error:"" }
      : { loadAttempt:attempt, memberAvatar:defaultMemberAvatar, member:null, points:null, care:null, authority:null, commercialEligible:false, commercialAccessible:false, supportUnread:null, tasks:[], tasksError:"", loading:true, error:"" });
    void this.loadTasks(attempt);
    this.loadAuxiliary(attempt, token);
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
      const normalizedCare = care ?? { phase: "waiting", completed: [], due: null, next: null };
      const careView = profileCareView(normalizedCare);
      // One authoritative core snapshot; local file work is never on this path.
      const core = { member:visibleMember, memberAvatar:defaultMemberAvatar, avatarState:"loading" as AuxiliaryState, points, care:normalizedCare, snapshotVersion:snapshot.businessVersion, progressPercent:Math.min(100, normalizedCare.completed.length * 25), pointsBalanceClass:String(points.projection.available).length >= 8 ? "pass-stat__value--compact" : "", careTitle:careView.title, careCopy:careView.copy, careStatus:careView.status, loading:false };
      recordClientMetric({ action: "profile", stage: "data_processing", durationMs: measurementClock() - processingStarted });
      const bridgeStarted = measurementClock();
      this.setData(core, () => {
        if (this.isCurrentLoad(attempt, token)) {
          recordClientMetric({ action: "profile", stage: "set_data", durationMs: measurementClock() - bridgeStarted });
          recordClientMetric({ action: "profile", stage: "critical_ready", durationMs: measurementClock() - loadStarted });
        }
      });
      void this.loadAvatar(member, attempt, token, snapshot.businessVersion);
    } catch {
      if (this.isCurrentLoad(attempt, token)) {
        this.data.tasksAttempt += 1;
        this.setData({ memberAvatar:defaultMemberAvatar, member:null, points:null, care:null, tasks:[], tasksLoading:false, tasksError:"", avatarState:"unknown", loading:false, error:"会员资料暂时无法同步，请重试。页面不会把旧积分或护理状态当作最新结果。" });
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
  openManagement(){if(this.data.authorityState!=="ready"||!this.data.authority?.managementAvailable)return;this.openRoute("/pages/management/index","navigate","管理中心暂时无法打开");},
  openInvite() { this.openRoute("/pages/invite/index", "navigate", "邀请页面暂时无法打开"); },
  openCommission(){this.openRoute("/pages/commission/index","navigate","商业资格与佣金暂时无法打开");},
  openCommunityActivity(){this.openRoute("/pages/community-activity/index","navigate","社区记录暂时无法打开");},
  openTasks() {
    if (this.data.tasksLoading || this.data.navigating) return;
    if (this.data.tasksError) { void this.loadTasks(); return; }
    const task = this.data.tasks[0];
    if (this.data.tasks.length > 1) { this.openRoute("/pages/community/index", "tab", "投稿列表暂时无法打开"); return; }
    if (task) this.openRoute(`/pages/task/index?id=${task.id}`, "navigate", "投稿与邀请暂时无法打开");
    else this.openRoute("/pages/community/index", "tab", "社区暂时无法打开");
  },
});
