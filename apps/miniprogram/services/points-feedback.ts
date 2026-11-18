import {commerceUuid,commerceContextRevision} from './commerce-command-store';
import {validCareDay} from './daily-care';
import type {PointsSnapshot} from './points';
import type {CareDayRewards} from './care-usage';
export type CreditIntent={kind:'questionnaire';operation:string;queuedAt:number}|{kind:'care';operation:string;queuedAt:number;day:string;before:string[]}|{kind:'content';operation:string;queuedAt:number;sourceType:'post'|'ugc_comment'|'editorial_comment';sourceId:string}|{kind:'receipt';operation:string;queuedAt:number;ids:string[]};
type Feedback={version:1;pending:CreditIntent[];firstSeen:string|null;careSeen:Record<string,string[]>;contentSeen:string[]};
const memory=new Map<string,Feedback>(),lifetime=24*60*60*1000;
let confirmed:{owner:string;token:string;context:number}|null=null;
/** Called after a current authenticated response proves the canonical owner. */
export function confirmCreditOwner(owner:string){if(commerceUuid.test(owner))confirmed={owner,token:getApp<IAppOption>().globalData.sessionToken,context:commerceContextRevision()};}
export function isCreditOwner(owner:string){return Boolean(confirmed&&confirmed.owner===owner&&confirmed.token===getApp<IAppOption>().globalData.sessionToken&&confirmed.context===commerceContextRevision());}
export function currentCreditOwner(){return confirmed&&isCreditOwner(confirmed.owner)?confirmed.owner:'';}
function slot(owner:string){if(!commerceUuid.test(owner))return '';const d=getApp<IAppOption>().globalData;return 'cisme.points-feedback.v1:'+JSON.stringify([d.apiBaseUrl,d.cloudFunction??null,owner]);}
function empty():Feedback{return{version:1,pending:[],firstSeen:null,careSeen:{},contentSeen:[]};}
function read(owner:string):Feedback{
 const key=slot(owner);if(!key)return empty();let raw=memory.get(key);if(!raw)try{raw=wx.getStorageSync(key);}catch{}
 if(!raw||raw.version!==1||!Array.isArray(raw.pending)||raw.pending.length>8||!(raw.firstSeen===null||commerceUuid.test(raw.firstSeen))||!raw.careSeen||typeof raw.careSeen!=='object'||Object.keys(raw.careSeen).length>14)return empty();
 if(raw.pending.some(p=>!p||!['questionnaire','care','content','receipt'].includes(p.kind)||typeof p.operation!=='string'||!Number.isSafeInteger(p.queuedAt)||p.kind==='care'&&(!validCareDay(p.day)||!Array.isArray(p.before)||p.before.length>8||p.before.some(id=>!commerceUuid.test(id)))||p.kind==='content'&&(!['post','ugc_comment','editorial_comment'].includes(p.sourceType)||!commerceUuid.test(p.sourceId))||p.kind==='receipt'&&(!Array.isArray(p.ids)||p.ids.length<1||p.ids.length>8||p.ids.some(id=>!commerceUuid.test(id)))))return empty();
 if(Object.entries(raw.careSeen).some(([day,ids])=>!validCareDay(day)||!Array.isArray(ids)||ids.length>8||ids.some(id=>!commerceUuid.test(id))))return empty();return {...raw,contentSeen:Array.isArray(raw.contentSeen)&&raw.contentSeen.length<=64&&raw.contentSeen.every(id=>commerceUuid.test(id))?raw.contentSeen:[]};
}
function priorityQueue(pending:CreditIntent[]){const rank={questionnaire:0,care:1,content:2,receipt:3};return pending.filter(p=>Date.now()-p.queuedAt<lifetime).sort((a,b)=>rank[a.kind]-rank[b.kind]).slice(0,8);}
function write(owner:string,value:Feedback){const key=slot(owner);if(!key)return;const bounded={...value,pending:priorityQueue(value.pending)};memory.set(key,bounded);try{wx.setStorageSync(key,bounded);}catch{ /* Presentation never blocks a care record or changes its points. */ }}
export function queueOnboardingFeedback(owner:string,operation:string){
 if(!slot(owner)||!operation)return;const p=read(owner);if(p.firstSeen||p.pending.some(x=>x.kind==='questionnaire'))return;
 write(owner,{...p,pending:[...p.pending,{kind:'questionnaire',operation,queuedAt:Date.now()}]});
}
export function queueCareFeedback(owner:string,day:string,before:CareDayRewards|null,operation:string){
 if(!slot(owner)||!validCareDay(day)||!operation)return;const p=read(owner);if(p.pending.some(x=>x.kind==='care'&&x.day===day))return;
 const ids=before?.careDay===day?before.components.map(c=>c.grantId).filter(id=>commerceUuid.test(id)):[];
 write(owner,{...p,pending:[...p.pending.filter(x=>x.kind!=='care'),{kind:'care',day,before:ids,operation,queuedAt:Date.now()}]});
}
export function queueContentFeedback(owner:string,sourceType:'post'|'ugc_comment'|'editorial_comment',sourceId:string){
 if(!isCreditOwner(owner)||!commerceUuid.test(sourceId))return;const p=read(owner),operation=`${sourceType}:${sourceId}`;if(p.pending.some(x=>x.operation===operation))return;
 write(owner,{...p,pending:[...p.pending.filter(x=>x.kind!=='content'),...p.pending.filter(x=>x.kind==='content').slice(-5),{kind:'content',operation,sourceType,sourceId,queuedAt:Date.now()}]});
}
export type ConfirmedPointReceipt={id:string;sourceType:string;sourceId:string;points:number};
export function queueConfirmedReceipts(owner:string,receipts:ConfirmedPointReceipt[]){
 if(!isCreditOwner(owner)||!Array.isArray(receipts)||receipts.some(g=>!commerceUuid.test(g.id)||!Number.isSafeInteger(g.points)||g.points<0))return;
 const p=read(owner),groups=new Map<string,string[]>(),queued=new Set(p.pending.flatMap(x=>x.kind==='receipt'?x.ids:[]));
 for(const row of receipts){if(p.contentSeen.includes(row.id)||queued.has(row.id)||row.points<1)continue;const key=row.sourceType+':'+row.sourceId;groups.set(key,[...(groups.get(key)??[]),row.id].slice(-8));}
 const added=Array.from(groups.entries()).map(([operation,ids])=>({kind:'receipt' as const,operation:'receipt:'+operation,ids,queuedAt:Date.now()}));
 write(owner,{...p,pending:[...p.pending,...added]});
}
export function forgetOnboardingFeedback(owner:string,operation:string){const p=read(owner);write(owner,{...p,pending:p.pending.filter(x=>x.operation!==operation)});}
export function pendingCredit(owner:string){const p=read(owner),now=Date.now();return p.pending.find(x=>now>=x.queuedAt&&now-x.queuedAt<lifetime)??null;}
export function hasOnboardingFeedback(owner:string){return pendingCredit(owner)?.kind==='questionnaire';}
/** Read the same receipt identity before starting the motion, without
 * treating a partially played animation as seen. */
export function hasUnseenCredit(owner:string,intent:CreditIntent,ids:string[]){
 const p=read(owner);
 if(!p.pending.some(x=>x.operation===intent.operation) || ids.some(id=>!commerceUuid.test(id))) return false;
 if(intent.kind==='questionnaire') return !p.firstSeen && ids.length===1;
 if(intent.kind==='care') return ids.some(id=>!p.careSeen[intent.day]?.includes(id));
 return ids.some(id=>!p.contentSeen.includes(id));
}
export function consumeCredit(owner:string,intent:CreditIntent,ids:string[]){
 const p=read(owner);if(!p.pending.some(x=>x.operation===intent.operation)||ids.some(id=>!commerceUuid.test(id)))return false;
 if(intent.kind==='questionnaire'){if(p.firstSeen||ids.length!==1)return false;write(owner,{...p,pending:p.pending.filter(x=>x.operation!==intent.operation),firstSeen:ids[0]!});}
 else if(intent.kind==='care'){
  const seen={...p.careSeen,[intent.day]:[...new Set([...(p.careSeen[intent.day]??[]),...ids])]};
  for(const day of Object.keys(seen).sort().slice(0,-14))delete seen[day];
  write(owner,{...p,pending:p.pending.filter(x=>x.operation!==intent.operation),careSeen:seen});
 }else{
  const fresh=ids.filter(id=>!p.contentSeen.includes(id));write(owner,{...p,pending:p.pending.filter(x=>x.operation!==intent.operation),contentSeen:[...p.contentSeen,...fresh].slice(-64)});if(ids.length&&!fresh.length)return false;
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
