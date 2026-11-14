import {request} from './api';
type Visit={origin:string;shareId:string;visitKey:string;productCode?:string;token?:string};
const storage='cisme.officer-visits.v1';
function origin(){const d=getApp<IAppOption>().globalData;return JSON.stringify([d.apiBaseUrl,d.cloudFunction??null]);}
function queue():Visit[]{const r=wx.getStorageSync(storage);if(r===''||r==null)return[];
 if(!Array.isArray(r)||r.some(v=>!v||typeof v.origin!=='string'||!/^[a-f0-9]{32}$/.test(v.shareId)||typeof v.visitKey!=='string'||v.visitKey.length<16||v.token&&!/^[A-Za-z0-9_-]{43}$/.test(v.token)))throw {code:'SHARING_RECOVERY_INVALID',title:'推荐信息需要重新核对，请联系客服'};return r;}
const resolving=new Map<string,Promise<string|null>>();
function same(a:Visit,b:Visit){return a.origin===b.origin&&a.shareId===b.shareId&&a.visitKey===b.visitKey;}
function discard(entry:Visit){wx.setStorageSync(storage,queue().filter(v=>!same(v,entry)));}
async function resolve(entry:Visit):Promise<string|null>{
 const key=entry.origin+entry.visitKey;if(resolving.has(key))return resolving.get(key)!;
 const session=getApp<IAppOption>().globalData.sessionToken;
 const task=(async()=>{
  const result=await request<{productCode:string;visitToken:string|null}>({path:`/v1/officer-shares/${entry.shareId}/visits`,method:'POST',authMode:'public',data:{visitKey:entry.visitKey}});
  if(entry.origin!==origin()||session&&session!==getApp<IAppOption>().globalData.sessionToken)return null;
  if(entry.productCode&&result.productCode!==entry.productCode){discard(entry);throw {code:'SHARING_TARGET_MISMATCH',title:'分享商品与链接不一致'};}
  if(!result.visitToken){discard(entry);return result.productCode;}
  if(!/^[A-Za-z0-9_-]{43}$/.test(result.visitToken))throw {title:'推荐信息暂未确认，请重试'};
  wx.setStorageSync(storage,queue().map(v=>same(v,entry)?{...v,productCode:result.productCode,token:result.visitToken}:v));
  return result.productCode;
 })();resolving.set(key,task);try{return await task;}catch(error){if(['SHARING_LINK_NOT_FOUND','SHARING_INPUT_INVALID'].includes(String((error as {code?:string})?.code))){discard(entry);return null;}throw error;}finally{if(resolving.get(key)===task)resolving.delete(key);}
}
let flushing:Promise<void>|null=null,flushingOwner='';
export async function incomingOfficerShare(shareId:string|undefined,expectedProduct?:string):Promise<string|null>{
 if(!shareId||!/^[a-f0-9]{32}$/.test(shareId))return null;
 const from=origin(),entry:Visit={origin:from,shareId,visitKey:`v-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`,...(expectedProduct?{productCode:expectedProduct}:{})};
 wx.setStorageSync(storage,[...queue(),entry]);
 const product=await resolve(entry);if(getApp<IAppOption>().globalData.sessionToken)await flushOfficerVisits();return product;
}
export function flushOfficerVisits():Promise<void>{
 const session=getApp<IAppOption>().globalData.sessionToken,from=origin();if(!session)return Promise.resolve();
 if(flushing&&flushingOwner===session+from)return flushing;
 flushingOwner=session+from;
 const task=(async()=>{for(;;){
  const entries=queue().filter(v=>v.origin===from);if(!entries.length)return;
  for(const saved of entries){
   if(session!==getApp<IAppOption>().globalData.sessionToken||from!==origin())return;
   if(!saved.token)await resolve(saved);
   const entry=queue().find(v=>same(v,saved));if(!entry)continue;if(!entry.token)throw {title:'推荐信息暂未同步，请重试'};
   if(session!==getApp<IAppOption>().globalData.sessionToken||from!==origin())return;
   try{await request({path:'/v1/me/sharing-officer/commands',method:'POST',idempotencyKey:`touch-${entry.token}`,data:{action:'bind_visit',input:{visitToken:entry.token}}});}
   catch(error){if(!['SHARING_VISIT_ALREADY_BOUND','SHARING_VISIT_NOT_FOUND'].includes(String((error as {code?:string})?.code)))throw error;}
   if(session!==getApp<IAppOption>().globalData.sessionToken||from!==origin())return;discard(entry);
  }
 }})();flushing=task;void task.finally(()=>{if(flushing===task)flushing=null;}).catch(()=>{});return task;
}
