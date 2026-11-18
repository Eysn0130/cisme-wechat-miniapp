import {DomainError} from '@cisme/domain';
import {boundedWechatJson} from './boundedWechatJson.js';
import {dependencySignal} from './operationBudget.js';
import {validateShippingBinding} from './wechatOrderShipping.js';
import type {LogisticsBinding} from './wechatLogistics.js';

export type LogisticsQueryCapability='logistics.query.register';
export type LogisticsMessageCapability='logistics.message.register';
export type QueryGoods={goods_name:string;goods_img_url:string};
export type QueryRegistration={binding:LogisticsBinding;carrierCode:string;trackingNumber:string;receiverPhone:string;goods:QueryGoods[];orderDetailPath:string};
export type LogisticsAuthorityBinding=Pick<LogisticsBinding,'appId'|'merchantId'>&Partial<Pick<LogisticsBinding,'merchantOrderNumber'>>;
export type LogisticsCarrier={id:string;name:string};
export interface LogisticsQueryChannel {
  assertReady(binding:LogisticsBinding):Promise<void>;
  register(input:QueryRegistration):Promise<string>;
  carriers?(binding:LogisticsAuthorityBinding):Promise<LogisticsCarrier[]>;
}
export class LogisticsRegistrationRejected extends DomainError {
  constructor(readonly providerCode:number){super('LOGISTICS_QUERY_REJECTED','微信暂时不能提供物流详情，请复制运单号查询或联系客服',503);}
}
export function validQueryToken(value:unknown):value is string{return typeof value==='string'&&value.length>=20&&value.length<=4096&&!/[\s\u0000-\u001f\u007f]/.test(value);}
function unavailable():never{throw new DomainError('LOGISTICS_QUERY_NOT_READY','暂时无法查看物流，可复制运单号查询或联系客服',503);}
/** Official logistics QUERY component, separate from electronic-waybill creation.
 * It registers only an existing paid order's parcel. No courier account,
 * shipment purchase, notification subscription or payment is created here. */
export class WechatLogisticsQueryClient implements LogisticsQueryChannel {
  private readyUntil=0;
  private carrierOptions:LogisticsCarrier[]=[];
  constructor(private token:()=>Promise<string>,private authorize:(cap:LogisticsQueryCapability|LogisticsMessageCapability,binding:LogisticsAuthorityBinding)=>void,private fetcher:typeof fetch=fetch,private mode:'query'|'message'='query',private invalidateToken:()=>void=()=>{}){}
  private get capability():LogisticsQueryCapability|LogisticsMessageCapability{return this.mode==='query'?'logistics.query.register':'logistics.message.register';}
  private async call(path:'get_delivery_list'|'trace_waybill'|'follow_waybill',binding:LogisticsAuthorityBinding,payload:unknown){
    let token:string;
    try{this.authorize(this.capability,binding);token=await this.token();this.authorize(this.capability,binding);
      if(typeof token!=='string'||!token||token.length>4096)unavailable();}
    catch(error){if(this.mode==='message')throw new DomainError('LOGISTICS_MESSAGE_NOT_DISPATCHED','物流消息尚未登记，将稍后重试',503);throw error;}
    let body:Record<string,unknown>;
    try{body=await boundedWechatJson<Record<string,unknown>>(await this.fetcher(`https://api.weixin.qq.com/cgi-bin/express/delivery/open_msg/${path}?access_token=${encodeURIComponent(token)}`,{
      method:'POST',redirect:'error',signal:dependencySignal(15000),headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)}));}
    catch{throw new DomainError('LOGISTICS_QUERY_OUTCOME_UNKNOWN','物流详情请求尚未确认，请保留运单并联系客服核对',503);}
    if(body.errcode!==undefined&&body.errcode!==0){
      if(!Number.isSafeInteger(body.errcode))throw new DomainError('LOGISTICS_QUERY_OUTCOME_UNKNOWN','物流详情请求尚未确认，请稍后核对',503);
      if(body.errcode===40001||body.errcode===42001)this.invalidateToken();
      throw new LogisticsRegistrationRejected(Number(body.errcode));
    }
    this.authorize(this.capability,binding);return body;
  }
  async assertReady(binding:LogisticsBinding){
    validateShippingBinding(binding);this.authorize(this.capability,binding);
    await this.carriers(binding);
  }
  /** Official query/message carrier metadata; never an electronic-waybill
   * account lookup, parcel registration or customer notification. */
  async carriers(binding:LogisticsAuthorityBinding){
    this.authorize(this.capability,binding);
    if(this.readyUntil>Date.now()&&this.carrierOptions.length)return this.carrierOptions.map(row=>({...row}));
    try{const body=await this.call('get_delivery_list',binding,{});
      if(!Array.isArray(body.delivery_list)||!body.delivery_list.length||body.delivery_list.length>5000
        ||body.delivery_list.some(x=>!x||typeof x!=='object'||typeof x.delivery_id!=='string'||!x.delivery_id||x.delivery_id.length>80)
        ||body.count!==undefined&&body.count!==body.delivery_list.length)unavailable();
      const seen=new Set<string>();
      this.carrierOptions=(body.delivery_list as Array<{delivery_id:string;delivery_name?:unknown}>).map(row=>{
        if(!/^[A-Z0-9_]{2,32}$/.test(row.delivery_id)||seen.has(row.delivery_id))unavailable();seen.add(row.delivery_id);
        const name=typeof row.delivery_name==='string'?row.delivery_name.trim():row.delivery_id;
        if(!name||Array.from(name).length>80||/[\u0000-\u001f\u007f]/.test(name))unavailable();
        return {id:row.delivery_id,name};
      });
      this.readyUntil=Date.now()+60_000;return this.carrierOptions.map(row=>({...row}));}
    catch{unavailable();}
  }
  async register(input:QueryRegistration){
    validateShippingBinding(input.binding);
    if(!/^wx[a-zA-Z0-9]{16}$/.test(input.binding.appId)||!/^[A-Z0-9_]{2,32}$/.test(input.carrierCode)||!/^[A-Za-z0-9-]{6,64}$/.test(input.trackingNumber)
      ||!/^[+0-9 -]{6,32}$/.test(input.receiverPhone)||!input.goods.length||input.goods.length>10||input.goods.some(g=>!g.goods_name||Array.from(g.goods_name).length>60||!g.goods_img_url.startsWith('https://'))
      ||!/^pages\/order-detail\/index\?id=[a-f0-9-]{36}$/.test(input.orderDetailPath))throw new DomainError('LOGISTICS_QUERY_INPUT_INVALID','物流信息需要核对',422);
    const body=await this.call(this.mode==='query'?'trace_waybill':'follow_waybill',input.binding,{openid:input.binding.payerOpenid,receiver_phone:input.receiverPhone,
      waybill_id:input.trackingNumber,delivery_id:input.carrierCode,trans_id:input.binding.transactionId,goods_info:{detail_list:input.goods},order_detail_path:input.orderDetailPath});
    if(!validQueryToken(body.waybill_token))throw new DomainError('LOGISTICS_QUERY_OUTCOME_UNKNOWN','物流详情请求尚未确认，请联系客服核对',503);
    return body.waybill_token;
  }
}
/** Free official logistics messages for the actual buyer of an existing paid
 * order. Does not request a subscription or claim that a message was delivered. */
export class WechatLogisticsMessageClient extends WechatLogisticsQueryClient {
  constructor(token:()=>Promise<string>,authorize:(cap:LogisticsQueryCapability|LogisticsMessageCapability,binding:LogisticsAuthorityBinding)=>void,fetcher:typeof fetch=fetch,invalidateToken:()=>void=()=>{}){super(token,authorize,fetcher,'message',invalidateToken);}
}
