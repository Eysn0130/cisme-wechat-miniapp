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
  amount:{total:binding.totalCents,currency:"CNY"},payer:{openid:binding.payerOpenid}};
function notification(payload:unknown=transaction){
  const nonce="0123456789ab",associated="transaction";
  const cipher=createCipheriv("aes-256-gcm",Buffer.from(apiV3Key),Buffer.from(nonce));
  cipher.setAAD(Buffer.from(associated));
  const ciphertext=Buffer.concat([cipher.update(JSON.stringify(payload)),cipher.final(),cipher.getAuthTag()]).toString("base64");
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
