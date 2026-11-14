export type NativeRouteAccess = "public" | "member";

/**
 * Consumer-route access is kept in one native policy table so a visual route
 * copied from a Web demo cannot silently acquire a different login boundary.
 * Data mutations still enforce authorization at the API; this table only
 * decides whether the page itself may be opened before login.
 */
export const nativeRouteAccess: Readonly<Record<string, NativeRouteAccess>> = {
  "/pages/account/index": "public",
  "/pages/home/index": "public",
  "/pages/records/index": "member",
  "/pages/community/index": "public",
  "/pages/community-post/index": "public",
  "/pages/community-author/index": "public",
  "/pages/community-compose/index": "member",
  "/pages/community-review/index": "member",
  "/pages/community-activity/index": "member",
  "/pages/profile/index": "member",
  "/pages/task/index": "member",
  "/pages/submit/index": "member",
  "/pages/progress/index": "member",
  "/pages/points/index": "member",
  "/pages/rewards/index": "member",
  "/pages/management-rewards/index": "member",
  "/pages/post/index": "public",
  "/pages/shop/index": "public",
  "/pages/product/index": "public",
  "/pages/checkout/index": "member",
  "/pages/orders/index": "member",
  "/pages/order-detail/index": "member",
  "/pages/aftersale/index": "member",
  "/pages/settings/index": "member",
  "/pages/invite/index": "member",
  "/pages/sharing-officer/index": "member",
  "/pages/management-sharing/index": "member",
  "/pages/commission/index": "member",
  "/pages/referral/index": "member",
  "/pages/legal/index": "public",
  "/pages/privacy-rights/index": "public",
  "/pages/support/index": "member",
  "/pages/management-points/index": "member",
  "/pages/management/index": "member",
  "/pages/management-members/index": "member",
  "/pages/management-member/index": "member",
  "/pages/management-catalog/index": "member",
  "/pages/management-product/index": "member",
  "/pages/management-orders/index": "member",
  "/pages/management-order-detail/index": "member",
  "/pages/management-finance/index": "member",
  "/pages/management-privacy/index": "member",
  "/pages/management-fulfillment/index": "member",
  "/pages/management-support/index": "member",
  "/pages/management-support-chat/index": "member"
};

export function nativeRoutePath(url: string): string {
  const path = String(url || "").split("?")[0] || "";
  return path.startsWith("/") ? path : `/${path}`;
}

/** The explicit "browse community" choice allows reading, not other workspaces.
 * Account and legal/data-rights pages remain reachable for authentication and rights. */
export function guestCommunityRouteAllowed(url:string):boolean {
  return ["/pages/community/index","/pages/post/index","/pages/community-post/index",
    "/pages/account/index","/pages/legal/index","/pages/privacy-rights/index"].includes(nativeRoutePath(url));
}

export function nativeRouteRequiresMember(url: string): boolean {
  // Unknown routes are not silently treated as public. app.json parity tests
  // require each new native page to receive an explicit access classification.
  return nativeRouteAccess[nativeRoutePath(url)] !== "public";
}
