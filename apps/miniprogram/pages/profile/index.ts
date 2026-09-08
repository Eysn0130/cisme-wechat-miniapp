import { clearAuthenticationRedirectSuppression, request } from "../../services/api";
import { currentChromeStyle } from "../../services/layout";
import { consumerTaskEntries } from "../../services/task-entry";

function profileCareView(care: any): { title: string; copy: string; status: string } {
  const completed = care?.completed?.length ?? 0;
  const next = care?.due || care?.next || "—";
  if (care?.phase === "planned") return { title: "护理周期待开始", copy: `${completed} / 4 个里程碑已完成 · 下一节点 ${next}`, status: "待用户确认开始" };
  if (care?.phase === "active") return { title: "护理周期进行中", copy: `${completed} / 4 个里程碑已完成 · 下一节点 ${next}`, status: "护理进行中" };
  if (care?.phase === "paused") return { title: "护理周期已暂停", copy: `${completed} / 4 个里程碑已完成 · 恢复后继续 ${next}`, status: "护理已暂停" };
  if (care?.phase === "terminated") return { title: "护理周期已终止", copy: `${completed} / 4 个里程碑已完成 · 历史护理事实已归档`, status: "周期已终止" };
  if (care?.phase === "completed") return { title: "护理周期已完成", copy: "4 / 4 个里程碑已完成 · 护理事实已归档", status: "周期已完成" };
  return { title: "护理周期待确认", copy: `${completed} / 4 个里程碑已完成 · 下一节点 ${next}`, status: "待资格确认" };
}

Page({
  data: { chromeStyle: currentChromeStyle(), member: null as any, points: null as any, care: null as any, tasks: [] as any[], tasksLoading: false, tasksError: "", progressPercent: 0, pointsBalanceClass: "", careTitle: "", careCopy: "", careStatus: "", memberCode: "", loading: true, navigating: false, loadAttempt: 0, tasksAttempt: 0, pageAlive: true, error: "" },
  onLoad() { this.data.pageAlive = true; },
  onResize() { this.setData({ chromeStyle: currentChromeStyle() }); },
  onShow() { this.data.pageAlive = true; this.setData({ navigating: false }); const tab = this.getTabBar?.(); if (tab) tab.setData({ active: 3, externalBusy: false }); tab?.syncActive?.(3); void this.load(); },
  onHide() { this.data.loadAttempt += 1; this.data.tasksAttempt += 1; },
  onUnload() { this.data.pageAlive = false; this.data.loadAttempt += 1; this.data.tasksAttempt += 1; },
  async load(event?: WechatMiniprogram.TouchEvent) {
    if (event?.type) clearAuthenticationRedirectSuppression();
    const attempt = this.data.loadAttempt + 1;
    this.setData({ loadAttempt: attempt, tasksAttempt: this.data.tasksAttempt + 1, member: null, points: null, care: null, tasks: [], tasksLoading: false, tasksError: "", pointsBalanceClass: "", loading: true, error: "" });
    try {
      const [member, points, care] = await Promise.all([
        request<any>({ path: "/v1/me" }),
        request<any>({ path: "/v1/me/points" }),
        request<any>({ path: "/v1/me/care" })
      ]);
      if (!this.data.pageAlive || this.data.loadAttempt !== attempt) return;
      const normalizedCare = care ?? { phase: "waiting", completed: [], due: null, next: null };
      const progressPercent = Math.min(100, Math.round((normalizedCare.completed?.length ?? 0) / 4 * 100));
      const careView = profileCareView(normalizedCare);
      const pointsBalanceClass = String(points.projection?.available ?? 0).length >= 8 ? "pass-stat__value--compact" : "";
      this.setData({ member, points, care: normalizedCare, progressPercent, pointsBalanceClass, careTitle: careView.title, careCopy: careView.copy, careStatus: careView.status, memberCode: String(member.id ?? "").slice(0, 8).toUpperCase(), loading: false, error: "" });
      void this.loadTasks(attempt);
    } catch (error) {
      if (this.data.pageAlive && this.data.loadAttempt === attempt) this.setData({ member: null, points: null, care: null, tasks: [], tasksLoading: false, tasksError: "", loading: false, error: "会员资料暂时无法同步，请检查网络后重试。旧积分与护理状态不会被当作当前权威。" });
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
      if (this.data.pageAlive && this.data.loadAttempt === ownerAttempt && this.data.tasksAttempt === attempt) this.setData({ tasks: [], tasksError: "有效邀请暂时无法同步" });
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
  openPoints() { this.openRoute("/pages/points/index", "navigate", "积分账本暂时无法打开"); },
  openSettings() { this.openRoute("/pages/settings/index", "navigate", "设置与隐私暂时无法打开"); },
  openShop() { this.openRoute("/pages/shop/index", "navigate", "商品目录暂时无法打开"); },
  openInvite() { this.openRoute("/pages/invite/index", "navigate", "邀请页面暂时无法打开"); },
  openTasks() {
    if (this.data.tasksLoading || this.data.navigating) return;
    if (this.data.tasksError) { void this.loadTasks(); return; }
    const task = this.data.tasks[0];
    if (this.data.tasks.length > 1) { this.openRoute("/pages/community/index", "tab", "投稿列表暂时无法打开"); return; }
    if (task) this.openRoute(`/pages/task/index?id=${task.id}`, "navigate", "投稿与邀请暂时无法打开");
    else this.openRoute("/pages/community/index", "tab", "社区暂时无法打开");
  },
});
