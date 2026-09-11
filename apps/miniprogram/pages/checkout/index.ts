import { requireMemberAccess } from "../../services/api";
import { catalogDetail, centsToYuan, type CatalogProduct, type CatalogSku } from "../../services/commerce";
import { clientOperationKey, createCheckoutQuote, createPendingOrder, memberAddresses, orderRuntimeStatus, type CheckoutAddress, type CheckoutQuote } from "../../services/orders";
import { currentChromeStyle } from "../../services/layout";

function problemCopy(error: unknown): string {
  const problem = error as { code?: string; title?: string };
  const known: Record<string,string> = {
    INVENTORY_NOT_AVAILABLE:"当前库存不足，请调整数量后重新报价。", QUOTE_STALE:"商品或价格已变化，请重新报价。",
    QUOTE_EXPIRED:"报价已过期，请重新获取。", DELIVERY_ADDRESS_CHANGED:"收货地址已变化，请重新选择并报价。",
    CATALOG_PRODUCT_NOT_SELLABLE:"商品当前不可售，请返回商品页刷新。", COMMERCE_ORDER_FLOW_DISABLED:"当前环境未开放待支付订单验证。"
  };
  return known[problem.code ?? ""] ?? problem.title ?? "操作未完成，请检查网络后重试。";
}

Page({
  countdownTimer: null as ReturnType<typeof setInterval> | null,
  serverOffsetMs: 0,
  data: { chromeStyle:currentChromeStyle(),productCode:"",requestedSkuId:"",quantity:1,product:null as CatalogProduct|null,selectedSku:null as CatalogSku|null,
    addresses:[] as CheckoutAddress[],selectedAddressId:"",runtimeEnabled:false,loading:true,busy:false,navigating:false,error:"",quote:null as CheckoutQuote|null,
    unitPriceYuan:"",subtotalYuan:"",discountYuan:"",shippingYuan:"",totalYuan:"",countdown:"",quoteKey:"",createKey:"" },
  onResize(){this.setData({chromeStyle:currentChromeStyle()});},
  onLoad(query:Record<string,string|undefined>){const quantity=Math.max(1,Math.min(99,Number(query.quantity)||1));this.setData({productCode:query.product??"",requestedSkuId:query.sku??"",quantity});},
  onShow(){this.setData({navigating:false});if(!requireMemberAccess())return;void this.load();},
  onHide(){this.stopCountdown();},onUnload(){this.stopCountdown();},
  stopCountdown(){if(this.countdownTimer){clearInterval(this.countdownTimer);this.countdownTimer=null;}},
  tickCountdown(){const quote=this.data.quote;if(!quote){this.setData({countdown:""});return;}const remaining=Math.max(0,Date.parse(quote.expiresAt)-(Date.now()+this.serverOffsetMs));const seconds=Math.ceil(remaining/1000);this.setData({countdown:seconds>0?`${Math.floor(seconds/60)}:${String(seconds%60).padStart(2,"0")}`:"已过期"});},
  startCountdown(quote:CheckoutQuote){this.stopCountdown();this.serverOffsetMs=Date.parse(quote.serverTime)-Date.now();this.tickCountdown();this.countdownTimer=setInterval(()=>this.tickCountdown(),1000);},
  async load(){if(this.data.loading&&this.data.product)return;this.setData({loading:true,error:""});try{const [product,addressBook,runtime]=await Promise.all([catalogDetail(this.data.productCode),memberAddresses(),orderRuntimeStatus()]);const selected=product.variants.find(item=>item.id===this.data.requestedSkuId&&item.active)??product.variants.find(item=>item.active)??null;const addresses=addressBook.addresses;const current=addresses.find(item=>item.id===this.data.selectedAddressId);const preferred=current??addresses.find(item=>item.isDefault)??addresses[0]??null;this.setData({product,selectedSku:selected,requestedSkuId:selected?.id??"",quantity:selected?Math.min(this.data.quantity,Math.max(1,selected.availableQuantity)):1,addresses,selectedAddressId:preferred?.id??"",runtimeEnabled:runtime.orderFlowEnabled,unitPriceYuan:selected?centsToYuan(selected.priceCents):"",loading:false,error:addressBook.enabled?"":"地址簿安全存储尚未配置，当前不能创建订单。"});}catch(error){this.setData({loading:false,error:problemCopy(error)});}},
  invalidateQuote(patch:WechatMiniprogram.IAnyObject){this.stopCountdown();this.setData({...patch,quote:null,quoteKey:"",createKey:"",countdown:"",subtotalYuan:"",discountYuan:"",shippingYuan:"",totalYuan:"",error:""});},
  selectSku(event:WechatMiniprogram.TouchEvent){if(this.data.busy)return;const sku=this.data.product?.variants.find(item=>item.id===String(event.currentTarget.dataset.id));if(!sku||!sku.active)return;this.invalidateQuote({selectedSku:sku,requestedSkuId:sku.id,quantity:Math.min(this.data.quantity,Math.max(1,sku.availableQuantity)),unitPriceYuan:centsToYuan(sku.priceCents)});},
  decrease(){if(this.data.busy||this.data.quantity<=1)return;this.invalidateQuote({quantity:this.data.quantity-1});},
  increase(){const max=Math.min(99,this.data.selectedSku?.availableQuantity??0);if(this.data.busy||this.data.quantity>=max)return;this.invalidateQuote({quantity:this.data.quantity+1});},
  selectAddress(event:WechatMiniprogram.TouchEvent){if(this.data.busy)return;this.invalidateQuote({selectedAddressId:String(event.currentTarget.dataset.id??"")});},
  editAddresses(){if(this.data.busy||this.data.navigating)return;this.setData({navigating:true});wx.navigateTo({url:"/pages/settings/index?section=addresses",fail:()=>this.setData({navigating:false})});},
  async requestQuote(){const sku=this.data.selectedSku;const address=this.data.addresses.find(item=>item.id===this.data.selectedAddressId);if(this.data.busy||!sku||!address)return;if(!this.data.runtimeEnabled){this.setData({error:"当前环境未开放待支付订单验证。"});return;}const quoteKey=this.data.quoteKey||clientOperationKey("checkout-quote");this.setData({busy:true,error:"",quoteKey});try{const quote=await createCheckoutQuote({skuId:sku.id,quantity:this.data.quantity,addressId:address.id,addressVersion:address.version},quoteKey);this.setData({quote,subtotalYuan:centsToYuan(quote.subtotalCents),discountYuan:centsToYuan(quote.memberDiscountCents),shippingYuan:centsToYuan(quote.shippingCents),totalYuan:centsToYuan(quote.totalCents)});this.startCountdown(quote);}catch(error){this.setData({error:problemCopy(error)});}finally{this.setData({busy:false});}},
  async confirmOrder(){const quote=this.data.quote;if(this.data.busy||!quote)return;if(this.data.countdown==="已过期"){this.invalidateQuote({});this.setData({error:"报价已过期，请重新获取。"});return;}const createKey=this.data.createKey||clientOperationKey("pending-order");this.setData({busy:true,error:"",createKey});try{const order=await createPendingOrder(quote.id,createKey);this.stopCountdown();this.setData({quote:null});wx.redirectTo({url:`/pages/order-detail/index?id=${encodeURIComponent(order.id)}`,fail:()=>{this.setData({busy:false,error:"订单已创建，但详情页暂时无法打开；可从“我的订单”查看。"});}});}catch(error){const problem=error as {code?:string};this.setData({busy:false,error:problemCopy(error)});if(["QUOTE_EXPIRED","QUOTE_STALE","DELIVERY_ADDRESS_CHANGED","CATALOG_PRODUCT_NOT_SELLABLE"].includes(problem.code??"")){this.invalidateQuote({});void this.load();}}},
  back(){if(this.data.busy||this.data.navigating)return;this.setData({navigating:true});wx.navigateBack({fail:()=>wx.redirectTo({url:`/pages/product/index?id=${encodeURIComponent(this.data.productCode)}`} )});}
});
