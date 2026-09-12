import { createDecipheriv, randomBytes, sign, verify } from "node:crypto";
import { DomainError } from "@cisme/domain";

type HeaderMap=Record<string,string|undefined>;
type Resource={algorithm?:unknown;ciphertext?:unknown;associated_data?:unknown;nonce?:unknown;original_type?:unknown};
type Notification={id?:unknown;event_type?:unknown;resource_type?:unknown;resource?:Resource};
export type PaymentTransaction={appid?:unknown;mchid?:unknown;out_trade_no?:unknown;transaction_id?:unknown;
  trade_type?:unknown;trade_state?:unknown;success_time?:unknown;amount?:{total?:unknown;currency?:unknown};payer?:{openid?:unknown}};
export interface PaymentBinding{appId:string;merchantId:string;outTradeNo:string;totalCents:number;currency:"CNY";payerOpenid:string;}
function reject(message:string):never{throw new DomainError("WECHAT_PAY_FACT_INVALID",message,422);}
function header(headers:HeaderMap,name:string){return headers[name]??headers[name.toLowerCase()]??headers[name.toUpperCase()];}
function validSignature(headers:HeaderMap,raw:Uint8Array,publicKeys:ReadonlyMap<string,string>,now:Date){
  const serial=header(headers,"Wechatpay-Serial"),timestamp=header(headers,"Wechatpay-Timestamp"),
    nonce=header(headers,"Wechatpay-Nonce"),signature=header(headers,"Wechatpay-Signature");
  if(!serial||!timestamp||!nonce||!signature||!/^\d{10}$/.test(timestamp)||nonce.length>128)
    reject("微信支付签名字段不完整");
  const seconds=Number(timestamp);
  if(Math.abs(now.getTime()-seconds*1000)>5*60_000)reject("微信支付通知已超出时间窗口");
  if(signature.startsWith("WECHATPAY/SIGNTEST/"))reject("微信支付签名探测流量");
  const key=publicKeys.get(serial);
  if(!key)reject("微信支付平台证书或公钥编号未知");
  const message=Buffer.concat([Buffer.from(`${timestamp}\n${nonce}\n`),Buffer.from(raw),Buffer.from("\n")]);
  if(!verify("RSA-SHA256",message,key,Buffer.from(signature,"base64")))reject("微信支付通知签名无效");
  return serial;
}
function decryptResource(resource:Resource|undefined,apiV3Key:string){
  if(!resource||resource.algorithm!=="AEAD_AES_256_GCM"||resource.original_type!=="transaction"||
    typeof resource.ciphertext!=="string"||typeof resource.nonce!=="string"||
    typeof resource.associated_data!=="string"||Buffer.byteLength(apiV3Key)!==32)
    reject("微信支付加密资源格式无效");
  const cipher=Buffer.from(resource.ciphertext,"base64");
  if(cipher.length<17||Buffer.byteLength(resource.nonce)!==12)reject("微信支付加密资源长度无效");
  const decipher=createDecipheriv("aes-256-gcm",Buffer.from(apiV3Key),Buffer.from(resource.nonce));
  decipher.setAuthTag(cipher.subarray(cipher.length-16));
  decipher.setAAD(Buffer.from(resource.associated_data));
  try{return JSON.parse(Buffer.concat([decipher.update(cipher.subarray(0,-16)),decipher.final()]).toString("utf8")) as PaymentTransaction;}
  catch{reject("微信支付加密资源认证失败");}
}
export function assertPaymentBinding(transaction:PaymentTransaction,binding:PaymentBinding){
  if(transaction.appid!==binding.appId||transaction.mchid!==binding.merchantId||
    transaction.out_trade_no!==binding.outTradeNo||transaction.amount?.total!==binding.totalCents||
    transaction.amount?.currency!==binding.currency||transaction.payer?.openid!==binding.payerOpenid||
    transaction.trade_type!=="JSAPI"||transaction.trade_state!=="SUCCESS"||
    typeof transaction.transaction_id!=="string"||!transaction.transaction_id||
    typeof transaction.success_time!=="string"||!Number.isFinite(Date.parse(transaction.success_time)))
    reject("微信支付事实与订单、金额或付款身份不匹配");
  return {providerTransactionId:transaction.transaction_id,orderNumber:binding.outTradeNo,
    totalCents:binding.totalCents,currency:binding.currency,merchantId:binding.merchantId,appId:binding.appId,
    paidAt:new Date(transaction.success_time).toISOString()};
}
export function decodePaymentNotification(input:{rawBody:Uint8Array;headers:HeaderMap;publicKeys:ReadonlyMap<string,string>;
  apiV3Key:string;now?:Date}){
  const serial=validSignature(input.headers,input.rawBody,input.publicKeys,input.now??new Date());
  let notification:Notification;
  try{notification=JSON.parse(Buffer.from(input.rawBody).toString("utf8")) as Notification;}catch{reject("微信支付通知不是有效 JSON");}
  if(typeof notification.id!=="string"||notification.id.length<8||notification.event_type!=="TRANSACTION.SUCCESS"||
    notification.resource_type!=="encrypt-resource")reject("微信支付通知类型无效");
  const transaction=decryptResource(notification.resource,input.apiV3Key);
  return {eventId:notification.id,serial,transaction};
}
export function verifyPaymentNotification(input:{rawBody:Uint8Array;headers:HeaderMap;publicKeys:ReadonlyMap<string,string>;
  apiV3Key:string;binding:PaymentBinding;now?:Date}){
  const decoded=decodePaymentNotification(input);
  return {eventId:decoded.eventId,serial:decoded.serial,...assertPaymentBinding(decoded.transaction,input.binding)};
}

/** Protocol adapter only. Callers must persist verified facts before 204 and keep the MAKE gate closed until approved. */
export class WechatPayV3Client{
  constructor(private readonly merchantId:string,private readonly merchantSerial:string,private readonly privateKeyPem:string,
    private readonly platformKeys:ReadonlyMap<string,string>,private readonly fetcher:typeof fetch=fetch){}
  private authorization(method:string,pathWithQuery:string,body:string){
    const timestamp=Math.floor(Date.now()/1000).toString(),nonce=randomBytes(16).toString("hex");
    const message=`${method}\n${pathWithQuery}\n${timestamp}\n${nonce}\n${body}\n`;
    const signature=sign("RSA-SHA256",Buffer.from(message),this.privateKeyPem).toString("base64");
    return `WECHATPAY2-SHA256-RSA2048 mchid="${this.merchantId}",nonce_str="${nonce}",timestamp="${timestamp}",serial_no="${this.merchantSerial}",signature="${signature}"`;
  }
  async queryByMerchantOrderNumber(outTradeNo:string){
    if(!/^[A-Za-z0-9_-]{6,32}$/.test(outTradeNo))reject("商户订单号无效");
    const path=`/v3/pay/transactions/out-trade-no/${encodeURIComponent(outTradeNo)}?mchid=${encodeURIComponent(this.merchantId)}`;
    const response=await this.fetcher(`https://api.mch.weixin.qq.com${path}`,{method:"GET",headers:{
      Authorization:this.authorization("GET",path,""),Accept:"application/json", "User-Agent":"CISME/1.0"},signal:AbortSignal.timeout(10000)});
    const raw=Buffer.from(await response.arrayBuffer());
    if(!response.ok)throw new DomainError("WECHAT_PAY_QUERY_UNAVAILABLE","微信支付查单暂不可用；保持原商户订单号待重试",503);
    validSignature(Object.fromEntries(response.headers.entries()),raw,this.platformKeys,new Date());
    return JSON.parse(raw.toString("utf8")) as PaymentTransaction;
  }
}
