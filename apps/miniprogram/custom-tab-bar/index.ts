import { requireMemberAccess } from "../services/api";
import { currentChromeStyle, shouldReduceMotion } from "../services/layout";
import { nativeRouteRequiresMember } from "../services/route-access";

let pendingLens: { from: number; to: number; at: number } | null = null;

function currentTabIndex(items: Array<{ path: string }>): number {
  const pages = getCurrentPages();
  const route = pages[pages.length - 1]?.route;
  const index = items.findIndex((item) => item.path === `/${route}`);
  return index >= 0 ? index : 0;
}

function currentPageBusy(): boolean {
  const pages = getCurrentPages();
  const current = pages[pages.length - 1] as WechatMiniprogram.Page.Instance<Record<string, unknown>, Record<string, unknown>> | undefined;
  return Boolean(current?.data?.working || current?.data?.navigating);
}

Component({
  data: {
    active: 0,
    lensIndex: 0,
    lensSettling: false,
    switching: false,
    externalBusy: false,
    chromeHidden: false,
    hiddenSources: [] as string[],
    communityFabMounted: false,
    communityFabVisible: false,
    reducedMotion: shouldReduceMotion(),
    chromeStyle: currentChromeStyle(),
    items: [
      { text: "护理", path: "/pages/home/index", icon: "/assets/icons/drop-muted.svg", activeIcon: "/assets/icons/drop-active.svg" },
      { text: "记录", path: "/pages/records/index", icon: "/assets/icons/clipboard-text-muted.svg", activeIcon: "/assets/icons/clipboard-text-active.svg" },
      { text: "社区", path: "/pages/community/index", icon: "/assets/icons/users-muted.svg", activeIcon: "/assets/icons/users-active.svg" },
      { text: "我的", path: "/pages/profile/index", icon: "/assets/icons/user-muted.svg", activeIcon: "/assets/icons/user-active.svg" }
    ]
  },
  lifetimes: {
    attached() {
      this.setData({
        active: currentTabIndex(this.data.items),
        lensIndex: pendingLens?.from ?? currentTabIndex(this.data.items),
        reducedMotion: shouldReduceMotion(),
        chromeStyle: currentChromeStyle()
      });
    }
  },
  pageLifetimes: {
    show() {
      const active = currentTabIndex(this.data.items);
      this.syncActive(active);
      if (active === 2) this.enterCommunityFab();
      else this.leaveCommunityFab();
    }
  },
  methods: {
    syncActive(active: number) {
      if (!this.data.items[active]) return;
      if (this.data.active === active && this.data.lensIndex === active && !pendingLens && !this.data.switching && this.data.externalBusy === currentPageBusy()) return;
      const reducedMotion = shouldReduceMotion();
      const motion = pendingLens;
      if (motion?.to === active) pendingLens = null;
      const from = motion && motion.to === active && Date.now() - motion.at < 1000 && !reducedMotion ? motion.from : active;
      this.setData({ active, lensIndex: from, lensSettling: false, reducedMotion, chromeStyle: currentChromeStyle(), switching: false, externalBusy: currentPageBusy() }, () => {
        wx.nextTick(() => { if (this.data.active === active) this.setData({ lensIndex: active, lensSettling: !reducedMotion }); });
      });
    },
    setPresentation(source: string, hidden: boolean) {
      const owner = String(source || "page");
      const current = this.data.hiddenSources as string[];
      const hiddenSources = hidden
        ? current.includes(owner) ? current : current.concat(owner)
        : current.filter((item) => item !== owner);
      const chromeHidden = hiddenSources.length > 0;
      if (chromeHidden === this.data.chromeHidden && hiddenSources.length === current.length) return;
      this.setData({ hiddenSources, chromeHidden });
    },
    enterCommunityFab() {
      if (this.data.active !== 2) return;
      if (this.data.communityFabMounted && this.data.communityFabVisible) return;
      const reducedMotion = shouldReduceMotion();
      this.setData({ communityFabMounted: true, communityFabVisible: reducedMotion, reducedMotion }, () => {
        if (reducedMotion) return;
        wx.nextTick(() => {
          if (this.data.active === 2 && this.data.communityFabMounted) this.setData({ communityFabVisible: true });
        });
      });
    },
    leaveCommunityFab() {
      if (!this.data.communityFabMounted && !this.data.communityFabVisible) return;
      this.setData({ communityFabMounted: false, communityFabVisible: false });
    },
    activateCommunityFab() {
      if (this.data.active !== 2 || !this.data.communityFabVisible || this.data.chromeHidden || this.data.switching || this.data.externalBusy) return;
      const pages = getCurrentPages();
      const current = pages[pages.length - 1] as WechatMiniprogram.Page.Instance<Record<string, unknown>, Record<string, unknown>> & { openPublisher?: () => void } | undefined;
      current?.openPublisher?.();
    },
    switchTab(event: WechatMiniprogram.TouchEvent) {
      const index = Number(event.currentTarget.dataset.index);
      const item = this.data.items[index];
      const liveExternalBusy = currentPageBusy();
      if (!item || this.data.chromeHidden || this.data.switching || this.data.externalBusy || liveExternalBusy) {
        if (liveExternalBusy && !this.data.externalBusy) this.setData({ externalBusy: true });
        return;
      }
      if (nativeRouteRequiresMember(item.path) && !requireMemberAccess(item.path)) return;
      if (index === this.data.active) {
        // Re-selecting a tab is a recovery action, so it stays instant on every
        // device and never bypasses the OS reduced-motion preference in JS.
        wx.pageScrollTo({ scrollTop: 0, duration: 0 });
        return;
      }
      const previous = this.data.active;
      this.leaveCommunityFab();
      pendingLens = { from: previous, to: index, at: Date.now() };
      this.setData({ active: index, lensIndex: index, lensSettling: true, switching: true });
      wx.switchTab({
        url: item.path,
        success: () => this.setData({ switching: false }),
        fail: () => { pendingLens = null; this.setData({ active: previous, lensIndex: previous, switching: false }, () => wx.showToast({ title: "页面切换失败，请重试", icon: "none" })); }
      });
    }
  }
});
