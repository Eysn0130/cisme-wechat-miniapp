import {clientOperationKey} from './orders';
import {commerceUuid} from './commerce-command-store';
const storage='cisme.reward-command.v1';
export interface RewardPending{ownerId:string;environment:string;key:string;kind:'claim'|'management';objectId:string;quoteId?:string}
function environment(){const d=getApp<IAppOption>().globalData;return JSON.stringify([d.apiBaseUrl,d.cloudFunction??null]);}
const failure=()=>({code:'REWARD_RECOVERY_STORAGE',title:'上次操作需要核对，请联系客服'});
function rows():RewardPending[]{try{const r=wx.getStorageSync(storage);if(r===undefined||r===null||r==='')return [];
 if(!Array.isArray(r)||r.length>16||r.some(v=>!v||!commerceUuid.test(v.ownerId)||!['claim','management'].includes(v.kind)||typeof v.environment!=='string'||v.environment.length>1000||!/^[A-Za-z0-9._:-]{8,200}$/.test(v.key)||typeof v.objectId!=='string'||v.objectId.length>80||v.kind==='claim'&&!commerceUuid.test(v.quoteId??'')||Object.keys(v).some(k=>!['ownerId','environment','key','kind','objectId','quoteId'].includes(k))))throw failure();return r;
 }catch{throw failure();}}
function write(v:RewardPending[]){try{if(v.length>16)throw failure();wx.setStorageSync(storage,v);if(JSON.stringify(rows())!==JSON.stringify(v))throw failure();}catch{throw failure();}}
export function pendingReward(ownerId:string){return rows().find(r=>r.ownerId===ownerId&&r.environment===environment())??null;}
export function prepareReward(ownerId:string,kind:RewardPending['kind'],objectId:string,quoteId?:string){
 if(!commerceUuid.test(ownerId)||kind==='claim'&&!commerceUuid.test(quoteId??''))throw failure();
 const existing=pendingReward(ownerId);if(existing){if(existing.kind===kind&&existing.objectId===objectId&&existing.quoteId===quoteId)return existing;throw {code:'REWARD_RECOVERY_PENDING',title:'请先核对上次操作'};}
 const value:RewardPending={ownerId,environment:environment(),key:clientOperationKey('reward'),kind,objectId,...(quoteId?{quoteId}:{})};write([...rows(),value]);return value;
}
export function forgetReward(value:RewardPending){write(rows().filter(r=>!(r.ownerId===value.ownerId&&r.environment===value.environment&&r.key===value.key)));}
