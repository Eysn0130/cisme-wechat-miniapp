import { createPrivateKey, createPublicKey } from "node:crypto";
import { readFileSync } from "node:fs";
import type pg from "pg";
import type { AppConfig } from "@cisme/config";
import { VerifiedPaymentInbox } from "./verifiedPaymentInbox.js";
import { VerifiedRefundInbox } from "./verifiedRefundInbox.js";
import { WechatPayV3Client } from "./wechatPayV3.js";
import { TransferCallbackInbox } from "./transferCallbackInbox.js";

function required(name:string){
  const value=process.env[name]?.trim();
  if(!value)throw new Error(`FAIL_CLOSED:ISOLATED_PAYMENT_${name}_REQUIRED`);
  return value;
}
function pem(name:string){
  const path=required(name);
  if(!path.startsWith("/"))throw new Error(`FAIL_CLOSED:ISOLATED_PAYMENT_${name}_ABSOLUTE_REQUIRED`);
  return readFileSync(path,"utf8");
}

/** Runtime assembly deliberately has no production branch. Fixture keys are
 * supplied through local files, never shipped in the repository or logs. */
export function isolatedPaymentProtocol(config:AppConfig,pool:pg.Pool){
  const profile=config.commerce.simulatedPayment;
  if(!profile)return undefined;
  if(config.env!=="test")throw new Error("FAIL_CLOSED:ISOLATED_PAYMENT_TEST_ONLY");
  const merchantSerial=required("COMMERCE_FIXTURE_MERCHANT_SERIAL"),
    platformSerial=required("COMMERCE_FIXTURE_PLATFORM_SERIAL"),
    apiV3Key=required("COMMERCE_FIXTURE_API_V3_KEY"),
    merchantPrivate=pem("COMMERCE_FIXTURE_MERCHANT_PRIVATE_KEY_FILE"),
    platformPublic=pem("COMMERCE_FIXTURE_PLATFORM_PUBLIC_KEY_FILE"),
    paymentNotifyUrl=required("COMMERCE_FIXTURE_PAYMENT_NOTIFY_URL"),
    refundNotifyUrl=required("COMMERCE_FIXTURE_REFUND_NOTIFY_URL"),
    transferNotifyUrl=profile.transferSceneId?required("COMMERCE_FIXTURE_TRANSFER_NOTIFY_URL"):undefined;
  if(Buffer.byteLength(apiV3Key)!==32||!/^https:\/\/[^/?#]+\/v1\/payments\/wechat\/callback$/.test(paymentNotifyUrl)||
    !/^https:\/\/[^/?#]+\/v1\/payments\/wechat\/refund-callback$/.test(refundNotifyUrl)||
    (transferNotifyUrl&&!/^https:\/\/[^/?#]+\/v1\/payments\/wechat\/transfer-callback$/.test(transferNotifyUrl)))
    throw new Error("FAIL_CLOSED:ISOLATED_PAYMENT_PROTOCOL_CONFIG_INVALID");
  createPrivateKey(merchantPrivate);createPublicKey(platformPublic);
  const platformKeys=new Map([[platformSerial,platformPublic]]);
  const channel=new WechatPayV3Client(profile.merchantId,merchantSerial,merchantPrivate,
    platformKeys,fetch,profile.channelUrl);
  const inbox=new VerifiedPaymentInbox(pool,{appId:profile.appId,merchantId:profile.merchantId,
    apiV3Key,platformKeys});
  const refundInbox=new VerifiedRefundInbox(pool,{merchantId:profile.merchantId,apiV3Key,platformKeys});
  const transferInbox=profile.transferSceneId
    ?new TransferCallbackInbox(pool,{merchantId:profile.merchantId,apiV3Key,platformKeys}):undefined;
  return {channel,inbox,refundInbox,paymentNotifyUrl,refundNotifyUrl,
    ...(transferNotifyUrl?{transferNotifyUrl}:{}),...(transferInbox?{transferInbox}:{})};
}
