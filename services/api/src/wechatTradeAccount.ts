import { DomainError } from '@cisme/domain';
import { boundedWechatJson } from './boundedWechatJson.js';
import { dependencySignal } from './operationBudget.js';
import { queryShippingAccountReadiness } from './wechatOrderShipping.js';

export const WECHAT_ORDER_DETAIL_PATH='pages/order-detail/index?outTradeNo=${商品订单号}&source=wechat_order';
export const WECHAT_SHIPPING_MESSAGE_PATH='pages/order-detail/index?source=wechat_shipping';
const denied=():never=>{throw new DomainError('WECHAT_TRADE_CONFIGURATION_NOT_AUTHORIZED','微信交易配置尚未授权',503);};

/** Fixed official hosts and paths; no token, raw response or user identity in
 * diagnostics. Path writes are separate from read-only shipping permission. */
export class WechatTradeAccountClient {
  constructor(private appId:string,private token:()=>Promise<string>,private authorize:()=>void=denied,
    private fetcher:typeof fetch=fetch,private authorizeConfiguration:()=>void=denied){}
  private async call(operation:string,payload:unknown,write=false){
    const authorize=write?this.authorizeConfiguration:this.authorize;
    authorize();const token=await this.token();authorize();
    if(!token||token.length>4096)throw Error('WECHAT_TOKEN_UNAVAILABLE');
    const response=await this.fetcher(`https://api.weixin.qq.com/wxa/sec/order/${operation}?access_token=${encodeURIComponent(token)}`,{
      method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload),
      redirect:'error',signal:dependencySignal(15000)});
    const body=await boundedWechatJson<Record<string,unknown>>(response);
    return {httpStatus:response.status,errcode:typeof body.errcode==='number'?body.errcode:null,
      ok:response.ok&&body.errcode===0,body};
  }
  async read(){
    const shipping=await queryShippingAccountReadiness(this.appId,this.token,this.authorize,this.fetcher);
    let orderDetailPath:string|null=null,pathVerified=false,pathCheck:{httpStatus:number|null;errcode:number|null}={httpStatus:null,errcode:null};
    try{const result=await this.call('get_order_detail_path',{});pathCheck={httpStatus:result.httpStatus,errcode:result.errcode};
      if(result.ok&&typeof result.body.path==='string'&&result.body.path.length<=1024){orderDetailPath=result.body.path;pathVerified=true;}}
    catch{/* UNKNOWN is distinct from an empty, successfully read path. */}
    return {appId:this.appId,observedAt:new Date().toISOString(),...shipping,orderDetailPath,pathVerified,pathCheck,
      expectedOrderDetailPath:WECHAT_ORDER_DETAIL_PATH,paymentPermissionVerified:false as const};
  }
  /** Invoke only after the resolver is PUBLISHED and the operator has completed
   * the platform agreement. A local source build cannot authorize this write. */
  async configurePublishedPaths(publishedVersion:string){
    if(!/^\d+\.\d+\.\d+$/.test(publishedVersion))throw new DomainError('PUBLISHED_CLIENT_REQUIRED','请先核对已发布的小程序版本',422);
    const detail=await this.call('update_order_detail_path',{path:WECHAT_ORDER_DETAIL_PATH},true);
    if(!detail.ok)return {publishedVersion,detailConfigured:false,messageConfigured:false,errcode:detail.errcode};
    const message=await this.call('set_msg_jump_path',{path:WECHAT_SHIPPING_MESSAGE_PATH},true);
    const observed=await this.read();
    return {publishedVersion,detailConfigured:observed.pathVerified&&observed.orderDetailPath===WECHAT_ORDER_DETAIL_PATH,
      messageConfigured:message.ok,errcode:message.errcode,observed};
  }
}
