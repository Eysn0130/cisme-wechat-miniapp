import {DomainError} from '@cisme/domain';
/** Bound identity/phone/content responses while streaming, not after buffering.
 * Errors never include upstream payloads or credential-bearing URLs. */
export async function boundedWechatJson<T>(response:Response):Promise<T>{
 const failed=()=>new DomainError('WECHAT_DEPENDENCY_RESPONSE_INVALID','微信服务响应暂不可用，请稍后重试',502);
 if(!response.ok){await response.body?.cancel();throw failed();}
 const reader=response.body?.getReader();if(!reader)throw failed();
 const chunks:Uint8Array[]=[];let size=0;
 try{
  for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;
   if(size>65_536){await reader.cancel();throw failed();}chunks.push(value);}
  const result=JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if(!result||typeof result!=='object'||Array.isArray(result))throw failed();
  return result as T;
 }catch{throw failed();}finally{reader.releaseLock();}
}
