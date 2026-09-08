import { nativeCatalogImage } from "../../services/catalog";
import { request } from "../../services/api";
import { currentChromeStyle } from "../../services/layout";
import { formatCnyCents } from "../../services/presentation";
import { prepareShareLink, registerIncomingShare } from "../../services/share";

Page({
  galleryObserver: null as WechatMiniprogram.IntersectionObserver | null,
  data: { galleryIndex: 0, galleryStopped: false, galleryVisible: true, galleryInView: false, gallery: [] as string[], chromeStyle: currentChromeStyle(), id: "", item: null as any, catalog: null as any, shareId: "", loading: true, loadAttempt: 0, pageAlive: true, leaving: false, errorKind: "none" as "none" | "missing" | "load", errorTitle: "", error: "" },
  onResize() { this.setData({ chromeStyle: currentChromeStyle() }); },
  onLoad(query: Record<string, string | undefined>) {
    const id = query.id ?? "";
    this.setData({ id, pageAlive: true });
    void registerIncomingShare(query.share_id, "product", id);
    wx.hideShareMenu();
  },
  onShow() { this.setData({ pageAlive: true, leaving: false, galleryVisible: true }); void this.load(); },
  onHide() { this.data.loadAttempt += 1; this.setData({ galleryVisible: false }); },
  onUnload() { this.data.pageAlive = false; this.data.loadAttempt += 1; this.galleryObserver?.disconnect(); },
  async load() {
    const attempt = this.data.loadAttempt + 1;
    this.galleryObserver?.disconnect();
    wx.hideShareMenu();
    this.setData({ loadAttempt: attempt, galleryInView: false, item: null, catalog: null, shareId: "", loading: true, errorKind: "none", errorTitle: "", error: "" });
    try {
      const catalog = await request<any>({ path: "/v1/catalog", authMode: "public" });
      if (!this.data.pageAlive || this.data.loadAttempt !== attempt) return;
      const raw = catalog.items.find((item: any) => item.id === this.data.id) ?? null;
      const displayPrice = raw ? formatCnyCents(raw.price) : null;
      if (raw && displayPrice === null) throw new Error("CATALOG_PRICE_INVALID");
      const item = raw ? { ...raw, image: nativeCatalogImage(raw.image), displayPrice } : null;
      this.setData({ gallery: item ? [item.image, "/assets/cisme/community-card-care-flatlay-v2.jpg", "/assets/cisme/community-card-glossy-hair-v1.jpg"].filter((image, index, images) => images.indexOf(image) === index) : [], catalog, item, loading: false, errorKind: item ? "none" : "missing", errorTitle: item ? "" : "这件商品暂不可用", error: item ? "" : "商品不存在、已下架，或当前目录不再展示它。请返回商品目录重新选择。" }, () => {
        if (!item || !this.data.pageAlive || this.data.loadAttempt !== attempt) return;
        this.galleryObserver = wx.createIntersectionObserver(this, { thresholds: [0, 0.6] }).relativeToViewport();
        this.galleryObserver.observe(".product-gallery", (entry: WechatMiniprogram.IntersectionObserverObserveCallbackResult) => { if (this.data.pageAlive) this.setData({ galleryInView: entry.intersectionRatio >= 0.6 }); });
      });
      if (item) {
        wx.showShareMenu({ menus: ["shareAppMessage"] });
        const shareId = await prepareShareLink("product", this.data.id);
        if (this.data.pageAlive && this.data.loadAttempt === attempt && this.data.item) this.setData({ shareId });
      }
    } catch (error) {
      if (this.data.pageAlive && this.data.loadAttempt === attempt) this.setData({ item: null, catalog: null, shareId: "", loading: false, errorKind: "load", errorTitle: "商品资料暂时未同步", error: "请检查网络后重试。页面不会把目录加载失败误显示成商品已下架。" });
    }
  },
  stopGallery() { this.setData({ galleryStopped: true }); },
  galleryChange(event: WechatMiniprogram.CustomEvent<{ current: number; source: string }>) { this.setData({ galleryIndex: event.detail.current, galleryStopped: this.data.galleryStopped || event.detail.source === "touch" }); },
  galleryPrevious() { this.setData({ galleryStopped: true, galleryIndex: (this.data.galleryIndex + this.data.gallery.length - 1) % this.data.gallery.length }); },
  galleryNext() { this.setData({ galleryStopped: true, galleryIndex: (this.data.galleryIndex + 1) % this.data.gallery.length }); },
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
