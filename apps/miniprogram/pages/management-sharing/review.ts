import {identityLabel,memberIdentityBadge} from '../../services/display-identity';
import {localMemberAvatar} from '../../services/member-avatar';
import {officerDate,officerLabels,officerMoney} from '../../services/sharing-officer';

export const officerFilters=[
 {id:'all',label:'全部'},{id:'pending',label:'待审核'},{id:'reviewed',label:'已审核'},
 {id:'active',label:'已开通'},{id:'suspended',label:'已暂停'},{id:'terminated',label:'已终止'},{id:'rejected',label:'未通过'}
];

type MemberCardSource={avatar?:string|null;avatarRevision?:string|null;displayIdentity?:string|null;cardNumber?:string|null;availablePoints?:number};
async function prepareMemberCard<T extends MemberCardSource>(row:T){
 const {avatar,avatarRevision,displayIdentity,availablePoints,...member}=row;
 const badge=memberIdentityBadge(displayIdentity);
 return {...member,badge,badgeLabel:identityLabel(badge),avatar:await localMemberAvatar(avatar,avatarRevision),
  points:Number.isSafeInteger(availablePoints)?String(availablePoints).replace(/\B(?=(\d{3})+(?!\d))/g,','):''};
}

export type CustomerRecord={id:string;displayName:string;userCode:string}&MemberCardSource&(
 {pending:true}|{pending?:false;version:number;controlVersion:number;expired:boolean;restorable:boolean;removedAt:string|null}
);
export type CustomerRow=Awaited<ReturnType<typeof prepareCustomerRow>>;
export function prepareCustomerRow(row:CustomerRecord){
 if(row.pending)return prepareMemberCard(row);
 return prepareMemberCard(row);
}

export async function prepareOfficerRow(row:any){
 const officer=await prepareMemberCard(row);
 const applicationDate=officerDate(officer.applicationAt===undefined?officer.appliedAt:officer.applicationAt);
 const date=officer.state==='pending'?applicationDate:officerDate(officer.reviewedAt);
 return {...officer,applicationDate,date,time:date.slice(11),label:officerLabels[officer.state]||''};
}

export type OfficerDay={key:string;label:string;items:any[]};

export function groupOfficerRows(rows:any[]):OfficerDay[]{
 const year=new Date(Date.now()+8*3_600_000).getUTCFullYear();
 const days=new Map<string,OfficerDay>();
 for(const row of rows){
  const key=row.date?.slice(0,10)||'history';
  let day=days.get(key);
  if(!day){
   const [y,m,d]=key.split('-').map(Number);
   const label=key==='history'?'历史记录':(y===year?'':`${y}年`)+`${m}月${d}日`;
   day={key,label,items:[]};
   days.set(key,day);
  }
  day.items.push(row);
 }
 return [...days.values()];
}

function decision(event:any){
 return {...event,date:officerDate(event.occurredAt),label:event.result==='active'?'已通过':officerLabels[event.result]||''};
}

export function officerReviewView(data:any){
 const {member,officer,agreement,review,qualification,history}=data;
 const commerce=member?.commerce;
 const accountActive=data.accountState==='active';
 return {accountActive,qualificationMet:qualification?.met===true,canApprove:accountActive&&qualification?.met===true,reason:officer.reviewReason||'',
  agreement:agreement?{accepted:officerDate(agreement.acceptedAt),version:agreement.version}:null,
  review:review?decision(review):null,history:(history??[]).map(decision),
  member:member?{registered:officerDate(member.registeredAt).slice(0,10),referrals:member.referrals,publicPosts:member.publicPosts,
   posts:member.posts.map((post:any)=>({...post,date:officerDate(post.publishedAt).slice(0,10)})),
   commerce:commerce?{...commerce,net:officerMoney(commerce.netCents),refunded:officerMoney(commerce.refundedCents),
    orders:commerce.orders.map((order:any)=>({...order,date:officerDate(order.paidAt).slice(0,10),net:officerMoney(order.paidCents-order.refundedCents)}))}:null}:null};
}
