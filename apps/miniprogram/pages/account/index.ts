import { cancelAuthentication, clearAuthenticationRedirectSuppression, consumeAuthReturnUrl, navigateAfterAuthentication, request, setSessionToken, suppressAuthenticationRedirectOnce } from "../../services/api";
import { legalDocumentVersions, shouldUseDevelopmentIdentity } from "../../release-config";
import type { LegalDocumentVersions } from "../../release-config";
import { currentChromeStyle, motionDuration } from "../../services/layout";
import { attributePendingShare } from "../../services/share";

function scrollToAccountError() {
  wx.pageScrollTo({ selector: "#account-error-summary", duration: motionDuration(200) });
}

function currentLegalDocuments(): LegalDocumentVersions | null {
  const account = wx.getAccountInfoSync();
  return legalDocumentVersions(account.miniProgram.envVersion, wx.getDeviceInfo().platform, getApp<IAppOption>().globalData.remoteDebugMode);
}

Page({
  data: { chromeStyle: currentChromeStyle(), loading: false, identityCommitStarted: false, leavePromptOpen: false, leaving: false, pendingDestination: "", agreementAccepted: false, legalTextsReady: false, localLegalFixture: false, pageAlive: true, authAttempt: 0, error: "" },
  syncLegalDocuments() {
    const documents = currentLegalDocuments();
    this.setData({
      legalTextsReady: Boolean(documents),
      localLegalFixture: documents?.localFixture === true,
      agreementAccepted: documents ? this.data.agreementAccepted : false
    });
  },
  onLoad() {
    this.data.pageAlive = true;
    this.syncLegalDocuments();
  },
  onShow() { this.syncLegalDocuments(); },
  onResize() { this.setData({ chromeStyle: currentChromeStyle() }); },
  onUnload() {
    this.data.pageAlive = false;
    this.data.authAttempt += 1;
    wx.disableAlertBeforeUnload();
    cancelAuthentication();
  },
  toggleAgreement(event: WechatMiniprogram.CheckboxGroupChange) {
    if (!this.data.legalTextsReady || this.data.loading || this.data.leaving) return;
    this.setData({ agreementAccepted: event.detail.value.includes("accepted"), error: "" });
  },
  async openTerms() {
    const documents = currentLegalDocuments();
    if (!documents) {
      this.setData({ error: "正式用户协议尚未完成法务签字与版本发布，生产身份确认保持关闭。" }, scrollToAccountError);
      return;
    }
    if (documents.localFixture) {
      await wx.showModal({
        title: "本地联调协议说明",
        content: "此入口只用于开发者工具验证按钮、勾选与身份流程，不是正式用户协议，也不会作为生产法务同意证据。",
        showCancel: false,
        confirmText: "我知道了"
      }).catch(() => {
        if (this.data.pageAlive) this.setData({ error: "本地协议说明暂时无法打开，请重试。" }, scrollToAccountError);
      });
      return;
    }
    this.setData({ error: "用户协议阅读入口尚未完成生产验收，身份确认保持关闭。" }, scrollToAccountError);
  },
  openPrivacy() {
    const documents = currentLegalDocuments();
    if (!documents) {
      this.setData({ error: "正式隐私文本尚未完成法务签字与微信后台配置，生产身份确认保持关闭。" }, scrollToAccountError);
      return;
    }
    if (documents.localFixture) {
      void wx.showModal({
        title: "本地联调隐私说明",
        content: "此入口只验证开发者工具中的分层授权交互，不是正式隐私政策，也不会作为生产法务同意证据。",
        showCancel: false,
        confirmText: "我知道了"
      }).catch(() => {
        if (this.data.pageAlive) this.setData({ error: "本地隐私说明暂时无法打开，请重试。" }, scrollToAccountError);
      });
      return;
    }
    wx.openPrivacyContract({ fail: (failure) => {
      if (/cancel/i.test((failure as { errMsg?: string }).errMsg ?? "")) return;
      this.setData({ error: "隐私保护指引暂时无法打开。请确认小程序后台已配置正式版本后重试。" }, scrollToAccountError);
    } });
  },
  async openLegalDocuments() {
    if (this.data.loading || this.data.leaving) return;
    try {
      const choice = await wx.showActionSheet({ itemList: ["查看用户协议", "查看隐私保护指引"] });
      if (!this.data.pageAlive) return;
      if (choice.tapIndex === 0) await this.openTerms();
      else if (choice.tapIndex === 1) this.openPrivacy();
    } catch (error) {
      if (/cancel/i.test((error as { errMsg?: string }).errMsg ?? "")) return;
      if (this.data.pageAlive) this.setData({ error: "协议阅读入口暂时无法打开，请重试。" }, scrollToAccountError);
    }
  },
  async login() {
    if (this.data.loading || this.data.leaving) return;
    if (this.data.pendingDestination && getApp<IAppOption>().globalData.sessionToken) {
      this.setData({ loading: true, error: "" });
      const landed = await navigateAfterAuthentication(this.data.pendingDestination);
      if (this.data.pageAlive) this.setData({ loading: false, error: landed === "target" ? "" : "身份已经确认，但原目标页面仍未打开。请稍后再次尝试。" });
      return;
    }
    if (!this.data.agreementAccepted) {
      this.setData({ error: "请先阅读并同意服务条款与隐私保护指引" }, scrollToAccountError);
      return;
    }
    const legalDocuments = currentLegalDocuments();
    if (!legalDocuments) {
      this.setData({ agreementAccepted: false, legalTextsReady: false, error: "正式用户协议与隐私文本尚未签字发布，生产身份确认保持关闭。你仍可浏览公开社区。" }, scrollToAccountError);
      return;
    }
    const attempt = this.data.authAttempt + 1;
    this.setData({ authAttempt: attempt, loading: true, identityCommitStarted: false, error: "" });
    try {
      const account = wx.getAccountInfoSync();
      const base = { displayName: "CISME 会员", consents: [{ documentType: "privacy", version: legalDocuments.privacy }, { documentType: "terms", version: legalDocuments.terms }] };
      let result: { sessionToken: string };
      if (shouldUseDevelopmentIdentity(account.miniProgram.envVersion, wx.getDeviceInfo().platform, getApp<IAppOption>().globalData.remoteDebugMode)) {
        const deviceId = wx.getStorageSync<string>("cisme.devUserId") || `device-${Date.now()}`;
        wx.setStorageSync("cisme.devUserId", deviceId);
        this.setData({ identityCommitStarted: true });
        wx.enableAlertBeforeUnload({ message: "身份确认请求已经发送。离开页面不会撤回服务端核验，是否继续离开？" });
        result = await request({ path: "/v1/identity/dev", method: "POST", authMode: "public", data: { ...base, externalUserId: deviceId } });
      } else {
        const login = await wx.login();
        if (!this.data.pageAlive || this.data.authAttempt !== attempt) return;
        this.setData({ identityCommitStarted: true });
        wx.enableAlertBeforeUnload({ message: "身份确认请求已经发送。离开页面不会撤回服务端核验，是否继续离开？" });
        result = await request({ path: "/v1/identity/wechat", method: "POST", authMode: "public", data: { ...base, code: login.code } });
      }
      if (!this.data.pageAlive || this.data.authAttempt !== attempt) return;
      setSessionToken(result.sessionToken);
      void attributePendingShare();
      const pendingDestination = consumeAuthReturnUrl();
      this.setData({ pendingDestination });
      wx.disableAlertBeforeUnload();
      const landed = await navigateAfterAuthentication(pendingDestination);
      if (this.data.pageAlive && landed !== "target") this.setData({ error: "身份已经确认，但原目标页面暂时无法打开。请点击主按钮再次打开，不会重复创建会员身份。" }, scrollToAccountError);
    } catch (error) {
      if (this.data.pageAlive && this.data.authAttempt === attempt) this.setData({ error: this.data.identityCommitStarted
        ? "暂未收到身份确认结果，服务端可能已完成核验。请检查网络后重试，本页尚未切换会员身份。"
        : "微信身份确认暂时未完成，请重试。身份核验请求尚未发送。" }, scrollToAccountError);
    } finally {
      if (this.data.authAttempt === attempt) {
        wx.disableAlertBeforeUnload();
        if (this.data.pageAlive) this.setData({ loading: false, identityCommitStarted: false });
      }
    }
  },
  async confirmIdentityLeave(destination: "source" | "community"): Promise<boolean> {
    if (this.data.leavePromptOpen || this.data.leaving) return false;
    if (this.data.loading && this.data.identityCommitStarted) {
      this.setData({ leavePromptOpen: true });
      let confirmation: WechatMiniprogram.ShowModalSuccessCallbackResult;
      try {
        confirmation = await wx.showModal({
          title: "身份请求已发送",
          content: destination === "source"
            ? "返回来源页面不会撤回已提交的身份确认；服务端仍可能完成唯一会员身份核验。是否仍要返回？"
            : "离开页面不会撤回已提交的身份确认；服务端仍可能完成唯一会员身份核验。是否仍要前往公开社区？",
          confirmText: destination === "source" ? "仍然返回" : "仍然离开",
          cancelText: "继续等待"
        });
      } catch {
        if (this.data.pageAlive) this.setData({ error: "离开确认弹层暂时无法打开，请等待身份结果或再次尝试。" }, scrollToAccountError);
        return false;
      } finally {
        if (this.data.pageAlive) this.setData({ leavePromptOpen: false });
      }
      if (!this.data.pageAlive || !confirmation.confirm) return false;
    }
    return true;
  },
  stopAuthenticationWait(suppressSourceRedirect = false) {
    this.data.authAttempt += 1;
    cancelAuthentication();
    const returnUrl = wx.getStorageSync<string>("cisme.authReturnUrl");
    if (suppressSourceRedirect) suppressAuthenticationRedirectOnce(returnUrl);
    wx.removeStorageSync("cisme.authReturnUrl");
    wx.disableAlertBeforeUnload();
    if (this.data.pageAlive) this.setData({ loading: false, identityCommitStarted: false, leavePromptOpen: false, leaving: true });
  },
  async back() {
    if (!await this.confirmIdentityLeave("source")) return;
    if (!this.data.pageAlive || this.data.leaving) return;
    this.stopAuthenticationWait(true);
    wx.navigateBack({ delta: 1, fail: () => {
      clearAuthenticationRedirectSuppression();
      wx.switchTab({ url: "/pages/community/index", fail: () => {
        if (this.data.pageAlive) this.setData({ leaving: false, error: "来源页面与公开社区均暂时无法打开。身份确认已停止等待，请稍后重试。" }, scrollToAccountError);
      } });
    } });
  },
  async browseCommunity() {
    if (!await this.confirmIdentityLeave("community")) return;
    if (!this.data.pageAlive || this.data.leaving) return;
    this.stopAuthenticationWait();
    wx.switchTab({ url: "/pages/community/index", fail: () => {
      if (this.data.pageAlive) this.setData({ leaving: false, error: "公开社区暂时无法打开，请稍后重试。身份确认已停止等待。" }, scrollToAccountError);
    } });
  }
});
