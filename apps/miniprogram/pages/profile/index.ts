import { defaultMemberAvatar, localMemberAvatar } from "../../services/member-avatar";
import { memberIdentity, publishMemberIdentity } from "../../services/member-identity";
import { requireMemberAccess, retainMemberSnapshot } from "../../services/api";
import { clearAuthenticationRedirectSuppression, request } from "../../services/api";
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

Page({
  data: { memberAvatar: defaultMemberAvatar, chromeStyle: currentChromeStyle(), member: null as any, points: null as any, care: null as any, authority:null as AuthorityProjection|null, commercialEligible:false,commercialAccessible:false, supportUnread:0, tasks: [] as any[], tasksLoading: false, tasksError: "", progressPercent: 0, pointsBalanceClass: "", careTitle: "", careCopy: "", careStatus: "", loading: true, navigating: false, loadAttempt: 0, snapshotVersion: 0, tasksAttempt: 0, pageAlive: true, error: "" },
  onLoad() { this.data.pageAlive = true; },
  onResize() { this.setData({ chromeStyle: currentChromeStyle() }); },
  onShow() { if (!requireMemberAccess()) { this.setData({member:null,points:null,care:null,authority:null,commercialEligible:false,commercialAccessible:false,supportUnread:0,tasks:[],loading:false}); return; } this.data.pageAlive = true; this.setData({ navigating: false }); const tab = this.getTabBar?.(); if (tab) tab.setData({ active: 3, externalBusy: false }); tab?.syncActive?.(3); const identity=memberIdentity(); if(identity && this.data.member?.id===identity.id)this.setData({member:{...this.data.member,...identity},memberAvatar:identity.avatarUrl}); void this.load(undefined, retainMemberSnapshot(this)); },
  onHide() { this.data.loadAttempt += 1; this.data.tasksAttempt += 1; },
  onUnload() { this.data.pageAlive = false; this.data.loadAttempt += 1; this.data.tasksAttempt += 1; },
  async load(event?: WechatMiniprogram.TouchEvent, preserveSnapshot = false) {
    if (event?.type) clearAuthenticationRedirectSuppression();
    const attempt = this.data.loadAttempt + 1;
    this.setData(preserveSnapshot && this.data.member ? { loadAttempt: attempt, tasksAttempt: this.data.tasksAttempt + 1, loading: true, error: "" } : { loadAttempt: attempt, tasksAttempt: this.data.tasksAttempt + 1, member: null, points: null, care: null, authority:null, commercialEligible:false,commercialAccessible:false, supportUnread:0, tasks: [], tasksLoading: false, tasksError: "", pointsBalanceClass: "", loading: true, error: "" });
    void this.loadTasks(attempt);
    try {
      const [snapshot,authority,support,commercial]=await Promise.all([
        request<any>({ path: "/v1/bootstrap/profile", cacheTags: ["member", "care", "points"] }),
        authorityProjection().catch(()=>({version:1,capabilities:[],managementAvailable:false} as AuthorityProjection)),
        request<{unreadCount:number}>({path:"/v1/me/support/summary",cacheTags:["support"]}).catch(()=>({unreadCount:0})),
        request<{eligible:boolean;membershipState:string;verifiedOrderCount:number;commission:{netEarnedCents:number}}>({path:"/v1/me/commercial-membership",cacheTags:["member"]}).catch(()=>({eligible:false,membershipState:"none",verifiedOrderCount:0,commission:{netEarnedCents:0}}))
      ]);
      const { member, points, care } = snapshot;
      const memberAvatar=await localMemberAvatar(member.avatar_data_url,member.avatar_revision);
      if (!this.data.pageAlive || this.data.loadAttempt !== attempt) return;
      if (snapshot.businessVersion < this.data.snapshotVersion) return;
      const {avatar_data_url,...safeMember}=member;
      publishMemberIdentity({...safeMember,avatarUrl:memberAvatar,profile_revision:member.profile_revision || 0});
      const normalizedCare = care ?? { phase: "waiting", completed: [], due: null, next: null };
      const progressPercent = Math.min(100, Math.round((normalizedCare.completed?.length ?? 0) / 4 * 100));
      const careView = profileCareView(normalizedCare);
      const pointsBalanceClass = String(points.projection?.available ?? 0).length >= 8 ? "pass-stat__value--compact" : "";
      this.setData({ member:{...safeMember,...memberIdentity()}, memberAvatar:memberIdentity()?.avatarUrl || memberAvatar, points, care: normalizedCare, authority, commercialEligible:commercial.eligible===true,commercialAccessible:commercial.membershipState!=="none"||commercial.verifiedOrderCount>0||commercial.commission.netEarnedCents>0, supportUnread:Math.max(0,Number(support.unreadCount)||0), snapshotVersion: snapshot.businessVersion, progressPercent, pointsBalanceClass, careTitle: careView.title, careCopy: careView.copy, careStatus: careView.status, loading: false, error: "" });
    } catch (error) {
      if (this.data.pageAlive && this.data.loadAttempt === attempt) {
        this.data.tasksAttempt += 1;
        this.setData({ member: null, points: null, care: null, authority:null, commercialEligible:false,commercialAccessible:false, supportUnread:0, tasks: [], tasksLoading: false, tasksError: "", loading: false, error: "会员资料暂时无法同步，请检查网络后重试。旧积分、护理状态与管理权限不会被当作当前权威。" });
      }
    }
  },
  async loadTasks(profileAttempt?: number) {
    const ownerAttempt = profileAttempt ?? this.data.loadAttempt;
    const attempt = this.data.tasksAttempt + 1;
    this.setData({ tasksAttempt: attempt, tasks: [], tasksLoading: true, tasksError: "" });
    try {
      const taskHistory = await request<any[]>({ path: "/v1/me/tasks" });
      if (!this.data.pageAlive || this.data.loadAttempt !== ownerAttempt || this.data.tasksAttempt !== attempt) return;
      const tasks = consumerTaskEntries(taskHistory);
      this.setData({ tasks, tasksError: "" });
    } catch (error) {
      if (this.data.pageAlive && this.data.loadAttempt === ownerAttempt && this.data.tasksAttempt === attempt) this.setData({ tasks: [], tasksError: "活动暂未加载，请重试" });
    } finally {
      if (this.data.pageAlive && this.data.loadAttempt === ownerAttempt && this.data.tasksAttempt === attempt) this.setData({ tasksLoading: false });
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
  openManagement(){this.openRoute("/pages/management/index","navigate","管理中心暂时无法打开");},
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
