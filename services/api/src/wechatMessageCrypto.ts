import { createDecipheriv, createHash, timingSafeEqual } from "node:crypto";
import { DomainError } from "@cisme/domain";

export type MessageQuery={signature?:unknown;msg_signature?:unknown;timestamp?:unknown;nonce?:unknown};
const unauthorized=()=>new DomainError("UGC_CALLBACK_UNAUTHORIZED","内容安全回调未通过密文认证",401);

/** Mini-program message push encryption is distinct from WeChat Pay API v3.
 * Signature binds the ciphertext; decrypted framing binds the recipient. */
export function decryptWechatMessage(query:MessageQuery,ciphertext:unknown,
  options:{token:string|null;aesKey:string|null;appId:string|null},now=Date.now()):string{
  if(!options.token||!options.aesKey||!options.appId||typeof ciphertext!=="string"||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(ciphertext)||ciphertext.length>256_000||
    typeof query.timestamp!=="string"||!/^\d{10}$/.test(query.timestamp)||
    Math.abs(now/1000-Number(query.timestamp))>300||
    typeof query.nonce!=="string"||!query.nonce||query.nonce.length>100||
    typeof query.msg_signature!=="string"||!/^[0-9a-f]{40}$/.test(query.msg_signature))throw unauthorized();
  const signature=createHash("sha1").update([options.token,query.timestamp,query.nonce,ciphertext]
    .sort().join("")).digest("hex");
  const actual=Buffer.from(query.msg_signature,"ascii"),expected=Buffer.from(signature,"ascii");
  if(!timingSafeEqual(actual,expected))throw unauthorized();
  try{
    const key=Buffer.from(`${options.aesKey}=`,"base64");
    if(key.length!==32)throw unauthorized();
    const encrypted=Buffer.from(ciphertext,"base64");
    if(!encrypted.length||encrypted.length%16!==0)throw unauthorized();
    const decoder=createDecipheriv("aes-256-cbc",key,key.subarray(0,16));
    decoder.setAutoPadding(false);
    const padded=Buffer.concat([decoder.update(encrypted),decoder.final()]);
    const padding=padded.at(-1)??0;
    if(padding<1||padding>32||padding>padded.length||
      !padded.subarray(-padding).every(byte=>byte===padding))throw unauthorized();
    const plain=padded.subarray(0,-padding);
    if(plain.length<20)throw unauthorized();
    const size=plain.readUInt32BE(16);
    if(size===0||size>128_000||20+size>plain.length)throw unauthorized();
    const recipient=plain.subarray(20+size).toString("utf8");
    if(recipient!==options.appId)throw unauthorized();
    return plain.subarray(20,20+size).toString("utf8");
  }catch{throw unauthorized();}
}
