import { nativeCatalogImage } from "../../services/catalog";
import { request } from "../../services/api";
import { currentChromeStyle } from "../../services/layout";
import { formatCnyCents } from "../../services/presentation";
import { prepareShareLink, registerIncomingShare } from "../../services/share";

Page({
  data: { chromeStyle: currentChromeStyle(), id: "", item: null as any, catalog: null as any, shareId: "", loading: true, loadAttempt: 0, pageAlive: true, leaving: false, errorKind: "none" as "none" | "missing" | "load", errorTitle: "", error: "" },
  onResize() { this.setData({ chromeStyle: currentChromeStyle() }); },
  onLoad(query: Record<string, string | undefined>) {
    const id = query.id ?? "";
    this.setData({ id, pageAlive: true });
    void registerIncomingShare(query.share_id, "product", id);
    wx.hideShareMenu();
  },
  onShow() { this.setData({ pageAlive: true, leaving: false }); void this.load(); },
  onHide() { this.data.loadAttempt += 1; },
  onUnload() { this.data.pageAlive = false; this.data.loadAttempt += 1; },
  async load() {
    const attempt = this.data.loadAttempt + 1;
    wx.hideShareMenu();
    this.setData({ loadAttempt: attempt, item: null, catalog: null, shareId: "", loading: true, errorKind: "none", errorTitle: "", error: "" });
    try {
      const catalog = await request<any>({ path: "/v1/catalog", authMode: "public" });
      if (!this.data.pageAlive || this.data.loadAttempt !== attempt) return;
      const raw = catalog.items.find((item: any) => item.id === this.data.id) ?? null;
      const displayPrice = raw ? formatCnyCents(raw.price) : null;
      if (raw && displayPrice === null) throw new Error("CATALOG_PRICE_INVALID");
      const item = raw ? { ...raw, image: nativeCatalogImage(raw.image), displayPrice } : null;
      this.setData({ catalog, item, loading: false, errorKind: item ? "none" : "missing", errorTitle: item ? "" : "这件商品暂不可用", error: item ? "" : "商品不存在、已下架，或当前目录不再展示它。请返回商品目录重新选择。" });
      if (item) {
        wx.showShareMenu({ menus: ["shareAppMessage"] });
        const shareId = await prepareShareLink("product", this.data.id);
        if (this.data.pageAlive && this.data.loadAttempt === attempt && this.data.item) this.setData({ shareId });
      }
    } catch (error) {
      if (this.data.pageAlive && this.data.loadAttempt === attempt) this.setData({ item: null, catalog: null, shareId: "", loading: false, errorKind: "load", errorTitle: "商品资料暂时未同步", error: "请检查网络后重试。页面不会把目录加载失败误显示成商品已下架。" });
    }
  },
  back() {
    if (!this.data.pageAlive || this.data.leaving) return;
    this.setData({ leaving: true });
    const failed = () => {
      if (!this.data.pageAlive) return;
      this.setData({ leaving: false });
      wx.showToast({ title: "暂时无法返回，请重试", icon: "none" });
    };
    wx.navigateBack({ fail: () => {
      if (!this.data.pageAlive) return;
      wx.redirectTo({ url: "/pages/shop/index", fail: () => {
        if (this.data.pageAlive) wx.switchTab({ url: "/pages/community/index", fail: failed });
      } });
    } });
  },
  onShareAppMessage() { return { title: this.data.item?.name ?? "CISME 护理精选", path: `/pages/product/index?id=${encodeURIComponent(this.data.id)}${this.data.shareId ? `&share_id=${this.data.shareId}` : ""}` }; }
});
