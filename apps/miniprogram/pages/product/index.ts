import { nativeCatalogImage } from "../../services/catalog";
import { catalogDetail } from "../../services/commerce";
import { requireMemberAccess } from "../../services/api";
import { currentChromeStyle } from "../../services/layout";
import { formatCnyCents } from "../../services/presentation";
import { prepareShareLink, registerIncomingShare } from "../../services/share";

Page({
  galleryObserver: null as WechatMiniprogram.IntersectionObserver | null,
  data: { galleryIndex: 0, galleryStopped: false, galleryVisible: true, galleryInView: false, gallery: [] as string[], chromeStyle: currentChromeStyle(), id: "", item: null as any, selectedSku:null as any, quantity:1, navigating:false, catalog: null as any, shareId: "", loading: true, loadAttempt: 0, pageAlive: true, leaving: false, errorKind: "none" as "none" | "missing" | "load", errorTitle: "", error: "" },
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
      const raw = await catalogDetail(this.data.id);
      if (!this.data.pageAlive || this.data.loadAttempt !== attempt) return;
      const displayPrice = raw ? formatCnyCents(raw.price) : null;
      if (raw && displayPrice === null) throw new Error("CATALOG_PRICE_INVALID");
      const item = raw ? { ...raw, image: nativeCatalogImage(raw.image ?? "/assets/cisme/community-card-purple-bottle-v1.jpg"), displayPrice,
        contractCopy:raw.purchaseEnabled?"隔离订单验证 · 支付尚未开放":raw.sourceKind==="synthetic_test"?"合成测试商品 · 购买关闭":"企业自营目录 · 购买关闭",
        purchaseCopy:raw.purchaseEnabled?"可创建待支付订单；不会调起支付或形成真实交易。":"当前只提供商品资料浏览，不接受真实购买。" } : null;
      const selectedSku=item?.variants.find((sku:any)=>sku.active&&sku.inStock)??item?.variants.find((sku:any)=>sku.active)??null;
      this.setData({ gallery: item ? [item.image, "/assets/cisme/community-card-care-flatlay-v2.jpg", "/assets/cisme/community-card-glossy-hair-v1.jpg"].filter((image, index, images) => images.indexOf(image) === index) : [], catalog: {items:[item]}, item, selectedSku, quantity:1, navigating:false, loading: false, errorKind: item ? "none" : "missing", errorTitle: item ? "" : "这件商品暂不可用", error: item ? "" : "商品不存在、已下架，或当前目录不再展示它。请返回商品目录重新选择。" }, () => {
        if (!item || !this.data.pageAlive || this.data.loadAttempt !== attempt) return;
        this.galleryObserver = wx.createIntersectionObserver(this, { thresholds: [0, 0.6], nativeMode: true }).relativeToViewport();
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
  selectSku(event:WechatMiniprogram.TouchEvent){if(this.data.navigating)return;const sku=this.data.item?.variants.find((item:any)=>item.id===String(event.currentTarget.dataset.id));if(!sku||!sku.active)return;this.setData({selectedSku:sku,quantity:Math.min(this.data.quantity,Math.max(1,sku.availableQuantity))});},
  decrease(){if(this.data.quantity>1&&!this.data.navigating)this.setData({quantity:this.data.quantity-1});},
  increase(){const maximum=Math.min(99,this.data.selectedSku?.availableQuantity??0);if(this.data.quantity<maximum&&!this.data.navigating)this.setData({quantity:this.data.quantity+1});},
  openCheckout(){const sku=this.data.selectedSku;if(this.data.navigating||!this.data.item?.purchaseEnabled||!sku?.purchaseEnabled)return;if(!requireMemberAccess(`/pages/product/index?id=${encodeURIComponent(this.data.id)}`))return;this.setData({navigating:true});wx.navigateTo({url:`/pages/checkout/index?product=${encodeURIComponent(this.data.id)}&sku=${encodeURIComponent(sku.id)}&quantity=${this.data.quantity}`,fail:()=>{this.setData({navigating:false});wx.showToast({title:"结算页暂时无法打开",icon:"none"});}});},
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
