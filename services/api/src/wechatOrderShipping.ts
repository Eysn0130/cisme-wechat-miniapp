import { DomainError } from '@cisme/domain';
import { boundedWechatJson } from './boundedWechatJson.js';
import { dependencySignal } from './operationBudget.js';

/** PRD §8.2 / WX-PAY-MAKE-01. A shipping observation is not a local
 * payment, carrier-delivery, receipt or after-sales terminal fact. */
export type ShippingBinding = Readonly<{
  merchantId: string; merchantOrderNumber: string; transactionId: string;
  payerOpenid: string; payerTotalCents: number;
}>;
export type UnifiedParcel = Readonly<{
  trackingNumber: string; carrierCode: string; description: string;
  receiverContactMasked?: string;
}>;
export type ShippingObservation = {
  decision: 'matched' | 'not_uploaded' | 'conflict';
  platformOrderState: number;
  inComplaint: boolean;
};
type JsonObject = Record<string, unknown>;
function object(value: unknown): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('WECHAT_SHIPPING_RESPONSE_INVALID', 502);
  return value as JsonObject;
}
function fail(code: string, status = 422): never {
  throw new DomainError(code, '发货信息需核对；请保留原操作记录，不要重复发货', status);
}
function text(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value === value.trim()
    && Buffer.byteLength(value) <= max && !/[\u0000-\u001f\u007f]/u.test(value);
}
export function validateShippingBinding(binding: ShippingBinding): void {
  if (!/^\d{6,20}$/.test(binding.merchantId) || !/^[A-Za-z0-9_*-]{1,32}$/.test(binding.merchantOrderNumber)
    || !text(binding.transactionId, 64) || !text(binding.payerOpenid, 128)
    || !Number.isSafeInteger(binding.payerTotalCents) || binding.payerTotalCents <= 0)
    fail('WECHAT_SHIPPING_BINDING_INVALID');
}
function validateParcel(parcel: UnifiedParcel): void {
  if (!text(parcel.trackingNumber, 128) || !text(parcel.carrierCode, 128)
    || !text(parcel.description, 480) || Array.from(parcel.description).length > 120)
    fail('WECHAT_SHIPPING_PARCEL_INVALID');
  if (parcel.receiverContactMasked !== undefined
    && (!/^\*{4}\d{4}$/.test(parcel.receiverContactMasked))) fail('WECHAT_SHIPPING_CONTACT_NOT_MASKED');
  if (parcel.carrierCode === 'SF' && !parcel.receiverContactMasked) fail('WECHAT_SHIPPING_CONTACT_REQUIRED');
}
export function unifiedShippingPayload(binding: ShippingBinding, parcel: UnifiedParcel, uploadTime: string) {
  validateShippingBinding(binding); validateParcel(parcel);
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(uploadTime)
    || !Number.isFinite(Date.parse(uploadTime)) || new Date(uploadTime).toISOString() !== uploadTime)
    fail('WECHAT_SHIPPING_UPLOAD_TIME_INVALID');
  return {
    order_key: { order_number_type: 2, transaction_id: binding.transactionId },
    logistics_type: 1, delivery_mode: 1,
    shipping_list: [{ tracking_no: parcel.trackingNumber, express_company: parcel.carrierCode,
      item_desc: parcel.description, ...(parcel.receiverContactMasked
        ? { contact: { receiver_contact: parcel.receiverContactMasked } } : {}) }],
    upload_time: uploadTime, payer: { openid: binding.payerOpenid }
  };
}

/** Check all payment identity fields before interpreting shipping state. No
 * upstream body, OpenID, tracking number or contact is retained in the result. */
export function shippingObservation(raw: unknown, binding: ShippingBinding, parcel: UnifiedParcel): ShippingObservation {
  validateShippingBinding(binding); validateParcel(parcel);
  const order = object(raw);
  if (order.transaction_id !== binding.transactionId || order.merchant_id !== binding.merchantId
    || order.merchant_trade_no !== binding.merchantOrderNumber || order.openid !== binding.payerOpenid
    || order.paid_amount !== binding.payerTotalCents || (order.sub_merchant_id !== undefined && order.sub_merchant_id !== '')
    || ![1, 2, 3, 4, 5, 6].includes(Number(order.order_state)) || typeof order.order_state !== 'number'
    || typeof order.in_complaint !== 'boolean') fail('WECHAT_SHIPPING_ORDER_BINDING_MISMATCH', 502);
  const result = { platformOrderState: order.order_state, inComplaint: order.in_complaint };
  if (order.order_state === 5 || order.in_complaint) return { ...result, decision: 'conflict' };
  const shipping = order.shipping === undefined ? undefined : object(order.shipping);
  if (!shipping) return { ...result, decision: order.order_state === 1 ? 'not_uploaded' : 'conflict' };
  const parcels = shipping.shipping_list;
  if (order.order_state === 1 && shipping.finish_shipping === false && shipping.finish_shipping_count === 0
    && Array.isArray(parcels) && parcels.length === 0) return { ...result, decision: 'not_uploaded' };
  if (shipping.delivery_mode !== 1 || shipping.logistics_type !== 1 || shipping.finish_shipping !== true
    || !Number.isInteger(shipping.finish_shipping_count) || Number(shipping.finish_shipping_count) < 1
    || Number(shipping.finish_shipping_count) > 2 || !Array.isArray(parcels) || parcels.length !== 1
    || order.order_state === 1) return { ...result, decision: 'conflict' };
  const uploaded = object(parcels[0]);
  if (uploaded.tracking_no !== parcel.trackingNumber || uploaded.express_company !== parcel.carrierCode
    || (uploaded.goods_desc !== undefined && uploaded.goods_desc !== parcel.description))
    return { ...result, decision: 'conflict' };
  return { ...result, decision: 'matched' };
}

export type ShippingCapability = 'shipping.query' | 'shipping.upload';
const deny = () => fail('WECHAT_SHIPPING_OUTBOUND_NOT_AUTHORIZED', 503);
/** Outbound access is denied unless explicitly supplied by the composition
 * root. No live credentials/configuration are installed by this module. */
export class WechatOrderShippingClient {
  constructor(private readonly accessToken: () => Promise<string>,
    private readonly authorize: (capability: ShippingCapability, binding: ShippingBinding) => void = deny,
    private readonly fetcher: typeof fetch = fetch) {}

  private async call(path: 'get_order' | 'upload_shipping_info', payload: unknown,
    binding: ShippingBinding): Promise<JsonObject> {
    const capability = path === 'get_order' ? 'shipping.query' : 'shipping.upload';
    this.authorize(capability, binding);
    let token: string;
    try { token = await this.accessToken(); } catch { fail('WECHAT_SHIPPING_TOKEN_UNAVAILABLE', 503); }
    if (!text(token, 4096)) fail('WECHAT_SHIPPING_TOKEN_UNAVAILABLE', 503);
    // Recheck a revocable/expiring grant after token acquisition, before send.
    this.authorize(capability, binding);
    try {
      const response = await this.fetcher(`https://api.weixin.qq.com/wxa/sec/order/${path}?access_token=${encodeURIComponent(token)}`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
          redirect: 'error', signal: dependencySignal(15000) });
      const body = await boundedWechatJson<JsonObject>(response);
      // Error 10060023 (unchanged) is not proof that OUR parcel was recorded.
      if (body.errcode !== 0) fail('WECHAT_SHIPPING_PROVIDER_REJECTED', 502);
      return body;
    } catch {
      // Fetch errors can contain access-token URLs. Never expose them or an
      // upstream errmsg. A failed upload has an UNKNOWN external outcome.
      fail(path === 'get_order' ? 'WECHAT_SHIPPING_QUERY_UNAVAILABLE' : 'WECHAT_SHIPPING_UPLOAD_OUTCOME_UNKNOWN', 503);
    }
  }

  async query(binding: ShippingBinding, parcel: UnifiedParcel): Promise<ShippingObservation> {
    validateShippingBinding(binding); validateParcel(parcel);
    const body = await this.call('get_order', { transaction_id: binding.transactionId,
      merchant_id: binding.merchantId, merchant_trade_no: binding.merchantOrderNumber }, binding);
    return shippingObservation(body.order, binding, parcel);
  }

  /** One upload attempt only. The caller durably records dispatch BEFORE
   * calling; all retries after this point must QUERY, including after a crash.
   * Re-uploading can consume WeChat's single permitted re-shipping opportunity. */
  async uploadOnce(binding: ShippingBinding, parcel: UnifiedParcel, persistedUploadTime: string): Promise<{ acknowledged: true }> {
    const payload = unifiedShippingPayload(binding, parcel, persistedUploadTime);
    await this.call('upload_shipping_info', payload, binding);
    return { acknowledged: true }; // Never interpret this as received/delivered.
  }
}

export type ShippingSyncState = 'prepared' | 'dispatching' | 'verifying' | 'synced' | 'manual_review';
/** Only read-only query retries are automatic after dispatch, even when a
 * lagging query reports no shipment. A new upload requires an explicit review. */
export function shippingSyncAction(state: ShippingSyncState, queryAttempts: number,
  observation?: ShippingObservation): { state: ShippingSyncState; action: 'upload_once' | 'query' | 'none' } {
  if (!Number.isSafeInteger(queryAttempts) || queryAttempts < 0) fail('WECHAT_SHIPPING_ATTEMPT_INVALID');
  if (state === 'synced' || state === 'manual_review') return { state, action: 'none' };
  if (observation?.decision === 'matched') return { state: 'synced', action: 'none' };
  if (observation?.decision === 'conflict' || queryAttempts >= 5) return { state: 'manual_review', action: 'none' };
  if (state === 'prepared' && observation?.decision === 'not_uploaded') return { state: 'dispatching', action: 'upload_once' };
  return { state: state === 'prepared' ? 'prepared' : 'verifying', action: 'query' };
}
