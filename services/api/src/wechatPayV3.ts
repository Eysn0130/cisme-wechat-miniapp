import { createDecipheriv, createHash, randomBytes, sign, verify } from "node:crypto";
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
export interface TransferBinding{appId:string;merchantId:string;outBillNo:string;payeeOpenid:string;
  amountCents:number;sceneId:string;remark:string;notifyUrl:string;}
export type TransferState="ACCEPTED"|"PROCESSING"|"WAIT_USER_CONFIRM"|"TRANSFERING"|
  "SUCCESS"|"FAIL"|"CANCELING"|"CANCELLED";
export interface TransferQueryResult{mch_id?:unknown;appid?:unknown;out_bill_no?:unknown;
  transfer_bill_no?:unknown;state?:unknown;transfer_amount?:unknown;openid?:unknown;
  transfer_remark?:unknown;create_time?:unknown;update_time?:unknown;package_info?:unknown;}
const transferStates=new Set<unknown>(["ACCEPTED","PROCESSING","WAIT_USER_CONFIRM","TRANSFERING",
  "SUCCESS","FAIL","CANCELING","CANCELLED"]);
export function assertTransferQueryBinding(result:TransferQueryResult,binding:TransferBinding){
  if(result.mch_id!==binding.merchantId||result.appid!==binding.appId||
    result.out_bill_no!==binding.outBillNo||result.openid!==binding.payeeOpenid||
    result.transfer_amount!==binding.amountCents||result.transfer_remark!==binding.remark||
    typeof result.transfer_bill_no!=="string"||result.transfer_bill_no.length<8||
    !transferStates.has(result.state)||typeof result.create_time!=="string"||
    !Number.isFinite(Date.parse(result.create_time))||typeof result.update_time!=="string"||
    !Number.isFinite(Date.parse(result.update_time)))reject("微信转账查单事实与收款人、金额或商户单号不匹配");
  return {state:result.state as TransferState,providerBillNo:result.transfer_bill_no,
    packageInfo:result.state==="WAIT_USER_CONFIRM"&&typeof result.package_info==="string"
      ?result.package_info:null};
}
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
function decryptResource<T>(resource:Resource|undefined,apiV3Key:string,
  originalType:"transaction"|"refund"|"mch_payment"):T{
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
export type TransferCallbackResult={out_bill_no?:unknown;transfer_bill_no?:unknown;state?:unknown;
  mch_id?:unknown;transfer_amount?:unknown;openid?:unknown;create_time?:unknown;update_time?:unknown};
export function decodeTransferNotification(input:{rawBody:Uint8Array;headers:HeaderMap;
  publicKeys:ReadonlyMap<string,string>;apiV3Key:string;now?:Date}){
  const serial=validSignature(input.headers,input.rawBody,input.publicKeys,input.now??new Date());
  let notification:Notification;
  try{notification=JSON.parse(Buffer.from(input.rawBody).toString("utf8")) as Notification;}
  catch{reject("商家转账通知不是有效 JSON");}
  if(typeof notification.id!=="string"||notification.id.length<8||
    notification.event_type!=="MCHTRANSFER.BILL.FINISHED"||
    notification.resource_type!=="encrypt-resource")reject("商家转账通知类型无效");
  const transfer=decryptResource<TransferCallbackResult>(notification.resource,input.apiV3Key,"mch_payment");
  if(!["SUCCESS","FAIL","CANCELLED"].includes(String(transfer.state))||
    typeof transfer.out_bill_no!=="string"||typeof transfer.transfer_bill_no!=="string"||
    typeof transfer.mch_id!=="string"||typeof transfer.openid!=="string"||
    !Number.isSafeInteger(transfer.transfer_amount)||
    typeof transfer.create_time!=="string"||!Number.isFinite(Date.parse(transfer.create_time))||
    typeof transfer.update_time!=="string"||!Number.isFinite(Date.parse(transfer.update_time)))
    reject("商家转账通知事实不完整");
  return {eventId:notification.id,serial,transfer};
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
    private readonly platformKeys:ReadonlyMap<string,string>,private readonly fetcher:typeof fetch=fetch,
    private readonly baseUrl="https://api.mch.weixin.qq.com"){
    if(baseUrl!=="https://api.mch.weixin.qq.com" &&
      !/^http:\/\/(127\.0\.0\.1|\[::1\]):[0-9]{2,5}$/.test(baseUrl))
      throw new DomainError("WECHAT_PAY_ENDPOINT_INVALID","仅允许微信支付正式域名或隔离测试回环地址",500);
  }
  private authorization(method:string,pathWithQuery:string,body:string){
    const timestamp=Math.floor(Date.now()/1000).toString(),nonce=randomBytes(16).toString("hex");
    const message=`${method}\n${pathWithQuery}\n${timestamp}\n${nonce}\n${body}\n`;
    const signature=sign("RSA-SHA256",Buffer.from(message),this.privateKeyPem).toString("base64");
    return `WECHATPAY2-SHA256-RSA2048 mchid="${this.merchantId}",nonce_str="${nonce}",timestamp="${timestamp}",serial_no="${this.merchantSerial}",signature="${signature}"`;
  }
  private async request(method:"GET"|"POST",path:string,body=""){
    const response=await this.fetcher(`${this.baseUrl}${path}`,{method,headers:{
      Authorization:this.authorization(method,path,body),Accept:"application/json",
      ...(body?{"Content-Type":"application/json"}:{}),"User-Agent":"CISME/1.0"},
      ...(body?{body}:{}),redirect:"error",signal:AbortSignal.timeout(10000)});
    const raw=Buffer.from(await response.arrayBuffer());
    if(raw.length)validSignature(Object.fromEntries(response.headers.entries()),raw,this.platformKeys,new Date());
    if(!response.ok){
      let code:unknown;
      try{code=(JSON.parse(raw.toString("utf8")) as {code?:unknown}).code;}catch{/* fail closed */}
      if(method==="GET"&&response.status===404&&code==="ORDER_NOT_EXIST")
        throw new DomainError("WECHAT_PAY_ORDER_NOT_FOUND","原商户订单号在渠道中不存在",404);
      if(method==="GET"&&response.status===404&&code==="RESOURCE_NOT_EXISTS")
        throw new DomainError("WECHAT_REFUND_NOT_FOUND","原商户退款单号在渠道中不存在",404);
      if(method==="GET"&&response.status===404&&code==="NOT_FOUND"&&
        path.startsWith("/v3/fund-app/mch-transfer/transfer-bills/out-bill-no/"))
        throw new DomainError("WECHAT_TRANSFER_NOT_FOUND","原商户转账单号在渠道中不存在",404);
      throw new DomainError("WECHAT_PAY_CHANNEL_UNAVAILABLE",
        "微信支付请求结果不确定；请按原商户单号查单",503);
    }
    return {status:response.status,raw};
  }
  async createJsapiPrepay(input:{appId:string;outTradeNo:string;payerOpenid:string;totalCents:number;
    description:string;notifyUrl:string;expiresAt:Date}){
    if(!/^[A-Za-z0-9_-]{6,32}$/.test(input.outTradeNo)||!Number.isSafeInteger(input.totalCents)||
      input.totalCents<1||input.totalCents>9_900_000_000||
      !/^https:\/\/[^?#]+$/.test(input.notifyUrl)||input.description.length<1||input.description.length>127)
      reject("预支付参数无效");
    const body=JSON.stringify({appid:input.appId,mchid:this.merchantId,description:input.description,
      out_trade_no:input.outTradeNo,time_expire:input.expiresAt.toISOString(),notify_url:input.notifyUrl,
      amount:{total:input.totalCents,currency:"CNY"},payer:{openid:input.payerOpenid}});
    const {raw}=await this.request("POST","/v3/pay/transactions/jsapi",body);
    let value:unknown;
    try{value=JSON.parse(raw.toString("utf8"));}catch{reject("预支付响应格式无效");}
    const prepayId=(value as {prepay_id?:unknown}).prepay_id;
    if(typeof prepayId!=="string"||prepayId.length<8||prepayId.length>128)reject("预支付标识无效");
    return {prepayId,rawSha256:createHash("sha256").update(raw).digest("hex")};
  }
  miniProgramPaymentParams(appId:string,prepayId:string){
    if(!/^wx[a-zA-Z0-9]{16}$/.test(appId)||prepayId.length<8||prepayId.length>128)
      reject("小程序支付参数无效");
    const timeStamp=Math.floor(Date.now()/1000).toString(),nonceStr=randomBytes(16).toString("hex");
    const packageValue=`prepay_id=${prepayId}`;
    const paySign=sign("RSA-SHA256",Buffer.from(`${appId}\n${timeStamp}\n${nonceStr}\n${packageValue}\n`),
      this.privateKeyPem).toString("base64");
    return {timeStamp,nonceStr,package:packageValue,signType:"RSA" as const,paySign};
  }
  async closeByMerchantOrderNumber(outTradeNo:string){
    if(!/^[A-Za-z0-9_-]{6,32}$/.test(outTradeNo))reject("商户订单号无效");
    const path=`/v3/pay/transactions/out-trade-no/${encodeURIComponent(outTradeNo)}/close`;
    const {status}=await this.request("POST",path,JSON.stringify({mchid:this.merchantId}));
    if(status!==204)reject("微信关单响应无效");
  }
  async queryByMerchantOrderNumberWithEvidence(outTradeNo:string){
    if(!/^[A-Za-z0-9_-]{6,32}$/.test(outTradeNo))reject("商户订单号无效");
    const path=`/v3/pay/transactions/out-trade-no/${encodeURIComponent(outTradeNo)}?mchid=${encodeURIComponent(this.merchantId)}`;
    const {raw}=await this.request("GET",path);
    let transaction:PaymentTransaction;
    try{transaction=JSON.parse(raw.toString("utf8")) as PaymentTransaction;}catch{reject("微信支付查单响应无效");}
    return {transaction,rawSha256:createHash("sha256").update(raw).digest("hex")};
  }
  async queryByMerchantOrderNumber(outTradeNo:string){
    return (await this.queryByMerchantOrderNumberWithEvidence(outTradeNo)).transaction;
  }
  async queryRefundByMerchantRefundNumber(binding:RefundBinding){
    return (await this.queryRefundByMerchantRefundNumberWithEvidence(binding)).fact;
  }
  async queryRefundByMerchantRefundNumberWithEvidence(binding:RefundBinding){
    if(!/^[A-Za-z0-9_-]{8,64}$/.test(binding.outRefundNo))reject("商户退款单号无效");
    const path=`/v3/refund/domestic/refunds/${encodeURIComponent(binding.outRefundNo)}`;
    const {raw}=await this.request("GET",path);
    const result=JSON.parse(raw.toString("utf8")) as RefundQueryResult;
    return {fact:assertRefundQueryBinding(result,binding),result,
      rawSha256:createHash("sha256").update(raw).digest("hex")};
  }
  async createRefund(binding:RefundBinding,reason:string,notifyUrl:string){
    if(!/^https:\/\/[^?#]+$/.test(notifyUrl)||reason.length<3||reason.length>80)
      reject("退款申请参数无效");
    const body=JSON.stringify({transaction_id:binding.providerTransactionId,
      out_refund_no:binding.outRefundNo,reason,notify_url:notifyUrl,
      amount:{refund:binding.refundCents,total:binding.totalCents,currency:"CNY"}});
    const {raw}=await this.request("POST","/v3/refund/domestic/refunds",body);
    let result:RefundQueryResult;
    try{result=JSON.parse(raw.toString("utf8")) as RefundQueryResult;}catch{reject("退款受理响应无效");}
    return {fact:assertRefundQueryBinding(result,binding),result,
      rawSha256:createHash("sha256").update(raw).digest("hex")};
  }
  async createTransfer(binding:TransferBinding){
    if(!/^[A-Za-z0-9]{8,32}$/.test(binding.outBillNo)||
      !Number.isSafeInteger(binding.amountCents)||binding.amountCents<1||
      binding.amountCents>9_900_000_000||binding.remark.length<1||binding.remark.length>32||
      !/^https:\/\/[^?#]+$/.test(binding.notifyUrl)||!/^[-A-Za-z0-9_]{2,36}$/.test(binding.sceneId)||
      !binding.payeeOpenid||binding.payeeOpenid.length>64)reject("商家转账参数无效");
    const body=JSON.stringify({appid:binding.appId,out_bill_no:binding.outBillNo,
      transfer_scene_id:binding.sceneId,openid:binding.payeeOpenid,
      transfer_amount:binding.amountCents,transfer_remark:binding.remark,notify_url:binding.notifyUrl,
      transfer_scene_report_infos:[{info_type:"活动名称",info_content:"隔离佣金测试"}]});
    const {raw}=await this.request("POST","/v3/fund-app/mch-transfer/transfer-bills",body);
    let result:{out_bill_no?:unknown;transfer_bill_no?:unknown;state?:unknown;package_info?:unknown};
    try{result=JSON.parse(raw.toString("utf8"));}catch{reject("商家转账受理响应无效");}
    if(result.out_bill_no!==binding.outBillNo||typeof result.transfer_bill_no!=="string"||
      result.transfer_bill_no.length<8||!transferStates.has(result.state))reject("商家转账受理单号或状态无效");
    return {state:result.state as TransferState,providerBillNo:result.transfer_bill_no,
      packageInfo:result.state==="WAIT_USER_CONFIRM"&&typeof result.package_info==="string"
        ?result.package_info:null,rawSha256:createHash("sha256").update(raw).digest("hex")};
  }
  async queryTransferByMerchantBillNumber(binding:TransferBinding){
    if(!/^[A-Za-z0-9]{8,32}$/.test(binding.outBillNo))reject("商户转账单号无效");
    const path=`/v3/fund-app/mch-transfer/transfer-bills/out-bill-no/${encodeURIComponent(binding.outBillNo)}`;
    const {raw}=await this.request("GET",path);
    let result:TransferQueryResult;
    try{result=JSON.parse(raw.toString("utf8")) as TransferQueryResult;}catch{reject("商家转账查单响应无效");}
    return {...assertTransferQueryBinding(result,binding),
      rawSha256:createHash("sha256").update(raw).digest("hex")};
  }
  /** Trade-bill download responses are unsigned; the signed application response supplies SHA1. */
  async downloadTradeBill(billDate:string,billType:"SUCCESS"|"REFUND"){
    const parsedDate=new Date(`${billDate}T00:00:00Z`);
    if(!/^\d{4}-\d{2}-\d{2}$/.test(billDate)||!Number.isFinite(parsedDate.getTime())||
      parsedDate.toISOString().slice(0,10)!==billDate||
      !["SUCCESS","REFUND"].includes(billType))reject("交易账单日期或类型无效");
    const shanghaiToday=new Date(Date.now()+8*60*60*1000).toISOString().slice(0,10);
    if(billDate>=shanghaiToday||parsedDate.getTime()<Date.now()-89*24*60*60*1000)
      reject("交易账单须为最近三个月内已结束的历史日期");
    const path=`/v3/bill/tradebill?bill_date=${billDate}&bill_type=${billType}`;
    const {raw}=await this.request("GET",path);
    let application:{download_url?:unknown;hash_type?:unknown;hash_value?:unknown};
    try{application=JSON.parse(raw.toString("utf8"));}catch{reject("交易账单申请响应无效");}
    if(application.hash_type!=="SHA1"||typeof application.hash_value!=="string"||
      !/^[0-9a-f]{40}$/i.test(application.hash_value)||typeof application.download_url!=="string")
      reject("交易账单摘要或下载地址无效");
    let url:URL;
    try{url=new URL(application.download_url);}catch{reject("交易账单下载地址无效");}
    const billDownloadHosts = new Set(["api.mch.weixin.qq.com", "api2.mch.weixin.qq.com"]);
    const allowed=this.baseUrl.startsWith("http://")
      ?url.origin===this.baseUrl
      :url.protocol==="https:" && billDownloadHosts.has(url.hostname);
    if(!allowed||url.username||url.password||url.hash||!url.pathname.startsWith("/v3/billdownload/"))
      reject("交易账单下载地址不属于渠道");
    const signedPath=url.pathname+url.search;
    const response=await this.fetcher(url,{method:"GET",headers:{
      Authorization:this.authorization("GET",signedPath,""),Accept:"application/octet-stream",
      "User-Agent":"CISME/1.0"},redirect:"error",signal:AbortSignal.timeout(15000)});
    if(!response.ok||Number(response.headers.get("content-length")??0)>10_000_000)
      throw new DomainError("WECHAT_BILL_DOWNLOAD_UNAVAILABLE","交易账单暂时无法下载或超出大小上限",503);
    const bytes=Buffer.from(await response.arrayBuffer());
    if(bytes.length>10_000_000||
      createHash("sha1").update(bytes).digest("hex")!==application.hash_value.toLowerCase())
      reject("交易账单文件摘要不匹配");
    return {bytes,sourceSha1:application.hash_value.toLowerCase(),
      sourceSha256:createHash("sha256").update(bytes).digest("hex")};
  }
}
