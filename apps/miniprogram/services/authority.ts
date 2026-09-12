import { request } from "./api";

export type Capability = "support.read" | "support.reply" | "support.assign" | "commerce.product.manage" | "commerce.qualification.manage" | "commerce.inventory.manage" | "commerce.order.read" | "commerce.fulfillment.manage" | "commerce.refund.approve" | "community.moderate" | "member.support_view" | "member.profile.read" | "member.manage" | "commission.read" | "commission.rate.manage" | "commission.rate.approve" | "privacy.request.manage";
export interface AuthorityProjection { version: 1; capabilities: Capability[]; managementAvailable: boolean }

export async function authorityProjection(): Promise<AuthorityProjection> {
  return request<AuthorityProjection>({ path:"/v1/me/authority",cacheTags:["member","authority"] });
}
export function hasCapability(projection: AuthorityProjection | null | undefined, capability: Capability): boolean {
  return Boolean(projection?.capabilities.includes(capability));
}
export async function requireCapability(capability: Capability): Promise<AuthorityProjection | null> {
  try {
    const projection=await authorityProjection();
    if(hasCapability(projection,capability))return projection;
  } catch {}
  wx.showToast({title:"当前账号没有这项管理权限",icon:"none"});
  wx.navigateBack({fail:()=>wx.switchTab({url:"/pages/profile/index"})});
  return null;
}
