import { request } from "./api";

export type PendingOrderStatus = "pending_payment" | "cancelled" | "expired" | "paid";
export interface CheckoutAddress {
  id: string; recipientName: string; phone: string; province: string; city: string; district: string; detail: string;
  postalCode: string; nationalCode: string; provinceCode?: string; cityCode?: string; districtCode?: string;
  label: "home" | "company" | "other"; isDefault: boolean; version: number; updatedAt: string;
}
export interface CheckoutQuote {
  id: string; status: "active" | "consumed" | "expired"; currency: "CNY"; quantity: number; unitPriceCents: number;
  subtotalCents: number; memberDiscountCents: number; shippingCents: number; totalCents: number;
  creditTenderCents:number;cashPayableCents:number;pricingRuleVersion: string;
  addressId: string; addressVersion: number; expiresAt: string; serverTime: string; paymentAvailable: false;
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
  id: string; orderNumber: string; status: PendingOrderStatus; currency: "CNY"; subtotalCents: number; memberDiscountCents: number;
  shippingCents: number; totalCents: number; creditTenderCents:number;cashPayableCents:number;
  pricingRuleVersion: string; version: number; expiresAt: string;
  cancelledAt: string | null; expiredAt: string | null; terminalReason: string | null; createdAt: string; updatedAt: string;
  paymentAvailable: false; transactionSourceKind:"synthetic_nonproduction"|"verified_commerce"; lines: OrderLine[]; address: TAddress | null;
}
export type CommerceOrderSummary = Omit<CommerceOrder, "address"> & { address: null };
export interface CommerceOrderPage {
  items: CommerceOrderSummary[]; nextCursor: string | null;
}
export interface CommerceOrderRuntimeStatus {
  version: 1; orderFlowEnabled: boolean; paymentAvailable: false; paymentOnboarding: "IN_PROGRESS"; currency: "CNY";
  scope: "synthetic_nonproduction" | "verified_isolated_test" | "formal_protocol_synthetic_test" | "disabled";
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

export function orderRuntimeStatus(): Promise<CommerceOrderRuntimeStatus> {
  return request<CommerceOrderRuntimeStatus>({ path: "/v1/commerce/orders/status", authMode: "public", cacheTags: ["catalog"] });
}
export function memberAddresses(): Promise<{ enabled: boolean; maxAddresses: number; addresses: CheckoutAddress[] }> {
  return request({ path: "/v1/me/addresses", cacheTags: ["member"] });
}
export function createCheckoutQuote(input: { skuId: string; quantity: number; addressId: string; addressVersion: number;
  creditCents?:number }, idempotencyKey: string): Promise<CheckoutQuote> {
  return request({ path: "/v1/me/commerce/quotes", method: "POST", data: input, idempotencyKey, cacheTags: ["catalog", "orders"] });
}
export function createPendingOrder(quoteId: string, idempotencyKey: string): Promise<CommerceOrder<MemberOrderAddress>> {
  return request({ path: "/v1/me/orders", method: "POST", data: { quoteId }, idempotencyKey, cacheTags: ["orders", "catalog"] });
}
export function myOrders(cursor?: string): Promise<CommerceOrderPage> {
  return request({ path: `/v1/me/orders?limit=20${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`, cacheTags: ["orders"] });
}
export function myOrder(id: string): Promise<CommerceOrder<MemberOrderAddress>> {
  return request({ path: `/v1/me/orders/${encodeURIComponent(id)}`, cacheTags: ["orders"] });
}
export function cancelMyOrder(id: string, expectedVersion: number, reason: string, idempotencyKey: string): Promise<CommerceOrder<MemberOrderAddress>> {
  return request({ path: `/v1/me/orders/${encodeURIComponent(id)}/cancel`, method: "POST", data: { expectedVersion, reason }, idempotencyKey, cacheTags: ["orders", "catalog"] });
}
export function managementOrders(cursor?: string): Promise<CommerceOrderPage> {
  return request({ path: `/v1/management/commerce/orders?limit=20${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`, cacheTags: ["orders", "authority"] });
}
export function managementOrder(id: string): Promise<CommerceOrder<ManagementOrderAddress>> {
  return request({ path: `/v1/management/commerce/orders/${encodeURIComponent(id)}`, cacheTags: ["orders", "authority"] });
}
