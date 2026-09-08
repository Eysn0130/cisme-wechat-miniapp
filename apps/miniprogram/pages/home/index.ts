import { beginAuthentication, request, resumeAuthentication } from "../../services/api";

interface CareView { id: string; version: number; phase: string; startedOn: string | null; timezone: string; due: string | null; next: string | null; completed: string[]; records: Array<{ milestone: string; completedAt: string }> }
interface MemberView { display_name: string }

const protocolSteps = [
  { code: "00", label: "净澈" },
  { code: "01", label: "清洁" },
  { code: "02", label: "修护" },
  { code: "03", label: "精护" }
];

function homeView(care: CareView | null, displayName = "CISME 会员") {
  const phase = care?.phase ?? "waiting";
  const completed = phase === "completed";
  const activeIndex = phase === "planned" || phase === "active" ? 1 : phase === "waiting" ? 0 : -1;
  const steps = protocolSteps.map((step, index) => ({ ...step, done: completed || index < activeIndex, active: index === activeIndex }));
  const activeStep = steps.find((step) => step.active);
  const protocol = activeStep
    ? { protocolCode: activeStep.code, protocolLabel: activeStep.label, protocolAria: `当前护理步骤，${activeStep.code} ${activeStep.label}` }
    : phase === "completed"
      ? { protocolCode: "✓", protocolLabel: "本周期护理完成", protocolAria: "本周期护理步骤已全部完成" }
      : phase === "paused"
        ? { protocolCode: "—", protocolLabel: "护理周期已暂停", protocolAria: "护理周期已暂停，当前没有进行中的护理步骤" }
        : { protocolCode: "—", protocolLabel: "当前没有护理步骤", protocolAria: "当前没有进行中的护理步骤" };
  const greeting = `晚上好，${displayName}`;
  const greetingClass = displayName.length > 24 ? "care-greeting--very-long" : displayName.length > 12 ? "care-greeting--long" : "";
  if (!care) return { greeting, greetingClass, schedule: "28 天护理周期", action: "等待体验资格确认", actionable: false, note: "签收或体验资格确认后，才会生成待开始的护理周期", steps, ...protocol };
  if (phase === "planned") return { greeting, greetingClass, schedule: "待用户确认开始", action: "确认开始新的护理周期", actionable: true, note: "确认开始后才记录开始日与 D1", steps, ...protocol };
  if (phase === "paused") return { greeting, greetingClass, schedule: "护理周期已暂停", action: "查看周期管理", actionable: true, note: "已保存护理事实不受影响；恢复与终止请在记录页确认", steps, ...protocol };
  if (phase === "terminated") return { greeting, greetingClass, schedule: "护理周期已终止", action: "查看护理记录", actionable: true, note: "历史护理事实已归档；终止不会自动触发退款或积分变化", steps, ...protocol };
  if (phase === "completed") return { greeting, greetingClass, schedule: "本周期 4 个里程碑已完成", action: "查看护理记录", actionable: true, note: "历史护理事实已保存，可从记录页回看", steps, ...protocol };
  const milestone = care.due ?? care.next ?? "日常";
  return { greeting, greetingClass, schedule: `${milestone} · 今日护理`, action: care.due ? `完成 ${care.due} 护理记录` : "查看护理进度", actionable: true, note: care.due ? "本次只保存护理事实；积分规则未签字时不会生成积分" : `当前无到期里程碑 · 下一节点 ${care.next ?? "待新周期"}`, steps, ...protocol };
}

Page({
  data: { care: null as CareView | null, view: homeView(null), loading: true, working: false, authorityAvailable: false, needsAuthentication: false, loadAttempt: 0, pageAlive: true, error: "" },
  onLoad() { this.data.pageAlive = true; },
  onShow() {
    const tab = this.getTabBar?.(); if (tab) tab.setData({ active: 0 });
    void this.load();
  },
  onUnload() { this.data.pageAlive = false; this.data.loadAttempt += 1; wx.disableAlertBeforeUnload(); },
  async load(preserveSnapshot = false): Promise<boolean> {
    const attempt = this.data.loadAttempt + 1;
    this.setData(preserveSnapshot && this.data.authorityAvailable
      ? { loadAttempt: attempt, loading: true, error: "" }
      : { loadAttempt: attempt, care: null, view: homeView(null), loading: true, authorityAvailable: false, needsAuthentication: false, error: "" });
    if (!getApp<IAppOption>().globalData.sessionToken) {
      this.setData({ care: null, view: homeView(null), loading: false, authorityAvailable: false, needsAuthentication: true, error: "" });
      beginAuthentication("/pages/home/index");
      return false;
    }
    try {
      const [member, care] = await Promise.all([
        request<MemberView>({ path: "/v1/me" }),
        request<CareView | null>({ path: "/v1/me/care" })
      ]);
      if (!this.data.pageAlive || this.data.loadAttempt !== attempt) return false;
      this.setData({ care, view: homeView(care, member.display_name || "CISME 会员"), authorityAvailable: true, needsAuthentication: false });
      return true;
    }
    catch (error) {
      if (this.data.pageAlive && this.data.loadAttempt === attempt) this.setData({ care: null, view: homeView(null), authorityAvailable: false, needsAuthentication: false, error: "护理状态暂时无法同步，请检查网络后重试。页面不会用旧状态开放护理操作。" });
      return false;
    }
    finally { if (this.data.pageAlive && this.data.loadAttempt === attempt) this.setData({ loading: false }); }
  },
  retryLoad() { void this.load(); },
  retryAuthentication() { resumeAuthentication("/pages/home/index"); },
  async primaryAction() {
    if (this.data.loading || !this.data.authorityAvailable) { wx.showToast({ title: "护理状态尚未确认，请重试", icon: "none" }); return; }
    const care = this.data.care;
    if (!care) { wx.showToast({ title: "体验资格确认后开放", icon: "none" }); return; }
    if (care.phase === "planned") { await this.act(`/v1/care-cycles/${care.id}/activate`, `care-activate-${care.id}-v${care.version}`, care.version); return; }
    if (care.phase === "active" && care.due) { await this.act(`/v1/care-cycles/${care.id}/milestones/${care.due}/complete`, `care-milestone-${care.id}-${care.due}-v${care.version}`, care.version); return; }
    wx.switchTab({ url: "/pages/records/index", fail: () => wx.showToast({ title: "护理记录页暂时无法打开", icon: "none" }) });
  },
  async act(path: string, idempotencyKey: string, expectedVersion: number) {
    if (this.data.working || !this.data.authorityAvailable) return;
    this.setData({ working: true, error: "" });
    const tab = this.getTabBar?.(); if (tab) tab.setData({ externalBusy: true });
    wx.enableAlertBeforeUnload({ message: "护理操作已经发送，离开不会撤回服务端处理。请等待最新周期状态确认。" });
    try {
      await request({ path, method: "POST", idempotencyKey, data: { expectedVersion } });
      if (this.data.pageAlive) {
        const refreshed = await this.load(true);
        if (this.data.pageAlive && !refreshed) this.setData({ error: "护理操作已受理，但最新周期暂时无法确认。页面已锁定护理动作，请刷新后核对。" });
      }
    }
    catch (error) {
      if (!this.data.pageAlive) return;
      const refreshed = await this.load(true);
      if (this.data.pageAlive) this.setData({ error: refreshed ? "护理操作未完成。已重新核对当前周期，请确认状态后再试。" : "护理操作结果与最新周期均暂时无法确认。页面已锁定护理动作，请刷新后核对。" });
    }
    finally {
      if (this.data.pageAlive) this.setData({ working: false });
      const currentTab = this.getTabBar?.(); if (currentTab) currentTab.setData({ externalBusy: false });
      wx.disableAlertBeforeUnload();
    }
  }
});
