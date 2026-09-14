import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const source = (path: string) => readFile(path, "utf8");

describe("mini program user-perceived performance guardrails", () => {
  it("derives a unique route inventory from app.json without a fixed page count", async () => {
    const app = JSON.parse(await source("apps/miniprogram/app.json")) as { pages: string[]; subPackages: Array<{ root:string;pages: string[] }> };
    expect(app.pages).toHaveLength(4);
    const routes=[...app.pages,...app.subPackages.flatMap(entry=>entry.pages.map(page=>`${entry.root}/${page}`))];
    expect(new Set(routes).size).toBe(routes.length);
    expect(routes).toContain("pages/checkout/index");
    expect(routes).toContain("pages/management-order-detail/index");
  });

  it("starts Profile secondary tasks without waiting for bootstrap and avatar file work", async () => {
    const profile = await source("apps/miniprogram/pages/profile/index.ts");
    const tasks = profile.indexOf("void this.loadTasks(attempt)");
    const bootstrap = profile.indexOf('request<any>({ path: "/v1/bootstrap/profile"');
    const avatar = profile.indexOf("await localMemberAvatar", bootstrap);
    expect(tasks).toBeGreaterThan(0);
    expect(tasks).toBeLessThan(bootstrap);
    expect(bootstrap).toBeLessThan(avatar);
  });

  it("does not bridge a duplicate Community display list and defers offscreen card images", async () => {
    const logic = await source("apps/miniprogram/pages/community/index.ts");
    const view = await source("apps/miniprogram/pages/community/index.wxml");
    expect(logic).not.toMatch(/\bdisplayFeed:/);
    expect(logic).toContain("displayFeedCount: items.length");
    expect(view).toContain("!displayFeedCount");
    expect(view.match(/lazy-load="\{\{true\}\}"/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it("invalidates hidden privacy reads and guards Community session-sensitive callbacks", async () => {
    const privacy = await source("apps/miniprogram/pages/privacy-rights/index.ts");
    const community = await source("apps/miniprogram/pages/community/index.ts");
    expect(privacy).toContain("onHide(){this.data.alive=false;this.data.loadAttempt+=1;this.data.operationAttempt+=1;this.setData({visibleExport:null});}");
    expect(privacy).toContain("attempt===this.data.loadAttempt && token===getApp<IAppOption>().globalData.sessionToken");
    expect(community).toContain("token !== getApp<IAppOption>().globalData.sessionToken || attempt !== this.data.feedAttempt");
    expect(community).toContain("const current = () => token === getApp<IAppOption>().globalData.sessionToken && attempt === this.data.feedAttempt");
  });
});
