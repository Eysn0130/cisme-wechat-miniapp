import {DomainError} from '@cisme/domain';
import {boundedWechatJson} from './boundedWechatJson.js';
import {dependencySignal} from './operationBudget.js';
import {validateShippingBinding} from './wechatOrderShipping.js';
import type {LogisticsBinding} from './wechatLogistics.js';

export type LogisticsQueryCapability='logistics.query.register';
export type QueryGoods={goods_name:string;goods_img_url:string};
export type QueryRegistration={binding:LogisticsBinding;carrierCode:string;trackingNumber:string;receiverPhone:string;goods:QueryGoods[];orderDetailPath:string};
export interface LogisticsQueryChannel {
  assertReady(binding:LogisticsBinding):Promise<void>;
  register(input:QueryRegistration):Promise<string>;
}
export class LogisticsRegistrationRejected extends DomainError {
  constructor(readonly providerCode:number){super('LOGISTICS_QUERY_REJECTED','微信暂时不能提供物流详情，请复制运单号查询或联系客服',503);}
}
export function validQueryToken(value:unknown):value is string{return typeof value==='string'&&value.length>=20&&value.length<=4096&&!/[\s\u0000-\u001f\u007f]/.test(value);}
function unavailable():never{throw new DomainError('LOGISTICS_QUERY_NOT_READY','物流详情暂未开通，可以复制运单号查询或联系客服',503);}
/** Official logistics QUERY component, separate from electronic-waybill creation.
 * It registers only an existing paid order's parcel. No courier account,
 * shipment purchase, notification subscription or payment is created here. */
export class WechatLogisticsQueryClient implements LogisticsQueryChannel {
  private readyUntil=0;
  constructor(private token:()=>Promise<string>,private authorize:(cap:LogisticsQueryCapability,binding:LogisticsBinding)=>void,private fetcher:typeof fetch=fetch){}
  private async call(path:'get_delivery_list'|'trace_waybill',binding:LogisticsBinding,payload:unknown){
    this.authorize('logistics.query.register',binding);
    const token=await this.token();this.authorize('logistics.query.register',binding);
    if(typeof token!=='string'||!token||token.length>4096)unavailable();
    let body:Record<string,unknown>;
    try{body=await boundedWechatJson<Record<string,unknown>>(await this.fetcher(`https://api.weixin.qq.com/cgi-bin/express/delivery/open_msg/${path}?access_token=${encodeURIComponent(token)}`,{
      method:'POST',redirect:'error',signal:dependencySignal(15000),headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)}));}
    catch{throw new DomainError('LOGISTICS_QUERY_OUTCOME_UNKNOWN','物流详情请求尚未确认，请保留运单并联系客服核对',503);}
    if(body.errcode!==undefined&&body.errcode!==0){
      if(!Number.isSafeInteger(body.errcode))throw new DomainError('LOGISTICS_QUERY_OUTCOME_UNKNOWN','物流详情请求尚未确认，请稍后核对',503);
      throw new LogisticsRegistrationRejected(Number(body.errcode));
    }
    this.authorize('logistics.query.register',binding);return body;
  }
  async assertReady(binding:LogisticsBinding){
    validateShippingBinding(binding);this.authorize('logistics.query.register',binding);
    if(this.readyUntil>Date.now())return;
    try{await this.call('get_delivery_list',binding,{});this.readyUntil=Date.now()+60_000;}
    catch{unavailable();}
  }
  async register(input:QueryRegistration){
    validateShippingBinding(input.binding);
    if(!/^wx[a-zA-Z0-9]{16}$/.test(input.binding.appId)||!/^[A-Z0-9_]{2,32}$/.test(input.carrierCode)||!/^[A-Za-z0-9-]{6,64}$/.test(input.trackingNumber)
      ||!/^[+0-9 -]{6,32}$/.test(input.receiverPhone)||!input.goods.length||input.goods.length>10||input.goods.some(g=>!g.goods_name||Array.from(g.goods_name).length>60||!g.goods_img_url.startsWith('https://'))
      ||!/^pages\/order-detail\/index\?id=[a-f0-9-]{36}$/.test(input.orderDetailPath))throw new DomainError('LOGISTICS_QUERY_INPUT_INVALID','物流信息需要核对',422);
    const body=await this.call('trace_waybill',input.binding,{openid:input.binding.payerOpenid,receiver_phone:input.receiverPhone,
      waybill_id:input.trackingNumber,delivery_id:input.carrierCode,trans_id:input.binding.transactionId,goods_info:{detail_list:input.goods},order_detail_path:input.orderDetailPath});
    if(!validQueryToken(body.waybill_token))throw new DomainError('LOGISTICS_QUERY_OUTCOME_UNKNOWN','物流详情请求尚未确认，请联系客服核对',503);
    return body.waybill_token;
  }
}
