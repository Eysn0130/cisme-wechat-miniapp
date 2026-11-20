import { requireMemberAccess, requireGuestCommunityAccess } from "../services/api";
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
    lensOffset: 0,
    switching: false,
    externalBusy: false,
    chromeHidden: false,
    hiddenSources: [] as string[],
    communityPublisherAvailable: false,
    communityPublisherLabel: "创作护理故事",
    communityFabMounted: false,
    communityFabVisible: false,
    reducedMotion: shouldReduceMotion(),
    chromeStyle: currentChromeStyle(),
    items: [
      { text: "护理", path: "/pages/home/index", icon: "/assets/icons/drop-muted.svg", activeIcon: "/assets/icons/drop-active.svg" },
      { text: "商城", path: "/pages/shop/index", icon: "/assets/icons/storefront-plum.svg", activeIcon: "/assets/icons/storefront-plum.svg" },
      { text: "社区", path: "/pages/community/index", icon: "/assets/icons/users-muted.svg", activeIcon: "/assets/icons/users-active.svg" },
      { text: "我的", path: "/pages/profile/index", icon: "/assets/icons/user-muted.svg", activeIcon: "/assets/icons/user-active.svg" }
    ]
  },
  lifetimes: {
    attached() {
      this.syncActive(currentTabIndex(this.data.items));
    }
  },
  pageLifetimes: {
    show() {
      const active = currentTabIndex(this.data.items);
      this.syncActive(active);
      if (active === 2) this.enterCommunityFab();
      else this.leaveCommunityFab();
    },
    hide() {
      if (this.data.lensOffset) this.setData({ lensOffset: 0 });
    }
  },
  methods: {
    syncActive(active: number) {
      if (!this.data.items[active]) return;
      // Each tab page has its own component. Consume the handoff only on the
      // destination and keep duplicate onShow notifications from restarting it.
      const motion = pendingLens?.to === active ? pendingLens : null;
      if (motion) pendingLens = null;
      const reducedMotion = shouldReduceMotion();
      const chromeStyle = currentChromeStyle();
      const externalBusy = currentPageBusy();
      let lensOffset = this.data.active === active ? this.data.lensOffset : 0;
      if (motion) lensOffset = Date.now() - motion.at < 1000 ? motion.from - active : 0;
      if (reducedMotion || this.data.chromeHidden) lensOffset = 0;
      if (this.data.active === active && this.data.lensOffset === lensOffset
        && this.data.reducedMotion === reducedMotion && this.data.chromeStyle === chromeStyle
        && this.data.externalBusy === externalBusy && !this.data.switching) return;
      this.setData({ active, lensOffset, reducedMotion, chromeStyle, externalBusy, switching: false });
    },
    setPresentation(source: string, hidden: boolean) {
      const owner = String(source || "page");
      const current = this.data.hiddenSources as string[];
      const hiddenSources = hidden
        ? current.includes(owner) ? current : current.concat(owner)
        : current.filter((item) => item !== owner);
      const chromeHidden = hiddenSources.length > 0;
      if (chromeHidden === this.data.chromeHidden && hiddenSources.length === current.length) return;
      this.setData({ hiddenSources, chromeHidden, ...(chromeHidden ? { lensOffset: 0 } : {}) });
    },
    setCommunityPublisherAvailable(available: boolean, label = "创作护理故事") {
      if (this.data.communityPublisherAvailable === available && this.data.communityPublisherLabel === label) return;
      this.setData({ communityPublisherAvailable: available, communityPublisherLabel: label });
      if (available) this.enterCommunityFab();
      else this.leaveCommunityFab();
    },
    enterCommunityFab() {
      if (this.data.active !== 2 || !this.data.communityPublisherAvailable) return;
      if (this.data.communityFabMounted && this.data.communityFabVisible) return;
      // A mount animation supplies its own first frame; nextTick can otherwise
      // coalesce the hidden and visible styles before WeChat paints either.
      this.setData({ communityFabMounted: true, communityFabVisible: true, reducedMotion: shouldReduceMotion() });
    },
    leaveCommunityFab() {
      if (!this.data.communityFabMounted && !this.data.communityFabVisible) return;
      this.setData({ communityFabMounted: false, communityFabVisible: false });
    },
    activateCommunityFab() {
      if (this.data.active !== 2 || !this.data.communityPublisherAvailable || !this.data.communityFabVisible || this.data.chromeHidden || this.data.switching || this.data.externalBusy) return;
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
      if (!requireGuestCommunityAccess(item.path)) return;
      if (nativeRouteRequiresMember(item.path) && !requireMemberAccess(item.path)) return;
      if (index === this.data.active) {
        // Re-selecting a tab is a recovery action, so it stays instant on every
        // device and never bypasses the OS reduced-motion preference in JS.
        wx.pageScrollTo({ scrollTop: 0, duration: 0 });
        return;
      }
      const motion = { from: this.data.active, to: index, at: Date.now() };
      this.leaveCommunityFab();
      pendingLens = motion;
      this.setData({ switching: true });
      wx.switchTab({
        url: item.path,
        success: () => this.setData({ switching: false }),
        fail: () => {
          if (pendingLens === motion) pendingLens = null;
          this.setData({ switching: false }, () => {
            this.enterCommunityFab();
            wx.showToast({ title: "页面切换失败，请重试", icon: "none" });
          });
        }
      });
    }
  }
});
