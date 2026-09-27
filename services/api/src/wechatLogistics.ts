import { DomainError } from '@cisme/domain';
import { boundedWechatJson } from './boundedWechatJson.js';
import { dependencySignal } from './operationBudget.js';
import { validateShippingBinding, type ShippingBinding } from './wechatOrderShipping.js';

// PRD §8.2 / ORD-03. Read-only logistics observations never settle an order,
// release commission, acknowledge receipt or create a paid logistics order.
export type LogisticsCapability = 'logistics.accounts.read' | 'logistics.tracking.read';
export type LogisticsBinding = ShippingBinding & { appId:string };
export type LogisticsEventState = 'collected'|'collect_failed'|'assigned'|'in_transit'|'out_for_delivery'|'delivered'|'delivery_failed'|'cancelled'|'held'|'unknown';
export type LogisticsTrack = { observedAt:string; events:Array<{time:string;code:number;state:LogisticsEventState;message:string}> };
type ObjectValue = Record<string, unknown>;
function fail(code:string, status=502):never {
  throw new DomainError(code,'物流轨迹暂时无法核验，请稍后重试或通过订单联系客服',status);
}
function object(raw:unknown):ObjectValue {
  if(!raw||typeof raw!=='object'||Array.isArray(raw))fail('LOGISTICS_RESPONSE_INVALID');
  return raw as ObjectValue;
}
function text(value:unknown,max:number):value is string {
  return typeof value==='string'&&value.length>0&&value===value.trim()
    &&Buffer.byteLength(value)<=max&&!/[\u0000-\u001f\u007f]/.test(value);
}
const states:Record<number,LogisticsEventState>={100001:'collected',100002:'collect_failed',100003:'assigned',
  200001:'in_transit',300002:'out_for_delivery',300003:'delivered',300004:'delivery_failed',400001:'cancelled',400002:'held'};
function checkParcel(carrierCode:string,trackingNumber:string) {
  if(!/^[A-Z0-9_]{2,32}$/.test(carrierCode)||!/^[A-Za-z0-9-]{6,64}$/.test(trackingNumber))fail('LOGISTICS_PARCEL_INVALID',422);
}
/** Strict response binding prevents another waybill or OpenID leaking into a
 * member's view. An unknown action code stays unknown, even if its text says
 * "delivered". Messages are owner-only transient text, never written to logs. */
export function logisticsTrack(raw:unknown,binding:ShippingBinding,carrierCode:string,trackingNumber:string,now=Date.now()):LogisticsTrack {
  validateShippingBinding(binding);checkParcel(carrierCode,trackingNumber);
  const body=object(raw);
  if(body.openid!==binding.payerOpenid||body.delivery_id!==carrierCode||body.waybill_id!==trackingNumber)
    fail('LOGISTICS_RESPONSE_BINDING_MISMATCH');
  if(!Array.isArray(body.path_item_list)||body.path_item_list.length>100||body.path_item_num!==body.path_item_list.length)
    fail('LOGISTICS_RESPONSE_INVALID');
  const events=body.path_item_list.map(rawEvent=>{
    const item=object(rawEvent);
    if(!Number.isSafeInteger(item.action_time)||Number(item.action_time)<=0||Number(item.action_time)*1000>now+300_000
      ||!Number.isSafeInteger(item.action_type)||Number(item.action_type)<=0||!text(item.action_msg,2000))fail('LOGISTICS_RESPONSE_INVALID');
    return {time:new Date(Number(item.action_time)*1000).toISOString(),code:Number(item.action_type),
      state:states[Number(item.action_type)]??'unknown',message:item.action_msg};
  });
  // Stable newest-first order; same-time events retain the provider's ordering.
  events.sort((a,b)=>Date.parse(b.time)-Date.parse(a.time));
  return {observedAt:new Date(now).toISOString(),events};
}

const deny=()=>fail('LOGISTICS_OUTBOUND_NOT_AUTHORIZED',503);
export class WechatLogisticsClient {
  constructor(private token:()=>Promise<string>,
    private authorize:(capability:LogisticsCapability,binding?:LogisticsBinding)=>void=deny,
    private fetcher:typeof fetch=fetch) {}
  private async call(path:'account/getall'|'delivery/getall'|'path/get',binding?:LogisticsBinding,payload?:unknown) {
    const capability:LogisticsCapability=path==='path/get'?'logistics.tracking.read':'logistics.accounts.read';
    this.authorize(capability,binding);
    let token:string;
    try{token=await this.token();}catch{fail('LOGISTICS_TOKEN_UNAVAILABLE',503);}
    if(!text(token,4096))fail('LOGISTICS_TOKEN_UNAVAILABLE',503);
    this.authorize(capability,binding); // Revocation while obtaining token wins.
    try{
      const response=await this.fetcher(`https://api.weixin.qq.com/cgi-bin/express/business/${path}?access_token=${encodeURIComponent(token)}`,{
        method:payload===undefined?'GET':'POST',redirect:'error',signal:dependencySignal(15000),
        ...(payload===undefined?{}:{headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)})});
      const body=await boundedWechatJson<ObjectValue>(response);
      // Official successful examples omit errcode. Wrong-typed or nonzero error
      // codes are never accepted; each success is additionally schema-checked.
      if(body.errcode!==undefined&&body.errcode!==0)fail('LOGISTICS_PROVIDER_REJECTED');
      return body;
    }catch{fail('LOGISTICS_QUERY_UNAVAILABLE',503);} // Never expose token URLs or upstream messages.
  }
  async query(binding:LogisticsBinding,carrierCode:string,trackingNumber:string):Promise<LogisticsTrack> {
    validateShippingBinding(binding);checkParcel(carrierCode,trackingNumber);
    if(!/^wx[a-f0-9]{16}$/.test(binding.appId))fail('LOGISTICS_APP_BINDING_INVALID',422);
    const body=await this.call('path/get',binding,{openid:binding.payerOpenid,delivery_id:carrierCode,waybill_id:trackingNumber});
    return logisticsTrack(body,binding,carrierCode,trackingNumber);
  }
  async capabilities() {
    const accounts=await this.call('account/getall'),carriers=await this.call('delivery/getall');
    if(!Array.isArray(accounts.list)||accounts.list.length>200||accounts.count!==accounts.list.length
      ||!Array.isArray(carriers.data)||carriers.data.length>200||carriers.count!==carriers.data.length)fail('LOGISTICS_RESPONSE_INVALID');
    return {observedAt:new Date().toISOString(),accounts:accounts.list.map(raw=>{
      const item=object(raw);
      if(!text(item.delivery_id,32)||!Number.isSafeInteger(item.status_code)
        ||item.quota_num!==undefined&&(!Number.isSafeInteger(item.quota_num)||Number(item.quota_num)<0))fail('LOGISTICS_RESPONSE_INVALID');
      // Do not expose biz_id, aliases, application remarks or provider errors.
      // Preserve raw status code: its meaning must be verified in this account.
      return {carrierCode:item.delivery_id,bindingStatusCode:Number(item.status_code),
        quotaAvailable:item.quota_num===undefined?null:Number(item.quota_num)>0};
    }),carriers:carriers.data.map(raw=>{
      const item=object(raw);
      if(!text(item.delivery_id,32)||!text(item.delivery_name,240)
        ||item.can_use_cash!==undefined&&item.can_use_cash!==0&&item.can_use_cash!==1)fail('LOGISTICS_RESPONSE_INVALID');
      return {carrierCode:item.delivery_id,name:item.delivery_name,cashOrdersSupported:item.can_use_cash===undefined?null:item.can_use_cash===1};
    })};
  }
}
