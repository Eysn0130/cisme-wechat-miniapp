import { request } from "./api";
import { pageRead } from "./page-requests";

export type PendingOrderStatus = "pending_payment" | "cancelled" | "expired" | "paid";
export interface CheckoutAddress {
  id: string; recipientName: string; phone: string; province: string; city: string; district: string; detail: string;
  postalCode: string; nationalCode: string; provinceCode?: string; cityCode?: string; districtCode?: string;
  label: "home" | "company" | "other"; isDefault: boolean; version: number; updatedAt: string;
}
export interface FulfillmentPolicy {
  version:string; shippingPromise:string; dispatchPromise:string; returnsPromise:string;
  returnFreight:{noReason:string;qualityWrongMissingTransport:string};
}
export type NoCourierDelivery = "local_delivery" | "pickup";
export interface OrderShipment {
  orderId:string; id?:string; version?:number; carrierName?:string; trackingNumber?:string|null;
  deliveryMethod?:"express"|NoCourierDelivery;
  logisticsState:"not_ready"|"awaiting_dispatch"|"shipped"|"delivered"|"exception";
  shippedAt?:string; deliveredAt?:string|null; receiptConfirmedAt?:string|null; autoReceiptAt?:string|null; wechatSyncState?:string;
  logisticsMessageState?:'queued'|'retry'|'dispatching'|'registered'|'unknown'|'review'|'cancelled'|null;
  wechatReceipt?: (WechatReceiptState&{observedLabel?:string;displayLabel?:string})|null;
}
export interface WechatReceiptState {source:'wechat_get_order';status:'unverified'|'awaiting_shipping'|'shipped'|'confirmed'|'completed'|'refunded'|'settlement_pending'|'unknown';
  label:string;inComplaint:boolean|null;observedAt:string|null;canOpenComponent:boolean}
export interface WechatReceiptQuery extends WechatReceiptState {orderId:string;shipmentId:string;component?:{transactionId:string}}
export function queryMyWechatReceipt(id:string):Promise<WechatReceiptQuery>{
  return request<WechatReceiptQuery>({path:`/v1/me/orders/${encodeURIComponent(id)}/wechat-receipt/query`,method:'POST',data:{},cacheTags:['orders']});
}
export function myShipment(id:string,page:object):Promise<OrderShipment>{
  return pageRead<OrderShipment>(page,{path:`/v1/me/orders/${encodeURIComponent(id)}/shipment`,cacheTags:["orders"]});
}
export interface ShipmentCarrier {id:string;name:string}
export function shipmentCarriers(page:object){return pageRead<{carriers:ShipmentCarrier[]}>(page,{path:"/v1/management/shipments/carriers"});}
export interface OrderTracking {orderId:string;shipmentId:string;source:"wechat_logistics";observedAt:string;
  events:Array<{time:string;code:number;state:string;message:string}>}
export function myTracking(id:string,page:object):Promise<OrderTracking>{
  return pageRead<OrderTracking>(page,{path:`/v1/me/orders/${encodeURIComponent(id)}/shipment/tracking`});
}
export function myLogisticsView(id:string):Promise<{orderId:string;shipmentId:string;source:'wechat_logistics_plugin';waybillToken:string}>{
  return request({path:`/v1/me/orders/${encodeURIComponent(id)}/shipment/logistics-view`,method:'POST',data:{}});
}
export function confirmMyReceipt(id:string,expectedVersion:number,idempotencyKey:string){
  return request({path:`/v1/me/orders/${encodeURIComponent(id)}/confirm-receipt`,method:"POST",data:{expectedVersion},idempotencyKey,cacheTags:["orders"]});
}
export interface CheckoutQuote {
  couponId?:string;couponDiscountCents?:number;
  shoppingPointsMultiplier?:number;pointsSpent?:number;pointsMaximum?:number;pointsPolicyVersion?:string|null;
  fulfillmentPolicy?:FulfillmentPolicy|null;
  id: string; status: "active" | "consumed" | "expired"; currency: "CNY"; quantity: number; unitPriceCents: number;
  subtotalCents: number; memberDiscountCents: number; shippingCents: number; totalCents: number;
  creditTenderCents:number;cashPayableCents:number;pricingRuleVersion: string;
  addressId: string; addressVersion: number; expiresAt: string; serverTime: string; paymentAvailable: boolean;
  item: { productId: string; productCode: string; productName: string; image: string | null; skuId: string; skuCode: string; skuLabel: string };
}
export interface OrderLine {
  id: string; lineNumber: number; productCode: string; productName: string; skuCode: string; skuLabel: string; image: string | null;
  quantity: number; unitPriceCents: number; subtotalCents: number; discountCents: number; totalCents: number;
  creditTenderCents:number;cashPayableCents:number;
}
export interface MemberOrderAddress {
  recipientName: string; phone: string; province: string; city: string; district: string; detail: string; postalCode: string;
}
export interface ManagementOrderAddress { recipientNameMasked: string; phoneMasked: string; province: string; city: string; district: string }
export interface CommerceOrder<TAddress = MemberOrderAddress | ManagementOrderAddress> {
  refundedCents?:number;
  couponId?:string;couponDiscountCents?:number;
  shoppingPointsMultiplier?:number;pointsSpent?:number;
  fulfillmentPolicy?:FulfillmentPolicy|null;
  id: string; orderNumber: string; status: PendingOrderStatus; currency: "CNY"; subtotalCents: number; memberDiscountCents: number;
  shippingCents: number; totalCents: number; creditTenderCents:number;cashPayableCents:number;
  pricingRuleVersion: string; version: number; expiresAt: string;
  cancelledAt: string | null; expiredAt: string | null; terminalReason: string | null; createdAt: string; updatedAt: string;
  paymentAvailable: boolean; transactionSourceKind:"synthetic_nonproduction"|"verified_commerce"; lines: OrderLine[]; address: TAddress | null;
}
export function orderLineSummary(line: {productName:string;skuLabel:string;quantity:number}): string {
  const variant = line.skuLabel?.trim() || "";
  const product = line.productName?.trim() || variant;
  return `${product}${variant && variant !== product ? " · "+variant : ""} × ${line.quantity}`;
}
export type CommerceOrderSummary = Omit<CommerceOrder, "address"> & { address: null;fulfillmentState?:string;
  shipmentDeliveryMethod?:OrderShipment["deliveryMethod"]|null; wechatReceipt?:WechatReceiptState|null };
export interface CommerceOrderPage {totalCount?:number|null;
  items: CommerceOrderSummary[]; nextCursor: string | null;
}
export interface CommerceOrderRuntimeStatus {
  paymentRestriction?:'wechat_trade_management'|null;
  version: 1|2; orderFlowEnabled: boolean; paymentAvailable: boolean; paymentOnboarding: "IN_PROGRESS"|"READY"; currency: "CNY";
  scope: "synthetic_nonproduction" | "verified_isolated_test" | "formal_protocol_synthetic_test" | "formal_commerce" | "disabled";
  formalMoneyOperationsAvailable?:boolean; formalRecoveryAvailable?:boolean;
  isolatedMoneyOperationsAvailable: boolean; isolatedTransferAvailable: boolean; isolatedCreditCheckoutAvailable:boolean;
}
export interface IsolatedCreditSummary{availableCents:number;checkoutAvailableCents:number;spendable:boolean;
  redemptionStatus:"ISOLATED_TEST_ONLY";totalCount:number}
export function isolatedCreditSummary():Promise<IsolatedCreditSummary>{
  return request({path:"/v1/me/commission/credit-conversions?limit=1",cacheTags:["member","orders"]});
}

export function clientOperationKey(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function orderRuntimeStatus(page?: object): Promise<CommerceOrderRuntimeStatus> {
  const options = { path: "/v1/commerce/orders/status", authMode: "public" as const, cacheTags: ["catalog"] };
  return page ? pageRead<CommerceOrderRuntimeStatus>(page, options) : request<CommerceOrderRuntimeStatus>(options);
}
export function memberAddresses(page?: object): Promise<{ enabled: boolean; maxAddresses: number; addresses: CheckoutAddress[] }> {
  const options = { path: "/v1/me/addresses", cacheTags: ["member"] };
  return page ? pageRead(page, options) : request(options);
}
export function createCheckoutQuote(input: { skuId: string; quantity: number; addressId: string; addressVersion: number;
  creditCents?:number;points?:number;couponId?:string }, idempotencyKey: string): Promise<CheckoutQuote> {
  return request({ path: "/v1/me/commerce/quotes", method: "POST", data: input, idempotencyKey, cacheTags: ["catalog", "orders"] });
}
export function createPendingOrder(quoteId: string, idempotencyKey: string): Promise<CommerceOrder<MemberOrderAddress>> {
  return request({ path: "/v1/me/orders", method: "POST", data: { quoteId }, idempotencyKey, cacheTags: ["orders", "catalog","points"] });
}
export function myOrders(cursor?: string, page?: object): Promise<CommerceOrderPage> {
  const options = { path: `/v1/me/orders?limit=20${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`, cacheTags: ["orders"] };
  return page ? pageRead<CommerceOrderPage>(page, options) : request<CommerceOrderPage>(options);
}
export function myOrder(id: string, page?: object): Promise<CommerceOrder<MemberOrderAddress>> {
  const options = { path: `/v1/me/orders/${encodeURIComponent(id)}`, cacheTags: ["orders"] };
  return page ? pageRead<CommerceOrder<MemberOrderAddress>>(page, options) : request<CommerceOrder<MemberOrderAddress>>(options);
}
export function cancelMyOrder(id: string, expectedVersion: number, reason: string, idempotencyKey: string): Promise<CommerceOrder<MemberOrderAddress>> {
  return request({ path: `/v1/me/orders/${encodeURIComponent(id)}/cancel`, method: "POST", data: { expectedVersion, reason }, idempotencyKey, cacheTags: ["orders", "catalog"] });
}
export function managementOrders(cursor?: string, page?: object,filters:{stage?:string;from?:string;through?:string}={}): Promise<CommerceOrderPage> {
  const options = { path: `/v1/management/commerce/orders?limit=20${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}${Object.entries(filters).filter(([,value])=>value).map(([key,value])=>'&'+key+'='+encodeURIComponent(value!)).join('')}`, cacheTags: ["orders", "authority"] };
  return page ? pageRead<CommerceOrderPage>(page, options) : request<CommerceOrderPage>(options);
}
export function managementOrder(id: string): Promise<CommerceOrder<ManagementOrderAddress>> {
  return request({ path: `/v1/management/commerce/orders/${encodeURIComponent(id)}`, cacheTags: ["orders", "authority"] });
}
export function managementShipment(id:string):Promise<OrderShipment>{
  return request({path:`/v1/management/commerce/orders/${encodeURIComponent(id)}/shipment`,cacheTags:["orders","authority"]});
}
export type ShipmentDispatchInput = {evidenceReference:string;expectedOrderVersion:number} & (
  {deliveryMethod?:undefined;carrierCode:string;carrierName:string;trackingNumber:string;shippedAt?:string}
  | {deliveryMethod:NoCourierDelivery}
);
export function dispatchShipment(id:string,input:ShipmentDispatchInput,idempotencyKey:string){
  return request({path:`/v1/management/commerce/orders/${encodeURIComponent(id)}/shipment`,method:"POST",data:input,idempotencyKey,cacheTags:["orders","authority"]});
}

export function reconcileShipment(id:string,evidenceReference:string,idempotencyKey:string){
  return request<{state:string;queryOutcome:string;queryOnly:true}>({path:`/v1/management/commerce/orders/${encodeURIComponent(id)}/shipment/reconcile`,method:"POST",data:{evidenceReference},idempotencyKey,cacheTags:["orders","authority"]});
}
