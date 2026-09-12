import { createDecipheriv, randomBytes, sign, verify } from "node:crypto";
import { DomainError } from "@cisme/domain";

type HeaderMap=Record<string,string|undefined>;
type Resource={algorithm?:unknown;ciphertext?:unknown;associated_data?:unknown;nonce?:unknown;original_type?:unknown};
type Notification={id?:unknown;event_type?:unknown;resource_type?:unknown;resource?:Resource};
export type PaymentTransaction={appid?:unknown;mchid?:unknown;out_trade_no?:unknown;transaction_id?:unknown;
  trade_type?:unknown;trade_state?:unknown;success_time?:unknown;amount?:{total?:unknown;currency?:unknown};payer?:{openid?:unknown}};
export type RefundTransaction={mchid?:unknown;out_trade_no?:unknown;transaction_id?:unknown;out_refund_no?:unknown;
  refund_id?:unknown;refund_status?:unknown;success_time?:unknown;
  amount?:{total?:unknown;refund?:unknown;payer_total?:unknown;payer_refund?:unknown;currency?:unknown}};
export type RefundQueryResult=Omit<RefundTransaction,"refund_status">&{status?:unknown};
export interface PaymentBinding{appId:string;merchantId:string;outTradeNo:string;totalCents:number;currency:"CNY";payerOpenid:string;}
export interface RefundBinding{merchantId:string;outTradeNo:string;providerTransactionId:string;outRefundNo:string;
  totalCents:number;refundCents:number;payerTotalCents:number;payerRefundCents:number;}
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
function decryptResource<T>(resource:Resource|undefined,apiV3Key:string,originalType:"transaction"|"refund"):T{
  if(!resource||resource.algorithm!=="AEAD_AES_256_GCM"||resource.original_type!==originalType||
    typeof resource.ciphertext!=="string"||typeof resource.nonce!=="string"||
    typeof resource.associated_data!=="string"||Buffer.byteLength(apiV3Key)!==32)
    reject("微信支付加密资源格式无效");
  const cipher=Buffer.from(resource.ciphertext,"base64");
  if(cipher.length<17||Buffer.byteLength(resource.nonce)!==12)reject("微信支付加密资源长度无效");
  const decipher=createDecipheriv("aes-256-gcm",Buffer.from(apiV3Key),Buffer.from(resource.nonce));
  decipher.setAuthTag(cipher.subarray(cipher.length-16));
  decipher.setAAD(Buffer.from(resource.associated_data));
  try{return JSON.parse(Buffer.concat([decipher.update(cipher.subarray(0,-16)),decipher.final()]).toString("utf8")) as T;}
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
  const transaction=decryptResource<PaymentTransaction>(notification.resource,input.apiV3Key,"transaction");
  return {eventId:notification.id,serial,transaction};
}
export function decodeRefundNotification(input:{rawBody:Uint8Array;headers:HeaderMap;publicKeys:ReadonlyMap<string,string>;
  apiV3Key:string;now?:Date}){
  const serial=validSignature(input.headers,input.rawBody,input.publicKeys,input.now??new Date());
  let notification:Notification;
  try{notification=JSON.parse(Buffer.from(input.rawBody).toString("utf8")) as Notification;}catch{reject("微信退款通知不是有效 JSON");}
  if(typeof notification.id!=="string"||notification.id.length<8||
    !["REFUND.SUCCESS","REFUND.CLOSED","REFUND.ABNORMAL"].includes(String(notification.event_type))||
    notification.resource_type!=="encrypt-resource")reject("微信退款通知类型无效");
  const refund=decryptResource<RefundTransaction>(notification.resource,input.apiV3Key,"refund");
  const eventStatus=String(notification.event_type).slice(7);
  if(refund.refund_status!==eventStatus)reject("微信退款通知状态不一致");
  return {eventId:notification.id,serial,status:eventStatus as "SUCCESS"|"CLOSED"|"ABNORMAL",refund};
}
export function assertRefundBinding(refund:RefundTransaction,binding:RefundBinding,status:"SUCCESS"|"CLOSED"|"ABNORMAL"|"PROCESSING"){
  const amount=refund.amount;
  if(refund.mchid!==binding.merchantId||refund.out_trade_no!==binding.outTradeNo||
    refund.transaction_id!==binding.providerTransactionId||refund.out_refund_no!==binding.outRefundNo||
    typeof refund.refund_id!=="string"||refund.refund_id.length<8||refund.refund_status!==status||
    amount?.total!==binding.totalCents||amount?.refund!==binding.refundCents||
    amount?.payer_total!==binding.payerTotalCents||amount?.payer_refund!==binding.payerRefundCents||
    !Number.isSafeInteger(binding.totalCents)||!Number.isSafeInteger(binding.refundCents)||
    !Number.isSafeInteger(binding.payerTotalCents)||!Number.isSafeInteger(binding.payerRefundCents)||
    binding.totalCents<=0||binding.refundCents<=0||binding.refundCents>binding.totalCents||
    binding.payerTotalCents<=0||binding.payerTotalCents>binding.totalCents||
    binding.payerRefundCents<=0||binding.payerRefundCents>binding.payerTotalCents||
    binding.payerRefundCents>binding.refundCents)
    reject("微信退款事实与原交易或商户退款单不匹配");
  if(status==="SUCCESS"&&
    (typeof refund.success_time!=="string"||!Number.isFinite(Date.parse(refund.success_time))))
    reject("微信退款成功时间无效");
  return {providerRefundId:refund.refund_id,status,totalCents:binding.totalCents,
    refundCents:binding.refundCents,payerRefundCents:binding.payerRefundCents,
    succeededAt:status==="SUCCESS"?new Date(String(refund.success_time)).toISOString():null};
}
export function assertRefundQueryBinding(result:RefundQueryResult,binding:RefundBinding){
  const status=String(result.status);
  if(!["SUCCESS","CLOSED","ABNORMAL","PROCESSING"].includes(status)||result.amount?.currency!=="CNY")
    reject("微信退款查询状态或币种无效");
  // This signed query response omits mchid; the authenticated merchant
  // request and its exact out_refund_no bind the merchant instead.
  return assertRefundBinding({...result,mchid:binding.merchantId,refund_status:status},binding,
    status as "SUCCESS"|"CLOSED"|"ABNORMAL"|"PROCESSING");
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
  async queryRefundByMerchantRefundNumber(binding:RefundBinding){
    if(!/^[A-Za-z0-9_-]{8,64}$/.test(binding.outRefundNo))reject("商户退款单号无效");
    const path=`/v3/refund/domestic/refunds/${encodeURIComponent(binding.outRefundNo)}`;
    const response=await this.fetcher(`https://api.mch.weixin.qq.com${path}`,{method:"GET",headers:{
      Authorization:this.authorization("GET",path,""),Accept:"application/json","User-Agent":"CISME/1.0"},
      signal:AbortSignal.timeout(10000)});
    const raw=Buffer.from(await response.arrayBuffer());
    if(!response.ok)throw new DomainError("WECHAT_REFUND_QUERY_UNAVAILABLE",
      "微信退款查询暂不可用；保持原商户退款单号待重试",503);
    validSignature(Object.fromEntries(response.headers.entries()),raw,this.platformKeys,new Date());
    const result=JSON.parse(raw.toString("utf8")) as RefundQueryResult;
    return assertRefundQueryBinding(result,binding);
  }
}
