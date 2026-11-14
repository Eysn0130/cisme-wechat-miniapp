import {request} from './api';
import {pageRead} from './page-requests';
import {clientOperationKey} from './orders';
import {commerceUuid} from './commerce-command-store';
export const officerLabels:Record<string,string>={pending:'审核中',rejected:'未通过',active:'已开通',suspended:'已暂停',terminated:'已终止',prepared:'待审核',reviewed:'待付款',paid:'已付款',voided:'已撤销'};
export const officerMoney=(value:number|null|undefined)=>value==null?'—':(value/100).toFixed(2);
export function officerDate(value:string|null|undefined){if(!value)return'';const d=new Date(value);if(!Number.isFinite(d.getTime()))return'';const n=new Date(d.getTime()+8*3600_000);return n.toISOString().slice(0,16).replace('T',' ');}
export const officerError=(error:unknown)=>String((error as {title?:string})?.title||'暂未完成，请重试');
export function officerHistoryRow(r:any){const label:Record<string,string>={accrual:'佣金入账',refund_reversal:'退款冲回',release:'转为可结算',settlement:'财务已结算',refund_record:'商品退款',payment_record:'月结付款记录',recovery_record:'冲回已核对'};
 return {...r,label:label[r.kind]||'佣金记录',date:officerDate(r.at),amount:officerMoney(r.kind==='refund_record'?r.merchandiseCents:r.amountCents),
  gross:officerMoney(r.settlementGrossCents),tax:officerMoney(r.settlementTaxCents),net:officerMoney(r.settlementNetCents),received:officerMoney(r.receivedCents),taxAdjustment:officerMoney(r.taxAdjustmentCents),stateLabel:officerLabels[r.state]||''};}
export interface OfficerPending{owner:string;origin:string;key:string;management:boolean;action:string}
const storage='cisme.sharing-command.v1';
function origin(){const d=getApp<IAppOption>().globalData;return JSON.stringify([d.apiBaseUrl,d.cloudFunction??null]);}
function all():OfficerPending[]{const r=wx.getStorageSync(storage);if(r===''||r==null)return[];
 if(!Array.isArray(r)||r.some(v=>!v||!commerceUuid.test(v.owner)||typeof v.origin!=='string'||!/^[A-Za-z0-9._:-]{8,160}$/.test(v.key)||typeof v.action!=='string'||typeof v.management!=='boolean'))throw {title:'上次操作需要核对，请联系客服'};return r;}
export function officerPending(owner:string){return all().find(v=>v.owner===owner&&v.origin===origin())??null;}
export function clearOfficerPending(p:OfficerPending){wx.setStorageSync(storage,all().filter(v=>v.owner!==p.owner||v.origin!==p.origin||v.key!==p.key));}
export async function officerCommand<T=any>(owner:string,action:string,input:Record<string,unknown>,management=false):Promise<T>{
 if(!commerceUuid.test(owner))throw {title:'请重新登录'};
 if(officerPending(owner))throw {title:'请先核对上次操作'};
 const p:OfficerPending={owner,origin:origin(),key:clientOperationKey('sharing'),management,action};wx.setStorageSync(storage,[...all(),p]);
 try{const result=await request<T>({path:`/v1/${management?'management':'me'}/sharing-officer/commands`,method:'POST',idempotencyKey:p.key,data:{action,input}});clearOfficerPending(p);return result;}
 catch(error){const status=Number((error as {status?:number})?.status);if(status>=400&&status<500&&status!==408&&status!==429)clearOfficerPending(p);throw error;}
}
export async function resolveOfficerPending(p:OfficerPending,abandon=false){
 const result=await request<{state:string}>({path:`/v1/me/sharing-officer/commands/${p.key}${abandon?'/abandon':''}`,...(abandon?{method:'POST' as const}:{})});
 if(result.state==='completed'||result.state==='abandoned')clearOfficerPending(p);return result;
}
export function officerRead<T=any>(page:object,path:string){return pageRead<T>(page,{path});}
