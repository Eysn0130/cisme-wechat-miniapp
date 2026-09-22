import { describe, expect, it, vi } from 'vitest';
import { shippingObservation, shippingSyncAction, unifiedShippingPayload, WechatOrderShippingClient,
  type ShippingBinding, type UnifiedParcel } from '../../services/api/src/wechatOrderShipping.js';

const binding: ShippingBinding = { merchantId: '1900000001', merchantOrderNumber: 'CM20260922TEST',
  transactionId: 'synthetic-transaction-0001', payerOpenid: 'synthetic-openid', payerTotalCents: 59800 };
const parcel: UnifiedParcel = { trackingNumber: 'SYNTHETIC0001', carrierCode: 'SF',
  description: 'CISME 护理套组 × 1', receiverContactMasked: '****1234' };
const uploadTime = '2026-09-22T08:00:00.000Z';
function observed(patch: Record<string, unknown> = {}) {
  return { transaction_id: binding.transactionId, merchant_id: binding.merchantId,
    merchant_trade_no: binding.merchantOrderNumber, openid: binding.payerOpenid,
    paid_amount: binding.payerTotalCents, order_state: 2, in_complaint: false,
    shipping: { delivery_mode: 1, logistics_type: 1, finish_shipping: true, finish_shipping_count: 1,
      shipping_list: [{ tracking_no: parcel.trackingNumber, express_company: parcel.carrierCode }] }, ...patch };
}

describe('WeChat shipping protocol: PRD §8.2 / WX-PAY-MAKE-01', () => {
  it('constructs a single physical parcel with the persisted timestamp and masked contact', () => {
    const payload = unifiedShippingPayload(binding, parcel, uploadTime);
    expect(payload).toMatchObject({ order_key: { order_number_type: 2, transaction_id: binding.transactionId },
      logistics_type: 1, delivery_mode: 1, upload_time: uploadTime, payer: { openid: binding.payerOpenid } });
    expect(payload.shipping_list).toHaveLength(1);
    expect(payload.shipping_list[0]?.contact?.receiver_contact).toBe('****1234');
    for (const receiverContactMasked of ['13800131234', '****123', '****1234\n']) {
      expect(() => unifiedShippingPayload(binding, { ...parcel, receiverContactMasked }, uploadTime)).toThrow();
    }
    const { receiverContactMasked: _contact, ...withoutContact } = parcel;
    expect(() => unifiedShippingPayload(binding, withoutContact, uploadTime)).toThrow();
    expect(() => unifiedShippingPayload(binding, { ...parcel, description: '字'.repeat(121) }, uploadTime)).toThrow();
    expect(() => unifiedShippingPayload(binding, parcel, '2026-02-30T00:00:00.000Z')).toThrow();
  });

  it.each(['transaction_id', 'merchant_id', 'merchant_trade_no', 'openid', 'paid_amount'])
    ('refuses a different %s even if the shipment looks identical', field => {
      expect(() => shippingObservation(observed({ [field]: 'wrong' }), binding, parcel))
        .toThrow('发货信息需核对');
    });

  it('does not confuse shipping synchronization with receipt, settlement, complaint or refund', () => {
    expect(shippingObservation(observed(), binding, parcel)).toEqual({ decision: 'matched', platformOrderState: 2, inComplaint: false });
    expect(shippingObservation(observed({ order_state: 5 }), binding, parcel).decision).toBe('conflict');
    expect(shippingObservation(observed({ in_complaint: true }), binding, parcel).decision).toBe('conflict');
    expect(shippingObservation(observed({ order_state: 1, shipping: undefined }), binding, parcel).decision).toBe('not_uploaded');
    expect(shippingObservation(observed({ order_state: 3, shipping: undefined }), binding, parcel).decision).toBe('conflict');
    const wrong = observed(); wrong.shipping.shipping_list[0]!.tracking_no = 'OTHER';
    expect(shippingObservation(wrong, binding, parcel).decision).toBe('conflict');
  });

  it('defaults to no outbound permission before acquiring credentials', async () => {
    const token = vi.fn(async () => 'synthetic-token'), transport = vi.fn();
    const client = new WechatOrderShippingClient(token, undefined, transport);
    await expect(client.query(binding, parcel)).rejects.toMatchObject({ code: 'WECHAT_SHIPPING_OUTBOUND_NOT_AUTHORIZED' });
    expect(token).not.toHaveBeenCalled(); expect(transport).not.toHaveBeenCalled();
  });

  it('checks expiry/revocation again after token acquisition', async () => {
    let active = true;
    const token = async () => { active = false; return 'synthetic-token'; };
    const authorize = () => { if (!active) throw Error('REVOKED'); }, transport = vi.fn();
    await expect(new WechatOrderShippingClient(token, authorize, transport).query(binding, parcel)).rejects.toThrow('REVOKED');
    expect(transport).not.toHaveBeenCalled();
  });

  it('uses only the fixed official endpoint, bounded response and no redirects', async () => {
    const transport = vi.fn(async () => new Response(JSON.stringify({ errcode: 0, order: observed() })));
    const client = new WechatOrderShippingClient(async () => 'synthetic-token', () => {}, transport);
    expect((await client.query(binding, parcel)).decision).toBe('matched');
    expect(transport.mock.calls[0]).toEqual([
      'https://api.weixin.qq.com/wxa/sec/order/get_order?access_token=synthetic-token',
      expect.objectContaining({ method: 'POST', redirect: 'error', signal: expect.any(AbortSignal) })
    ]);
  });

  it('never retries uploads or leaks token URLs on timeout, rejection or oversized response', async () => {
    const cases = [async () => { throw Error('https://api.weixin.qq.com/?access_token=SECRET'); },
      async () => new Response(JSON.stringify({ errcode: 10060023, errmsg: 'SECRET unchanged' })),
      async () => new Response(JSON.stringify({ errcode: 0, extra: 'x'.repeat(70_000) }))];
    for (const fetcher of cases) {
      const transport = vi.fn(fetcher);
      const client = new WechatOrderShippingClient(async () => 'SECRET', () => {}, transport);
      await expect(client.uploadOnce(binding, parcel, uploadTime)).rejects.toMatchObject({ code: 'WECHAT_SHIPPING_UPLOAD_OUTCOME_UNKNOWN' });
      expect(transport).toHaveBeenCalledTimes(1);
    }
  });

  it('queries after crash or uncertain outcome and never consumes re-shipping on an automatic retry', () => {
    const absent = { decision: 'not_uploaded' as const, platformOrderState: 1, inComplaint: false };
    expect(shippingSyncAction('prepared', 0)).toEqual({ state: 'prepared', action: 'query' });
    expect(shippingSyncAction('prepared', 1, absent)).toEqual({ state: 'dispatching', action: 'upload_once' });
    for (const state of ['dispatching', 'verifying'] as const) {
      for (let attempts = 0; attempts < 5; attempts++) expect(shippingSyncAction(state, attempts, absent).action).toBe('query');
      expect(shippingSyncAction(state, 5, absent)).toEqual({ state: 'manual_review', action: 'none' });
    }
    expect(shippingSyncAction('verifying', 3, { ...absent, decision: 'matched', platformOrderState: 2 }))
      .toEqual({ state: 'synced', action: 'none' });
    expect(shippingSyncAction('manual_review', 8, { ...absent, decision: 'matched' }).state).toBe('manual_review');
  });
});
