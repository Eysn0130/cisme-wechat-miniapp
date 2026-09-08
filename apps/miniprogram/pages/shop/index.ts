import { nativeCatalogImage } from "../../services/catalog";
import { request } from "../../services/api";
import { currentChromeStyle } from "../../services/layout";
import { formatCnyCents } from "../../services/presentation";

Page({
  data: { chromeStyle: currentChromeStyle(), catalog: null as any, featured: null as any, loading: true, navigating: false, loadAttempt: 0, pageAlive: true, error: "" },
  onResize() { this.setData({ chromeStyle: currentChromeStyle() }); },
  onLoad() { this.data.pageAlive = true; },
  onShow() { this.data.pageAlive = true; this.setData({ navigating: false }); void this.load(); },
  onHide() { this.data.loadAttempt += 1; },
  onUnload() { this.data.pageAlive = false; this.data.loadAttempt += 1; },
  async load() {
    const attempt = this.data.loadAttempt + 1;
    this.setData({ loadAttempt: attempt, catalog: null, featured: null, loading: true, error: "" });
    try {
      const catalog = await request<any>({ path: "/v1/catalog", authMode: "public" });
      if (!this.data.pageAlive || this.data.loadAttempt !== attempt) return;
      catalog.items = catalog.items.map((item: any) => {
        const displayPrice = formatCnyCents(item.price);
        if (displayPrice === null) throw new Error("CATALOG_PRICE_INVALID");
        return { ...item, image: nativeCatalogImage(item.image), displayPrice };
      });
      this.setData({ catalog, featured: catalog.items[0] ?? null, loading: false, error: "" });
    } catch (error) { if (this.data.pageAlive && this.data.loadAttempt === attempt) this.setData({ catalog: null, featured: null, loading: false, error: "只读商品目录暂时无法同步，请检查网络后重试。交易入口仍保持关闭。" }); }
  },
  openProduct(event: WechatMiniprogram.TouchEvent) {
    if (this.data.navigating) return;
    const id = String(event.currentTarget.dataset.id ?? "");
    if (!id) { wx.showToast({ title: "商品编号缺失，请刷新后重试", icon: "none" }); return; }
    this.setData({ navigating: true });
    wx.navigateTo({
      url: `/pages/product/index?id=${encodeURIComponent(id)}`,
      fail: () => {
        if (this.data.pageAlive) this.setData({ navigating: false });
        wx.showToast({ title: "商品详情暂时无法打开", icon: "none" });
      }
    });
  },
  back() { wx.navigateBack({ fail: () => wx.switchTab({ url: "/pages/community/index" }) }); }
});
