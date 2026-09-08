import { clearAuthenticationRedirectSuppression, request, resumeAuthentication, setSessionToken } from "../../services/api";
import { currentChromeStyle, motionDuration } from "../../services/layout";

function scrollToSettingsError() {
  wx.pageScrollTo({ selector: "#settings-error-summary", duration: motionDuration(200) });
}

const consentPurposeLabels: Record<string, string> = {
  content_storage: "安全存储投稿证据",
  human_review: "人工审核与风险复核",
  feed_readonly: "通过后只读精选展示"
};

function isAuthenticationFailure(error: unknown): boolean {
  const problem = error as { status?: number; code?: string };
  return problem.status === 401 || problem.code === "MEMBER_NOT_FOUND";
}

Page({
  data: { chromeStyle: currentChromeStyle(), consents: [] as any[], loading: true, confirmingLogout: false, loggingOut: false, sessionStatus: "unknown", workingConsentId: "", loadAttempt: 0, revokeAttempt: 0, pageAlive: true, leaving: false, operationStatus: "", errorAction: "load" as "load" | "revoke" | "auth", error: "" },
  onLoad() { this.data.pageAlive = true; },
  onResize() { this.setData({ chromeStyle: currentChromeStyle() }); },
  onShow() { this.setData({ leaving: false }); void this.load(); },
  onUnload() {
    this.data.pageAlive = false;
    this.data.loadAttempt += 1;
    this.data.revokeAttempt += 1;
    wx.disableAlertBeforeUnload();
  },
  async load(event?: WechatMiniprogram.TouchEvent) {
    if (event?.type) clearAuthenticationRedirectSuppression();
    const attempt = this.data.loadAttempt + 1;
    this.setData({ loadAttempt: attempt, consents: [], loading: true, sessionStatus: "unknown", errorAction: "load", error: "" });
    try {
      const consents = await request<any[]>({ path: "/v1/me/consents" });
      if (!this.data.pageAlive || this.data.loadAttempt !== attempt) return;
      this.setData({ consents: consents.map((item) => ({ ...item, purposeLabel: consentPurposeLabels[item.purpose] ?? "其他已记录用途许可" })), sessionStatus: "valid", error: "" });
    } catch (error) {
      if (!this.data.pageAlive || this.data.loadAttempt !== attempt) return;
      const invalid = isAuthenticationFailure(error);
      this.setData({ consents: [], sessionStatus: invalid ? "invalid" : "unknown", errorAction: invalid ? "auth" : "load", error: invalid ? "当前会话已失效。重新登录后会回到本页，不会改写已有许可。" : "许可记录暂时无法加载，请检查网络后重试。" }, scrollToSettingsError);
    } finally {
      if (this.data.pageAlive && this.data.loadAttempt === attempt) this.setData({ loading: false });
    }
  },
  reauthenticate() { resumeAuthentication("/pages/settings/index"); },
  async revoke(event: WechatMiniprogram.TouchEvent) {
    const id = String(event.currentTarget.dataset.id ?? "");
    const purpose = String(event.currentTarget.dataset.purpose ?? "这项用途许可");
    if (!id || !this.data.pageAlive || this.data.leaving || this.data.workingConsentId || this.data.confirmingLogout || this.data.loggingOut) return;
    let confirmation: { confirm: boolean };
    try {
      confirmation = await wx.showModal({ title: `确认撤回“${purpose}”？`, content: `撤回“${purpose}”会立即阻止新增使用，但不会改写历史审核与积分证据。`, confirmText: "确认撤回" });
    } catch {
      if (this.data.pageAlive) this.setData({ errorAction: "revoke", error: `“${purpose}”撤回确认窗口暂时无法打开，请刷新许可状态后再试。` }, scrollToSettingsError);
      return;
    }
    if (!confirmation.confirm || !this.data.pageAlive || this.data.workingConsentId) return;
    const attempt = this.data.revokeAttempt + 1;
    this.setData({ revokeAttempt: attempt, workingConsentId: id, operationStatus: "正在提交撤回请求…", error: "" });
    wx.enableAlertBeforeUnload({ message: "用途许可撤回正在确认，请等待结果后再离开。" });
    try {
      await request({ path: `/v1/consents/${id}/revoke`, method: "POST", idempotencyKey: `consent-revoke-${id}`, data: { reason: "MEMBER_REQUEST" } });
      if (!this.data.pageAlive || this.data.revokeAttempt !== attempt) return;
      await this.load();
      if (this.data.pageAlive && this.data.revokeAttempt === attempt) this.setData({ operationStatus: "用途许可撤回请求已受理，不再产生新增使用" });
    } catch (error) {
      if (this.data.pageAlive && this.data.revokeAttempt === attempt) this.setData({ operationStatus: "", errorAction: "revoke", error: `“${purpose}”撤回请求尚未确认。请刷新许可状态后再决定是否重试。` }, scrollToSettingsError);
    } finally {
      if (this.data.pageAlive && this.data.revokeAttempt === attempt) {
        this.setData({ workingConsentId: "" });
        wx.disableAlertBeforeUnload();
      }
    }
  },
  async logout() {
    if (!this.data.pageAlive || this.data.leaving) return;
    if (this.data.workingConsentId || this.data.confirmingLogout || this.data.loggingOut) { wx.showToast({ title: this.data.loggingOut ? "正在退出当前账号" : this.data.confirmingLogout ? "退出确认窗口已打开" : "许可撤回确认中，请稍候", icon: "none" }); return; }
    this.setData({ confirmingLogout: true, error: "" });
    let confirmation: { confirm: boolean };
    try {
      confirmation = await wx.showModal({ title: "确认退出当前账号？", content: "本机登录会话将被清除；护理记录、投稿、许可与积分账本不会被删除。", confirmText: "确认退出" });
    } catch {
      if (this.data.pageAlive) this.setData({ confirmingLogout: false, errorAction: "auth", error: "退出确认窗口暂时无法打开，请稍后重试。" }, scrollToSettingsError);
      return;
    }
    if (this.data.pageAlive) this.setData({ confirmingLogout: false });
    if (!confirmation.confirm || !this.data.pageAlive) return;
    this.data.loadAttempt += 1;
    setSessionToken("");
    this.setData({ loggingOut: true, loading: false, consents: [], sessionStatus: "invalid", operationStatus: "正在安全退出当前账号…", error: "" });
    wx.reLaunch({
      url: "/pages/account/index",
      fail: () => {
        if (this.data.pageAlive) this.setData({ loggingOut: false, operationStatus: "", errorAction: "auth", error: "会话已经安全退出，但登录页面暂时无法打开。请点击下方按钮重新登录。" }, scrollToSettingsError);
      }
    });
  },
  back() {
    if (!this.data.pageAlive || this.data.leaving) return;
    if (this.data.workingConsentId || this.data.confirmingLogout || this.data.loggingOut) { wx.showToast({ title: this.data.loggingOut ? "正在退出当前账号" : this.data.confirmingLogout ? "请先完成退出确认" : "许可撤回确认中，请稍候", icon: "none" }); return; }
    this.setData({ leaving: true });
    wx.navigateBack({ fail: () => {
      if (this.data.pageAlive) wx.switchTab({ url: "/pages/profile/index", fail: () => {
      if (!this.data.pageAlive) return;
      this.setData({ leaving: false });
      wx.showToast({ title: "暂时无法返回，请重试", icon: "none" });
    } });
    } });
  }
});
