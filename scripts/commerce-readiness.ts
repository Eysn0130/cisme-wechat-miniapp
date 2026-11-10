import {loadConfig} from '@cisme/config';
import {createPool} from '../services/api/src/db.js';
import {formalPaymentProtocol,loadFormalWechatPayTrust} from '../services/api/src/formalPaymentProtocol.js';
import {shippingAuthorization,fulfillmentRuntime} from '../services/api/src/fulfillmentRuntime.js';
const config=loadConfig();
if(config.env!=='staging'||decodeURIComponent(new URL(config.databaseUrl).pathname.slice(1))!=='cisme_trial')throw Error('READINESS_TARGET_MISMATCH');
const pool=createPool(config.databaseUrl,config.database);
try{
  if((await pool.query('SELECT current_database() name')).rows[0]?.name!=='cisme_trial')throw Error('READINESS_DATABASE_MISMATCH');
  const profile=config.commerce.formalProtocol;if(!profile)throw Error('READINESS_PAYMENT_PROFILE_MISSING');
  const trust=loadFormalWechatPayTrust(profile),protocol=formalPaymentProtocol(config,pool)!;
  for(const capability of ['order.create','payment.prepare','payment.close'] as const)protocol.authorizeCommerce!(capability);
  for(const capability of ['payment.query','payment.callback','refund.query','refund.callback','bill.read'] as const)protocol.authorizeRecovery(capability);
  const shipping=shippingAuthorization(config);for(const capability of ['shipping.query','shipping.upload','logistics.accounts.read'] as const)shipping(capability);
  let providerRead:'not_requested'|'signed_order_not_found'|'signed_order_found'='not_requested';
  if(process.argv.includes('--query-merchant')){
    try{await protocol.channel.queryByMerchantOrderNumber('READYCISME20261110');providerRead='signed_order_found';}
    catch(error){if((error as {code?:string}).code==='WECHAT_PAY_ORDER_NOT_FOUND')providerRead='signed_order_not_found';else throw error;}
  }
  let logistics:{accountCount:number;carrierCount:number}|null=null;
  if(process.argv.includes('--query-logistics')){const runtime=fulfillmentRuntime(config,pool)!;const result=await runtime.service.logisticsCapabilities('8d2b65b6-c165-4186-b4d0-5fdda9c67456');logistics={accountCount:result.accounts.length,carrierCount:result.carriers.length};}
  console.log(JSON.stringify({ready:true,database:'cisme_trial',environment:'staging',realMerchantTrustValidated:true,merchantCertificateValidUntil:trust.merchantCertificate?.validTo,platformTrustKeyCount:trust.platformKeys.size,orderFlowEnabled:config.commerce.orderFlowEnabled,fulfillmentEnabled:Boolean(config.commerce.fulfillment),providerRead,logistics,orderTrackingNotExercised:true,paymentOrOrderCreated:false},null,2));
}catch(error){console.error(JSON.stringify({ready:false,code:(error as {code?:string}).code??'READINESS_CHECK_FAILED',name:(error as Error).name}));process.exitCode=1;}
finally{await pool.end();}
