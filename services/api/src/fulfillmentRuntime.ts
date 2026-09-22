import { createHmac } from 'node:crypto';
import type pg from 'pg';
import type { AppConfig } from '@cisme/config';
import { DomainError } from '@cisme/domain';
import { protectedText } from './formalPaymentAuthorization.js';
import { boundedWechatJson } from './boundedWechatJson.js';
import { dependencySignal } from './operationBudget.js';
import { AuthorityService } from './authority.js';
import { DeliveryAddressService } from './deliveryAddress.js';
import { OrderFulfillmentService } from './orderFulfillment.js';
import { ShippingSyncService } from './shippingSync.js';
import { WechatOrderShippingClient, type ShippingBinding, type ShippingCapability } from './wechatOrderShipping.js';

function denied():never{throw new DomainError('SHIPPING_OUTBOUND_NOT_AUTHORIZED','微信发货同步权限待核验，本地发货记录已保留',503);}
export function shippingAuthorization(config:AppConfig,now=()=>Date.now()){
  const profile=config.commerce.fulfillment;
  const read=()=>{
    if(!profile?.authorizationFile)denied();
    let grant:Record<string,unknown>;
    try{grant=JSON.parse(protectedText(profile.authorizationFile));}catch{denied();}
    if(!grant||grant.schemaVersion!==1||grant.mode!=='wechat-shipping-sync'
      || !['staging','production'].includes(config.env)||grant.environment!==config.env
      || grant.appId!==profile.appId||grant.merchantId!==profile.merchantId
      || typeof grant.approvalReference!=='string'||!/^[-A-Za-z0-9_:.]{8,120}$/.test(grant.approvalReference)
      || typeof grant.expiresAt!=='string'||!Number.isFinite(Date.parse(grant.expiresAt))||Date.parse(grant.expiresAt)<=now()
      || !Array.isArray(grant.capabilities)||!grant.capabilities.length
      || grant.capabilities.some(x=>!['shipping.query','shipping.upload'].includes(String(x)))
      || new Set(grant.capabilities).size!==grant.capabilities.length
      || (config.env==='staging'&&(grant.dataScope!=='isolated-test-only'||!Array.isArray(grant.orderNumbers)
        || !grant.orderNumbers.length||grant.orderNumbers.length>100||grant.orderNumbers.some(x=>typeof x!=='string'||!/^[A-Za-z0-9_*-]{1,32}$/.test(x)))))denied();
    return grant;
  };
  if(profile?.authorizationFile)read();
  return (capability:ShippingCapability,binding?:ShippingBinding)=>{
    const grant=read();
    if(!(grant.capabilities as string[]).includes(capability)||binding&&binding.merchantId!==profile!.merchantId
      || binding&&config.env==='staging'&&!(grant.orderNumbers as string[]).includes(binding.merchantOrderNumber))denied();
    return String(grant.approvalReference);
  };
}

/** Configuration enables only local records; the protected, revocable grant
 * separately controls network I/O. There is no fallback public/provider URL. */
export function fulfillmentRuntime(config:AppConfig,pool:pg.Pool,
  testChannel?:Pick<WechatOrderShippingClient,'query'|'uploadOnce'>){
  const profile=config.commerce.fulfillment;if(!profile)return undefined;
  if(testChannel&&config.env!=='test')throw new Error('FAIL_CLOSED:SHIPPING_TEST_TRANSPORT_ONLY');
  const authorize=shippingAuthorization(config);
  let cached:{value:string;expiresAt:number}|undefined;
  const token=async()=>{
    if(cached&&cached.expiresAt>Date.now())return cached.value;
    if(!config.wechat.appSecret)denied();
    try{
      const response=await fetch('https://api.weixin.qq.com/cgi-bin/stable_token',{method:'POST',
        headers:{'Content-Type':'application/json'},body:JSON.stringify({grant_type:'client_credential',appid:profile.appId,secret:config.wechat.appSecret}),
        signal:dependencySignal(15000),redirect:'error'});
      const data=await boundedWechatJson<{access_token?:unknown;expires_in?:unknown}>(response);
      if(typeof data.access_token!=='string'||!data.access_token||data.access_token.length>4096
        || typeof data.expires_in!=='number'||!Number.isFinite(data.expires_in)||data.expires_in<1||data.expires_in>7200)denied();
      cached={value:data.access_token,expiresAt:Date.now()+Math.max(0,data.expires_in-120)*1000};return cached.value;
    }catch{throw new DomainError('SHIPPING_TOKEN_UNAVAILABLE','微信发货服务暂不可用，本地记录已保留',503);}
  };
  const authority=new AuthorityService(pool,config.env);
  const derive=(secret:string,label:string)=>createHmac('sha256',Buffer.from(secret,'hex')).update(label).digest('hex');
  const sync=new ShippingSyncService(pool,authority,{enabled:true,appId:profile.appId,merchantId:profile.merchantId,
    encryptionKey:derive(config.contacts.encryptionKey!,'cisme-shipping-encryption-v1'),
    hashKey:derive(config.contacts.hashKey!,'cisme-shipping-request-v1'),keyVersion:config.contacts.keyVersion},
    testChannel??new WechatOrderShippingClient(token,authorize));
  const service=new OrderFulfillmentService(pool,authority,new DeliveryAddressService(pool,config),sync,true);
  const runCycle=async()=>{
    if(!testChannel){try{authorize('shipping.query');}catch{return {processed:0,status:'not_authorized'};}}
    const rows=(await pool.query(`SELECT id FROM commerce_shipping_sync WHERE state IN ('prepared','dispatching','verifying')
      AND next_attempt_at<=clock_timestamp() AND (lease_until IS NULL OR lease_until<clock_timestamp())
      ORDER BY next_attempt_at,id LIMIT 10`)).rows;
    for(const row of rows)await sync.processOne(row.id);
    return {processed:rows.length,status:'processed'};
  };
  return {service,sync,runCycle};
}
