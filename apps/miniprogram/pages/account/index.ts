import { publishMemberIdentity } from "../../services/member-identity";
import { defaultMemberAvatar, localMemberAvatar, prepareAvatarUpload } from "../../services/member-avatar";
import { cancelAuthentication, consumeAuthReturnUrl, navigateAfterAuthentication, request, setSessionToken, suppressAuthenticationRedirectOnce } from "../../services/api";
import { legalDocumentVersions, shouldUseDevelopmentIdentity } from "../../release-config";
import type { LegalDocumentVersions } from "../../release-config";
import { currentChromeStyle, motionDuration } from "../../services/layout";
import { attributePendingShare } from "../../services/share";

function scrollToAccountError() {
  wx.pageScrollTo({ selector: "#account-error-summary", duration: motionDuration(200) });
}

function currentLegalDocuments(): LegalDocumentVersions | null {
  const account = wx.getAccountInfoSync();
  const runtime = getApp<IAppOption>().globalData;
  return legalDocumentVersions(account.miniProgram.envVersion, wx.getDeviceInfo().platform, runtime.remoteDebugMode, Boolean(runtime.cloudFunction));
}

Page({
  data: { loginStage:"login", avatarBusy:false, avatarUrl:defaultMemberAvatar, phoneBindingEnabled:false, capabilityAttempt:0, notice:"", serverLegalDocuments: null as LegalDocumentVersions | null, legalAttempt: 0, chromeStyle: currentChromeStyle(), loading: false, identityCommitStarted: false, leavePromptOpen: false, leaving: false, pendingDestination: "", crossBorderAccepted: false, crossBorderRequired: false, agreementAccepted: false, legalTextsReady: false, legalLoading: true, localLegalFixture: false, pageAlive: true, authAttempt: 0, error: "" },
  documents(): LegalDocumentVersions | null { return currentLegalDocuments() || this.data.serverLegalDocuments; },
  async syncLegalDocuments() {
    const previous = this.documents();
    const attempt = ++this.data.legalAttempt;
    this.setData({legalLoading:true});
    let documents = currentLegalDocuments();
    if (!documents) {
      try {
        const response = await request<{ready:boolean;documents:Array<{document_type:string;version:string}>}>({path:"/v1/legal",authMode:"public"});
        if (!this.data.pageAlive || attempt !== this.data.legalAttempt) return;
        const privacy = response.documents.find(item=>item.document_type === "privacy")?.version;
        const terms = response.documents.find(item=>item.document_type === "terms")?.version;
        const crossBorder = response.documents.find(item=>item.document_type === "cross_border")?.version;
        documents = response.ready && privacy && terms ? {privacy,terms,crossBorder,localFixture:false} : null;
      } catch { documents = null; }
      if (!this.data.pageAlive || attempt !== this.data.legalAttempt) return;
      this.setData({ serverLegalDocuments: documents });
    }
    this.setData({
      legalTextsReady: Boolean(documents),
      legalLoading: false,
      crossBorderRequired: Boolean(documents?.crossBorder),
      crossBorderAccepted: documents && previous?.crossBorder === documents.crossBorder ? this.data.crossBorderAccepted : false,
      localLegalFixture: documents?.localFixture === true,
      agreementAccepted: documents && previous?.privacy === documents.privacy && previous?.terms === documents.terms ? this.data.agreementAccepted : false
    });
  },
  onLoad(query: Record<string, string | undefined>) {
    this.data.pageAlive = true;
    // The first route is a lightweight entry gate; explicit account visits stay here.
    if (!query?.intent && getCurrentPages().length === 1) {
      const token = getApp<IAppOption>().globalData.sessionToken;
      const guest = wx.getStorageSync<boolean>("cisme.guestBrowsing");
      if (token || guest) {
        this.data.leaving = true;
        wx.switchTab({ url: token ? "/pages/home/index" : "/pages/community/index", fail: () => { this.setData({leaving:false}); void this.syncLegalDocuments(); } });
      }
    }
  },
  onShow() { if (this.data.leaving) return; if(getApp<IAppOption>().globalData.sessionToken)this.setData({pendingDestination:this.data.pendingDestination || "/pages/profile/index"}); void this.syncLegalDocuments(); void this.loadCapabilities(); },
  async loadMemberIdentity() {
    const token = getApp<IAppOption>().globalData.sessionToken;
    if (!token) return;
    try {
      const me = await request<any>({path:"/v1/me",authMode:"optional"});
      const avatarUrl = await localMemberAvatar(me.avatar_data_url,me.avatar_revision);
      if(token !== getApp<IAppOption>().globalData.sessionToken)return;
      publishMemberIdentity({id:me.id,display_name:me.display_name,avatarUrl,profile_revision:me.profile_revision || 0,completed_at:me.completed_at,public_status:me.public_status,phone_masked:me.phone_masked});
      return {...me,avatarUrl};
    } catch { /* Destination pages refresh independently; profile sync never blocks login. */ }
  },
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
  toggleCrossBorder(event: WechatMiniprogram.CheckboxGroupChange) {
    if (!this.data.legalTextsReady || this.data.loading || this.data.leaving) return;
    this.setData({ crossBorderAccepted: event.detail.value.includes("accepted"), error: "" });
  },
  openCrossBorder() { wx.navigateTo({url:"/pages/legal/index?type=cross_border"}); },
  async openTerms() {
    const documents = this.documents();
    if (!documents) {
      this.setData({ error: "用户协议正在准备，发布后即可自主注册。" }, scrollToAccountError);
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
    wx.navigateTo({ url: "/pages/legal/index?type=terms", fail: () => this.setData({error:"用户协议暂时无法打开，请重试。"},scrollToAccountError) });
  },
  openPrivacy() {
    const documents = this.documents();
    if (!documents) {
      this.setData({ error: "隐私指引正在准备，发布后即可自主注册。" }, scrollToAccountError);
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
    wx.navigateTo({ url: "/pages/legal/index?type=privacy", fail: () => this.setData({error:"隐私指引暂时无法打开，请重试。"},scrollToAccountError) });
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
  async loadCapabilities() {
    const attempt=++this.data.capabilityAttempt;
    try {
      const result=await request<{phoneBindingEnabled:boolean}>({path:"/v1/identity/capabilities",authMode:"public"});
      if(this.data.pageAlive && attempt===this.data.capabilityAttempt && !this.data.loading)this.setData({phoneBindingEnabled:result.phoneBindingEnabled === true});
    } catch { if(this.data.pageAlive && attempt===this.data.capabilityAttempt)this.setData({phoneBindingEnabled:false}); }
  },
  loginTap() {
    // Native open-type owns the gesture when enabled. Do not race wx.login
    // against the native authorization result or avatar picker callback.
    if(this.data.loginStage === "avatar" || (this.data.phoneBindingEnabled && !this.data.pendingDestination))return;
    void this.login();
  },
  async loginWithPhone(event:WechatMiniprogram.CustomEvent) {
    if(!this.data.pageAlive || this.data.loading || this.data.leaving || this.data.loginStage !== "login")return;
    const code=typeof event.detail.code === "string" ? event.detail.code : undefined;
    this.setData({notice:code ? "" : /112|privacy|not configured/i.test(event.detail.errMsg || "") ? "微信手机号授权暂未开放，先登录使用；稍后可在设置中绑定。" : "本次未提供手机号，仍可登录使用。"});
    await this.login(code);
  },
  async continueLogin() {
    if(!this.data.pageAlive || this.data.leaving || this.data.avatarBusy)return;
    const token=getApp<IAppOption>().globalData.sessionToken;
    if(!token)return;
    this.setData({loading:true,error:""});
    const landed=await navigateAfterAuthentication(this.data.pendingDestination || "/pages/home/index");
    if(this.data.pageAlive && token===getApp<IAppOption>().globalData.sessionToken)this.setData({loading:false,error:landed === "target" ? "" : "已登录，请再次点击继续。"});
  },
  async chooseLoginAvatar(event:WechatMiniprogram.CustomEvent) {
    if(!this.data.pageAlive || this.data.loading || this.data.leaving || this.data.avatarBusy || this.data.loginStage !== "avatar" || !event.detail.avatarUrl)return;
    const token=getApp<IAppOption>().globalData.sessionToken;
    if(!token)return;
    this.setData({avatarBusy:true,error:""});
    try {
      const avatarDataUrl=await prepareAvatarUpload(this as unknown as WechatMiniprogram.Page.TrivialInstance,event.detail.avatarUrl);
      if(!this.data.pageAlive || token!==getApp<IAppOption>().globalData.sessionToken)return;
      const profile=await request<any>({path:"/v1/me/profile"});
      if(!this.data.pageAlive || token!==getApp<IAppOption>().globalData.sessionToken)return;
      const saved=await request<any>({path:"/v1/me/profile",method:"PUT",data:{displayName:profile.display_name,expectedVersion:profile.profile_revision || 0,avatarDataUrl}});
      const avatarUrl=await localMemberAvatar(saved.avatar_data_url,saved.avatar_revision);
      if(!this.data.pageAlive || token!==getApp<IAppOption>().globalData.sessionToken)return;
      publishMemberIdentity({id:saved.id,display_name:saved.display_name,avatarUrl,profile_revision:saved.profile_revision,completed_at:saved.completed_at,public_status:saved.public_status});
      this.setData({avatarUrl,avatarBusy:false});
      await this.continueLogin();
    } catch(error) {
      if(this.data.pageAlive && token===getApp<IAppOption>().globalData.sessionToken)this.setData({error:(error as {title?:string}).title || "头像未保存，请重新选择；也可以稍后设置。"});
    } finally { if(this.data.pageAlive)this.setData({avatarBusy:false}); }
  },
  async login(phoneCode?:string) {
    if (this.data.loading || this.data.leaving || this.data.avatarBusy || !this.data.pageAlive) return;
    if (this.data.pendingDestination && getApp<IAppOption>().globalData.sessionToken) {
      this.setData({ loading: true, error: "" });
      const token=getApp<IAppOption>().globalData.sessionToken;
      const me=await this.loadMemberIdentity();
      if(!this.data.pageAlive || this.data.leaving || token!==getApp<IAppOption>().globalData.sessionToken)return;
      if(!me?.avatar_data_url) { this.setData({loading:false,loginStage:"avatar"}); return; }
      const landed = await navigateAfterAuthentication(this.data.pendingDestination);
      if (this.data.pageAlive) this.setData({ loading: false, error: landed === "target" ? "" : "身份已经确认，但原目标页面仍未打开。请稍后再次尝试。" });
      return;
    }
    if (!this.data.agreementAccepted) {
      this.setData({ error: "请先阅读并同意服务条款与隐私保护指引" }, scrollToAccountError);
      return;
    }
    const legalDocuments = this.documents();
    if (!legalDocuments) {
      this.setData({ agreementAccepted: false, legalTextsReady: false, error: "请先阅读当前用户协议与隐私指引。你仍可浏览公开社区。" }, scrollToAccountError);
      return;
    }
    if (legalDocuments.crossBorder && !this.data.crossBorderAccepted) {
      this.setData({error:"请阅读境外存储告知并单独选择是否同意；不同意仍可浏览公开社区。"},scrollToAccountError);
      return;
    }
    const attempt = this.data.authAttempt + 1;
    this.setData({ authAttempt: attempt, loading: true, identityCommitStarted: false, error: "" });
    try {
      const account = wx.getAccountInfoSync();
      const base = { displayName: "CISME 会员", consents: [{ documentType: "privacy", version: legalDocuments.privacy }, { documentType: "terms", version: legalDocuments.terms }] };
      if (legalDocuments.crossBorder) base.consents.push({documentType:"cross_border",version:legalDocuments.crossBorder});
      let result: { sessionToken: string; phoneBindingEnabled?: boolean };
      const runtime = getApp<IAppOption>().globalData;
      if (shouldUseDevelopmentIdentity(account.miniProgram.envVersion, wx.getDeviceInfo().platform, runtime.remoteDebugMode, Boolean(runtime.cloudFunction))) {
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
      if(phoneCode) {
        try { await request({path:"/v1/me/phone",method:"POST",data:{code:phoneCode}}); }
        catch(error) { if(this.data.pageAlive)this.setData({notice:(error as {title?:string}).title || "手机号尚未绑定，账号已登录，可稍后在设置中重试。"}); }
      }
      if(!this.data.pageAlive || this.data.authAttempt !== attempt || result.sessionToken !== getApp<IAppOption>().globalData.sessionToken)return;
      const me=await this.loadMemberIdentity();
      if(!this.data.pageAlive || this.data.authAttempt !== attempt || result.sessionToken !== getApp<IAppOption>().globalData.sessionToken)return;
      if(!me?.avatar_data_url) { this.setData({loginStage:"avatar",avatarUrl:defaultMemberAvatar}); return; }
      if(this.data.notice)wx.showToast({title:"已登录，手机号可稍后在设置中确认",icon:"none"});
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
    if (this.data.leavePromptOpen || this.data.leaving || this.data.avatarBusy) return false;
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
  stopAuthenticationWait(suppressSourceRedirect = false): string {
    this.data.authAttempt += 1;
    cancelAuthentication();
    const returnUrl = wx.getStorageSync<string>("cisme.authReturnUrl");
    if (suppressSourceRedirect) suppressAuthenticationRedirectOnce(returnUrl);
    wx.removeStorageSync("cisme.authReturnUrl");
    wx.disableAlertBeforeUnload();
    if (this.data.pageAlive) this.setData({ loading: false, identityCommitStarted: false, leavePromptOpen: false, leaving: true });
    return returnUrl.startsWith("/pages/") && !returnUrl.startsWith("/pages/account/") ? returnUrl : "/pages/home/index";
  },
  async back() {
    if (!await this.confirmIdentityLeave("source")) return;
    if (!this.data.pageAlive || this.data.leaving) return;
    const returnUrl = this.stopAuthenticationWait(true);
    const fail = () => {
      if (this.data.pageAlive) this.setData({ leaving: false, error: "来源页面暂时无法恢复。身份确认已停止等待，请稍后重试。" }, scrollToAccountError);
    };
    const openSource = () => {
      const path = returnUrl.split("?")[0] || "/pages/home/index";
      if (["/pages/home/index", "/pages/records/index", "/pages/community/index", "/pages/profile/index"].includes(path)) {
        wx.switchTab({ url: path, fail });
      } else {
        wx.redirectTo({ url: returnUrl, fail: () => wx.switchTab({ url: "/pages/home/index", fail }) });
      }
    };
    wx.navigateBack({ delta: 1, fail: openSource });
  },
  async browseCommunity() {
    if(this.data.loginStage === "avatar") { if(!this.data.loading && !this.data.avatarBusy)await this.continueLogin(); return; }
    if (!await this.confirmIdentityLeave("community")) return;
    if (!this.data.pageAlive || this.data.leaving) return;
    wx.setStorageSync("cisme.guestBrowsing", true);
    this.stopAuthenticationWait();
    wx.switchTab({ url: "/pages/community/index", fail: () => {
      if (this.data.pageAlive) this.setData({ leaving: false, error: "公开社区暂时无法打开，请稍后重试。身份确认已停止等待。" }, scrollToAccountError);
    } });
  }
});
