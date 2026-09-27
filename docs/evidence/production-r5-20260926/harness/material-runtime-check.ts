import {createPrivateKey,sign,verify,X509Certificate} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {loadConfig} from '@cisme/config';
import {formalPaymentProtocol,loadFormalWechatPayTrust} from '../../services/api/src/formalPaymentProtocol';
import {commerceAuthorization} from '../../services/api/src/formalCommerceAuthorization';
import {shippingAuthorization,fulfillmentRuntime} from '../../services/api/src/fulfillmentRuntime';
import type pg from 'pg';
try {
 const config=loadConfig(process.env),profile=config.commerce.formalProtocol!;
 if(config.env!=='production'||profile.appId!=='wx4eac2d4fb11d299b'||profile.merchantId!=='1000579096')throw Error('IDENTITY');
 const trust=loadFormalWechatPayTrust(profile),protocol=formalPaymentProtocol(config,{} as pg.Pool)!;
 const challenge=Buffer.from('CISME R5 offline runtime identity check');
 if(!trust.merchantCertificate||!verify('RSA-SHA256',challenge,trust.merchantCertificate.publicKey,sign('RSA-SHA256',challenge,trust.privatePem)))throw Error('SIGNATURE');
 if(trust.activePublicKeyId!=='PUB_KEY_ID_0111178110872026092600191735000402')throw Error('TRUST');
 const shipping=fulfillmentRuntime(config,{} as pg.Pool);
 const capabilities:Record<string,boolean>={};
 for(const cap of ['order.create','payment.prepare','payment.close','refund.request','refund.approve','refund.submit'] as const){
   try{protocol.authorizeCommerce?.(cap);capabilities[cap]=Boolean(protocol.authorizeCommerce);}catch{capabilities[cap]=false;}
 }
 for(const cap of ['payment.query','refund.query','bill.read','payment.callback','refund.callback'] as const){
   try{protocol.authorizeRecovery(cap);capabilities[cap]=true;}catch{capabilities[cap]=false;}
 }
 for(const cap of ['shipping.query','shipping.upload'] as const){
   try{shippingAuthorization(config)(cap);capabilities[cap]=true;}catch{capabilities[cap]=false;}
 }
 console.log(JSON.stringify({ok:true,uid:process.getuid?.(),environment:config.env,merchantIdentityBound:true,merchantCertificateExpiresAt:trust.merchantCertificate.validTo,
   publicKeyMode:true,localSignatureVerified:true,formalProtocolLoaded:true,fulfillmentLoaded:Boolean(shipping),
   commerceEnabled:config.commerce.orderFlowEnabled,capabilities,networkRequests:0,databaseRequests:0,productionDeployed:false}));
}catch{console.error(JSON.stringify({ok:false,code:'R5_PRIVATE_RUNTIME_CHECK_FAILED'}));process.exitCode=1;}
