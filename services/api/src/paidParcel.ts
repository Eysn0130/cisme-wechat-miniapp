import {DomainError} from '@cisme/domain';
import {requireActiveMemberWithClient} from './authority.js';
import type {DbClient} from './db.js';
import type {DeliveryAddressService} from './deliveryAddress.js';
import type {ShippingSyncService} from './shippingSync.js';
import {validateShippingBinding} from './wechatOrderShipping.js';
import type {QueryRegistration} from './wechatLogisticsQuery.js';
export type PaidParcelOptions={appId:string;merchantId:string;imageUrl:(code:string)=>string};
export type PaidParcel={owner:string;shipmentId:string;registration:QueryRegistration};
function fail(code:string,status=409):never{throw new DomainError(code,'物流信息需要核对，请通过原订单联系客服',status);}
/** Exact own paid parcel, shared by buyer query and future-shipment notifications.
 * No gift claims, guessed transaction IDs, mutable address-book or operator OpenID. */
export class PaidParcelSource {
  constructor(private addresses:DeliveryAddressService,private sync:ShippingSyncService,private options:PaidParcelOptions){}
  async read(client:DbClient,actor:string|undefined,orderId:string):Promise<PaidParcel>{
    const owner=await requireActiveMemberWithClient(client,actor);
    const order=(await client.query(`SELECT id,order_number,status,transaction_source_kind FROM commerce_order WHERE id=$1 AND member_id=$2`,[orderId,owner])).rows[0];
    if(!order)fail('ORDER_NOT_FOUND',404);
    if(order.status!=='paid'||order.transaction_source_kind!=='verified_commerce')fail('LOGISTICS_PAYMENT_BINDING_REQUIRED');
    const shipment=(await client.query('SELECT id,shipping_sync_id FROM commerce_shipment WHERE order_id=$1',[orderId])).rows[0];
    if(!shipment)fail('SHIPMENT_NOT_FOUND',404);
    const payments=(await client.query(`SELECT p.app_id,p.merchant_id,p.payer_openid,p.out_trade_no,
      i.provider_transaction_id,i.payer_total_cents FROM commerce_payment_attempt p
      JOIN commission_payment_inbox i ON i.order_id=p.order_id AND i.app_id=p.app_id AND i.merchant_id=p.merchant_id
      WHERE p.order_id=$1 AND p.state='paid' AND i.state='applied' AND i.composition_status='full_cash'`,[orderId])).rows;
    if(payments.length!==1||payments[0].out_trade_no!==order.order_number
      ||payments[0].app_id!==this.options.appId||payments[0].merchant_id!==this.options.merchantId)fail('LOGISTICS_PAYMENT_BINDING_REQUIRED');
    const paid=payments[0],binding={appId:paid.app_id,merchantId:paid.merchant_id,merchantOrderNumber:paid.out_trade_no,
      transactionId:paid.provider_transaction_id,payerOpenid:paid.payer_openid,payerTotalCents:Number(paid.payer_total_cents)};
    validateShippingBinding(binding);
    const address=(await client.query('SELECT encrypted_payload,payload_hmac,key_version FROM commerce_order_address WHERE order_id=$1',[orderId])).rows[0];
    if(!address)fail('SHIPMENT_ADDRESS_REQUIRED');
    const opened=this.addresses.openOrderSnapshot(owner,orderId,address.encrypted_payload,address.payload_hmac,address.key_version);
    const parcel=await this.sync.parcelWithClient(client,shipment.shipping_sync_id);
    const lines=(await client.query('SELECT product_code,product_name FROM commerce_order_line WHERE order_id=$1 ORDER BY line_number',[orderId])).rows;
    if(!lines.length||lines.length>10)fail('LOGISTICS_GOODS_REQUIRED');
    return {owner,shipmentId:shipment.id,registration:{binding,carrierCode:parcel.carrierCode,trackingNumber:parcel.trackingNumber,
      receiverPhone:opened.phone,goods:lines.map(line=>({goods_name:Array.from(String(line.product_name)).slice(0,60).join(''),
        goods_img_url:this.options.imageUrl(line.product_code)})),orderDetailPath:`pages/order-detail/index?id=${orderId}`}};
  }
}
