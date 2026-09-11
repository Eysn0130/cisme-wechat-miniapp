import { requireMemberAccess } from "../../services/api";
import { clearAuthenticationRedirectSuppression, request } from "../../services/api";
import { currentChromeStyle } from "../../services/layout";

const entryLabels: Record<string, string> = {
  grant_frozen: "奖励已进入冻结期",
  unfreeze: "冻结积分已转为可用",
  expire: "积分已按规则到期",
  reversal: "积分已完成冲正",
  debt_created: "积分欠分已登记",
  debt_offset: "可用积分已冲抵欠分"
};

function sourceLabel(businessKey: string): string {
  if (businessKey.startsWith("grant:")) return "投稿审核奖励";
  if (businessKey.startsWith("points-action:")) return "财务复核动作";
  if (businessKey.startsWith("debt:")) return "账本冲抵规则";
  return "可追溯业务事实";
}

function pointsInteger(value: unknown, nonnegative = false): number {
  if ((typeof value !== "number" && typeof value !== "string") || (typeof value === "string" && !/^-?\d+$/.test(value))) throw new Error("POINTS_VALUE_INVALID");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || (nonnegative && parsed < 0)) throw new Error("POINTS_VALUE_INVALID");
  return parsed;
}

Page({
  data: { chromeStyle: currentChromeStyle(), points: null as any, balanceClass: "", loading: true, navigating: false, loadAttempt: 0, pageAlive: true, error: "" },
  onLoad() { this.data.pageAlive = true; },
  onResize() { this.setData({ chromeStyle: currentChromeStyle() }); },
  onShow() { if (!requireMemberAccess()) return; this.data.pageAlive = true; this.setData({ navigating: false }); void this.load(); },
  onHide() { this.data.loadAttempt += 1; },
  onUnload() { this.data.pageAlive = false; this.data.loadAttempt += 1; },
  async load(event?: WechatMiniprogram.TouchEvent) {
    if (event?.type) clearAuthenticationRedirectSuppression();
    const attempt = this.data.loadAttempt + 1;
    this.setData({ loadAttempt: attempt, points: null, balanceClass: "", loading: true, error: "" });
    try {
      const points = await request<any>({ path: "/v1/me/points" });
      if (!this.data.pageAlive || this.data.loadAttempt !== attempt) return;
      if (!points?.projection || !Array.isArray(points.entries)) throw new Error("POINTS_PAYLOAD_INVALID");
      points.projection = {
        ...points.projection,
        available: pointsInteger(points.projection.available, true),
        frozen: pointsInteger(points.projection.frozen, true),
        debt: pointsInteger(points.projection.debt, true)
      };
      points.entries = points.entries.map((entry: any) => {
        const amount = pointsInteger(entry.available_delta ?? 0) + pointsInteger(entry.frozen_delta ?? 0) - pointsInteger(entry.debt_delta ?? 0);
        const businessKey = String(entry.business_key ?? "");
        return { ...entry, displayTitle: entryLabels[entry.entry_type] ?? "积分账本变更", displaySource: sourceLabel(businessKey), displayAmount: `${amount > 0 ? "+" : ""}${amount}`, displayDate: String(entry.occurred_at ?? "").slice(0, 10) };
      });
      const balanceClass = String(points.projection.available).length >= 8 ? "points-hero__balance--compact" : "";
      if (this.data.pageAlive && this.data.loadAttempt === attempt) this.setData({ points, balanceClass, loading: false, error: "" });
    }
    catch (error) { if (this.data.pageAlive && this.data.loadAttempt === attempt) this.setData({ points: null, balanceClass: "", loading: false, error: "积分账本暂时无法同步，请检查网络后重试。页面不会显示缓存余额。" }); }
  },
  openShop() {
    if (this.data.navigating) return;
    this.setData({ navigating: true });
    wx.navigateTo({
      url: "/pages/shop/index",
      fail: () => {
        if (this.data.pageAlive) this.setData({ navigating: false });
        wx.showToast({ title: "商品目录暂时无法打开", icon: "none" });
      }
    });
  },
  back() { wx.navigateBack({ fail: () => wx.switchTab({ url: "/pages/profile/index" }) }); }
});
