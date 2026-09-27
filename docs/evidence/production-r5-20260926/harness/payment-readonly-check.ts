import {randomBytes} from 'node:crypto';
import {loadConfig} from '@cisme/config';
import {formalPaymentProtocol} from '../../services/api/src/formalPaymentProtocol';
import type pg from 'pg';
const observed:Array<Record<string,unknown>>=[];
const config=loadConfig(process.env);
if(process.argv[2]!=='--single-synthetic-order-query'||config.env!=='production'||config.commerce.formalProtocol?.merchantId!=='1000579096'||config.wechat.appId!=='wx4eac2d4fb11d299b')throw Error('READ_ONLY_QUERY_SCOPE');
const outTradeNo='R5READONLY20260926'+randomBytes(5).toString('hex');
const expectedPath='/v3/pay/transactions/out-trade-no/'+outTradeNo;
const network=globalThis.fetch;let calls=0;
// Observe the real transport after its ordinary recovery grant check; no
// protocol testTransport, synthetic signer, orders, payments or callback writes.
globalThis.fetch=async(input,init)=>{
 const url=new URL(String(input));
 if(++calls!==1||url.origin!=='https://api.mch.weixin.qq.com'||url.pathname!==expectedPath||init?.method!=='GET'||url.searchParams.get('mchid')!=='1000579096')throw Error('READ_ONLY_QUERY_SCOPE');
 const response=await network(input,init);
 const serial=response.headers.get('Wechatpay-Serial');
 observed.push({httpStatus:response.status,requestPublicKeyId:new Headers(init.headers).get('Wechatpay-Serial'),
   responseSigner:serial&&/^[A-Za-z0-9_]{8,120}$/.test(serial)?serial:null,responseSignaturePresent:Boolean(response.headers.get('Wechatpay-Signature'))});
 return response;
};
try{
 const protocol=formalPaymentProtocol(config,{} as pg.Pool)!;
 protocol.authorizeRecovery('payment.query');
 await protocol.channel.queryByMerchantOrderNumber(outTradeNo);
 console.log(JSON.stringify({ok:false,code:'UNEXPECTED_ORDER_PRESENT',observed,requests:calls,fundsWrites:0}));
}catch(error){
 const code=typeof (error as {code?:unknown}).code==='string'?(error as {code:string}).code:'TRANSPORT_OR_CONFIGURATION_UNAVAILABLE';
 console.log(JSON.stringify({ok:code==='WECHAT_PAY_ORDER_NOT_FOUND',code,signedNotFoundVerified:code==='WECHAT_PAY_ORDER_NOT_FOUND',
   observedAt:new Date().toISOString(),observed,requests:calls,syntheticOrderNumberOnly:true,orderCreated:false,fundsWrites:0,realCallbackTested:false}));
}finally{globalThis.fetch=network;}
