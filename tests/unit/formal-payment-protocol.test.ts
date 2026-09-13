import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type pg from "pg";
import { afterAll, expect, it } from "vitest";
import { loadConfig } from "@cisme/config";
import { formalPaymentProtocol } from "../../services/api/src/formalPaymentProtocol";

const roots:string[]=[];
afterAll(async()=>{await Promise.all(roots.map(root=>rm(root,{recursive:true,force:true})));});

async function fixture(){
  const root=await mkdtemp(join(tmpdir(),"cisme-formal-protocol-"));roots.push(root);
  const merchant=generateKeyPairSync("rsa",{modulusLength:2048,
    publicKeyEncoding:{type:"spki",format:"pem"},privateKeyEncoding:{type:"pkcs8",format:"pem"}});
  const platform=generateKeyPairSync("rsa",{modulusLength:2048,
    publicKeyEncoding:{type:"spki",format:"pem"},privateKeyEncoding:{type:"pkcs8",format:"pem"}});
  const serial="AABBCCDD00112233";
  const paths={merchant:join(root,"merchant.pem"),platform:join(root,"platform.pem"),
    apiKey:join(root,"api-v3-key"),manifest:join(root,"trusted-public-keys.json")};
  await Promise.all([
    writeFile(paths.merchant,merchant.privateKey,{mode:0o600}),
    writeFile(paths.platform,platform.publicKey,{mode:0o600}),
    writeFile(paths.apiKey,"12345678901234567890123456789012",{mode:0o600}),
    writeFile(paths.manifest,JSON.stringify({schemaVersion:1,
      keys:[{id:serial,publicKeyFile:paths.platform}]}),{mode:0o600})
  ]);
  const environment={APP_ENV:"test",DATABASE_URL:"postgres://unused/cisme_test",
    APP_SESSION_SECRET:"formal-protocol-session",ADMIN_API_TOKEN:"formal-protocol-admin",
    UPLOAD_TOKEN_SECRET:"formal-protocol-upload",WECHAT_APP_ID:"wx4eac2d4fb11d299b",
    COMMERCE_FORMAL_PROTOCOL_CONFIG_ENABLED:"true",COMMERCE_FORMAL_MERCHANT_ID:"1900000001",
    COMMERCE_FORMAL_MERCHANT_SERIAL:serial,
    COMMERCE_FORMAL_MERCHANT_PRIVATE_KEY_FILE:paths.merchant,
    COMMERCE_FORMAL_API_V3_KEY_FILE:paths.apiKey,
    COMMERCE_FORMAL_PLATFORM_TRUST_FILE:paths.manifest,
    COMMERCE_FORMAL_PAYMENT_NOTIFY_URL:"https://api.example.test/v1/payments/wechat/callback",
    COMMERCE_FORMAL_REFUND_NOTIFY_URL:"https://api.example.test/v1/payments/wechat/refund-callback"};
  return {paths,platform,serial,environment};
}

it("starts with no formal profile and rejects incomplete or simultaneous simulated profiles",async()=>{
  expect(loadConfig({APP_ENV:"test",DATABASE_URL:"postgres://unused/cisme_test",
    APP_SESSION_SECRET:"session",ADMIN_API_TOKEN:"admin",UPLOAD_TOKEN_SECRET:"upload"}).commerce.formalProtocol).toBeUndefined();
  const {environment}=await fixture();
  expect(()=>loadConfig({...environment,COMMERCE_FORMAL_API_V3_KEY_FILE:""}))
    .toThrow("CONFIG_MISSING:COMMERCE_FORMAL_API_V3_KEY_FILE");
  expect(()=>loadConfig({...environment,COMMERCE_FORMAL_PAYMENT_NOTIFY_URL:"http://localhost/v1/payments/wechat/callback"}))
    .toThrow("FAIL_CLOSED:COMMERCE_FORMAL_PAYMENT_NOTIFY_URL_INVALID");
  expect(()=>loadConfig({...environment,COMMERCE_ORDER_FLOW_ENABLED:"true",
    COMMERCE_SIMULATED_PAYMENT_ENABLED:"true",COMMERCE_SIMULATED_CHANNEL_URL:"http://127.0.0.1:4444",
    COMMERCE_SIMULATED_MERCHANT_ID:"1900000001"}))
    .toThrow("FAIL_CLOSED:COMMERCE_PROTOCOL_PROFILES_MUTUALLY_EXCLUSIVE");
});

it("pins independent public keys, validates a signed response and never uses a live transport by default",async()=>{
  const {environment,platform,serial,paths}=await fixture();
  const config=loadConfig(environment),pool={} as pg.Pool;
  const inert=formalPaymentProtocol(config,pool)!;
  expect(inert.networkAuthorized).toBe(false);
  await expect(inert.channel.queryByMerchantOrderNumber("CSORDER0001"))
    .rejects.toThrow("FAIL_CLOSED:FORMAL_WECHAT_PAY_OUTBOUND_NOT_AUTHORIZED");
  let expectedSerial=serial;
  const fake=(async(_url:string|URL|Request)=>{
    const raw=JSON.stringify({appid:environment.WECHAT_APP_ID,mchid:environment.COMMERCE_FORMAL_MERCHANT_ID,
      out_trade_no:"CSORDER0001",trade_type:"JSAPI",trade_state:"SUCCESS",
      transaction_id:"synthetic-transaction",success_time:"2026-09-13T00:00:00Z",
      amount:{total:100,currency:"CNY"},payer:{openid:"synthetic-openid"}});
    const timestamp=Math.floor(Date.now()/1000).toString(),nonce="synthetic-nonce";
    const signature=sign("RSA-SHA256",Buffer.from(`${timestamp}\n${nonce}\n${raw}\n`),
      platform.privateKey).toString("base64");
    return new Response(raw,{status:200,headers:{"Wechatpay-Serial":expectedSerial,
      "Wechatpay-Timestamp":timestamp,"Wechatpay-Nonce":nonce,"Wechatpay-Signature":signature}});
  }) as typeof fetch;
  const isolated=formalPaymentProtocol(config,pool,fake)!;
  expect((await isolated.channel.queryByMerchantOrderNumber("CSORDER0001")).trade_state).toBe("SUCCESS");
  expectedSerial="UNKNOWN_SERIAL_0001";
  await expect(isolated.channel.queryByMerchantOrderNumber("CSORDER0001"))
    .rejects.toMatchObject({code:"WECHAT_PAY_FACT_INVALID"});
  await writeFile(paths.manifest,JSON.stringify({schemaVersion:1,keys:[{id:serial,publicKeyFile:paths.platform},
    {id:serial,publicKeyFile:paths.platform}]}));
  expect(()=>formalPaymentProtocol(config,pool)).toThrow("FAIL_CLOSED:FORMAL_WECHAT_PAY_TRUST_ID_INVALID");
  expect(()=>formalPaymentProtocol({...config,env:"production"},pool,fake))
    .toThrow("FAIL_CLOSED:FORMAL_WECHAT_PAY_TEST_TRANSPORT_ONLY");
});
