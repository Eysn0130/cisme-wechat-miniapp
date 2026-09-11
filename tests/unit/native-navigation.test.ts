import { beforeEach, describe, expect, it, vi } from "vitest";
const reduced = vi.hoisted(() => ({ value: false }));
vi.mock("../../apps/miniprogram/services/layout", () => ({ currentChromeStyle: () => "", shouldReduceMotion: () => reduced.value }));
let definition: any, route: string, wxMock: any, currentPage: any;
function instance() {
  const context: any = { data: structuredClone(definition.data), setData(patch: any, cb?: () => void) { Object.assign(this.data, patch); cb?.(); }, ...definition.methods };
  return context;
}
const tap = (index: number) => ({ currentTarget: { dataset: { index } } });
beforeEach(async () => {
  vi.resetModules(); reduced.value = false; route = "pages/home/index";
  currentPage = { route, data: {} };
  wxMock = { nextTick: vi.fn((cb: () => void) => cb()), switchTab: vi.fn(), pageScrollTo: vi.fn(), showToast: vi.fn() };
  Object.assign(globalThis, { wx: wxMock, getApp: () => ({globalData:{sessionToken:"member-session"}}), getCurrentPages: () => [{ ...currentPage, route }], Component: (value: any) => { definition = value; } });
  await vi.importActual("../../apps/miniprogram/custom-tab-bar/index");
});
describe("native tab lens", () => {
  it("starts at the actual route and settles at the newly visible route", () => {
    const source = instance(); definition.lifetimes.attached.call(source);
    source.switchTab(tap(2));
    source.switchTab(tap(3));
    expect(wxMock.switchTab).toHaveBeenCalledTimes(1);
    route = "pages/community/index";
    const target = instance(); definition.lifetimes.attached.call(target);
    expect(target.data.lensIndex).toBe(0);
    definition.pageLifetimes.show.call(target);
    expect(target.data).toMatchObject({ active: 2, lensIndex: 2, switching: false });
    target.switchTab(tap(3));
    expect(wxMock.switchTab).toHaveBeenLastCalledWith(expect.objectContaining({ url: "/pages/profile/index" }));
  });
  it("restores selection on navigation failure and makes only a repeat tap return to top", () => {
    const source = instance(); definition.lifetimes.attached.call(source);
    source.switchTab(tap(1));
    expect(wxMock.pageScrollTo).not.toHaveBeenCalled();
    wxMock.switchTab.mock.calls[0][0].fail();
    expect(source.data).toMatchObject({ active: 0, lensIndex: 0, switching: false });
    source.switchTab(tap(0));
    expect(wxMock.pageScrollTo).toHaveBeenCalledWith({ scrollTop: 0, duration: 0 });
  });
  it("uses the correct end state for reduced motion and a directly opened root route", () => {
    route = "pages/profile/index"; reduced.value = true;
    const target = instance(); definition.lifetimes.attached.call(target); definition.pageLifetimes.show.call(target);
    expect(target.data).toMatchObject({ active: 3, lensIndex: 3, reducedMotion: true });
  });
  it("lets the page's authoritative index correct early component lifecycle ordering", () => {
    const source = instance(); definition.lifetimes.attached.call(source);
    source.switchTab(tap(2));
    // WeChat can announce component show before getCurrentPages reflects the target.
    const target = instance(); definition.lifetimes.attached.call(target); definition.pageLifetimes.show.call(target);
    expect(target.data.active).toBe(0);
    route = "pages/community/index";
    target.syncActive(2);
    expect(target.data).toMatchObject({ active: 2, lensIndex: 2 });
  });

  it("keeps navigation down until every presentation owner releases it", () => {
    const source = instance(); definition.lifetimes.attached.call(source);
    source.setPresentation("care-sheet", true);
    source.setPresentation("community-scroll", true);
    source.setPresentation("care-sheet", false);
    expect(source.data).toMatchObject({ chromeHidden: true, hiddenSources: ["community-scroll"] });
    source.switchTab(tap(1));
    expect(wxMock.switchTab).not.toHaveBeenCalled();
    source.setPresentation("community-scroll", false);
    expect(source.data).toMatchObject({ chromeHidden: false, hiddenSources: [] });
  });

  it("grows the community publish action only on Community and delegates its action to the page", () => {
    route = "pages/community/index";
    currentPage.openPublisher = vi.fn();
    const target = instance(); definition.lifetimes.attached.call(target); definition.pageLifetimes.show.call(target);
    expect(target.data).toMatchObject({ active: 2, communityFabMounted: true, communityFabVisible: true });
    target.activateCommunityFab();
    expect(currentPage.openPublisher).toHaveBeenCalledTimes(1);
    target.setPresentation("community-scroll", true);
    target.activateCommunityFab();
    expect(currentPage.openPublisher).toHaveBeenCalledTimes(1);
  });

});
