import {loadConfig} from '@cisme/config';
import {protectedText} from '../services/api/src/formalPaymentAuthorization.js';
import {shippingAuthorization} from '../services/api/src/fulfillmentRuntime.js';
import {WechatTradeAccountClient} from '../services/api/src/wechatTradeAccount.js';
import {boundedWechatJson} from '../services/api/src/boundedWechatJson.js';

// No cookies, UI session, arbitrary host, payment or shipping-upload operation.
const config=loadConfig(),profile=config.commerce.fulfillment;
if(!profile||!config.wechat.appSecret||!['production','staging'].includes(config.env))throw Error('WECHAT_TRADE_PROFILE_REQUIRED');
const args=process.argv.slice(2),configuration=args.includes('--configure-paths');
const flag=(name:string)=>args[args.indexOf(name)+1];
const version=configuration?flag('--published-version'):undefined;
const authorizeRead=()=>{shippingAuthorization(config)('shipping.query');};
const authorizeWrite=()=>{
 const path=flag('--approval-file');if(!args.includes('--approval-file')||!path)throw Error('PROTECTED_PATH_APPROVAL_REQUIRED');
 const grant=JSON.parse(protectedText(path));
 if(grant.schemaVersion!==1||grant.mode!=='wechat-published-order-paths'||grant.environment!==config.env
   ||grant.appId!==profile.appId||grant.merchantId!==profile.merchantId||grant.publishedClientVersion!==version
   ||grant.orderCenterAgreementConfirmed!==true||typeof grant.approvalReference!=='string'||grant.approvalReference.length<8
   ||typeof grant.expiresAt!=='string'||!Number.isFinite(Date.parse(grant.expiresAt))||Date.parse(grant.expiresAt)<=Date.now())throw Error('PUBLISHED_PATH_APPROVAL_INVALID');
};
let accessToken:string|undefined;
const token=async()=>{
 if(accessToken)return accessToken;
 authorizeRead();const response=await fetch('https://api.weixin.qq.com/cgi-bin/stable_token',{
  method:'POST',headers:{'Content-Type':'application/json'},redirect:'error',signal:AbortSignal.timeout(15000),
  body:JSON.stringify({grant_type:'client_credential',appid:profile.appId,secret:config.wechat.appSecret})});
 const body=await boundedWechatJson<Record<string,unknown>>(response);
 if(!response.ok||typeof body.access_token!=='string'||!body.access_token||body.access_token.length>4096)throw Error('WECHAT_TOKEN_UNAVAILABLE');
 accessToken=body.access_token;return accessToken;
};
try{
 const client=new WechatTradeAccountClient(profile.appId,token,authorizeRead,fetch,authorizeWrite);
 const observed=await client.read();
 if(!configuration)console.log(JSON.stringify(observed));
 else{
  if(observed.managed!==true||observed.settlementConfirmed!==true)throw Error('WECHAT_TRADE_ENROLLMENT_INCOMPLETE');
  console.log(JSON.stringify(await client.configurePublishedPaths(version??'')));
 }
}catch(error){
 // Never print fetch errors carrying access_token URLs or platform response text.
 console.error(JSON.stringify({success:false,code:(error as {code?:string}).code??'WECHAT_TRADE_OPERATION_NOT_VERIFIED'}));process.exitCode=1;
}
