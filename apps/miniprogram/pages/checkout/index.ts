import {validateRuntime} from "../../services/commerce-runtime";
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
import { clientOperationKey, createCheckoutQuote, createPendingOrder, isolatedCreditSummary, memberAddresses, orderRuntimeStatus, type CheckoutAddress, type CheckoutQuote } from "../../services/orders";
import { currentChromeStyle } from "../../services/layout";

function problemCopy(error: unknown): string {
  const problem = error as { code?: string; title?: string };
  const known: Record<string, string> = {
    INVENTORY_NOT_AVAILABLE: "库存不足，请调整数量后重新确认。", QUOTE_STALE: "商品或价格有变化，请重新确认。",
    QUOTE_EXPIRED: "费用已过期，请重新确认。", DELIVERY_ADDRESS_CHANGED: "收货地址有变化，请重新选择并确认费用。",
    CATALOG_PRODUCT_NOT_SELLABLE: "商品当前不可售，请返回商品页刷新。", COMMERCE_ORDER_FLOW_DISABLED: "暂时无法下单，请稍后重试。",
    CREDIT_CHECKOUT_INSUFFICIENT:"可用测试购物权益已变化，请刷新后重新报价。",
    CREDIT_CASH_COMPONENT_REQUIRED:"本机测试订单仍需保留至少一分模拟渠道现金支付。"
  };
  return known[problem.code ?? ""] ?? problem.title ?? "操作未完成，请检查网络后重试。";
}

function currentSessionToken(): string { return getApp<IAppOption>().globalData.sessionToken; }
function creditCents(value:string){const parts=/^(\d{1,8})(?:\.(\d{1,2}))?$/.exec(value.trim());
  return parts?Number(parts[1])*100+Number((parts[2]??"").padEnd(2,"0")):NaN;}

Page({
  countdownTimer: null as ReturnType<typeof setInterval> | null,
  requestEpoch: 0,
  loadAttempt: 0,
  mounted: false,
  visible: false,
  data: {
    chromeStyle: currentChromeStyle(), productCode: "", requestedSkuId: "", quantity: 1, product: null as CatalogProduct | null,
    selectedSku: null as CatalogSku | null, addresses: [] as CheckoutAddress[], selectedAddressId: "", runtimeEnabled: false,
    formalPayment:false,isolatedPayment:false,creditEnabled:false,creditAvailableCents:0,creditAvailableYuan:"0.00",
    creditInput:"",creditReadError:"",
    loading: true, busy: false, navigating: false, error: "", syncError: "", quote: null as CheckoutQuote | null,
    quoteClock: null as QuoteClock | null, quoteExpired: false, unitPriceYuan: "", subtotalYuan: "", discountYuan: "",
    shippingYuan: "", totalYuan: "",creditYuan:"",cashYuan:"",
    countdown: "", quoteKey: "", createKey: "", sessionToken: ""
  },
  onResize() { this.setData({ chromeStyle: currentChromeStyle() }); },
  onLoad(query: Record<string, string | undefined>) {
    this.mounted = true;
    const requestedQuantity = Number(query.quantity);
    const quantity = Number.isSafeInteger(requestedQuantity) ? Math.max(1, Math.min(99, requestedQuantity)) : 1;
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
    if (this.data.busy) return;
    const attempt = ++this.loadAttempt;
    const epoch = this.requestEpoch;
    const ownerToken = currentSessionToken();
    this.setData({ loading: true, syncError: "" });
    try {
      const [product, addressBook, runtimeResponse] = await Promise.all([catalogDetail(this.data.productCode), memberAddresses(), orderRuntimeStatus()]);
      const runtime=validateRuntime(runtimeResponse);
      const credit=runtime.isolatedCreditCheckoutAvailable?await isolatedCreditSummary().catch(()=>null):null;
      if (!requestStillOwned(this.ownership(), epoch, ownerToken) || attempt !== this.loadAttempt) return;
      const selected = product.variants.find((item) => item.id === this.data.requestedSkuId && item.active) ?? product.variants.find((item) => item.active) ?? null;
      const effectiveQuantity = selected ? Math.min(this.data.quantity, Math.max(1, selected.availableQuantity)) : 1;
      const addresses = addressBook.addresses;
      const current = addresses.find((item) => item.id === this.data.selectedAddressId);
      const preferred = current ?? addresses.find((item) => item.isDefault) ?? addresses[0] ?? null;
      const quoteAddress = this.data.quote ? addresses.find((item) => item.id === this.data.quote!.addressId) : null;
      const quoteStillMatches = !this.data.quote || Boolean(
        selected && quoteAddress &&
        selected.id === this.data.quote.item.skuId &&
        effectiveQuantity === this.data.quote.quantity &&
        (this.data.quote.creditTenderCents===0||credit!==null)&&
        this.data.quote.creditTenderCents===(this.data.creditInput?creditCents(this.data.creditInput):0) &&
        quoteAddress.version === this.data.quote.addressVersion &&
        preferred?.id === quoteAddress.id
      );
      const publicPatch = {
        product, selectedSku: selected, requestedSkuId: selected?.id ?? "",
        quantity: effectiveQuantity,
        addresses, selectedAddressId: preferred?.id ?? "", runtimeEnabled: runtime.orderFlowEnabled,
        isolatedPayment:runtime.isolatedMoneyOperationsAvailable,formalPayment:runtime.scope==="formal_commerce"&&runtime.paymentAvailable,
        creditEnabled:runtime.isolatedCreditCheckoutAvailable&&credit!==null,
        creditAvailableCents:credit?.checkoutAvailableCents??0,
        creditAvailableYuan:centsToYuan(credit?.checkoutAvailableCents??0),
        creditInput:credit?this.data.creditInput:"",
        creditReadError:runtime.isolatedCreditCheckoutAvailable&&!credit?"测试购物权益暂不可核对，请仅按原价继续。":"",
        unitPriceYuan: selected ? centsToYuan(selected.priceCents) : "", loading: false,
        syncError: addressBook.enabled ? "" : "收货地址暂时无法使用，请稍后重试。"
      };
      if (!quoteStillMatches) {
        this.stopCountdown();
        this.setData({ ...invalidateCheckoutQuote(this.data, publicPatch, true), quoteExpired: false, error: "收货地址或商品信息已变化，请重新确认价格。" });
      } else {
        this.setData(publicPatch);
        if (this.data.quote && this.data.quoteClock) this.startCountdown(this.data.quoteClock);
      }
    } catch (error) {
      if (requestStillOwned(this.ownership(), epoch, ownerToken) && attempt === this.loadAttempt) this.setData({ loading: false, syncError: problemCopy(error) });
    }
  },
  invalidateQuote(patch: WechatMiniprogram.IAnyObject = {}, preserveError = false) {
    this.stopCountdown();
    this.setData({ ...invalidateCheckoutQuote(this.data, patch, preserveError), quoteExpired: false });
  },
  checkoutBlocked() { return this.data.busy || this.data.loading || this.data.navigating || Boolean(this.data.syncError); },
  retryLoad() { if (!this.data.busy && !this.data.loading) void this.load(); },
  selectSku(event: WechatMiniprogram.TouchEvent) {
    if (this.checkoutBlocked()) return;
    const sku = this.data.product?.variants.find((item) => item.id === String(event.currentTarget.dataset.id));
    if (!sku || !sku.active) return;
    this.invalidateQuote({ selectedSku: sku, requestedSkuId: sku.id, quantity: Math.min(this.data.quantity, Math.max(1, sku.availableQuantity)), unitPriceYuan: centsToYuan(sku.priceCents) });
  },
  decrease() { if (!this.checkoutBlocked() && this.data.quantity > 1) this.invalidateQuote({ quantity: this.data.quantity - 1 }); },
  increase() {
    const maximum = Math.min(99, this.data.selectedSku?.availableQuantity ?? 0);
    if (!this.checkoutBlocked() && this.data.quantity < maximum) this.invalidateQuote({ quantity: this.data.quantity + 1 });
  },
  selectAddress(event: WechatMiniprogram.TouchEvent) { if (!this.checkoutBlocked()) this.invalidateQuote({ selectedAddressId: String(event.currentTarget.dataset.id ?? "") }); },
  editCredit(event:WechatMiniprogram.Input){if(!this.checkoutBlocked()&&this.data.creditEnabled)
    this.invalidateQuote({creditInput:event.detail.value});},
  editAddresses() {
    if (this.data.busy || this.data.navigating) return;
    this.setData({ navigating: true });
    wx.navigateTo({ url: "/pages/settings/index?section=addresses", fail: () => this.setData({ navigating: false }) });
  },
  async requestQuote() {
    const sku = this.data.selectedSku;
    const address = this.data.addresses.find((item) => item.id === this.data.selectedAddressId);
    if (this.checkoutBlocked() || !sku || !address) return;
    if (!this.data.runtimeEnabled) { this.setData({ error: "暂时无法下单，请稍后重试。" }); return; }
    const credit=this.data.creditInput?creditCents(this.data.creditInput):0;
    if(!Number.isSafeInteger(credit)||credit<0||credit>this.data.creditAvailableCents||
      credit>0&&!this.data.creditEnabled||credit>=sku.priceCents*this.data.quantity){
      this.setData({error:"购物权益金额须在本机测试可用额度内，且小于商品金额。"});return;}
    const epoch = this.requestEpoch;
    const ownerToken = currentSessionToken();
    const quoteKey = this.data.quoteKey || clientOperationKey("checkout-quote");
    this.setData({ busy: true, error: "", quoteKey });
    try {
      const quote = await createCheckoutQuote({ skuId: sku.id, quantity: this.data.quantity,
        addressId: address.id, addressVersion: address.version,...(credit?{creditCents:credit}:{}) }, quoteKey);
      if (!requestStillOwned(this.ownership(), epoch, ownerToken)) return;
      const quoteClock = createQuoteClock(quote.expiresAt, quote.serverTime);
      this.setData({
        quote, quoteClock, quoteExpired: false, createKey: "", subtotalYuan: centsToYuan(quote.subtotalCents),
        discountYuan: centsToYuan(quote.memberDiscountCents), shippingYuan: centsToYuan(quote.shippingCents),
        totalYuan: centsToYuan(quote.totalCents),creditYuan:centsToYuan(quote.creditTenderCents),
        cashYuan:centsToYuan(quote.cashPayableCents)
      });
      this.startCountdown(quoteClock);
    } catch (error) {
      if (requestStillOwned(this.ownership(), epoch, ownerToken)) this.setData({ error: problemCopy(error) });
    } finally { if (requestStillOwned(this.ownership(), epoch, ownerToken)) this.setData({ busy: false }); }
  },
  refreshQuote() {
    if (this.checkoutBlocked()) return;
    this.invalidateQuote({}, true);
    this.setData({ error: "请确认最新费用后再提交订单。" });
    void this.requestQuote();
  },
  async confirmOrder() {
    const quote = this.data.quote;
    if (this.checkoutBlocked() || !quote) return;
    if (!this.data.runtimeEnabled) { this.setData({ error: "暂时无法下单，请稍后重试。" }); return; }
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
