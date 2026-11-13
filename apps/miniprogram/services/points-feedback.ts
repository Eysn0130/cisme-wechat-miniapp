import {commerceUuid,commerceContextRevision} from './commerce-command-store';
import {validCareDay} from './daily-care';
import type {PointsSnapshot} from './points';
import type {CareDayRewards} from './care-usage';
export type CreditIntent={kind:'questionnaire';operation:string;queuedAt:number}|{kind:'care';operation:string;queuedAt:number;day:string;before:string[]};
type Feedback={version:1;pending:CreditIntent[];firstSeen:string|null;careSeen:Record<string,string[]>};
const memory=new Map<string,Feedback>(),lifetime=24*60*60*1000;
let confirmed:{owner:string;token:string;context:number}|null=null;
/** Called only after a current authenticated owner/profile bootstrap response. */
export function confirmCreditOwner(owner:string){if(commerceUuid.test(owner))confirmed={owner,token:getApp<IAppOption>().globalData.sessionToken,context:commerceContextRevision()};}
export function isCreditOwner(owner:string){return Boolean(confirmed&&confirmed.owner===owner&&confirmed.token===getApp<IAppOption>().globalData.sessionToken&&confirmed.context===commerceContextRevision());}
function slot(owner:string){if(!commerceUuid.test(owner))return '';const d=getApp<IAppOption>().globalData;return 'cisme.points-feedback.v1:'+JSON.stringify([d.apiBaseUrl,d.cloudFunction??null,owner]);}
function empty():Feedback{return{version:1,pending:[],firstSeen:null,careSeen:{}};}
function read(owner:string):Feedback{
 const key=slot(owner);if(!key)return empty();let raw=memory.get(key);if(!raw)try{raw=wx.getStorageSync(key);}catch{}
 if(!raw||raw.version!==1||!Array.isArray(raw.pending)||raw.pending.length>3||!(raw.firstSeen===null||commerceUuid.test(raw.firstSeen))||!raw.careSeen||typeof raw.careSeen!=='object'||Object.keys(raw.careSeen).length>14)return empty();
 if(raw.pending.some(p=>!p||!['questionnaire','care'].includes(p.kind)||typeof p.operation!=='string'||!Number.isSafeInteger(p.queuedAt)||p.kind==='care'&&(!validCareDay(p.day)||!Array.isArray(p.before)||p.before.length>8||p.before.some(id=>!commerceUuid.test(id)))))return empty();
 if(Object.entries(raw.careSeen).some(([day,ids])=>!validCareDay(day)||!Array.isArray(ids)||ids.length>8||ids.some(id=>!commerceUuid.test(id))))return empty();return raw;
}
function write(owner:string,value:Feedback){const key=slot(owner);if(!key)return;memory.set(key,value);try{wx.setStorageSync(key,value);}catch{ /* Presentation never blocks a care record or changes its points. */ }}
export function queueOnboardingFeedback(owner:string,operation:string){
 if(!slot(owner)||!operation)return;const p=read(owner);if(p.firstSeen||p.pending.some(x=>x.kind==='questionnaire'))return;
 write(owner,{...p,pending:[...p.pending,{kind:'questionnaire',operation,queuedAt:Date.now()}]});
}
export function queueCareFeedback(owner:string,day:string,before:CareDayRewards|null,operation:string){
 if(!slot(owner)||!validCareDay(day)||!operation)return;const p=read(owner);if(p.pending.some(x=>x.kind==='care'&&x.day===day))return;
 const ids=before?.careDay===day?before.components.map(c=>c.grantId).filter(id=>commerceUuid.test(id)):[];
 write(owner,{...p,pending:[...p.pending.filter(x=>x.kind!=='care'),{kind:'care',day,before:ids,operation,queuedAt:Date.now()}]});
}
export function forgetOnboardingFeedback(owner:string,operation:string){const p=read(owner);write(owner,{...p,pending:p.pending.filter(x=>x.operation!==operation)});}
export function pendingCredit(owner:string){const p=read(owner),now=Date.now();return p.pending.find(x=>now>=x.queuedAt&&now-x.queuedAt<lifetime)??null;}
export function hasOnboardingFeedback(owner:string){return pendingCredit(owner)?.kind==='questionnaire';}
export function consumeCredit(owner:string,intent:CreditIntent,ids:string[]){
 const p=read(owner);if(!p.pending.some(x=>x.operation===intent.operation)||ids.some(id=>!commerceUuid.test(id)))return false;
 if(intent.kind==='questionnaire'){if(p.firstSeen||ids.length!==1)return false;write(owner,{...p,pending:p.pending.filter(x=>x.operation!==intent.operation),firstSeen:ids[0]!});}
 else{
  const seen={...p.careSeen,[intent.day]:[...new Set([...(p.careSeen[intent.day]??[]),...ids])]};
  for(const day of Object.keys(seen).sort().slice(0,-14))delete seen[day];
  write(owner,{...p,pending:p.pending.filter(x=>x.operation!==intent.operation),careSeen:seen});
 }return true;
}
export function consumeOnboardingFeedback(owner:string,receipt:string){const p=pendingCredit(owner);return p?.kind==='questionnaire'?consumeCredit(owner,p,[receipt]):false;}
export function questionnaireCredit(points:PointsSnapshot){
 const entries=points.entries.filter(e=>e.source_type==='questionnaire'&&e.component==='base'&&e.entry_type==='grant_available');if(entries.length!==1)return null;
 const e=entries[0]!;return commerceUuid.test(e.id)&&Number.isSafeInteger(e.available_delta)&&e.available_delta>0?{id:e.id,amount:e.available_delta}:null;
}
export function careCredit(owner:string,intent:Extract<CreditIntent,{kind:'care'}>,receipt:CareDayRewards){
 if(receipt.careDay!==intent.day||receipt.pending)return null;
 const seen=new Set([...intent.before,...(read(owner).careSeen[intent.day]??[])]);
 const components=receipt.components.filter(c=>!seen.has(c.grantId)&&commerceUuid.test(c.grantId));
 return{ids:components.map(c=>c.grantId),amount:components.reduce((n,c)=>n+Math.max(0,c.points-c.reversed),0)};
}
