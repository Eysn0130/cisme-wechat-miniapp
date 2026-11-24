import {campaignEssenceCode} from './home-campaign';
import {commerceContextRevision,commerceUuid} from './commerce-command-store';
import {clientOperationKey} from './orders';

type QualificationPurchase = {
 key:string;
 memberId:string;
 origin:object;
 session:string;
 context:number;
 orderId:string;
 completed:boolean;
};
let purchase:QualificationPurchase|null=null;

function activePurchase(key:string){
 if(!purchase||purchase.key!==key)return null;
 if(purchase.session!==getApp<IAppOption>().globalData.sessionToken||purchase.context!==commerceContextRevision()){
  purchase=null;
  return null;
 }
 return purchase;
}

export function beginQualificationPurchase(origin:object,memberId:string){
 const session=getApp<IAppOption>().globalData.sessionToken;
 if(!session||!memberId)return '';
 const key=clientOperationKey('sharing-qualification');
 purchase={key,memberId,origin,session,context:commerceContextRevision(),orderId:'',completed:false};
 return key;
}

export function qualificationPurchaseQuery(key:string,productCode:string){
 return productCode===campaignEssenceCode&&activePurchase(key)
  ? '&sharingQualification='+encodeURIComponent(key) : '';
}

export function bindQualificationOrder(key:string,productCode:string,orderId:string){
 const query=qualificationPurchaseQuery(key,productCode);
 const flow=query?activePurchase(key):null;
 if(!flow||!commerceUuid.test(orderId)||flow.completed||flow.orderId&&flow.orderId!==orderId)return '';
 flow.orderId=orderId;
 return query;
}

function activeQualificationOrder(key:string,orderId:string){
 const flow=activePurchase(key);
 return orderId&&flow?.orderId===orderId&&!flow.completed ? flow : null;
}

export function qualificationOrderOwner(key:string,orderId:string){
 return activeQualificationOrder(key,orderId)?.memberId??null;
}

export function qualificationReturnDistance(key:string,orderId:string,detail:object){
 const flow=activeQualificationOrder(key,orderId);
 if(!flow)return 0;
 const pages=getCurrentPages();
 const index=pages.findIndex(page=>page===flow.origin);
 return index>=0&&pages[pages.length-1]===detail ? pages.length-1-index : 0;
}

export function markQualificationCompleted(key:string,orderId:string){
 const flow=activeQualificationOrder(key,orderId);
 if(flow)flow.completed=true;
}

export function consumeQualificationReturn(origin:object,memberId:string){
 const flow=purchase?activePurchase(purchase.key):null;
 if(!flow?.completed||flow.origin!==origin||flow.memberId!==memberId)return false;
 purchase=null;
 return true;
}

export function discardQualificationPurchase(key:string){
 if(purchase?.key===key)purchase=null;
}
