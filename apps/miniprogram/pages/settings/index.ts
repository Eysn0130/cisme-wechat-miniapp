import { memberIdentity, publishMemberIdentity } from "../../services/member-identity";
import { defaultMemberAvatar, localMemberAvatar, prepareAvatarUpload } from "../../services/member-avatar";
import { requireMemberAccess, retainMemberSnapshot } from "../../services/api";
import { clearAuthenticationRedirectSuppression, request, resumeAuthentication, setSessionToken } from "../../services/api";
import { currentChromeStyle, motionDuration } from "../../services/layout";
import { authorityProjection, hasCapability } from "../../services/authority";
import { emptyAddressDraft, makeStoredAddressDraft, mergeAddressDraft, parseQuickAddress, recoverStoredAddressDraft, touchAddressField, validateAddressDraft, type AddressDraft, type AddressField, type AddressLabel, type StoredAddressDraft } from "../../services/address-draft";

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

interface AddressView {
  id: string; recipientName: string; phone: string; province: string; city: string; district: string; detail: string;
  postalCode: string; nationalCode: string; provinceCode?: string; cityCode?: string; districtCode?: string; label: AddressLabel; labelText: string; summary: string; isDefault: boolean; version: number;
}
const addressLabels: Record<AddressLabel, string> = { home: "家", company: "公司", other: "其他" };
const addressDraftStorageKey = "cisme.addressDraft.v1";
function addressView(item: Omit<AddressView, "labelText" | "summary">): AddressView {
  return { ...item, labelText: addressLabels[item.label] ?? "其他", summary: `${item.province}${item.city}${item.district} ${item.detail}` };
}
function runtimeLabel(): string {
  const version = wx.getAccountInfoSync().miniProgram.envVersion;
  return version === "release" ? "正式版" : version === "trial" ? "体验版" : "开发版";
}

Page({
  profileSessionToken: "",
  requestedAddressSection: false,
  addressRecoverySnapshot: null as StoredAddressDraft | null,
  clipboardAttempt: 0,
  addressImportAttempt: 0,
  avatarAttempt: 0,
  data: { avatarUrl: defaultMemberAvatar, avatarPayload: null as string | null, avatarChanged: false, avatarBusy: false, profileVersion: 0, profileCompleted: false, profileDirty: false, profileAttempt: 0, communityVisible: false, publicStatus: "private", publicReviewNote: "", nicknameInvalid: false, displayName: "", wechatHandle: "", memberId: "", memberCode: "", runtimeLabel: runtimeLabel(), profileBusy: false, profileReady: false, profileError: "", authenticated: false, phoneLoading: false, phoneEnabled: false, phoneBound: false, phoneMasked: "", phoneBusy: false, phoneError: "", leavePromptOpen:false, editingProfile:false, editingAddresses:false, aboutOpen:false, canManageMembers:false, addresses: [] as AddressView[], addressesEnabled:true, addressesReady:false, addressesLoading:false, addressesError:"", addressAttempt:0, addressBusy:false, addressDirty:false, addressEditorOpen:false, addressDraft:emptyAddressDraft(), addressQuickInput:"", addressParsing:false, addressParseStatus:"idle" as "idle"|"success"|"partial"|"failed", addressParseSummary:"", addressParseWarnings:[] as string[], addressFieldErrors:{} as Partial<Record<AddressField,string>>, addressConflict:false, addressRecoveryAvailable:false, addressRecoveryTime:"", chromeStyle: currentChromeStyle(), consents: [] as any[], loading: true, confirmingLogout: false, loggingOut: false, sessionStatus: "unknown", workingConsentId: "", loadAttempt: 0, revokeAttempt: 0, pageAlive: true, leaving: false, operationStatus: "", errorAction: "load" as "load" | "revoke" | "auth", error: "" },
  onLoad(query:Record<string,string|undefined>) { this.data.pageAlive = true; this.requestedAddressSection=query.section==="addresses"; if(this.requestedAddressSection)this.setData({editingAddresses:true}); },
  onResize() { this.setData({ chromeStyle: currentChromeStyle() }); },
  onShow() {
    this.data.pageAlive = true;
    const memberChanged = !retainMemberSnapshot(this);
    if (memberChanged) this.clearMemberSnapshot();
    if (!requireMemberAccess()) { this.setData({ loading: false, errorAction: "auth", error: "请先确认身份后查看个人设置。" }); return; }
    this.setData({ leaving: false, canManageMembers:false, ...(memberChanged && this.requestedAddressSection ? {editingAddresses:true} : {}) });
    void this.loadSettingsBootstrap(); void this.loadAddresses(); void this.loadManagementAccess();
  },
  onHide() {
    this.clipboardAttempt = (this.clipboardAttempt ?? 0) + 1;
    this.addressImportAttempt = (this.addressImportAttempt ?? 0) + 1;
    this.avatarAttempt = (this.avatarAttempt ?? 0) + 1;
    if (this.data.avatarBusy) this.setData({ avatarBusy: false });
  },
  clearMemberSnapshot() {
    this.profileSessionToken = "";
    this.addressRecoverySnapshot = null;
    this.setData({
      loadAttempt: this.data.loadAttempt + 1, profileAttempt: this.data.profileAttempt + 1,
      addressAttempt: this.data.addressAttempt + 1, revokeAttempt: this.data.revokeAttempt + 1,
      avatarUrl: defaultMemberAvatar, avatarPayload: null, avatarChanged: false, avatarBusy: false,
      profileVersion: 0, profileCompleted: false, profileDirty: false, communityVisible: false,
      publicStatus: "private", publicReviewNote: "", nicknameInvalid: false, displayName: "", wechatHandle: "",
      memberId: "", memberCode: "", profileBusy: false, profileReady: false, profileError: "",
      authenticated: false, phoneLoading: false, phoneEnabled: false, phoneBound: false, phoneMasked: "",
      phoneBusy: false, phoneError: "", leavePromptOpen: false, editingProfile: false, editingAddresses: false,
      canManageMembers: false, addresses: [], addressesReady: false, addressesLoading: false, addressesError: "",
      addressBusy: false, addressDirty: false, addressEditorOpen: false, addressDraft: emptyAddressDraft(),
      addressQuickInput: "", addressParsing: false, addressParseStatus: "idle", addressParseSummary: "",
      addressParseWarnings: [], addressFieldErrors: {}, addressConflict: false,
      addressRecoveryAvailable: false, addressRecoveryTime: "", consents: [], loading: false,
      confirmingLogout: false, loggingOut: false, sessionStatus: "invalid", workingConsentId: "",
      operationStatus: "", error: ""
    });
    this.syncUnloadGuard();
  },
  async loadManagementAccess() { const token=getApp<IAppOption>().globalData.sessionToken; try { const projection=await authorityProjection(); if(this.data.pageAlive && token===getApp<IAppOption>().globalData.sessionToken)this.setData({canManageMembers:hasCapability(projection,"member.profile.read")}); } catch { if(this.data.pageAlive&&token===getApp<IAppOption>().globalData.sessionToken)this.setData({canManageMembers:false}); } },
  onUnload() {
    this.data.pageAlive = false;
    this.clipboardAttempt = (this.clipboardAttempt ?? 0) + 1;
    this.addressImportAttempt = (this.addressImportAttempt ?? 0) + 1;
    this.avatarAttempt = (this.avatarAttempt ?? 0) + 1;
    this.data.loadAttempt += 1;
    this.data.revokeAttempt += 1;
    this.data.addressAttempt += 1;
    wx.disableAlertBeforeUnload();
  },
  async loadSettingsBootstrap() {
    const token = getApp<IAppOption>().globalData.sessionToken;
    const attempt = ++this.data.loadAttempt;
    this.setData({ loading: true, phoneLoading: true, profileError: "", phoneError: "", error: "" });
    try {
      const snapshot = await request<any>({ path: "/v1/bootstrap/settings", cacheTags: ["member"] });
      if (!this.data.pageAlive || token !== getApp<IAppOption>().globalData.sessionToken || attempt !== this.data.loadAttempt) return;
      const profile = snapshot.settings.profile;
      const avatarUrl = await localMemberAvatar(profile.avatar_data_url, profile.avatar_revision);
      if (!this.data.pageAlive || token !== getApp<IAppOption>().globalData.sessionToken || attempt !== this.data.loadAttempt || this.data.profileDirty) return;
      this.profileSessionToken = token;
      publishMemberIdentity({id:profile.id,display_name:profile.display_name,avatarUrl,profile_revision:profile.profile_revision || 0,completed_at:profile.completed_at,public_status:profile.public_status});
      this.setData({ displayName:profile.display_name, wechatHandle:profile.wechat_handle || "", avatarUrl, memberId:profile.id, memberCode:String(profile.id || "").slice(0,8).toUpperCase(),
        avatarPayload:null,avatarChanged:false,profileVersion:profile.profile_revision || 0,profileCompleted:Boolean(profile.completed_at),communityVisible:profile.community_visible === true,
        publicStatus:profile.public_status || "private",publicReviewNote:profile.public_review_note || "",profileReady:true,
        authenticated:true,phoneEnabled:snapshot.settings.phone.enabled,phoneBound:snapshot.settings.phone.bound,phoneMasked:snapshot.settings.phone.masked || "",
        consents:snapshot.settings.consents.map((item:any)=>({...item,purposeLabel:consentPurposeLabels[item.purpose] ?? "其他已记录用途许可"})),sessionStatus:"valid",loading:false,phoneLoading:false
      },()=>this.checkAddressDraftRecovery(profile.id));
    } catch (error) {
      if (!this.data.pageAlive || attempt !== this.data.loadAttempt || token !== getApp<IAppOption>().globalData.sessionToken) return;
      const invalid=isAuthenticationFailure(error);
      this.setData({loading:false,phoneLoading:false,profileError:"会员资料暂未同步，请重试。",phoneError:"手机号状态暂未同步。",sessionStatus:invalid?"invalid":"unknown",errorAction:invalid?"auth":"load",error:invalid?"当前会话已失效。重新登录后会回到本页，不会改写已有许可。":"设置快照暂时无法加载，请检查网络后重试。"},scrollToSettingsError);
    }
  },
  async loadProfile() {
    const token = getApp<IAppOption>().globalData.sessionToken;
    if (this.data.profileDirty && this.profileSessionToken === token) return;
    if (this.profileSessionToken !== token) this.setData({profileDirty:false,displayName:"",wechatHandle:"",avatarUrl:defaultMemberAvatar,avatarChanged:false,avatarPayload:null});
    const attempt = ++this.data.profileAttempt;
    this.setData({profileReady:this.profileSessionToken === token && this.data.profileReady, profileError:""});
    if (!token) { this.profileSessionToken=""; this.setData({profileDirty:false,avatarUrl:defaultMemberAvatar}); return; }
    try {
      const profile = await request<any>({path:"/v1/me/profile", authMode:"optional"});
      const avatarUrl = await localMemberAvatar(profile.avatar_data_url,profile.avatar_revision);
      if (this.data.pageAlive && attempt === this.data.profileAttempt && token === getApp<IAppOption>().globalData.sessionToken && !this.data.profileDirty) { this.profileSessionToken=token; publishMemberIdentity({id:profile.id,display_name:profile.display_name,avatarUrl,profile_revision:profile.profile_revision || 0,completed_at:profile.completed_at,public_status:profile.public_status}); this.setData({
        displayName:profile.display_name, wechatHandle:profile.wechat_handle || "", avatarUrl, memberId:profile.id, memberCode:String(profile.id || "").slice(0,8).toUpperCase(),
        avatarPayload:null,avatarChanged:false,profileVersion:profile.profile_revision || 0, profileCompleted:Boolean(profile.completed_at),
        communityVisible:profile.community_visible === true,publicStatus:profile.public_status || "private",publicReviewNote:profile.public_review_note || "",profileReady:true
      },()=>this.checkAddressDraftRecovery(profile.id)); }
    } catch { if(this.data.pageAlive && attempt === this.data.profileAttempt && token === getApp<IAppOption>().globalData.sessionToken)this.setData({profileError:"会员资料暂未同步，请重试。"}); }
  },
  markProfileDirty() {
    this.setData({profileDirty:true,profileError:""});
    this.syncUnloadGuard();
  },
  syncUnloadGuard() {
    if (this.data.profileDirty || this.data.addressDirty || this.data.workingConsentId || this.data.addressBusy) wx.enableAlertBeforeUnload({message:"有尚未确认的设置修改，请完成或放弃后再离开。"});
    else wx.disableAlertBeforeUnload();
  },
  editDisplayName(event:WechatMiniprogram.Input) { if(this.data.displayName === event.detail.value)return; this.setData({displayName:event.detail.value,nicknameInvalid:false}); this.markProfileDirty(); },
  editWechatHandle(event:WechatMiniprogram.Input) { if(this.data.wechatHandle === event.detail.value)return; this.setData({wechatHandle:event.detail.value}); this.markProfileDirty(); },
  reviewNickname(event:WechatMiniprogram.CustomEvent) {
    if (event.detail.pass === false) this.setData({nicknameInvalid:true,profileError:"微信未通过该昵称检测，请修改后再保存。"});
  },
  changeCommunityVisibility(event:WechatMiniprogram.SwitchChange) { this.setData({communityVisible:event.detail.value}); this.markProfileDirty(); },
  async chooseAvatar(event:WechatMiniprogram.CustomEvent) {
    const path = event.detail.avatarUrl;
    if (this.data.workingConsentId || this.data.confirmingLogout || this.data.loggingOut || this.data.leavePromptOpen || this.data.phoneBusy || !path || !this.data.profileReady || this.data.avatarBusy || this.data.profileBusy) return;
    const token = getApp<IAppOption>().globalData.sessionToken;
    const attempt = this.avatarAttempt = (this.avatarAttempt ?? 0) + 1;
    const current = () => this.data.pageAlive && token === getApp<IAppOption>().globalData.sessionToken && attempt === this.avatarAttempt;
    this.setData({avatarBusy:true,profileError:""});
    try {
      const payload = await prepareAvatarUpload(this as unknown as WechatMiniprogram.Page.TrivialInstance,path);
      if (!current()) return;
      this.setData({avatarUrl:path,avatarPayload:payload,avatarChanged:true}); this.markProfileDirty();
    } catch { if(current())this.setData({profileError:"头像未处理成功，请重新选择；原头像保持不变。"}); }
    finally { if(current())this.setData({avatarBusy:false}); }
  },
  removeAvatar() { if(this.data.profileBusy || this.data.avatarBusy)return; this.setData({avatarUrl:defaultMemberAvatar,avatarPayload:null,avatarChanged:true}); this.markProfileDirty(); },
  async reloadProfile() {
    if(this.data.profileBusy || this.data.avatarBusy)return;
    if(this.data.profileDirty) {
      const result=await wx.showModal({title:"重新加载会员资料？",content:"未保存的修改将被丢弃，读取服务器当前资料。",confirmText:"重新加载"});
      if(!result.confirm)return;
    }
    this.setData({profileDirty:false});this.syncUnloadGuard();await this.loadProfile();
  },
  async saveProfile(event?:WechatMiniprogram.CustomEvent) {
    if(this.data.workingConsentId || this.data.confirmingLogout || this.data.loggingOut || this.data.leavePromptOpen || this.data.phoneBusy || this.data.profileBusy || !this.data.profileReady || this.data.avatarBusy || this.data.nicknameInvalid) return;
    const submittedName = event?.detail?.value?.nickname;
    if(typeof submittedName === "string")this.setData({displayName:submittedName});
    const token = getApp<IAppOption>().globalData.sessionToken;
    this.setData({profileBusy:true, profileError:""});
    try {
      await request({path:"/v1/me/profile", method:"PUT", data:{displayName:this.data.displayName,wechatHandle:this.data.wechatHandle,communityVisible:this.data.communityVisible,expectedVersion:this.data.profileVersion,...(this.data.avatarChanged ? {avatarDataUrl:this.data.avatarPayload} : {})}});
      if(!this.data.pageAlive || token !== getApp<IAppOption>().globalData.sessionToken)return;
      this.setData({profileDirty:false});this.syncUnloadGuard();await this.loadProfile();
      wx.showToast({title:"会员资料已保存",icon:"success"});
    } catch(error) { if(this.data.pageAlive && token === getApp<IAppOption>().globalData.sessionToken)this.setData({profileError:(error as {title?:string}).title || "资料未保存，请重试"}); }
    finally { if(this.data.pageAlive)this.setData({profileBusy:false}); }
  },
  async loadPhone() {
    const token = getApp<IAppOption>().globalData.sessionToken;
    this.setData({ authenticated: Boolean(token), phoneLoading:Boolean(token), phoneEnabled: false, phoneBound: false, phoneMasked: "", phoneError: "" });
    if (!token) return;
    try {
      const result = await request<{enabled:boolean;bound:boolean;masked:string}>({path:"/v1/me/phone",authMode:"optional"});
      if (this.data.pageAlive && token === getApp<IAppOption>().globalData.sessionToken) this.setData({ phoneEnabled: result.enabled, phoneBound: result.bound, phoneMasked: result.masked || "" });
    } catch { if (this.data.pageAlive && token === getApp<IAppOption>().globalData.sessionToken) this.setData({ phoneError: "手机号状态暂未同步，你仍可继续使用会员账号。" }); }
    finally { if(this.data.pageAlive && token === getApp<IAppOption>().globalData.sessionToken)this.setData({phoneLoading:false}); }
  },
  async bindPhone(event: WechatMiniprogram.CustomEvent) {
    if (this.data.workingConsentId || this.data.confirmingLogout || this.data.loggingOut || this.data.leavePromptOpen || this.data.phoneBusy || this.data.profileBusy || this.data.avatarBusy || !this.data.authenticated) return;
    if (!event.detail.code) { this.setData({phoneError:"未授权手机号，你仍可浏览并使用不需要手机号的功能。"}); return; }
    const token=getApp<IAppOption>().globalData.sessionToken;
    this.setData({phoneBusy:true,phoneError:""});
    try {
      const result=await request<{bound:boolean;masked:string}>({path:"/v1/me/phone",method:"POST",data:{code:event.detail.code}});
      if(this.data.pageAlive && token === getApp<IAppOption>().globalData.sessionToken){this.setData({phoneBound:result.bound,phoneMasked:result.masked});const identity=memberIdentity();if(identity)publishMemberIdentity({...identity,phone_masked:result.masked});}
    } catch(error) {if(this.data.pageAlive && token === getApp<IAppOption>().globalData.sessionToken)this.setData({phoneError:(error as {title?:string}).title || "绑定未确认，请重新授权；会员注册结果不受影响。"});}
    finally{if(this.data.pageAlive)this.setData({phoneBusy:false});}
  },
  async unbindPhone() {
    if(this.data.workingConsentId || this.data.confirmingLogout || this.data.loggingOut || this.data.leavePromptOpen || this.data.phoneBusy || this.data.profileBusy || this.data.avatarBusy || !this.data.phoneBound)return;
    const token=getApp<IAppOption>().globalData.sessionToken;
    this.setData({phoneBusy:true,phoneError:""});
    try {
      const answer=await wx.showModal({title:"解除联系电话绑定？",content:"将删除当前会员保存的联系电话；微信会员身份、昵称与护理记录不受影响。",confirmText:"解除绑定"});
      if(!answer.confirm || !this.data.pageAlive || token!==getApp<IAppOption>().globalData.sessionToken)return;
      await request({path:"/v1/me/phone",method:"DELETE"});
      if(this.data.pageAlive && token===getApp<IAppOption>().globalData.sessionToken){this.setData({phoneBound:false,phoneMasked:""});const identity=memberIdentity();if(identity)publishMemberIdentity({...identity,phone_masked:null});}
    }catch(error){if(this.data.pageAlive && token===getApp<IAppOption>().globalData.sessionToken)this.setData({phoneError:(error as {title?:string}).title || "解绑未确认，请刷新核对"});}
    finally{if(this.data.pageAlive)this.setData({phoneBusy:false});}
  },
  async confirmProfileLeave():Promise<boolean> {
    if(this.data.profileBusy || this.data.avatarBusy || this.data.phoneBusy)return false;
    if(!this.data.profileDirty)return true;
    if(this.data.leavePromptOpen)return false;
    this.setData({leavePromptOpen:true});
    const result=await wx.showModal({title:"资料尚未保存",content:"现在离开将放弃本次修改；已有会员资料不受影响。",confirmText:"放弃修改",cancelText:"继续编辑"}).catch(()=>({confirm:false}));
    if(this.data.pageAlive)this.setData({leavePromptOpen:false});
    if(result.confirm){this.profileSessionToken="";this.setData({profileDirty:false,profileReady:false});this.syncUnloadGuard();}
    return result.confirm;
  },
  async loadAddresses() {
    const token = getApp<IAppOption>().globalData.sessionToken;
    const attempt = ++this.data.addressAttempt;
    this.setData({addressesLoading:true,addressesError:""});
    if(!token){this.setData({addresses:[],addressesReady:false,addressesLoading:false});return;}
    try{
      const result=await request<{enabled:boolean;maxAddresses:number;addresses:Array<Omit<AddressView,"labelText"|"summary">>}>({path:"/v1/me/addresses"});
      if(!this.data.pageAlive || attempt!==this.data.addressAttempt || token!==getApp<IAppOption>().globalData.sessionToken)return;
      this.setData({addressesEnabled:result.enabled,addresses:result.addresses.map(addressView),addressesReady:true,addressesError:result.enabled?"":"地址簿安全存储尚未配置，当前不会收集地址。"});
    }catch(error){if(this.data.pageAlive && attempt===this.data.addressAttempt && token===getApp<IAppOption>().globalData.sessionToken)this.setData({addressesReady:false,addressesError:(error as {title?:string}).title||"收货地址暂时无法同步，请重试。"});}
    finally{if(this.data.pageAlive && attempt===this.data.addressAttempt)this.setData({addressesLoading:false});}
  },
  checkAddressDraftRecovery(ownerMemberId?:string) {
    ownerMemberId=ownerMemberId || this.data.memberId;
    if(!ownerMemberId)return;
    const stored=recoverStoredAddressDraft(wx.getStorageSync<unknown>(addressDraftStorageKey),ownerMemberId);
    this.addressRecoverySnapshot=stored;
    if(!stored){this.setData({addressRecoveryAvailable:false,addressRecoveryTime:""});return;}
    const saved=new Date(stored.savedAt);
    const time=`${saved.getMonth()+1}月${saved.getDate()}日 ${String(saved.getHours()).padStart(2,"0")}:${String(saved.getMinutes()).padStart(2,"0")}`;
    this.setData({addressRecoveryAvailable:true,addressRecoveryTime:time});
  },
  persistAddressDraft() {
    const owner=this.data.memberId || memberIdentity()?.id || "";
    if(!owner || !this.data.addressEditorOpen || !this.data.addressDirty)return;
    const stored=makeStoredAddressDraft(owner,this.data.addressDraft,this.data.addressQuickInput);
    this.addressRecoverySnapshot=stored;
    wx.setStorageSync(addressDraftStorageKey,stored);
    this.setData({addressRecoveryAvailable:true,addressRecoveryTime:"刚刚"});
  },
  clearAddressDraftRecovery() {
    this.addressRecoverySnapshot=null;
    wx.removeStorageSync(addressDraftStorageKey);
    this.setData({addressRecoveryAvailable:false,addressRecoveryTime:""});
  },
  restoreAddressDraft() {
    const stored=this.addressRecoverySnapshot;
    if(!stored || stored.ownerMemberId!==this.data.memberId)return;
    this.setData({addressEditorOpen:true,addressDirty:true,addressDraft:stored.draft,addressQuickInput:stored.quickInput,addressParseStatus:"idle",addressParseSummary:"已恢复未保存的地址草稿",addressParseWarnings:[],addressFieldErrors:{},addressConflict:false});
    this.syncUnloadGuard();
  },
  discardRecoveredAddressDraft() {
    this.clearAddressDraftRecovery();
    if(this.data.addressEditorOpen)this.setData({addressEditorOpen:false,addressDirty:false,addressDraft:emptyAddressDraft(),addressQuickInput:"",addressFieldErrors:{},addressConflict:false});
    this.syncUnloadGuard();
  },
  async openAddresses(){
    if(this.data.addressBusy)return;
    if(this.data.editingProfile && this.data.profileDirty && !await this.confirmProfileLeave())return;
    if(this.data.editingAddresses && this.data.addressDirty && !await this.confirmAddressLeave())return;
    this.setData({editingProfile:false,editingAddresses:!this.data.editingAddresses,addressEditorOpen:false,addressDirty:false,addressDraft:emptyAddressDraft(),addressQuickInput:"",addressFieldErrors:{},addressConflict:false,addressParseStatus:"idle",addressParseSummary:"",addressParseWarnings:[]});
    this.syncUnloadGuard();
    if(this.data.editingAddresses){this.checkAddressDraftRecovery();if(!this.data.addressesReady)void this.loadAddresses();}
  },
  async newAddress(){
    if(this.data.addressBusy || !this.data.addressesEnabled)return;
    if(this.data.addresses.length>=10){wx.showToast({title:"最多保存 10 个地址",icon:"none"});return;}
    if(this.data.addressRecoveryAvailable){const answer=await wx.showModal({title:"发现未完成的地址",content:"可以恢复上次草稿，或丢弃后填写新地址。",confirmText:"恢复草稿",cancelText:"填写新的"}).catch(()=>({confirm:false,cancel:false}));if(answer.confirm){this.restoreAddressDraft();return;}if(!answer.cancel)return;this.clearAddressDraftRecovery();}
    this.setData({addressEditorOpen:true,addressDirty:false,addressDraft:{...emptyAddressDraft(),isDefault:this.data.addresses.length===0},addressQuickInput:"",addressParseStatus:"idle",addressParseSummary:"",addressParseWarnings:[],addressFieldErrors:{},addressConflict:false});
  },
  editAddress(event:WechatMiniprogram.TouchEvent){
    if(this.data.addressBusy)return;
    const item=this.data.addresses.find(address=>address.id===String(event.currentTarget.dataset.id||""));
    if(!item)return;
    const codes=[item.provinceCode||"",item.cityCode||"",item.districtCode||item.nationalCode||""];
    this.setData({addressEditorOpen:true,addressDirty:false,addressDraft:{...emptyAddressDraft(),id:item.id,recipientName:item.recipientName,phone:item.phone,region:[item.province,item.city,item.district],regionText:[item.province,item.city,item.district].join(" "),regionCodes:codes,regionSource:"server",regionNeedsConfirmation:codes.some(code=>!code),detail:item.detail,postalCode:item.postalCode||"",nationalCode:item.nationalCode||item.districtCode||"",label:item.label,isDefault:item.isDefault,expectedVersion:item.version,clientRequestKey:""},addressQuickInput:"",addressParseStatus:"idle",addressParseSummary:"",addressParseWarnings:codes.some(code=>!code)?["此历史地址缺少完整行政区划 code，保存前请重新选择所在地"]:[],addressFieldErrors:{},addressConflict:false});
  },
  updateAddressDraft(next:AddressDraft,clearedField?:AddressField) {
    const errors={...this.data.addressFieldErrors};if(clearedField)delete errors[clearedField];
    this.setData({addressDraft:next,addressDirty:true,addressConflict:false,addressFieldErrors:errors},()=>this.persistAddressDraft());this.syncUnloadGuard();
  },
  editAddressField(event:WechatMiniprogram.CustomEvent){
    const detail=event.detail as unknown as {field?:string;value?:string};
    const field=String(detail.field||"");
    if(!["recipientName","phone","detail","postalCode"].includes(field))return;
    this.updateAddressDraft(touchAddressField(this.data.addressDraft,field as AddressField,String(detail.value??"")),field as AddressField);
  },
  editAddressQuickInput(event:WechatMiniprogram.CustomEvent){const value=String((event.detail as unknown as {value?:string}).value??"").slice(0,500);this.setData({addressQuickInput:value,addressDirty:true,addressParseStatus:"idle",addressParseSummary:"",addressParseWarnings:[]},()=>this.persistAddressDraft());this.syncUnloadGuard();},
  recognizeAddressText(){
    if(this.data.addressBusy || this.data.addressParsing)return;
    this.setData({addressParsing:true,addressParseSummary:"正在本机识别…",addressParseWarnings:[]},()=>{
      const result=parseQuickAddress(this.data.addressQuickInput);
      const next=mergeAddressDraft(this.data.addressDraft,result.patch,true);
      const summary=result.recognized.length?`已识别：${result.recognized.join("、")}`:"未识别出可可靠填写的字段";
      this.setData({addressDraft:next,addressDirty:true,addressParsing:false,addressParseStatus:result.status,addressParseSummary:summary,addressParseWarnings:[...result.warnings,...(result.missing.length?[`仍需补充：${result.missing.join("、")}`]:[])]},()=>this.persistAddressDraft());
      this.syncUnloadGuard();
    });
  },
  pasteAndRecognizeAddress(){
    if(this.data.addressBusy || this.data.addressParsing)return;
    const token=getApp<IAppOption>().globalData.sessionToken,ownerId=this.data.memberId;
    const attempt=this.clipboardAttempt=(this.clipboardAttempt??0)+1;
    const current=()=>this.data.pageAlive&&token===getApp<IAppOption>().globalData.sessionToken&&ownerId===this.data.memberId&&attempt===this.clipboardAttempt;
    wx.getClipboardData({
      success:(result)=>{if(!current())return;this.setData({addressQuickInput:String(result.data||"").slice(0,500)},()=>{if(current())this.recognizeAddressText();});},
      fail:(error)=>{if(current() && !String(error.errMsg||"").includes("cancel"))this.setData({addressParseStatus:"failed",addressParseSummary:"未能读取剪贴板",addressParseWarnings:["你仍可在文本框中长按粘贴，或直接手工填写"]});}
    });
  },
  changeAddressRegion(event:WechatMiniprogram.CustomEvent){
    const detail=event.detail as unknown as {value?:string[];code?:string[];postcode?:string};
    const region=Array.isArray(detail.value)?detail.value.map(String):[];
    const codes=Array.isArray(detail.code)?[0,1,2].map(index=>String(detail.code?.[index]||"")):[];
    let next=mergeAddressDraft(this.data.addressDraft,{region,regionCodes:codes,regionSource:"picker",regionNeedsConfirmation:codes.length!==3||codes.some(code=>!code),nationalCode:codes[2]||""},false);
    next={...next,manualTouched:{...next.manualTouched,region:true}};
    if(detail.postcode && !next.manualTouched.postalCode)next={...next,postalCode:String(detail.postcode)};
    this.updateAddressDraft(next,"region");
  },
  selectAddressLabel(event:WechatMiniprogram.CustomEvent){
    const label=String((event.detail as unknown as {label?:string}).label||"") as AddressLabel;
    if(!addressLabels[label])return;
    this.updateAddressDraft(touchAddressField(this.data.addressDraft,"label",label));
  },
  changeAddressDefault(event:WechatMiniprogram.CustomEvent){this.updateAddressDraft(touchAddressField(this.data.addressDraft,"isDefault",Boolean((event.detail as unknown as {value?:boolean}).value)));},
  importWechatAddress(){
    if(this.data.addressBusy)return;
    const token=getApp<IAppOption>().globalData.sessionToken,ownerId=this.data.memberId;
    const attempt=this.addressImportAttempt=(this.addressImportAttempt??0)+1;
    const current=()=>this.data.pageAlive&&token===getApp<IAppOption>().globalData.sessionToken&&ownerId===this.data.memberId&&attempt===this.addressImportAttempt;
    if(!token||!ownerId){this.setData({addressesError:"会员身份暂未同步，请稍后重试。"});return;}
    wx.chooseAddress({
      success:(result)=>{if(!current())return;const region=[result.provinceName||"",result.cityName||"",result.countyName||""];const districtCode=result.nationalCode||"";const next=mergeAddressDraft(this.data.addressDraft,{recipientName:result.userName||"",phone:result.telNumber||"",region,regionCodes:["","",districtCode],regionSource:"wechat",regionNeedsConfirmation:true,detail:(result as typeof result & {detailInfoNew?:string}).detailInfoNew||[result.streetName,result.detailInfo].filter(Boolean).join(""),postalCode:result.postalCode||"",nationalCode:districtCode},true);this.setData({addressEditorOpen:true,addressDirty:true,addressDraft:next,addressParseStatus:"partial",addressParseSummary:"已从微信地址填入未手工修改的字段",addressParseWarnings:["请用所在地选择器核对省、市、区县及行政区划 code"]},()=>{if(current())this.persistAddressDraft();});if(current())this.syncUnloadGuard();},
      fail:(error)=>{if(current()&&!String(error.errMsg||"").includes("cancel"))this.setData({addressesError:"未能读取微信收货地址，你仍可手动填写。"});}
    });
  },
  async confirmAddressLeave():Promise<boolean>{
    if(!this.data.addressDirty)return true;
    const result=await wx.showModal({title:"地址尚未保存",content:"现在离开将放弃本次地址修改。",confirmText:"放弃修改",cancelText:"继续编辑"}).catch(()=>({confirm:false}));
    if(result.confirm){this.clearAddressDraftRecovery();this.setData({addressDirty:false,addressEditorOpen:false,addressDraft:emptyAddressDraft(),addressQuickInput:"",addressFieldErrors:{},addressConflict:false});this.syncUnloadGuard();}
    return result.confirm;
  },
  async cancelAddressEdit(){if(this.data.addressBusy)return;if(await this.confirmAddressLeave()){this.setData({addressEditorOpen:false,addressDraft:emptyAddressDraft(),addressQuickInput:"",addressFieldErrors:{},addressConflict:false});}},
  async saveAddress(){
    if(this.data.addressBusy || !this.data.addressesEnabled)return;
    const draft=this.data.addressDraft;
    const validation=validateAddressDraft(draft);
    if(!validation.valid){this.setData({addressFieldErrors:validation.errors,addressesError:"地址尚未通过校验，请核对标记字段。"});wx.pageScrollTo({selector:`#address-field-${validation.firstField}`,duration:motionDuration(180)});return;}
    const token=getApp<IAppOption>().globalData.sessionToken;
    this.setData({addressBusy:true,addressesError:"",operationStatus:"正在安全保存收货地址…"});this.syncUnloadGuard();
    const data={recipientName:draft.recipientName,phone:draft.phone,province:draft.region[0],city:draft.region[1],district:draft.region[2],detail:draft.detail,postalCode:draft.postalCode,nationalCode:draft.regionCodes[2]||draft.nationalCode,provinceCode:draft.regionCodes[0],cityCode:draft.regionCodes[1],districtCode:draft.regionCodes[2],label:draft.label,isDefault:draft.isDefault,...(draft.id?{expectedVersion:draft.expectedVersion}:{})};
    try{
      await request({path:draft.id?`/v1/me/addresses/${draft.id}`:"/v1/me/addresses",method:draft.id?"PUT":"POST",...(draft.id?{}:{idempotencyKey:draft.clientRequestKey}),data});
      if(!this.data.pageAlive || token!==getApp<IAppOption>().globalData.sessionToken)return;
      this.clearAddressDraftRecovery();this.setData({addressDirty:false,addressEditorOpen:false,addressDraft:emptyAddressDraft(),addressQuickInput:"",addressFieldErrors:{},addressConflict:false,operationStatus:"收货地址已保存"});this.syncUnloadGuard();await this.loadAddresses();
    }catch(error){if(this.data.pageAlive && token===getApp<IAppOption>().globalData.sessionToken){const problem=error as {title?:string;code?:string};this.setData({addressesError:problem.code==="DELIVERY_ADDRESS_CHANGED"?"这个地址已在其他页面更新。请选择加载服务器版本，或将当前内容另存为新地址。":problem.title||"地址未保存，草稿已保留，可按原请求重试。",addressConflict:problem.code==="DELIVERY_ADDRESS_CHANGED",operationStatus:""});this.persistAddressDraft();}}
    finally{if(this.data.pageAlive){this.setData({addressBusy:false});this.syncUnloadGuard();}}
  },
  async loadConflictedAddress(){
    const id=this.data.addressDraft.id;if(!id||this.data.addressBusy)return;
    this.setData({addressBusy:true,operationStatus:"正在加载服务器版本…"});
    await this.loadAddresses();
    if(!this.data.addressesReady){this.setData({addressBusy:false,operationStatus:"",addressesError:"服务器版本暂时无法加载，当前草稿仍保留在本机。"});this.syncUnloadGuard();return;}
    const item=this.data.addresses.find(address=>address.id===id);
    if(item){const codes=[item.provinceCode||"",item.cityCode||"",item.districtCode||item.nationalCode||""];this.clearAddressDraftRecovery();this.setData({addressDraft:{...emptyAddressDraft(),id:item.id,recipientName:item.recipientName,phone:item.phone,region:[item.province,item.city,item.district],regionText:[item.province,item.city,item.district].join(" "),regionCodes:codes,regionSource:"server",regionNeedsConfirmation:codes.some(code=>!code),detail:item.detail,postalCode:item.postalCode||"",nationalCode:item.nationalCode||"",label:item.label,isDefault:item.isDefault,expectedVersion:item.version,clientRequestKey:""},addressDirty:false,addressConflict:false,addressFieldErrors:{},addressesError:"",operationStatus:"已加载服务器当前版本"});}
    else this.setData({addressesError:"服务器中的这条地址已不存在。可将当前内容另存为新地址。",operationStatus:""});
    this.setData({addressBusy:false});this.syncUnloadGuard();
  },
  saveConflictedAsNew(){
    if(this.data.addressBusy || this.data.addresses.length>=10)return;
    const fresh=emptyAddressDraft();
    const draft={...this.data.addressDraft,id:"",expectedVersion:0,clientRequestKey:fresh.clientRequestKey,isDefault:false};
    this.setData({addressDraft:draft,addressConflict:false,addressesError:"",addressDirty:true},()=>{this.persistAddressDraft();void this.saveAddress();});
  },
  async setDefaultAddress(event:WechatMiniprogram.TouchEvent){
    if(this.data.addressBusy)return;const item=this.data.addresses.find(address=>address.id===String(event.currentTarget.dataset.id||""));if(!item||item.isDefault)return;
    this.setData({addressBusy:true,addressesError:"",operationStatus:"正在更新默认地址…"});this.syncUnloadGuard();
    try{await request({path:`/v1/me/addresses/${item.id}/default`,method:"POST",data:{expectedVersion:item.version}});if(this.data.pageAlive){this.setData({operationStatus:"默认地址已更新"});await this.loadAddresses();}}
    catch(error){if(this.data.pageAlive){this.setData({addressesError:(error as {title?:string}).title||"默认地址未更新，请刷新后重试。",operationStatus:""});await this.loadAddresses();}}
    finally{if(this.data.pageAlive){this.setData({addressBusy:false});this.syncUnloadGuard();}}
  },
  async deleteAddress(event:WechatMiniprogram.TouchEvent){
    if(this.data.addressBusy)return;const item=this.data.addresses.find(address=>address.id===String(event.currentTarget.dataset.id||""));if(!item)return;
    const result=await wx.showModal({title:"删除这个收货地址？",content:"仅删除地址簿记录，不会删除会员账号或历史业务记录。",confirmText:"删除",confirmColor:"#8b3f5c"}).catch(()=>({confirm:false}));if(!result.confirm)return;
    this.setData({addressBusy:true,addressesError:"",operationStatus:"正在删除收货地址…"});this.syncUnloadGuard();
    try{await request({path:`/v1/me/addresses/${item.id}`,method:"DELETE",data:{expectedVersion:item.version}});if(this.data.pageAlive){this.setData({operationStatus:"收货地址已删除"});await this.loadAddresses();}}
    catch(error){if(this.data.pageAlive){this.setData({addressesError:(error as {title?:string}).title||"地址删除结果未确认，请刷新核对。",operationStatus:""});await this.loadAddresses();}}
    finally{if(this.data.pageAlive){this.setData({addressBusy:false});this.syncUnloadGuard();}}
  },
  async toggleAbout(){
    if(this.data.addressBusy || this.data.profileBusy || this.data.avatarBusy || this.data.phoneBusy)return;
    if(this.data.profileDirty && !await this.confirmProfileLeave())return;
    if(this.data.addressDirty && !await this.confirmAddressLeave())return;
    this.setData({editingProfile:false,editingAddresses:false,addressEditorOpen:false,aboutOpen:!this.data.aboutOpen});
  },
  copyMemberId(){if(this.data.memberId)wx.setClipboardData({data:this.data.memberId});},
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
    if (!id || !this.data.pageAlive || this.data.leaving || this.data.profileBusy || this.data.avatarBusy || this.data.phoneBusy || this.data.leavePromptOpen || this.data.workingConsentId || this.data.confirmingLogout || this.data.loggingOut) return;
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
        this.syncUnloadGuard();
      }
    }
  },
  async logout() {
    if (!this.data.pageAlive || this.data.leaving) return;
    if (this.data.profileBusy || this.data.avatarBusy || this.data.phoneBusy || this.data.addressBusy || this.data.leavePromptOpen || this.data.workingConsentId || this.data.confirmingLogout || this.data.loggingOut) { wx.showToast({ title: this.data.loggingOut ? "正在退出当前账号" : this.data.confirmingLogout ? "退出确认窗口已打开" : "设置操作确认中，请稍候", icon: "none" }); return; }
    if (this.data.profileDirty && !await this.confirmProfileLeave()) return;
    if (this.data.addressDirty && !await this.confirmAddressLeave()) return;
    if (!this.data.pageAlive || this.data.leaving) return;
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
    this.clearAddressDraftRecovery();
    setSessionToken("");
    this.clearMemberSnapshot();
    this.setData({ loggingOut: true, loading: false, consents: [], sessionStatus: "invalid", operationStatus: "正在安全退出当前账号…", error: "" });
    wx.reLaunch({
      url: "/pages/account/index",
      fail: () => {
        if (this.data.pageAlive) this.setData({ loggingOut: false, operationStatus: "", errorAction: "auth", error: "会话已经安全退出，但登录页面暂时无法打开。请点击下方按钮重新登录。" }, scrollToSettingsError);
      }
    });
  },
  async openAccount() {
    if(this.data.workingConsentId || this.data.confirmingLogout || this.data.loggingOut || this.data.profileBusy || this.data.avatarBusy || this.data.phoneBusy || this.data.addressBusy)return;
    if(this.data.editingAddresses && this.data.addressDirty && !await this.confirmAddressLeave())return;
    if(this.data.editingProfile && !await this.confirmProfileLeave())return;
    this.setData({editingAddresses:false,addressEditorOpen:false,editingProfile:!this.data.editingProfile});
    if(this.data.editingProfile)void this.loadProfile();
  },
  async openSettingsRoute(url:string,failureCopy:string) {
    if(this.data.workingConsentId || this.data.confirmingLogout || this.data.loggingOut || this.data.profileBusy || this.data.avatarBusy || this.data.phoneBusy || this.data.addressBusy)return;
    if(this.data.profileDirty && !await this.confirmProfileLeave())return;
    if(this.data.addressDirty && !await this.confirmAddressLeave())return;
    wx.navigateTo({url,fail:()=>wx.showToast({title:failureCopy,icon:"none"})});
  },
  openLegal() { void this.openSettingsRoute("/pages/legal/index?type=privacy","隐私政策暂时无法打开"); },
  openPrivacyRights() { void this.openSettingsRoute("/pages/privacy-rights/index","数据权利页面暂时无法打开"); },
  openMemberManagement() { if(this.data.canManageMembers)void this.openSettingsRoute("/pages/management-members/index","会员管理暂时无法打开"); },
  async back() {
    if (!this.data.pageAlive || this.data.leaving) return;
    if (this.data.profileBusy || this.data.avatarBusy || this.data.phoneBusy || this.data.addressBusy || this.data.leavePromptOpen || this.data.workingConsentId || this.data.confirmingLogout || this.data.loggingOut) { wx.showToast({ title: this.data.loggingOut ? "正在退出当前账号" : this.data.confirmingLogout ? "请先完成退出确认" : "设置操作确认中，请稍候", icon: "none" }); return; }
    if (this.data.profileDirty && !await this.confirmProfileLeave()) return;
    if (this.data.addressDirty && !await this.confirmAddressLeave()) return;
    if (!this.data.pageAlive || this.data.leaving) return;
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
