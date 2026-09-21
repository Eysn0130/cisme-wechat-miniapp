import {DomainError} from '@cisme/domain';
import {dependencySignal} from './operationBudget.js';

/** jscode2session is an identity exchange only; never expose its response or
 * credentials in an error, and never follow a redirect carrying the secret. */
export async function exchangeWechatIdentity(appId:string,appSecret:string,code:unknown,fetcher:typeof fetch=fetch){
 if(typeof code!=='string'||code.length<1||code.length>256||/[\s\x00-\x1f]/.test(code))
  throw new DomainError('WECHAT_LOGIN_CODE_INVALID','微信登录凭证无效，请重新登录',422);
 const failed=()=>new DomainError('WECHAT_LOGIN_FAILED','微信登录暂不可用，请重新登录',502);
 try{
  const response=await fetcher(`https://api.weixin.qq.com/sns/jscode2session?appid=${encodeURIComponent(appId)}&secret=${encodeURIComponent(appSecret)}&js_code=${encodeURIComponent(code)}&grant_type=authorization_code`,
   {signal:dependencySignal(12_000),redirect:'error'});
  if(!response.ok){await response.body?.cancel();throw failed();}
  const reader=response.body?.getReader();if(!reader)throw failed();
  const chunks:Uint8Array[]=[];let size=0;
  try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;
   if(size>65_536){await reader.cancel();throw failed();}chunks.push(value);}}
  finally{reader.releaseLock();}
  const body=JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string,unknown>;
  const valid=(value:unknown):value is string=>typeof value==='string'&&value.length>0&&value.length<=128&&!/[\s\x00-\x1f]/.test(value);
  if(!body||!valid(body.openid)||(body.errcode!==undefined&&body.errcode!==0)||(body.unionid!==undefined&&!valid(body.unionid)))throw failed();
  return {openid:body.openid,...(valid(body.unionid)?{unionid:body.unionid}:{})};
 }catch{throw failed();}
}
