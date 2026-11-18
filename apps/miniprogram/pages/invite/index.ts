import { retainReadPresentation } from "../../services/read-presentation";
import { requireMemberAccess, retainMemberSnapshot } from "../../services/api";
import { clearAuthenticationRedirectSuppression, request } from "../../services/api";
import { currentChromeStyle } from "../../services/layout";
import {commerceContextRevision} from '../../services/commerce-command-store';

type ShareLink = { officerShareId?:string|null; shareId: string; targetType: string; targetRef: string; state: string; createdAt: string; expiresAt: string };
const shortCode = (id: string) => id.slice(0, 8).toUpperCase();
const dateLabel = (value: string) => {
  const date = new Date(value);
  return `${date.getFullYear()}.${String(date.getMonth() + 1).padStart(2, "0")}.${String(date.getDate()).padStart(2, "0")}`;
};

Page({
  shareOwner:'',shareContext:-1,
  data: { invitationReady:false,shareReady:false,chromeStyle: currentChromeStyle(), loading: true, preparing: false, leaving: false, pageAlive: true, attempt: 0, displayName: "CISME 会员", shareId: "", officerShareId:"",shareCode: "待生成", expiresAt: "", commercialEligible:false, referralAvailable:false, referralCode:"", referralError:"", history: [] as Array<ShareLink & { code: string; date: string; label: string }>, error: "" },
  onLoad() { wx.hideShareMenu(); },
  onResize() { this.setData({ chromeStyle: currentChromeStyle() }); },
  onShow() {
    this.data.pageAlive = true;
    if (!retainMemberSnapshot(this)) {
      this.setData({ invitationReady:false,shareReady:false,attempt: this.data.attempt + 1, loading: true, preparing: false, displayName: "CISME 会员", shareId: "", officerShareId:"",shareCode: "待生成",
        expiresAt: "", commercialEligible: false, referralAvailable:false, referralCode: "", referralError: "", history: [], error: "" });
      wx.hideShareMenu();
    }
    if (!requireMemberAccess()) { this.setData({ loading: false, error: "登录后即可查看邀请记录。" }); return; }
    this.setData({ pageAlive: true, leaving: false });
    void this.load();
  },
  onHide() { this.data.attempt += 1; },
  onUnload() { this.data.pageAlive = false; this.data.attempt += 1; },
  async load(event?: WechatMiniprogram.TouchEvent) {
    if (event?.type) clearAuthenticationRedirectSuppression();
    const attempt = this.data.attempt + 1;
    const token = getApp<IAppOption>().globalData.sessionToken;
    const context=commerceContextRevision();this.shareOwner='';this.shareContext=-1;
    const preserve = retainReadPresentation(this);
    this.setData({ attempt, loading: true, shareReady:false, preparing: false, error: "", referralError:"", ...(!preserve ? { invitationReady:false, displayName: "CISME 会员", shareId: "", officerShareId:"",shareCode: "待生成",
      expiresAt: "", commercialEligible: false, referralAvailable:false, referralCode: "", history: [] } : {}) });
    wx.hideShareMenu();
    try {
      const [member, links, commercial] = await Promise.all([request<{ display_name: string }>({ path: "/v1/me" }), request<ShareLink[]>({ path: "/v1/me/shares?targetType=invite" }),
        request<{canShare:boolean;officer:{state:string;referralCode:string}|null}>({path:"/v1/me/sharing-officer"}).catch(()=>({canShare:false,officer:null}))]);
      if (!this.data.pageAlive || attempt !== this.data.attempt || token !== getApp<IAppOption>().globalData.sessionToken||context!==commerceContextRevision()) return;
      this.shareOwner=token;this.shareContext=context;
      const invitations = links.filter((link) => link.targetType === "invite" && link.targetRef === "home");
      const active = invitations.find((link) => link.state === "active");
      const referralAvailable=commercial.canShare===true&&commercial.officer?.state==='active';
      this.setData({ invitationReady:true,displayName: member.display_name || "CISME 会员", shareId: active?.shareId ?? "",officerShareId:'', shareCode: active ? shortCode(active.shareId) : "待生成", expiresAt: active?.expiresAt ?? "", commercialEligible:referralAvailable,referralAvailable,referralCode:commercial.officer?.referralCode||'',referralError:'', history: invitations.slice(0, 5).map((link) => ({ ...link, code: shortCode(link.shareId), date: dateLabel(link.createdAt), label: link.state === "active" ? "可分享" : link.state === "expired" ? "已过期" : "已失效" })), loading: false });
      if (active || referralAvailable) void this.prepareCurrentShare(attempt);
    } catch {
      if (this.data.pageAlive && attempt === this.data.attempt) this.setData({ invitationReady:false,shareId:"",shareCode:"待生成",referralCode:"",commercialEligible:false,referralAvailable:false,history:[],loading: false, error: "暂时无法加载邀请记录，请重试。" });
    }
  },
  async prepareCurrentShare(attempt: number) {
    const token = this.shareOwner, context = this.shareContext;
    const current = () => this.data.pageAlive && this.data.attempt === attempt
      && token === getApp<IAppOption>().globalData.sessionToken && context === commerceContextRevision();
    this.setData({preparing:true});
    try {
      const link = await request<ShareLink>({path:'/v1/shares',method:'POST',idempotencyKey:`officer-invite-${Date.now().toString(36)}`,data:{targetType:'invite',targetRef:'home'}});
      if (!current()) return;
      if (!link.shareId) throw Error('INVITATION_SHARE_INVALID');
      this.setData({shareReady:true,shareId:link.shareId,officerShareId:link.officerShareId??'',shareCode:shortCode(link.shareId),expiresAt:link.expiresAt});
      wx.showShareMenu({menus:['shareAppMessage']});
    } catch {
      if (current()) this.setData({referralError:'分享信息暂未同步，请重试'});
    } finally {
      if (current()) this.setData({preparing:false});
    }
  },
  copyReferralCode(){if(!this.data.loading&&this.data.referralCode)wx.setClipboardData({data:this.data.referralCode});},
  openReferralConfirm(){wx.navigateTo({url:"/pages/sharing-officer/index?mode=referrer",fail:()=>wx.showToast({title:"推荐人页面暂时无法打开",icon:"none"})});},
  async prepare() {
    if (this.data.loading || this.data.preparing || this.data.leaving || !this.data.pageAlive) return;
    const attempt = this.data.attempt;
    this.setData({ preparing: true, error: "" });
    try {
      await request({ path: "/v1/shares", method: "POST", idempotencyKey: `invite-${Date.now().toString(36)}`, data: { targetType: "invite", targetRef: "home" } });
      if (this.data.pageAlive && attempt === this.data.attempt) await this.load();
    } catch {
      if (this.data.pageAlive && attempt === this.data.attempt) this.setData({ preparing: false, error: "卡片生成结果尚未确认，请先刷新页面查看。" });
    }
  },
  back() {
    if (this.data.leaving) return;
    this.setData({ leaving: true });
    wx.navigateBack({ fail: () => wx.switchTab({ url: "/pages/profile/index", fail: () => { if (this.data.pageAlive) this.setData({ leaving: false }); wx.showToast({ title: "暂时无法返回，请重试", icon: "none" }); } }) });
  },
  onShareAppMessage(){const own=this.shareOwner===getApp<IAppOption>().globalData.sessionToken&&this.shareContext===commerceContextRevision(),ready=own&&this.data.shareReady&&this.data.shareId&&new Date(this.data.expiresAt).getTime()>Date.now(),params=[ready?`share_id=${this.data.shareId}`:'',ready&&this.data.officerShareId?`officer_share=${this.data.officerShareId}`:''].filter(Boolean).join('&');return {title:'邀请你一起记录头皮护理',path:`/pages/home/index${params?'?'+params:''}`};}
});
