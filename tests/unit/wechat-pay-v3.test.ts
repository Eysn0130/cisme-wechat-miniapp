import { createCipheriv,generateKeyPairSync,randomBytes,sign } from "node:crypto";
import { expect,it } from "vitest";
import { assertPaymentBinding,verifyPaymentNotification,WechatPayV3Client } from "../../services/api/src/wechatPayV3";

const platform=generateKeyPairSync("rsa",{modulusLength:2048});
const merchant=generateKeyPairSync("rsa",{modulusLength:2048});
const platformPublic=platform.publicKey.export({type:"spki",format:"pem"}).toString();
const merchantPrivate=merchant.privateKey.export({type:"pkcs8",format:"pem"}).toString();
const keys=new Map([["PUB_KEY_ID_3000000001",platformPublic]]);
const apiV3Key="0123456789abcdef0123456789abcdef";
const now=new Date("2026-09-12T12:00:00Z");
const binding={appId:"wx4eac2d4fb11d299b",merchantId:"1234567890",outTradeNo:"CISME202609120001",
  totalCents:50_000,currency:"CNY" as const,payerOpenid:"test-user-openid"};
const transaction={appid:binding.appId,mchid:binding.merchantId,out_trade_no:binding.outTradeNo,
  transaction_id:"420000000000000000000001",trade_type:"JSAPI",trade_state:"SUCCESS",
  success_time:"2026-09-12T11:59:30Z",
  amount:{total:binding.totalCents,payer_total:binding.totalCents,currency:"CNY",payer_currency:"CNY"},
  payer:{openid:binding.payerOpenid}};
function notification(payload:unknown=transaction, associated:unknown="transaction", corruptTag=false){
  const nonce="0123456789ab";
  const cipher=createCipheriv("aes-256-gcm",Buffer.from(apiV3Key),Buffer.from(nonce));
  cipher.setAAD(Buffer.from(typeof associated==="string"?associated:""));
  const encrypted=Buffer.concat([cipher.update(JSON.stringify(payload)),cipher.final(),cipher.getAuthTag()]);
  if(corruptTag)encrypted[encrypted.length-1]=encrypted[encrypted.length-1]!^1;
  const ciphertext=encrypted.toString("base64");
  const raw=Buffer.from(JSON.stringify({id:"EV-20260912-0001",event_type:"TRANSACTION.SUCCESS",resource_type:"encrypt-resource",
    resource:{algorithm:"AEAD_AES_256_GCM",ciphertext,associated_data:associated,nonce,original_type:"transaction"}}));
  const timestamp=Math.floor(now.getTime()/1000).toString(),requestNonce=randomBytes(16).toString("hex");
  const signature=sign("RSA-SHA256",Buffer.concat([Buffer.from(`${timestamp}\n${requestNonce}\n`),raw,Buffer.from("\n")]),platform.privateKey).toString("base64");
  return {rawBody:raw,headers:{"Wechatpay-Serial":"PUB_KEY_ID_3000000001","Wechatpay-Timestamp":timestamp,
    "Wechatpay-Nonce":requestNonce,"Wechatpay-Signature":signature},publicKeys:keys,apiV3Key,binding,now};
}

it("accepts only a signed, decrypted and order-bound JSAPI success fact",()=>{
  expect(verifyPaymentNotification(notification())).toMatchObject({eventId:"EV-20260912-0001",
    providerTransactionId:transaction.transaction_id,totalCents:50_000});
  expect(assertPaymentBinding({...transaction,amount:{...transaction.amount,payer_total:40_000}},binding))
    .toMatchObject({totalCents:50_000,payerTotalCents:40_000,compositionStatus:"unknown_or_discounted"});
  expect(assertPaymentBinding({...transaction,amount:{total:50_000,currency:"CNY"}},binding))
    .toMatchObject({payerTotalCents:null,compositionStatus:"unknown_or_discounted"});
  expect(()=>verifyPaymentNotification(notification({...transaction,amount:{total:49_999,currency:"CNY"}}))).toThrow();
  expect(()=>verifyPaymentNotification(notification({...transaction,payer:{openid:"other-user"}}))).toThrow();
  expect(()=>assertPaymentBinding({...transaction,trade_state:"NOTPAY"},binding)).toThrow();
  const tampered=notification();tampered.rawBody=Buffer.from(tampered.rawBody.toString().replace("TRANSACTION.SUCCESS","TRANSACTION.FAIL"));
  expect(()=>verifyPaymentNotification(tampered)).toThrow();
  const stale=notification();stale.now=new Date(now.getTime()+10*60_000);expect(()=>verifyPaymentNotification(stale)).toThrow();
  const unknown=notification();unknown.headers["Wechatpay-Serial"]="unknown";expect(()=>verifyPaymentNotification(unknown)).toThrow();
});

it("queries an unknown result using the original merchant order number and verifies the response",async()=>{
  let seenUrl="";
  const fetcher=(async(url:string|URL|Request,init?:RequestInit)=>{
    seenUrl=String(url);
    expect(init?.method).toBe("GET");
    expect((init?.headers as Record<string,string>).Authorization).toContain('mchid="1234567890"');
    const raw=JSON.stringify(transaction),timestamp=Math.floor(Date.now()/1000).toString(),nonce="query-nonce";
    const signature=sign("RSA-SHA256",Buffer.from(`${timestamp}\n${nonce}\n${raw}\n`),platform.privateKey).toString("base64");
    return new Response(raw,{status:200,headers:{"Wechatpay-Serial":"PUB_KEY_ID_3000000001","Wechatpay-Timestamp":timestamp,
      "Wechatpay-Nonce":nonce,"Wechatpay-Signature":signature}});
  }) as typeof fetch;
  const client=new WechatPayV3Client(binding.merchantId,"MERCHANT_SERIAL",merchantPrivate,keys,fetcher);
  const queried=await client.queryByMerchantOrderNumber(binding.outTradeNo);
  expect(seenUrl).toContain(`/out-trade-no/${binding.outTradeNo}?mchid=${binding.merchantId}`);
  expect(assertPaymentBinding(queried,binding).providerTransactionId).toBe(transaction.transaction_id);
});

it("queries the same merchant refund number and keeps PROCESSING distinct from success",async()=>{
  const refundBinding={merchantId:binding.merchantId,outTradeNo:binding.outTradeNo,
    providerTransactionId:transaction.transaction_id,outRefundNo:"RF2026091200000008",
    totalCents:50_000,refundCents:10_000,payerTotalCents:50_000,payerRefundCents:10_000};
  let status="PROCESSING",seenUrl="",payerRefund=10_000;
  const fetcher=(async(url:string|URL|Request)=>{
    seenUrl=String(url);
    const payload={refund_id:"500000000000000000000108",out_refund_no:refundBinding.outRefundNo,
      transaction_id:refundBinding.providerTransactionId,out_trade_no:refundBinding.outTradeNo,status,
      create_time:"2026-09-12T13:00:00+08:00",
      ...(status==="SUCCESS"?{success_time:new Date().toISOString()}:{}),
      amount:{total:refundBinding.totalCents,refund:refundBinding.refundCents,
        payer_total:refundBinding.payerTotalCents,payer_refund:payerRefund,currency:"CNY"}};
    const raw=JSON.stringify(payload),timestamp=Math.floor(Date.now()/1000).toString(),nonce="refund-query-nonce";
    const signature=sign("RSA-SHA256",Buffer.from(`${timestamp}\n${nonce}\n${raw}\n`),platform.privateKey).toString("base64");
    return new Response(raw,{status:200,headers:{"Wechatpay-Serial":"PUB_KEY_ID_3000000001",
      "Wechatpay-Timestamp":timestamp,"Wechatpay-Nonce":nonce,"Wechatpay-Signature":signature}});
  }) as typeof fetch;
  const client=new WechatPayV3Client(binding.merchantId,"MERCHANT_SERIAL",merchantPrivate,keys,fetcher);
  expect((await client.queryRefundByMerchantRefundNumber(refundBinding)).status).toBe("PROCESSING");
  expect(seenUrl).toContain(`/v3/refund/domestic/refunds/${refundBinding.outRefundNo}`);
  status="SUCCESS";
  expect((await client.queryRefundByMerchantRefundNumber(refundBinding)).succeededAt).toBeTruthy();
  payerRefund=9_999;
  await expect(client.queryRefundByMerchantRefundNumber(refundBinding)).rejects.toThrow();
});

function responseHeaders(raw:string, offset=0) {
  const timestamp=String(Math.floor(Date.now()/1000)+offset),nonce="synthetic-response";
  return {"Wechatpay-Serial":"PUB_KEY_ID_3000000001","Wechatpay-Timestamp":timestamp,
    "Wechatpay-Nonce":nonce,"Wechatpay-Signature":sign("RSA-SHA256",Buffer.from(`${timestamp}\n${nonce}\n${raw}\n`),platform.privateKey).toString("base64")};
}
it.each(["missing","bad","unknown-key","expired","valid"])("checks %s signatures on empty 204 close responses",async mode=>{
  const headers=responseHeaders("",mode==="expired"?-600:0);
  if(mode==="bad")headers["Wechatpay-Signature"]="WECHATPAY/SIGNTEST/bad";
  if(mode==="unknown-key")headers["Wechatpay-Serial"]="UNKNOWN";
  const fetcher=(async()=>new Response(null,{status:204,headers:mode==="missing"?{}:headers})) as typeof fetch;
  const client=new WechatPayV3Client(binding.merchantId,"MERCHANT_SERIAL",merchantPrivate,keys,fetcher);
  if(mode==="valid")await expect(client.closeByMerchantOrderNumber(binding.outTradeNo)).resolves.toBeUndefined();
  else await expect(client.closeByMerchantOrderNumber(binding.outTradeNo)).rejects.toThrow();
});
it.each(["",undefined])("accepts optional empty callback AAD %s with a valid signature and GCM tag",aad=>{
  // undefined bypasses the helper default using an explicit omitted sentinel.
  const input=notification(transaction,aad==undefined?null:aad);
  if(aad===undefined){
    const body=JSON.parse(input.rawBody.toString());delete body.resource.associated_data;
    input.rawBody=Buffer.from(JSON.stringify(body));
    input.headers["Wechatpay-Signature"]=sign("RSA-SHA256",Buffer.concat([
      Buffer.from(`${input.headers["Wechatpay-Timestamp"]}\n${input.headers["Wechatpay-Nonce"]}\n`),input.rawBody,Buffer.from("\n")]),platform.privateKey).toString("base64");
  }
  expect(verifyPaymentNotification(input).providerTransactionId).toBe(transaction.transaction_id);
});
it.each([null,{},7])("rejects invalid callback AAD type %s",aad=>expect(()=>verifyPaymentNotification(notification(transaction,aad))).toThrow());
it("rejects an authentic envelope with a broken GCM tag",()=>expect(()=>verifyPaymentNotification(notification(transaction,"",true))).toThrow());

it("caps chunked channel responses before buffering an unbounded body",async()=>{
  let cancelled=false;
  const stream=new ReadableStream<Uint8Array>({pull(controller){controller.enqueue(new Uint8Array(600_000));},cancel(){cancelled=true;}});
  const fetcher=(async()=>new Response(stream,{status:200})) as typeof fetch;
  const client=new WechatPayV3Client(binding.merchantId,"MERCHANT_SERIAL",merchantPrivate,keys,fetcher);
  await expect(client.queryByMerchantOrderNumber(binding.outTradeNo)).rejects.toMatchObject({code:"WECHAT_PAY_RESPONSE_TOO_LARGE"});
  expect(cancelled).toBe(true);
});
it("refuses transfer without an explicit scene report before any outbound call",async()=>{
  let calls=0;
  const fetcher=(async()=>{calls++;throw new Error("unexpected transport");}) as typeof fetch;
  const client=new WechatPayV3Client(binding.merchantId,"MERCHANT_SERIAL",merchantPrivate,keys,fetcher);
  await expect(client.createTransfer({appId:binding.appId,merchantId:binding.merchantId,outBillNo:"SYNTHETIC0001",
    payeeOpenid:"synthetic-payee",amountCents:1,sceneId:"TEST",remark:"synthetic",notifyUrl:"https://example.test/notify"}))
    .rejects.toMatchObject({code:"WECHAT_TRANSFER_SCENE_REQUIRED"});
  expect(calls).toBe(0);
});
