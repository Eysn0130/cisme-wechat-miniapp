import type { AppConfig } from '@cisme/config';
import { DomainError } from '@cisme/domain';
import { protectedText, recoveryTransport, type RecoveryCapability } from './formalPaymentAuthorization.js';

export type CommerceCapability = 'order.create' | 'payment.prepare' | 'payment.close' | 'refund.request' | 'refund.approve' | 'refund.submit';
const capabilities: readonly string[] = ['order.create','payment.prepare','payment.close','refund.request','refund.approve','refund.submit'];
type Profile = NonNullable<AppConfig['commerce']['formalProtocol']>;
function denied(): never { throw new DomainError('FORMAL_COMMERCE_NOT_AUTHORIZED','该正式交易操作尚未授权',503); }
/** Runtime consumers reread exact-environment approval on every command. Merely
 * configuring merchant credentials or a recovery grant never enables commerce. */
export function commerceAuthorization(config:AppConfig,profile:Profile,now=()=>Date.now()) {
  const read=()=>{
    if(!profile.commerceAuthorizationFile)denied();
    let grant:Record<string,unknown>;
    try{grant=JSON.parse(protectedText(profile.commerceAuthorizationFile));}catch{denied();}
    if(!grant||grant.schemaVersion!==1||grant.mode!=='ordinary-merchant-commerce-commands'
      ||config.env!=='production'||grant.environment!==config.env
      ||grant.appId!==profile.appId||grant.merchantId!==profile.merchantId
      ||typeof grant.approvalReference!=='string'||!/^[-A-Za-z0-9_:.]{8,120}$/.test(grant.approvalReference)
      ||typeof grant.expiresAt!=='string'||!Number.isFinite(Date.parse(grant.expiresAt))||Date.parse(grant.expiresAt)<=now()
      ||!Array.isArray(grant.capabilities)||!grant.capabilities.length
      ||grant.capabilities.some(c=>typeof c!=='string'||!capabilities.includes(c))
      ||new Set(grant.capabilities).size!==grant.capabilities.length)denied();
    return grant;
  };
  if(profile.commerceAuthorizationFile)read();
  return (capability:CommerceCapability)=>{
    const grant=read();if(!(grant.capabilities as string[]).includes(capability))denied();
    return String(grant.approvalReference);
  };
}

/** Fixed ordinary-merchant endpoints only. No transfers, partner APIs, redirects
 * or catch-all POST authorization. Reads retain their independent recovery gate. */
export function commerceTransport(authorize:(capability:CommerceCapability)=>string,
  authorizeRecovery:(capability:RecoveryCapability)=>string):typeof fetch {
  const read=recoveryTransport(authorizeRecovery);
  return async(input,init)=>{
    const url=new URL(input instanceof Request?input.url:String(input));
    const method=(init?.method??(input instanceof Request?input.method:'GET')).toUpperCase();
    if(method==='GET')return read(input,init);
    let capability:CommerceCapability|undefined;
    if(method==='POST'&&url.protocol==='https:'&&url.hostname==='api.mch.weixin.qq.com'
      &&!url.username&&!url.password&&!url.hash&&!url.port&&!url.search){
      if(url.pathname==='/v3/pay/transactions/jsapi')capability='payment.prepare';
      else if(/^\/v3\/pay\/transactions\/out-trade-no\/[A-Za-z0-9_-]{6,32}\/close$/.test(url.pathname))capability='payment.close';
      else if(url.pathname==='/v3/refund/domestic/refunds')capability='refund.submit';
    }
    if(!capability)denied();
    const approvalReference=authorize(capability),started=Date.now();
    try{
      const response=await fetch(input,{...init,redirect:'error',signal:AbortSignal.any([AbortSignal.timeout(15000),...(init?.signal?[init.signal]:[])])});
      const raw=response.headers.get('Request-ID')??'';
      console.info(JSON.stringify({event:'formal_commerce_response',capability,approvalReference,status:response.status,
        requestId:/^[A-Za-z0-9_-]{16,128}$/.test(raw)?raw:null,elapsedMs:Date.now()-started}));
      return response;
    }catch(error){
      console.info(JSON.stringify({event:'formal_commerce_transport_unknown',capability,approvalReference,elapsedMs:Date.now()-started}));
      throw error;
    }
  };
}
