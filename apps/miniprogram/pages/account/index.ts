import { publishMemberIdentity } from "../../services/member-identity";
import { defaultMemberAvatar, localMemberAvatar, prepareAvatarUpload } from "../../services/member-avatar";
import { cancelAuthentication, consumeAuthReturnUrl, navigateAfterAuthentication, request, setPrivacyRightsToken, setSessionToken, suppressAuthenticationRedirectOnce, acceptCurrentLegalDocuments, isGuestCommunityBrowsing } from "../../services/api";
import { guestCommunityRouteAllowed } from "../../services/route-access";
import { legalDocumentVersions, shouldUseDevelopmentIdentity } from "../../release-config";
import type { LegalDocumentVersions } from "../../release-config";
import { currentChromeStyle, motionDuration, shouldReduceMotion } from "../../services/layout";
import { attributePendingShare } from "../../services/share";
import { legalRequestFailure, parseLegalBootstrap, type LegalLoadError } from "../../services/legal-bootstrap";

const loginAvatarDrafts=new WeakMap<object,{token:string;owner:string;dataUrl:string;local:string}>();
function needsLoginName(profile:{display_name?:string;completed_at?:string|null}){const name=profile.display_name?.trim();return !name||!profile.completed_at&&['CISME 会员','微信用户'].includes(name);}
function scrollToAccountError() {
  wx.pageScrollTo({ selector: "#account-error-summary", duration: motionDuration(200) });
}

const legalReadErrors = new Set([
  "协议服务暂时无法连接，请稍后重试。",
  "用户协议暂不可用，请稍后重试。",
  "隐私保护指引暂不可用，请稍后重试。",
  "协议信息暂不可用，请稍后重试。",
  "协议暂时无法加载，请稍后重试。"
]);

function currentLegalDocuments(): LegalDocumentVersions | null {
  const account = wx.getAccountInfoSync();
  const runtime = getApp<IAppOption>().globalData;
  return legalDocumentVersions(account.miniProgram.envVersion, wx.getDeviceInfo().platform, runtime.remoteDebugMode, Boolean(runtime.cloudFunction));
}

Page({
  authenticationFlowId:"",
  loginFlowToken:"",loginOwnerId:"",
  authenticationReturnUrl:"/pages/home/index",
  renewalSessionToken:"",
  renewalDestination:"",
  data: { restoringSession:false,sessionRestoreFailed:false,renewalMode:false,renewalComplete:false,legalAcceptanceStarted:false,loginStage:"login",loginName:"",loginNameInvalid:false,loginProfileUncertain:false,phoneSkipped:false,profileAttempt:0, avatarBusy:false, avatarAttempt:0, pageVisible:true, avatarUrl:defaultMemberAvatar, phoneBindingEnabled:false, phoneCapabilityKnown:false, capabilityAttempt:0, notice:"", serverLegalDocuments: null as LegalDocumentVersions | null, legalAttempt: 0, legalLoadError: "" as LegalLoadError, legalFailureCode: "", chromeStyle: currentChromeStyle(), reducedMotion:shouldReduceMotion(), heroMotionActive:false, loading: false, identityCommitStarted: false, leavePromptOpen: false, leaving: false, pendingDestination: "", crossBorderAccepted: false, crossBorderRequired: false, agreementAccepted: false, legalTextsReady: false, legalLoading: true, localLegalFixture: false, pageAlive: true, authAttempt: 0, error: "", accountHelpAvailable:false,accountHelpBusy:false },
  async openAccountHelp(){
    if(this.data.accountHelpBusy)return;
    const attempt=++this.data.authAttempt;
    this.setData({accountHelpBusy:true,error:""});
    try{
      const login=await wx.login();
      if(!this.data.pageAlive||attempt!==this.data.authAttempt)return;
      const result=await request<{sessionToken:string;scope:string}>({path:"/v1/identity/wechat/privacy-rights",
        method:"POST",authMode:"public",data:{code:login.code}});
      if(!this.data.pageAlive||attempt!==this.data.authAttempt)return;
      if(result.scope!=="privacy_rights"||!result.sessionToken)throw new Error("PRIVACY_IDENTITY_INVALID");
      setPrivacyRightsToken(result.sessionToken);
      const landed=await navigateAfterAuthentication("/pages/privacy-rights/index");
      if(this.data.pageAlive&&attempt===this.data.authAttempt&&landed!=="target")
        this.setData({error:"身份已核验，隐私请求页暂时无法打开，请重试。"},scrollToAccountError);
    }catch{
      if(this.data.pageAlive&&attempt===this.data.authAttempt)
        this.setData({error:"账号信息暂时无法确认，请重试。"},scrollToAccountError);
    }finally{
      if(this.data.pageAlive&&attempt===this.data.authAttempt)this.setData({accountHelpBusy:false});
    }
  },
  documents(): LegalDocumentVersions | null { return currentLegalDocuments() || this.data.serverLegalDocuments; },
  async syncLegalDocuments() {
    const previous = this.documents();
    const attempt = ++this.data.legalAttempt;
    // Keep the accepted versions for comparison, but do not authorize a new
    // login until the current read finishes. Returning from a legal page may
    // otherwise leave the old ready/accepted pair actionable during refresh.
    this.setData({legalLoading:true,legalTextsReady:false,legalLoadError:"",legalFailureCode:"",...(legalReadErrors.has(this.data.error)?{error:""}:{})});
    let documents = currentLegalDocuments();
    let legalLoadError: LegalLoadError = "";
    let legalFailureCode = "";
    if (!documents) {
      try {
        const response = await request<unknown>({path:"/v1/legal",authMode:"public"});
        if (!this.data.pageAlive || attempt !== this.data.legalAttempt) return;
        const result = parseLegalBootstrap(response);
        documents = result.documents;
        legalLoadError = result.error;
        legalFailureCode = result.diagnostic;
      } catch (error) {
        documents = null;
        const failure = legalRequestFailure(error);
        legalLoadError = failure.error;
        legalFailureCode = failure.diagnostic;
      }
      if (!this.data.pageAlive || attempt !== this.data.legalAttempt) return;
      this.setData({ serverLegalDocuments: documents });
    }
    this.setData({
      legalTextsReady: Boolean(documents),
      legalLoading: false,
      legalLoadError,
      legalFailureCode,
      crossBorderRequired: Boolean(documents?.crossBorder),
      crossBorderAccepted: documents && previous?.crossBorder === documents.crossBorder ? this.data.crossBorderAccepted : false,
      localLegalFixture: documents?.localFixture === true,
      agreementAccepted: documents && previous?.privacy === documents.privacy && previous?.terms === documents.terms ? this.data.agreementAccepted : false
    });
  },
  onLoad(query: Record<string, string | undefined>) {
    this.data.pageAlive = true;
    this.authenticationFlowId = query?.authFlow || "";
    this.authenticationReturnUrl = consumeAuthReturnUrl(this.authenticationFlowId, query?.intent === "renew" ? "renew" : "login");
    if(query?.intent==="renew"){
      this.renewalDestination = this.authenticationReturnUrl;
      this.renewalSessionToken=getApp<IAppOption>().globalData.sessionToken;
      this.setData({renewalMode:true,renewalComplete:false,loginStage:"login",agreementAccepted:false,crossBorderAccepted:false,pendingDestination:""});
    }
    // The first route is a lightweight entry gate; explicit account visits stay here.
    if (!query?.intent && getCurrentPages().length === 1) {
      const token = getApp<IAppOption>().globalData.sessionToken;
      if (token) void this.restoreRetainedSession();
    }
  },
  async restoreRetainedSession() {
    if(!this.data.pageAlive||!this.data.pageVisible||this.data.leaving||this.data.restoringSession)return;
    const token=getApp<IAppOption>().globalData.sessionToken;
    if(!token){this.revealExpiredLogin();return;}
    const attempt=++this.data.authAttempt;
    const current=()=>this.data.pageAlive&&this.data.pageVisible&&attempt===this.data.authAttempt
      &&token===getApp<IAppOption>().globalData.sessionToken;
    this.setData({loading:true,restoringSession:true,sessionRestoreFailed:false,pendingDestination:this.authenticationReturnUrl,error:""});
    try {
      const me=await request<{id:string;profile_revision?:number;display_name?:string;avatar_data_url?:string|null;completed_at?:string|null}>({path:"/v1/me",authMode:"optional"});
      if(!current()){
        if(this.data.pageAlive&&this.data.pageVisible&&attempt===this.data.authAttempt&&!getApp<IAppOption>().globalData.sessionToken&&this.revealExpiredLogin()){
          void this.syncLegalDocuments();void this.loadCapabilities();
        }
        return;
      }
      if(!me||typeof me.id!=="string"||!me.id)throw new Error("MEMBER_RESTORE_RESPONSE_INVALID");
      if(Number.isSafeInteger(me.profile_revision)&&(needsLoginName(me)||!me.avatar_data_url)){
        this.loginFlowToken=token;this.loginOwnerId=me.id;await this.advanceLogin();return;
      }
      this.setData({leaving:true});
      wx.switchTab({url:"/pages/home/index",fail:()=>{
        if(current())this.setData({leaving:false,sessionRestoreFailed:true,error:"登录仍保留，首页暂时无法打开，请重试。"});
      }});
    } catch {
      if(!this.data.pageAlive||!this.data.pageVisible||attempt!==this.data.authAttempt)return;
      if(!getApp<IAppOption>().globalData.sessionToken){
        if(this.revealExpiredLogin()){void this.syncLegalDocuments();void this.loadCapabilities();}
        return;
      }
      if(current())this.setData({sessionRestoreFailed:true,error:"暂时无法连接，原登录状态已保留。请重新连接，或选择重新登录。"});
    } finally {
      if(this.data.pageAlive&&attempt===this.data.authAttempt){
        this.setData({loading:false,restoringSession:false});
        if(current()&&!this.data.leaving){void this.syncLegalDocuments();void this.loadCapabilities();}
      }
    }
  },
  restartLogin() {
    if(!this.data.pageAlive||!this.data.pageVisible||this.data.loading||this.data.leaving||!this.data.sessionRestoreFailed||this.data.renewalMode)return;
    this.data.authAttempt+=1;
    setSessionToken("");
    this.setData({sessionRestoreFailed:false,restoringSession:false,pendingDestination:"",loginStage:"login",agreementAccepted:false,crossBorderAccepted:false,error:"",notice:"请重新确认微信身份。"});
    void this.syncLegalDocuments();
  },
  onShow() {
    this.data.pageVisible = true;if(this.data.leaving)return;
    const flowToken=getApp<IAppOption>().globalData.sessionToken;
    if(this.loginFlowToken&&this.loginFlowToken!==flowToken){loginAvatarDrafts.delete(this);this.loginFlowToken='';this.loginOwnerId='';this.setData({loginStage:'login',loginName:'',loginNameInvalid:false,avatarUrl:defaultMemberAvatar,avatarBusy:false,loading:false,phoneSkipped:false,loginProfileUncertain:false});}
    else if(this.loginFlowToken&&this.data.loginProfileUncertain&&!this.data.loading&&!this.data.avatarBusy)void this.advanceLogin();
    const reducedMotion=shouldReduceMotion(),token=getApp<IAppOption>().globalData.sessionToken;
    this.setData({reducedMotion,heroMotionActive:!reducedMotion});
    if(this.data.renewalMode){
      if(!token)this.setData({renewalMode:false,renewalComplete:false,pendingDestination:"",notice:"原会话已失效，请重新微信登录确认。"});
      else if(token!==this.renewalSessionToken){this.renewalSessionToken=token;this.renewalDestination="";this.authenticationReturnUrl="/pages/community/index";this.setData({renewalComplete:false,agreementAccepted:false,crossBorderAccepted:false});}
    }
    if(!token&&!this.data.renewalMode)this.revealExpiredLogin();
    if(token&&!this.data.renewalMode)this.setData({pendingDestination:this.data.pendingDestination || this.authenticationReturnUrl});
    // The retained-session verdict may change the request context. Start the
    // public login bootstrap after that verdict, rather than aborting it on401.
    if(!this.data.restoringSession){
      void this.syncLegalDocuments();
      if(!this.data.renewalMode)void this.loadCapabilities();
    }
  },
  revealExpiredLogin() {
    if(!this.data.pageAlive||this.data.leaving||this.data.renewalMode||getApp<IAppOption>().globalData.sessionToken||(!this.data.pendingDestination&&this.data.loginStage!=="avatar"))return false;
    this.data.authAttempt+=1;this.data.avatarAttempt+=1;loginAvatarDrafts.delete(this);this.loginFlowToken="";this.loginOwnerId="";this.data.profileAttempt+=1;
    this.setData({pendingDestination:"",loginStage:"login",avatarBusy:false,loading:false,restoringSession:false,sessionRestoreFailed:false,identityCommitStarted:false,
      agreementAccepted:false,crossBorderAccepted:false,avatarUrl:defaultMemberAvatar,error:"",notice:""});
    return true;
  },
  onHide() { if(this.loginFlowToken)this.setData({loginProfileUncertain:this.data.loading||this.data.avatarBusy,loading:false});this.data.pageVisible = false; this.data.avatarAttempt += 1;this.data.profileAttempt+=1;if(this.data.restoringSession){this.data.authAttempt+=1;this.setData({loading:false,restoringSession:false,sessionRestoreFailed:true});} this.setData({heroMotionActive:false,...(this.data.avatarBusy?{avatarBusy:false}:{})}); },
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
  onResize() { const reducedMotion=shouldReduceMotion(); this.setData({ chromeStyle: currentChromeStyle(),reducedMotion,heroMotionActive:this.data.pageVisible&&!reducedMotion }); },
  onUnload() {
    loginAvatarDrafts.delete(this);this.loginFlowToken="";this.loginOwnerId="";this.data.profileAttempt+=1;
    this.data.pageAlive = false;
    this.data.pageVisible = false;
    this.data.avatarAttempt += 1;
    this.data.authAttempt += 1;
    wx.disableAlertBeforeUnload();
    cancelAuthentication(this.authenticationFlowId);
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
      this.setData({ error: this.data.legalLoadError === "invalid" ? "协议信息暂不可用，请稍后重试。" : this.data.legalLoadError === "unreachable" ? "协议暂时无法加载，请稍后重试。" : "用户协议暂不可用，请稍后重试。" }, scrollToAccountError);
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
      this.setData({ error: this.data.legalLoadError === "invalid" ? "协议信息暂不可用，请稍后重试。" : this.data.legalLoadError === "unreachable" ? "协议暂时无法加载，请稍后重试。" : "隐私保护指引暂不可用，请稍后重试。" }, scrollToAccountError);
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
  async loadCapabilities() {
    const attempt=++this.data.capabilityAttempt;
    try {
      const result=await request<{phoneBindingEnabled:boolean}>({path:"/v1/identity/capabilities",authMode:"public"});
      if(this.data.pageAlive && attempt===this.data.capabilityAttempt && !this.data.loading)this.setData({phoneBindingEnabled:result.phoneBindingEnabled === true,phoneCapabilityKnown:true});
    } catch { if(this.data.pageAlive && attempt===this.data.capabilityAttempt)this.setData({phoneBindingEnabled:false,phoneCapabilityKnown:false}); }
  },
  loginTap() {
    if(this.data.renewalMode){void this.login();return;}
    if(this.revealExpiredLogin())return;
    if(this.data.loginProfileUncertain&&this.loginFlowToken)return this.advanceLogin();
    if(this.data.loginStage==='phone'||this.data.loginStage==='avatar')return;
    if(this.data.loginStage==='nickname')return this.saveLoginNickname();
    if(this.loginFlowToken)return this.advanceLogin();
    return this.login();
  },
  async loginWithPhone(event:WechatMiniprogram.CustomEvent){
    if(this.data.renewalMode||!this.data.pageAlive||!this.data.pageVisible||this.data.loading||this.data.leaving)return;
    const code=typeof event.detail.code==='string'&&event.detail.code?event.detail.code:undefined;
    if(!this.loginFlowToken){await this.login(code,!code);return;}
    if(this.data.loginStage!=='phone')return;
    const token=this.loginFlowToken,attempt=++this.data.profileAttempt;
    const current=()=>this.data.pageAlive&&this.data.pageVisible&&attempt===this.data.profileAttempt&&token===getApp<IAppOption>().globalData.sessionToken;
    this.setData({loading:true,error:'',phoneSkipped:!code});
    try{if(code)await request({path:'/v1/me/phone',method:'POST',data:{code}});if(current())await this.advanceLogin();}
    catch(error){if(current())this.setData({loginProfileUncertain:true,error:(error as {title?:string}).title||'手机号保存结果待确认，请核对后继续'});}
    finally{if(current())this.setData({loading:false});}
  },
  async continueLogin() {
    if(this.data.renewalMode){await this.confirmLegalRenewal();return;}
    if(!this.data.pageAlive || this.data.leaving || this.data.avatarBusy)return;
    const token=getApp<IAppOption>().globalData.sessionToken;
    if(!token){this.revealExpiredLogin();return;}
    this.setData({loading:true,error:""});
    const landed=await navigateAfterAuthentication(this.data.pendingDestination || "/pages/home/index");
    if(this.data.pageAlive && token===getApp<IAppOption>().globalData.sessionToken)this.setData({loading:false,error:landed === "target" ? "" : "已登录，请再次点击继续。"});
  },
  editLoginName(event:WechatMiniprogram.Input){if(!this.data.loading)this.setData({loginName:event.detail.value,loginNameInvalid:false,error:''});},
  reviewLoginName(event:WechatMiniprogram.CustomEvent){if(event.detail.pass===false)this.setData({loginNameInvalid:true,error:'请换一个昵称'});},
  async advanceLogin(){
    const token=this.loginFlowToken;if(!token||token!==getApp<IAppOption>().globalData.sessionToken||!this.data.pageAlive||!this.data.pageVisible||this.data.leaving)return;
    const attempt=++this.data.profileAttempt,current=()=>this.data.pageAlive&&this.data.pageVisible&&!this.data.leaving&&attempt===this.data.profileAttempt&&token===getApp<IAppOption>().globalData.sessionToken;
    this.setData({loading:true,error:'',loginProfileUncertain:false});
    try{
      let [profile,phone]=await Promise.all([request<any>({path:'/v1/me/profile'}),request<{bound:boolean;enabled:boolean;masked?:string|null}>({path:'/v1/me/phone'})]);
      if(!current())return;
      if(!profile?.id||typeof profile.display_name!=='string'||!Number.isSafeInteger(profile.profile_revision)||typeof phone?.bound!=='boolean'||typeof phone.enabled!=='boolean'||this.loginOwnerId&&profile.id!==this.loginOwnerId)throw Error('LOGIN_PROFILE_INVALID');
      this.loginOwnerId=profile.id;
      if(!phone.bound&&phone.enabled&&!this.data.phoneSkipped){this.setData({loginStage:'phone'});return;}
      let draft=loginAvatarDrafts.get(this);if(draft&&(draft.token!==token||draft.owner!==profile.id)){loginAvatarDrafts.delete(this);draft=undefined;}
      if(profile.avatar_data_url){loginAvatarDrafts.delete(this);draft=undefined;}
      const avatarUrl=draft?.local??await localMemberAvatar(profile.avatar_data_url,profile.avatar_revision);if(!current())return;
      this.setData({avatarUrl});
      if(!profile.avatar_data_url&&!draft){this.setData({loginStage:'avatar'});return;}
      if(needsLoginName(profile)){this.setData({loginStage:'nickname'});return;}
      if(draft){const saved=await request<any>({path:'/v1/me/profile',method:'PUT',data:{displayName:profile.display_name,expectedVersion:profile.profile_revision,avatarDataUrl:draft.dataUrl}});if(!current())return;if(saved.id!==profile.id)throw Error('LOGIN_PROFILE_OWNER_INVALID');profile=saved;loginAvatarDrafts.delete(this);}
      const finalAvatar=await localMemberAvatar(profile.avatar_data_url,profile.avatar_revision);if(!current())return;
      publishMemberIdentity({id:profile.id,display_name:profile.display_name,avatarUrl:finalAvatar,profile_revision:profile.profile_revision,completed_at:profile.completed_at,public_status:profile.public_status,phone_masked:phone.masked??null});
      this.setData({loginStage:'login',avatarUrl:finalAvatar});
      const landed=await navigateAfterAuthentication(this.data.pendingDestination||'/pages/home/index');
      if(landed==='target'&&token===getApp<IAppOption>().globalData.sessionToken&&this.loginFlowToken===token)this.loginFlowToken='';else if(current())this.setData({error:'页面暂时无法打开，请再次点击继续'});
    }catch(error){if(current())this.setData({loginProfileUncertain:true,error:(error as {title?:string}).title||'资料状态待确认，请重试'});}
    finally{if(current())this.setData({loading:false});}
  },
  async chooseLoginAvatar(event:WechatMiniprogram.CustomEvent){
    if(this.data.renewalMode||!this.data.pageAlive||!this.data.pageVisible||this.data.loading||this.data.leaving||this.data.avatarBusy||this.data.loginStage!=='avatar'||!event.detail.avatarUrl)return;
    if(!getApp<IAppOption>().globalData.sessionToken){this.revealExpiredLogin();return;}
    const token=this.loginFlowToken||getApp<IAppOption>().globalData.sessionToken;if(!token||token!==getApp<IAppOption>().globalData.sessionToken)return;
    this.loginFlowToken=token;const attempt=++this.data.avatarAttempt;this.data.profileAttempt++;
    const current=()=>this.data.pageAlive&&this.data.pageVisible&&attempt===this.data.avatarAttempt&&token===getApp<IAppOption>().globalData.sessionToken;
    this.setData({avatarBusy:true,error:''});
    try{
      const avatarDataUrl=await prepareAvatarUpload(this as unknown as WechatMiniprogram.Page.TrivialInstance,event.detail.avatarUrl);if(!current())return;
      const profile=await request<any>({path:'/v1/me/profile'});if(!current())return;
      if(!profile?.id||this.loginOwnerId&&profile.id!==this.loginOwnerId)throw Error('LOGIN_PROFILE_OWNER_INVALID');
      this.loginOwnerId=profile.id;loginAvatarDrafts.set(this,{token,owner:profile.id,dataUrl:avatarDataUrl,local:event.detail.avatarUrl});
      this.setData({avatarUrl:event.detail.avatarUrl,avatarBusy:false});await this.advanceLogin();
    }catch(error){if(current())this.setData({loginProfileUncertain:true,error:(error as {title?:string}).title||'头像未处理成功，请重试'});}
    finally{if(current())this.setData({avatarBusy:false});}
  },
  async saveLoginNickname(event?:WechatMiniprogram.Input){
    if(typeof event?.detail?.value==='string')this.setData({loginName:event.detail.value});
    const token=this.loginFlowToken,name=this.data.loginName.trim();
    if(!token||token!==getApp<IAppOption>().globalData.sessionToken||!this.data.pageAlive||!this.data.pageVisible||this.data.loading||this.data.leaving||this.data.loginStage!=='nickname')return;
    if(this.data.loginNameInvalid||!name||Array.from(name).length>40){this.setData({error:'请确认你的微信昵称'});return;}
    const attempt=++this.data.profileAttempt,current=()=>this.data.pageAlive&&this.data.pageVisible&&attempt===this.data.profileAttempt&&token===getApp<IAppOption>().globalData.sessionToken;
    this.setData({loading:true,error:''});
    try{
      const profile=await request<any>({path:'/v1/me/profile'});if(!current())return;
      if(!profile?.id||profile.id!==this.loginOwnerId)throw Error('LOGIN_PROFILE_OWNER_INVALID');
      const draft=loginAvatarDrafts.get(this),avatar=draft?.token===token&&draft.owner===profile.id&&!profile.avatar_data_url?draft.dataUrl:undefined;
      if(!profile.avatar_data_url&&!avatar){this.setData({loginStage:'avatar'});return;}
      if(needsLoginName(profile)){
        const saved=await request<any>({path:'/v1/me/profile',method:'PUT',data:{displayName:name,expectedVersion:profile.profile_revision,...(avatar?{avatarDataUrl:avatar}:{})}});if(!current())return;if(saved.id!==profile.id||saved.profile_revision<=profile.profile_revision)throw Error('LOGIN_PROFILE_RECEIPT_INVALID');loginAvatarDrafts.delete(this);
      }
      await this.advanceLogin();
    }catch(error){if(current())this.setData({loginProfileUncertain:true,error:(error as {title?:string}).title||'资料保存结果待确认，请核对后继续'});}
    finally{if(current())this.setData({loading:false});}
  },
  async login(phoneCode?:string,phoneDeclined=false) {
    if (this.data.loading || this.data.leaving || this.data.avatarBusy || !this.data.pageAlive) return;
    if(this.data.renewalMode){await this.confirmLegalRenewal();return;}
    if(this.data.sessionRestoreFailed&&getApp<IAppOption>().globalData.sessionToken){await this.restoreRetainedSession();return;}
    if(this.revealExpiredLogin())return;
    if (this.data.pendingDestination && getApp<IAppOption>().globalData.sessionToken) {
      const attempt=++this.data.authAttempt;
      this.setData({ loading: true, error: "" });
      const token=getApp<IAppOption>().globalData.sessionToken;
      try {
        // The destination owns profile refresh. An existing session does not
        // require an avatar or a second identity/profile round trip to continue.
        if(!this.data.pageAlive || this.data.leaving || this.data.authAttempt!==attempt)return;
        if(token!==getApp<IAppOption>().globalData.sessionToken){
          this.setData({loginStage:"login",error:"登录状态已变化，请重新确认身份。"});return;
        }
        const landed = await navigateAfterAuthentication(this.data.pendingDestination);
        if(this.data.pageAlive && this.data.authAttempt===attempt && token===getApp<IAppOption>().globalData.sessionToken)
          this.setData({error:landed === "target" ? "" : "身份已经确认，但原目标页面仍未打开。请稍后再次尝试。"});
      } finally {
        if(this.data.pageAlive && this.data.authAttempt===attempt)this.setData({loading:false});
      }
      return;
    }
    if (this.data.legalLoading && !this.data.legalTextsReady) return;
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
    const legalAttempt = this.data.legalAttempt;
    const attempt = this.data.authAttempt + 1;
    this.setData({ authAttempt: attempt, loading: true, identityCommitStarted: false, error: "", accountHelpAvailable:false });
    try {
      const account = wx.getAccountInfoSync();
      // wx.login provides an identity code, not a nickname. The server uses
      // this default only for a new member; later logins retain saved profile.
      const base = { displayName: "CISME 会员", consents: [{ documentType: "privacy", version: legalDocuments.privacy }, { documentType: "terms", version: legalDocuments.terms }] };
      if (legalDocuments.crossBorder) base.consents.push({documentType:"cross_border",version:legalDocuments.crossBorder});
      let result: { sessionToken: string; phoneBindingEnabled?: boolean; onboardingRequired?:boolean };
      const runtime = getApp<IAppOption>().globalData;
      if (shouldUseDevelopmentIdentity(account.miniProgram.envVersion, wx.getDeviceInfo().platform, runtime.remoteDebugMode, Boolean(runtime.cloudFunction))) {
        const deviceId = wx.getStorageSync<string>("cisme.devUserId") || `device-${Date.now()}`;
        wx.setStorageSync("cisme.devUserId", deviceId);
        this.setData({ identityCommitStarted: true });
        wx.enableAlertBeforeUnload({ message: "登录正在处理中，离开后请先确认账号状态。" });
        result = await request({ path: "/v1/identity/dev", method: "POST", authMode: "public", data: { ...base, externalUserId: deviceId } });
      } else {
        const login = await wx.login();
        if (!this.data.pageAlive || this.data.authAttempt !== attempt) return;
        // wx.login is asynchronous. A refresh started after the tap must not
        // submit the previously captured consent versions when it returns.
        if (this.data.legalAttempt !== legalAttempt || !this.data.agreementAccepted ||
          (legalDocuments.crossBorder && !this.data.crossBorderAccepted)) {
          this.setData({error:"协议状态已更新，请确认后重新登录。"},scrollToAccountError);
          return;
        }
        this.setData({ identityCommitStarted: true });
        wx.enableAlertBeforeUnload({ message: "登录正在处理中，离开后请先确认账号状态。" });
        result = await request({ path: "/v1/identity/wechat", method: "POST", authMode: "public", data: { ...base, code: login.code } });
      }
      if (!this.data.pageAlive || this.data.authAttempt !== attempt) return;
      setSessionToken(result.sessionToken);this.loginFlowToken=result.sessionToken;this.loginOwnerId="";this.setData({phoneSkipped:phoneDeclined});
      void attributePendingShare();
      if(result.onboardingRequired){runtime.onboardingReturnUrl=this.authenticationReturnUrl;runtime.onboardingReturnToken=result.sessionToken;}
      else {delete runtime.onboardingReturnUrl;delete runtime.onboardingReturnToken;}
      const pendingDestination = result.onboardingRequired ? '/pages/home/index' : this.authenticationReturnUrl;
      this.setData({ pendingDestination });
      wx.disableAlertBeforeUnload();
      if(phoneCode) {
        try { await request({path:"/v1/me/phone",method:"POST",data:{code:phoneCode}}); }
        catch(error) { if(this.data.pageAlive&&this.data.authAttempt===attempt&&result.sessionToken===getApp<IAppOption>().globalData.sessionToken)this.setData({notice:(error as {title?:string}).title || "账号已登录，手机号绑定结果尚未确认，可在设置中查看。"}); }
      }
      if(!this.data.pageAlive || this.data.authAttempt !== attempt || result.sessionToken !== getApp<IAppOption>().globalData.sessionToken)return;
      await this.advanceLogin();
    } catch (error) {
      if (this.data.pageAlive && this.data.authAttempt === attempt) {
        const code=(error as {code?:string})?.code;
        const unavailable=code==="ACCOUNT_CLOSED"||code==="MEMBER_NOT_ACTIVE";
        this.setData({accountHelpAvailable:code==="ACCOUNT_CLOSED",error:unavailable
          ?code==="ACCOUNT_CLOSED"?"账号已注销。你仍可核验微信身份，查看历史隐私申请。":"账号暂不可登录，请稍后重试或联系小程序客服。"
          :this.data.identityCommitStarted
            ?"登录结果尚未确认，请检查网络后重试。"
            :"微信登录尚未完成，请重试。"},scrollToAccountError);
      }
    } finally {
      if (this.data.authAttempt === attempt) {
        wx.disableAlertBeforeUnload();
        if (this.data.pageAlive) this.setData({ loading: false, identityCommitStarted: false });
      }
    }
  },
  async confirmLegalRenewal(){
    if(!this.data.renewalMode||this.data.loading||this.data.leaving||!this.data.pageAlive||!this.data.pageVisible)return;
    const token=getApp<IAppOption>().globalData.sessionToken;
    if(!token){this.setData({renewalMode:false,renewalComplete:false,pendingDestination:"",error:"会话已失效，请重新微信登录确认。"});return;}
    if(token!==this.renewalSessionToken){this.renewalSessionToken=token;this.renewalDestination="";this.authenticationReturnUrl="/pages/community/index";this.setData({renewalComplete:false,agreementAccepted:false,error:"账号状态已变化，请重新阅读并确认。"});return;}
    const documents=this.documents();
    if(!this.data.renewalComplete&&(this.data.legalLoading||!this.data.legalTextsReady||!documents||!this.data.agreementAccepted)){
      this.setData({error:"请先阅读并同意用户协议与隐私保护指引。"},scrollToAccountError);return;
    }
    const attempt=++this.data.authAttempt,legalAttempt=this.data.legalAttempt;
    const current=()=>this.data.pageAlive&&this.data.pageVisible&&!this.data.leaving&&attempt===this.data.authAttempt&&token===getApp<IAppOption>().globalData.sessionToken;
    this.setData({loading:true,error:""});
    try{
      if(!this.data.renewalComplete){
        this.setData({legalAcceptanceStarted:true});
        await acceptCurrentLegalDocuments([{documentType:"terms",version:documents!.terms},{documentType:"privacy",version:documents!.privacy}]);
        if(!current())return;
        this.renewalDestination=this.renewalDestination || this.authenticationReturnUrl;
        this.setData({renewalComplete:true,legalAcceptanceStarted:false});
        if(legalAttempt!==this.data.legalAttempt){this.setData({notice:"协议已确认，返回后会重新加载最新状态。"});}
      }
      if(!current())return;
      const landed=await navigateAfterAuthentication(this.renewalDestination||"/pages/community/index");
      if(current())this.setData({error:landed==="target"?"":"协议已确认，原页面暂时无法打开，请再次点击返回。"});
    }catch(error){if(current()){
      const problem=error as {status?:number;code?:string};
      if(problem.status===409&&["LEGAL_VERSION_REQUIRED","CURRENT_LEGAL_CONSENT_REQUIRED"].includes(problem.code||"")){await this.syncLegalDocuments();if(current())this.setData({agreementAccepted:false,renewalComplete:false,error:"协议版本已更新，请重新阅读后确认。"},scrollToAccountError);}
      else this.setData({error:"协议确认结果尚未收到，请重试；本次互动尚未执行。"},scrollToAccountError);
    }else if(this.data.pageAlive&&attempt===this.data.authAttempt&&!getApp<IAppOption>().globalData.sessionToken){
      this.setData({renewalMode:false,renewalComplete:false,pendingDestination:"",error:"会话已失效，请重新微信登录确认。"});
    }}finally{if(this.data.pageAlive&&attempt===this.data.authAttempt)this.setData({loading:false,legalAcceptanceStarted:false});}
  },
  async confirmIdentityLeave(destination: "source" | "community"): Promise<boolean> {
    if (this.data.leavePromptOpen || this.data.leaving || this.data.avatarBusy) return false;
    if (this.data.loading && (this.data.identityCommitStarted||this.data.legalAcceptanceStarted)) {
      this.setData({ leavePromptOpen: true });
      let confirmation: WechatMiniprogram.ShowModalSuccessCallbackResult;
      try {
        confirmation = await wx.showModal({
          title: this.data.legalAcceptanceStarted?"协议正在确认":"登录仍在处理中",
          content: this.data.legalAcceptanceStarted?"协议确认仍在处理中。返回后请先查看确认结果。":destination === "source"
            ? "登录结果尚未确认。返回后请先查看账号状态。"
            : "登录仍在处理中。前往社区后，请重新确认登录状态。",
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
    cancelAuthentication(this.authenticationFlowId);
    const returnUrl = this.data.renewalMode && this.renewalDestination ? this.renewalDestination : this.authenticationReturnUrl;
    if (suppressSourceRedirect) suppressAuthenticationRedirectOnce(returnUrl);
    wx.disableAlertBeforeUnload();
    if (this.data.pageAlive) this.setData({ loading: false, identityCommitStarted: false,legalAcceptanceStarted:false,leavePromptOpen: false, leaving: true });
    return returnUrl.startsWith("/pages/") && !returnUrl.startsWith("/pages/account/") ? returnUrl : "/pages/home/index";
  },
  async back() {
    if (!await this.confirmIdentityLeave("source")) return;
    if (!this.data.pageAlive || this.data.leaving) return;
    const guest=isGuestCommunityBrowsing();
    const returnUrl = this.stopAuthenticationWait(!guest);
    const fail = () => {
      if (this.data.pageAlive) this.setData({ leaving: false, error: "暂时无法返回，请重试或留在本页查看账号状态。" }, scrollToAccountError);
    };
    const openSource = () => {
      const path = returnUrl.split("?")[0] || "/pages/home/index";
      if (["/pages/home/index", "/pages/shop/index", "/pages/community/index", "/pages/profile/index"].includes(path)) {
        wx.switchTab({ url: path, fail });
      } else {
        wx.redirectTo({ url: returnUrl, fail: () => wx.switchTab({ url: "/pages/home/index", fail }) });
      }
    };
    if(guest&&!guestCommunityRouteAllowed(returnUrl)){
      wx.switchTab({url:"/pages/community/index",fail});return;
    }
    wx.navigateBack({ delta: 1, fail: openSource });
  },
  async browseCommunity() {
    if(this.data.renewalMode){await this.back();return;}
    if (!await this.confirmIdentityLeave("community")) return;
    if (!this.data.pageAlive || this.data.leaving) return;
    wx.setStorageSync("cisme.guestBrowsing", true);
    this.stopAuthenticationWait();
    wx.switchTab({ url: "/pages/community/index", fail: () => {
      if (this.data.pageAlive) this.setData({ leaving: false, error: "社区暂时无法打开，请重试。" }, scrollToAccountError);
    } });
  }
});
