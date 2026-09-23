import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { nativeRouteAccess, nativeRouteRequiresMember } from "../../apps/miniprogram/services/route-access";
import { CommunityAccess } from "../../services/api/src/communityAccess";

const publicRoutes = [
  "/pages/account/index",
  "/pages/home/index",
  "/pages/community/index",
  "/pages/community-post/index",
  "/pages/community-author/index",
  "/pages/post/index",
  "/pages/shop/index",
  "/pages/product/index",
  "/pages/legal/index",
  "/pages/privacy-rights/index"
];

const memberRoutes = [
  "/pages/records/index",
  "/pages/profile/index",
  "/pages/task/index",
  "/pages/submit/index",
  "/pages/progress/index",
  "/pages/points/index",
  "/pages/commission/index",
  "/pages/settings/index",
  "/pages/invite/index",
  "/pages/referral/index",
  "/pages/community-compose/index",
  "/pages/community-activity/index",
  "/pages/community-review/index",
  "/pages/support/index",
  "/pages/management/index",
  "/pages/management-members/index",
  "/pages/management-member/index",
  "/pages/management-catalog/index",
  "/pages/management-product/index",
  "/pages/management-support/index",
  "/pages/management-support-chat/index"
  ,"/pages/checkout/index"
  ,"/pages/orders/index"
  ,"/pages/order-detail/index"
  ,"/pages/management-orders/index"
  ,"/pages/management-order-detail/index"
  ,"/pages/management-finance/index"
  ,"/pages/management-privacy/index"
  ,"/pages/management-fulfillment/index"
];

async function source(path: string): Promise<string> {
  return readFile(resolve(path), "utf8");
}

describe("native route access policy", () => {
  it("classifies every app.json page exactly once", async () => {
    const app = JSON.parse(await source("apps/miniprogram/app.json")) as { pages: string[]; subPackages?: Array<{root:string;pages:string[]}> };
    const declared = [...app.pages, ...(app.subPackages ?? []).flatMap(pack => pack.pages.map(page => `${pack.root}/${page}`))].map((page) => `/${page}`).sort();
    const classified = Object.keys(nativeRouteAccess).sort();

    expect(classified).toEqual(declared);
    expect(Object.entries(nativeRouteAccess).filter(([, access]) => access === "public").map(([route]) => route).sort()).toEqual([...publicRoutes].sort());
    expect(Object.entries(nativeRouteAccess).filter(([, access]) => access === "member").map(([route]) => route).sort()).toEqual([...memberRoutes].sort());
  });

  it("keeps public read routes open and fails closed for protected or unknown routes", () => {
    for (const route of publicRoutes) expect(nativeRouteRequiresMember(`${route}?from=test`)).toBe(false);
    for (const route of memberRoutes) expect(nativeRouteRequiresMember(route)).toBe(true);
    expect(nativeRouteRequiresMember("/pages/future/index")).toBe(true);
  });

  it("does not reintroduce a client login gate on public catalog or community reads", async () => {
    for (const route of ["community", "post", "shop"]) {
      const logic = await source(`apps/miniprogram/pages/${route}/index.ts`);
      expect(logic).not.toContain("requireMemberAccess");
      expect(logic).not.toContain("allowPublicBrowsing");
    }
    const product = await source("apps/miniprogram/pages/product/index.ts");
    expect(product).toContain("catalogDetail(this.data.id)");
    expect(product).toContain("openCheckout()");
    expect(product).not.toMatch(/onShow\(\)[^{]*\{[^}]*requireMemberAccess/);

    const tab = await source("apps/miniprogram/custom-tab-bar/index.ts");
    expect(tab).toContain("nativeRouteRequiresMember(item.path) && !requireMemberAccess(item.path)");
  });
});

describe("community preview production gate", () => {
  it.each(["production", "staging"])("rejects hidden follow reads and writes in %s", async (env) => {
    const query = vi.fn();
    const access = new CommunityAccess({ query } as never, { env, allowDevAdapters: false } as never, {} as never);

    await expect(access.follows("member-id")).rejects.toMatchObject({ code: "COMMUNITY_PREVIEW_CLOSED", status: 503 });
    await expect(access.follow("member-id", "brand:cisme", true)).rejects.toMatchObject({ code: "COMMUNITY_PREVIEW_CLOSED", status: 503 });
    expect(query).not.toHaveBeenCalled();
  });
});
