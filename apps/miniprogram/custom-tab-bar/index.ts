import { currentChromeStyle, shouldReduceMotion } from "../services/layout";

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
    switching: false,
    externalBusy: false,
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
        reducedMotion: shouldReduceMotion(),
        chromeStyle: currentChromeStyle()
      });
    }
  },
  pageLifetimes: {
    show() {
      this.setData({ active: currentTabIndex(this.data.items), reducedMotion: shouldReduceMotion(), chromeStyle: currentChromeStyle(), switching: false, externalBusy: currentPageBusy() });
    }
  },
  methods: {
    switchTab(event: WechatMiniprogram.TouchEvent) {
      const index = Number(event.currentTarget.dataset.index);
      const item = this.data.items[index];
      const liveExternalBusy = currentPageBusy();
      if (!item || this.data.switching || this.data.externalBusy || liveExternalBusy) {
        if (liveExternalBusy && !this.data.externalBusy) this.setData({ externalBusy: true });
        return;
      }
      if (index === this.data.active) {
        // Re-selecting a tab is a recovery action, so it stays instant on every
        // device and never bypasses the OS reduced-motion preference in JS.
        wx.pageScrollTo({ scrollTop: 0, duration: 0 });
        return;
      }
      const previous = this.data.active;
      this.setData({ active: index, switching: true });
      wx.switchTab({
        url: item.path,
        success: () => this.setData({ switching: false }),
        fail: () => this.setData({ active: previous, switching: false }, () => wx.showToast({ title: "页面切换失败，请重试", icon: "none" }))
      });
    }
  }
});
