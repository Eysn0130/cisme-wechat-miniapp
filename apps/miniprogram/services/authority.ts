import { pageRead } from "./page-requests";
import { request } from "./api";

export type Capability = "support.read" | "support.reply" | "support.assign" | "commerce.product.manage" | "commerce.qualification.manage" | "commerce.inventory.manage" | "commerce.order.read" | "commerce.fulfillment.manage" | "commerce.refund.approve" | "commerce.money.reconcile" | "community.moderate" | "member.support_view" | "member.profile.read" | "member.manage" | "commission.read" | "commission.rate.manage" | "commission.rate.approve" | "commission.settlement.approve" | "privacy.request.manage";
export interface AuthorityProjection { version: 1; capabilities: Capability[]; managementAvailable: boolean }

export async function authorityProjection(page?: object): Promise<AuthorityProjection> {
  const options = { path:"/v1/me/authority",cacheTags:["member","authority"] };
  return page ? pageRead<AuthorityProjection>(page, options) : request<AuthorityProjection>(options);
}
export function hasCapability(projection: AuthorityProjection | null | undefined, capability: Capability): boolean {
  return Boolean(projection?.capabilities.includes(capability));
}
export async function requireCapability(capability: Capability): Promise<AuthorityProjection | null> {
  try {
    const projection=await authorityProjection();
    if(hasCapability(projection,capability))return projection;
  } catch {
    wx.showToast({title:"权限暂未确认，请稍后重试",icon:"none"});
    wx.navigateBack({fail:()=>wx.switchTab({url:"/pages/profile/index"})});
    return null;
  }
  wx.showToast({title:"当前账号没有这项管理权限",icon:"none"});
  wx.navigateBack({fail:()=>wx.switchTab({url:"/pages/profile/index"})});
  return null;
}
