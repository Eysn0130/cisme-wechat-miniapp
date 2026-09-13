import { requireMemberAccess, retainMemberSnapshot } from "../../services/api";
import { clearAuthenticationRedirectSuppression, request } from "../../services/api";
import { currentChromeStyle } from "../../services/layout";

type ShareLink = { shareId: string; targetType: string; targetRef: string; state: string; createdAt: string; expiresAt: string };
const shortCode = (id: string) => id.slice(0, 8).toUpperCase();
const dateLabel = (value: string) => {
  const date = new Date(value);
  return `${date.getFullYear()}.${String(date.getMonth() + 1).padStart(2, "0")}.${String(date.getDate()).padStart(2, "0")}`;
};

Page({
  data: { chromeStyle: currentChromeStyle(), loading: true, preparing: false, leaving: false, pageAlive: true, attempt: 0, displayName: "CISME 会员", shareId: "", shareCode: "待生成", expiresAt: "", commercialEligible:false, referralCode:"", referralError:"", history: [] as Array<ShareLink & { code: string; date: string; label: string }>, error: "" },
  onLoad() { wx.hideShareMenu(); },
  onResize() { this.setData({ chromeStyle: currentChromeStyle() }); },
  onShow() {
    this.data.pageAlive = true;
    if (!retainMemberSnapshot(this)) {
      this.setData({ attempt: this.data.attempt + 1, loading: true, preparing: false, displayName: "CISME 会员", shareId: "", shareCode: "待生成",
        expiresAt: "", commercialEligible: false, referralCode: "", referralError: "", history: [], error: "" });
      wx.hideShareMenu();
    }
    if (!requireMemberAccess()) { this.setData({ loading: false, error: "请先确认身份后查看邀请资料。" }); return; }
    this.setData({ pageAlive: true, leaving: false });
    void this.load();
  },
  onHide() { this.data.attempt += 1; },
  onUnload() { this.data.pageAlive = false; this.data.attempt += 1; },
  async load(event?: WechatMiniprogram.TouchEvent) {
    if (event?.type) clearAuthenticationRedirectSuppression();
    const attempt = this.data.attempt + 1;
    const token = getApp<IAppOption>().globalData.sessionToken;
    this.setData({ attempt, loading: true, preparing: false, error: "", referralError:"", displayName: "CISME 会员", shareId: "", shareCode: "待生成",
      expiresAt: "", commercialEligible: false, referralCode: "", history: [] });
    wx.hideShareMenu();
    try {
      const [member, links, commercial] = await Promise.all([request<{ display_name: string }>({ path: "/v1/me" }), request<ShareLink[]>({ path: "/v1/me/shares?targetType=invite" }),
        request<{eligible:boolean;referralCode:string|null;referralCodeDisabled:boolean}>({path:"/v1/me/commercial-membership"}).catch(()=>({eligible:false,referralCode:null,referralCodeDisabled:false}))]);
      if (!this.data.pageAlive || attempt !== this.data.attempt || token !== getApp<IAppOption>().globalData.sessionToken) return;
      const invitations = links.filter((link) => link.targetType === "invite" && link.targetRef === "home");
      const active = invitations.find((link) => link.state === "active");
      this.setData({ displayName: member.display_name || "CISME 会员", shareId: active?.shareId ?? "", shareCode: active ? shortCode(active.shareId) : "待生成", expiresAt: active?.expiresAt ?? "", commercialEligible:commercial.eligible,referralCode:commercial.referralCode||"", referralError:commercial.referralCodeDisabled?"推荐码已停用，请联系平台。":"", history: invitations.slice(0, 5).map((link) => ({ ...link, code: shortCode(link.shareId), date: dateLabel(link.createdAt), label: link.state === "active" ? "可分享" : link.state === "expired" ? "已过期" : "已失效" })), loading: false });
      if (commercial.eligible && !commercial.referralCode && !commercial.referralCodeDisabled) void this.prepareReferralCode(attempt);
      if (active || commercial.referralCode) wx.showShareMenu({ menus: ["shareAppMessage"] });
    } catch {
      if (this.data.pageAlive && attempt === this.data.attempt) this.setData({ loading: false, error: "邀请资料暂时无法同步，请重试。" });
    }
  },
  async prepareReferralCode(attempt:number){try{const result=await request<{code:string}>({path:"/v1/me/commercial-membership/code",method:"POST"});
      if(this.data.pageAlive&&attempt===this.data.attempt){this.setData({referralCode:result.code});wx.showShareMenu({menus:["shareAppMessage"]});}}
    catch(error){if(this.data.pageAlive&&attempt===this.data.attempt)this.setData({referralError:(error as {title?:string}).title||"推荐码暂未生成，请稍后重试。"});}},
  copyReferralCode(){if(this.data.referralCode)wx.setClipboardData({data:this.data.referralCode});},
  openReferralConfirm(){wx.navigateTo({url:"/pages/referral/index",fail:()=>wx.showToast({title:"推荐码页面暂时无法打开",icon:"none"})});},
  async prepare() {
    if (this.data.loading || this.data.preparing || this.data.leaving || !this.data.pageAlive) return;
    const attempt = this.data.attempt;
    this.setData({ preparing: true, error: "" });
    try {
      await request({ path: "/v1/shares", method: "POST", idempotencyKey: `invite-${Date.now().toString(36)}`, data: { targetType: "invite", targetRef: "home" } });
      if (this.data.pageAlive && attempt === this.data.attempt) await this.load();
    } catch {
      if (this.data.pageAlive && attempt === this.data.attempt) this.setData({ preparing: false, error: "分享卡片暂未生成，请稍后重试。" });
    }
  },
  back() {
    if (this.data.leaving) return;
    this.setData({ leaving: true });
    wx.navigateBack({ fail: () => wx.switchTab({ url: "/pages/profile/index", fail: () => { if (this.data.pageAlive) this.setData({ leaving: false }); wx.showToast({ title: "暂时无法返回，请重试", icon: "none" }); } }) });
  },
  onShareAppMessage(event?:{target?:{dataset?:{kind?:string}}}) {
    if(event?.target?.dataset?.kind==="commercial"&&this.data.referralCode)
      return {title:"邀请你了解 CISME，推荐关系由你决定是否确认",path:`/pages/referral/index?code=${this.data.referralCode}`};
    const ready = this.data.shareId && new Date(this.data.expiresAt).getTime() > Date.now();
    return { title: "邀请你一起，记录真实的头皮护理", path: `/pages/home/index${ready ? `?share_id=${this.data.shareId}` : ""}` };
  }
});
