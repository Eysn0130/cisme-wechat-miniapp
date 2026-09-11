import { requireMemberAccess, retainMemberSnapshot } from "../../services/api";
import { catalogDetail, centsToYuan, type CatalogProduct, type CatalogSku } from "../../services/commerce";
import {
  clearCheckoutPrivateState,
  createQuoteClock,
  invalidateCheckoutQuote,
  quoteClockView,
  requestStillOwned,
  type QuoteClock
} from "../../services/checkout-state";
import { clientOperationKey, createCheckoutQuote, createPendingOrder, memberAddresses, orderRuntimeStatus, type CheckoutAddress, type CheckoutQuote } from "../../services/orders";
import { currentChromeStyle } from "../../services/layout";

function problemCopy(error: unknown): string {
  const problem = error as { code?: string; title?: string };
  const known: Record<string, string> = {
    INVENTORY_NOT_AVAILABLE: "当前库存不足，请调整数量后重新报价。", QUOTE_STALE: "商品或价格已变化，请重新报价。",
    QUOTE_EXPIRED: "报价已过期，请重新获取。", DELIVERY_ADDRESS_CHANGED: "收货地址已变化，请重新选择并报价。",
    CATALOG_PRODUCT_NOT_SELLABLE: "商品当前不可售，请返回商品页刷新。", COMMERCE_ORDER_FLOW_DISABLED: "当前环境未开放待支付订单验证。"
  };
  return known[problem.code ?? ""] ?? problem.title ?? "操作未完成，请检查网络后重试。";
}

function currentSessionToken(): string { return getApp<IAppOption>().globalData.sessionToken; }

Page({
  countdownTimer: null as ReturnType<typeof setInterval> | null,
  requestEpoch: 0,
  mounted: false,
  visible: false,
  data: {
    chromeStyle: currentChromeStyle(), productCode: "", requestedSkuId: "", quantity: 1, product: null as CatalogProduct | null,
    selectedSku: null as CatalogSku | null, addresses: [] as CheckoutAddress[], selectedAddressId: "", runtimeEnabled: false,
    loading: true, busy: false, navigating: false, error: "", syncError: "", quote: null as CheckoutQuote | null,
    quoteClock: null as QuoteClock | null, quoteExpired: false, unitPriceYuan: "", subtotalYuan: "", discountYuan: "",
    shippingYuan: "", totalYuan: "", countdown: "", quoteKey: "", createKey: "", sessionToken: ""
  },
  onResize() { this.setData({ chromeStyle: currentChromeStyle() }); },
  onLoad(query: Record<string, string | undefined>) {
    this.mounted = true;
    const quantity = Math.max(1, Math.min(99, Number(query.quantity) || 1));
    this.setData({ productCode: query.product ?? "", requestedSkuId: query.sku ?? "", quantity });
  },
  onShow() {
    this.visible = true;
    this.requestEpoch += 1;
    // A request that was interrupted by backgrounding is no longer allowed to
    // own this page epoch. Unlock the controls so the same retained
    // idempotency key can be retried safely.
    this.setData({ navigating: false, busy: false });
    const token = currentSessionToken();
    const preserve = retainMemberSnapshot(this);
    if (!preserve) {
      this.stopCountdown();
      this.setData({ ...clearCheckoutPrivateState(this.data), syncError: "", quoteExpired: false, sessionToken: token });
    } else {
      this.setData({ sessionToken: token });
      if (this.data.quote && this.data.quoteClock) this.startCountdown(this.data.quoteClock);
    }
    if (!requireMemberAccess()) { this.visible = false; return; }
    void this.load();
  },
  onHide() { this.visible = false; this.requestEpoch += 1; this.stopCountdown(); },
  onUnload() { this.mounted = false; this.visible = false; this.requestEpoch += 1; this.stopCountdown(); },
  ownership() { return { mounted: this.mounted, visible: this.visible, epoch: this.requestEpoch, sessionToken: currentSessionToken() }; },
  stopCountdown() { if (this.countdownTimer) { clearInterval(this.countdownTimer); this.countdownTimer = null; } },
  tickCountdown() {
    const clock = this.data.quoteClock;
    if (!this.data.quote || !clock) { this.setData({ countdown: "", quoteExpired: false }); return; }
    const view = quoteClockView(clock);
    this.setData({ countdown: view.label, quoteExpired: view.expired });
    if (view.expired) this.stopCountdown();
  },
  startCountdown(clock: QuoteClock) {
    this.stopCountdown();
    this.tickCountdown();
    if (!quoteClockView(clock).expired && this.visible) this.countdownTimer = setInterval(() => this.tickCountdown(), 1_000);
  },
  async load() {
    const epoch = this.requestEpoch;
    const ownerToken = currentSessionToken();
    this.setData({ loading: true, syncError: "" });
    try {
      const [product, addressBook, runtime] = await Promise.all([catalogDetail(this.data.productCode), memberAddresses(), orderRuntimeStatus()]);
      if (!requestStillOwned(this.ownership(), epoch, ownerToken)) return;
      const selected = product.variants.find((item) => item.id === this.data.requestedSkuId && item.active) ?? product.variants.find((item) => item.active) ?? null;
      const addresses = addressBook.addresses;
      const current = addresses.find((item) => item.id === this.data.selectedAddressId);
      const preferred = current ?? addresses.find((item) => item.isDefault) ?? addresses[0] ?? null;
      const quoteAddress = this.data.quote ? addresses.find((item) => item.id === this.data.quote!.addressId) : null;
      const quoteStillMatches = !this.data.quote || Boolean(
        selected && quoteAddress &&
        selected.id === this.data.quote.item.skuId &&
        this.data.quantity === this.data.quote.quantity &&
        quoteAddress.version === this.data.quote.addressVersion &&
        preferred?.id === quoteAddress.id
      );
      const publicPatch = {
        product, selectedSku: selected, requestedSkuId: selected?.id ?? "",
        quantity: selected ? Math.min(this.data.quantity, Math.max(1, selected.availableQuantity)) : 1,
        addresses, selectedAddressId: preferred?.id ?? "", runtimeEnabled: runtime.orderFlowEnabled,
        unitPriceYuan: selected ? centsToYuan(selected.priceCents) : "", loading: false,
        syncError: addressBook.enabled ? "" : "地址簿安全存储尚未配置，当前不能创建订单。"
      };
      if (!quoteStillMatches) {
        this.stopCountdown();
        this.setData({ ...invalidateCheckoutQuote(this.data, publicPatch, true), quoteExpired: false, error: "收货地址或商品信息已变化，请重新确认价格。" });
      } else {
        this.setData(publicPatch);
        if (this.data.quote && this.data.quoteClock) this.startCountdown(this.data.quoteClock);
      }
    } catch (error) {
      if (requestStillOwned(this.ownership(), epoch, ownerToken)) this.setData({ loading: false, syncError: problemCopy(error) });
    }
  },
  invalidateQuote(patch: WechatMiniprogram.IAnyObject = {}, preserveError = false) {
    this.stopCountdown();
    this.setData({ ...invalidateCheckoutQuote(this.data, patch, preserveError), quoteExpired: false });
  },
  selectSku(event: WechatMiniprogram.TouchEvent) {
    if (this.data.busy) return;
    const sku = this.data.product?.variants.find((item) => item.id === String(event.currentTarget.dataset.id));
    if (!sku || !sku.active) return;
    this.invalidateQuote({ selectedSku: sku, requestedSkuId: sku.id, quantity: Math.min(this.data.quantity, Math.max(1, sku.availableQuantity)), unitPriceYuan: centsToYuan(sku.priceCents) });
  },
  decrease() { if (!this.data.busy && this.data.quantity > 1) this.invalidateQuote({ quantity: this.data.quantity - 1 }); },
  increase() {
    const maximum = Math.min(99, this.data.selectedSku?.availableQuantity ?? 0);
    if (!this.data.busy && this.data.quantity < maximum) this.invalidateQuote({ quantity: this.data.quantity + 1 });
  },
  selectAddress(event: WechatMiniprogram.TouchEvent) { if (!this.data.busy) this.invalidateQuote({ selectedAddressId: String(event.currentTarget.dataset.id ?? "") }); },
  editAddresses() {
    if (this.data.busy || this.data.navigating) return;
    this.setData({ navigating: true });
    wx.navigateTo({ url: "/pages/settings/index?section=addresses", fail: () => this.setData({ navigating: false }) });
  },
  async requestQuote() {
    const sku = this.data.selectedSku;
    const address = this.data.addresses.find((item) => item.id === this.data.selectedAddressId);
    if (this.data.busy || !sku || !address) return;
    if (!this.data.runtimeEnabled) { this.setData({ error: "当前环境未开放待支付订单验证。" }); return; }
    const epoch = this.requestEpoch;
    const ownerToken = currentSessionToken();
    const quoteKey = this.data.quoteKey || clientOperationKey("checkout-quote");
    this.setData({ busy: true, error: "", quoteKey });
    try {
      const quote = await createCheckoutQuote({ skuId: sku.id, quantity: this.data.quantity, addressId: address.id, addressVersion: address.version }, quoteKey);
      if (!requestStillOwned(this.ownership(), epoch, ownerToken)) return;
      const quoteClock = createQuoteClock(quote.expiresAt, quote.serverTime);
      this.setData({
        quote, quoteClock, quoteExpired: false, createKey: "", subtotalYuan: centsToYuan(quote.subtotalCents),
        discountYuan: centsToYuan(quote.memberDiscountCents), shippingYuan: centsToYuan(quote.shippingCents), totalYuan: centsToYuan(quote.totalCents)
      });
      this.startCountdown(quoteClock);
    } catch (error) {
      if (requestStillOwned(this.ownership(), epoch, ownerToken)) this.setData({ error: problemCopy(error) });
    } finally { if (requestStillOwned(this.ownership(), epoch, ownerToken)) this.setData({ busy: false }); }
  },
  refreshQuote() {
    if (this.data.busy) return;
    this.invalidateQuote({}, true);
    this.setData({ error: "原报价已失效，请确认最新金额后再创建订单。" });
    void this.requestQuote();
  },
  async confirmOrder() {
    const quote = this.data.quote;
    if (this.data.busy || !quote) return;
    if (this.data.quoteExpired || quoteClockView(this.data.quoteClock ?? createQuoteClock(quote.expiresAt, quote.serverTime)).expired) { this.refreshQuote(); return; }
    const epoch = this.requestEpoch;
    const ownerToken = currentSessionToken();
    const createKey = this.data.createKey || clientOperationKey("pending-order");
    this.setData({ busy: true, error: "", createKey });
    try {
      const order = await createPendingOrder(quote.id, createKey);
      if (!requestStillOwned(this.ownership(), epoch, ownerToken)) return;
      this.stopCountdown();
      this.setData({ quote: null, quoteClock: null, quoteExpired: false });
      wx.redirectTo({ url: `/pages/order-detail/index?id=${encodeURIComponent(order.id)}`, fail: () => { this.setData({ busy: false, error: "订单已创建，但详情页暂时无法打开；可从“我的订单”查看。" }); } });
    } catch (error) {
      if (!requestStillOwned(this.ownership(), epoch, ownerToken)) return;
      const problem = error as { code?: string };
      const errorCopy = problemCopy(error);
      this.setData({ busy: false, error: errorCopy });
      if (["QUOTE_EXPIRED", "QUOTE_STALE", "DELIVERY_ADDRESS_CHANGED", "CATALOG_PRODUCT_NOT_SELLABLE"].includes(problem.code ?? "")) {
        this.invalidateQuote({}, true);
        this.setData({ error: errorCopy });
        void this.load();
      }
    }
  },
  back() {
    if (this.data.busy || this.data.navigating) return;
    this.setData({ navigating: true });
    wx.navigateBack({ fail: () => wx.redirectTo({ url: `/pages/product/index?id=${encodeURIComponent(this.data.productCode)}` }) });
  }
});
