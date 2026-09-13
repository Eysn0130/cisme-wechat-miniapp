import { createPrivateKey, createPublicKey } from "node:crypto";
import { readFileSync } from "node:fs";
import type pg from "pg";
import type { AppConfig } from "@cisme/config";
import { VerifiedPaymentInbox } from "./verifiedPaymentInbox.js";
import { VerifiedRefundInbox } from "./verifiedRefundInbox.js";
import { TransferCallbackInbox } from "./transferCallbackInbox.js";
import { WechatPayV3Client } from "./wechatPayV3.js";

type TrustManifest={schemaVersion:1;keys:Array<{id:string;publicKeyFile:string}>};
const disabledTransport:typeof fetch=async()=>{throw new Error("FAIL_CLOSED:FORMAL_WECHAT_PAY_OUTBOUND_NOT_AUTHORIZED");};

/** Validate a pinned, operator-supplied set of trust anchors at startup.
 * Unknown response/callback serials are rejected; they are never fetched
 * and trusted dynamically from an unauthenticated response. Rotations are
 * installed as an explicit overlapping manifest update. */
export function loadFormalWechatPayTrust(profile:NonNullable<AppConfig["commerce"]["formalProtocol"]>){
  const privatePem=readFileSync(profile.merchantPrivateKeyFile,"utf8");
  const privateKey=createPrivateKey(privatePem);
  if(privateKey.asymmetricKeyType!=="rsa"||
    (privateKey.asymmetricKeyDetails?.modulusLength??0)<2048)
    throw new Error("FAIL_CLOSED:FORMAL_WECHAT_PAY_MERCHANT_RSA_INVALID");
  const apiV3Key=readFileSync(profile.apiV3KeyFile,"utf8").trimEnd();
  if(Buffer.byteLength(apiV3Key)!==32)throw new Error("FAIL_CLOSED:FORMAL_WECHAT_PAY_API_V3_KEY_INVALID");
  let manifest:TrustManifest;
  try{manifest=JSON.parse(readFileSync(profile.platformTrustManifestFile,"utf8")) as TrustManifest;}
  catch{throw new Error("FAIL_CLOSED:FORMAL_WECHAT_PAY_TRUST_MANIFEST_INVALID");}
  if(manifest.schemaVersion!==1||!Array.isArray(manifest.keys)||
    manifest.keys.length<1||manifest.keys.length>8)
    throw new Error("FAIL_CLOSED:FORMAL_WECHAT_PAY_TRUST_MANIFEST_INVALID");
  const platformKeys=new Map<string,string>();
  for(const key of manifest.keys){
    if(typeof key.id!=="string"||!/^([A-F0-9]{16,64}|PUB_KEY_ID_[A-Za-z0-9_]{8,100})$/.test(key.id)||
      typeof key.publicKeyFile!=="string"||!key.publicKeyFile.startsWith("/")||
      key.publicKeyFile.includes("\0")||platformKeys.has(key.id))
      throw new Error("FAIL_CLOSED:FORMAL_WECHAT_PAY_TRUST_ID_INVALID");
    const publicPem=readFileSync(key.publicKeyFile,"utf8");
    const publicKey=createPublicKey(publicPem);
    if(publicKey.asymmetricKeyType!=="rsa"||
      (publicKey.asymmetricKeyDetails?.modulusLength??0)<2048)
      throw new Error("FAIL_CLOSED:FORMAL_WECHAT_PAY_TRUST_RSA_INVALID");
    platformKeys.set(key.id,publicPem);
  }
  return {privatePem,apiV3Key,platformKeys};
}

/** Protocol wiring is inert by default: credentials only validate local
 * identity and pinned keys. A synthetic transport may be injected in an
 * isolated test. Live command/callback/worker enablement requires separate
 * reviewed gates and is deliberately not inferred from configuration. */
export function formalPaymentProtocol(config:AppConfig,pool:pg.Pool,testTransport?:typeof fetch){
  const profile=config.commerce.formalProtocol;
  if(!profile)return undefined;
  if(testTransport&&config.env!=="test")
    throw new Error("FAIL_CLOSED:FORMAL_WECHAT_PAY_TEST_TRANSPORT_ONLY");
  const {privatePem,apiV3Key,platformKeys}=loadFormalWechatPayTrust(profile);
  const channel=new WechatPayV3Client(profile.merchantId,profile.merchantSerial,
    privatePem,platformKeys,testTransport??disabledTransport);
  const inbox=new VerifiedPaymentInbox(pool,{appId:profile.appId,
    merchantId:profile.merchantId,apiV3Key,platformKeys});
  const refundInbox=new VerifiedRefundInbox(pool,{merchantId:profile.merchantId,apiV3Key,platformKeys});
  const transferInbox=profile.transferSceneId
    ?new TransferCallbackInbox(pool,{merchantId:profile.merchantId,apiV3Key,platformKeys}):undefined;
  return {channel,inbox,refundInbox,...(transferInbox?{transferInbox}:{}),
    paymentNotifyUrl:profile.paymentNotifyUrl,refundNotifyUrl:profile.refundNotifyUrl,
    ...(profile.transferNotifyUrl?{transferNotifyUrl:profile.transferNotifyUrl}:{}),
    networkAuthorized:false as const,isolatedSyntheticTransport:Boolean(testTransport)};
}
