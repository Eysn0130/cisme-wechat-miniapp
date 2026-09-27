import {queryShippingAccountReadiness} from '../../services/api/src/wechatOrderShipping';
import {boundedWechatJson} from '../../services/api/src/boundedWechatJson';
const appId=process.env.WECHAT_APP_ID,secret=process.env.WECHAT_APP_SECRET;
const observations:Array<Record<string,unknown>>=[];
const start=Date.now();let checks=0,tokenCalls=0;
const authorization=()=>{
 if(process.argv[2]!=='--read-only-app-status'||appId!=='wx4eac2d4fb11d299b'||!secret||Date.now()-start>120_000||++checks>3)
   throw Error('READ_ONLY_STATUS_SCOPE');
};
try{
 const result=await queryShippingAccountReadiness(appId!,async()=>{
  if(++tokenCalls>1)throw Error('TOKEN_REQUEST_LIMIT');
  const response=await fetch('https://api.weixin.qq.com/cgi-bin/stable_token',{method:'POST',headers:{'Content-Type':'application/json'},
   body:JSON.stringify({grant_type:'client_credential',appid:appId,secret}),redirect:'error',signal:AbortSignal.timeout(15000)});
  const data=await boundedWechatJson<{access_token?:string;expires_in?:number;errcode?:number}>(response);
  observations.push({operation:'stable_token',httpStatus:response.status,errcode:data.errcode??0,tokenReceived:typeof data.access_token==='string'});
  if(!data.access_token||typeof data.expires_in!=='number'||data.expires_in<=0||data.expires_in>7200)throw Error('TOKEN_UNAVAILABLE');
  return data.access_token;
 },authorization,async(input,init)=>{
  const url=new URL(String(input));
  if(url.origin!=='https://api.weixin.qq.com'||!['/wxa/sec/order/is_trade_managed','/wxa/sec/order/is_trade_management_confirmation_completed'].includes(url.pathname))throw Error('READ_ONLY_STATUS_PATH');
  const response=await fetch(input,init);
  observations.push({operation:url.pathname.split('/').at(-1),httpStatus:response.status});
  return response;
 });
 console.log(JSON.stringify({ok:result.checks.every(x=>x.verified),appId,approvalReference:'CISME-R5-USER-READ-ONLY-20260926',observedAt:new Date().toISOString(),...result,observations,orderQueries:0,shippingWrites:0,fundsWrites:0}));
}catch{
 console.log(JSON.stringify({ok:false,code:'SHIPPING_READINESS_NOT_VERIFIED',observedAt:new Date().toISOString(),observations,orderQueries:0,shippingWrites:0,fundsWrites:0}));process.exitCode=1;
}
