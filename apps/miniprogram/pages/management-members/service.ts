import {localMemberAvatar} from '../../services/member-avatar';
import {request} from '../../services/api';
import {cancelPageReads,pageRead} from '../../services/page-requests';
import {commerceContextRevision} from '../../services/commerce-command-store';
export type UserScope={profile:boolean;contact:boolean;care:boolean;orders:boolean;points:boolean;rewards:boolean;sharing:boolean;commission:boolean;finance:boolean;support:boolean;privacy:boolean;moderate:boolean;manage:boolean;export:boolean};
export type UserRow={id:string;displayName:string;cardNumber:string|null;avatar:string|null;avatarRevision?:string|null;accountStatus:string;onboarding:string;createdAt:string;phoneMasked:string|null;points:any;commerce:any;activity:any;rewards:any;sharing:any};
export type UserQuery={q:string;view:string;account:string;onboarding:string;officer:string;sort:string;direction:string};
export const initialQuery:UserQuery={q:'',view:'profile',account:'all',onboarding:'all',officer:'all',sort:'registered',direction:'desc'};
export const views=[{id:'profile',label:'资料'},{id:'commerce',label:'消费'},{id:'activity',label:'活跃'},{id:'assets',label:'权益'},{id:'sharing',label:'分享官'}];
export const labels:Record<string,string>={active:'正常',blocked:'已停用',complete:'已建档',incomplete:'待建档',erased:'已撤回',none:'未申请',pending:'待审核',rejected:'未通过',suspended:'已暂停',terminated:'已终止',unused:'待领取',available:'可用',reserved:'已预占',used:'已使用',claimed:'已领取',expired:'已过期',revoked:'已撤销',pending_payment:'待付款',paid:'已付款',cancelled:'已取消',refunded:'已退款',shipped:'已发货',received:'已收货',awaiting_dispatch:'待发货',requested:'已申请',need_info:'待补充',awaiting_return:'待退货',return_in_transit:'退货中',return_received:'退货已收',quality_checked:'已检验',refund_pending:'退款中',prepared:'待审核',reviewed:'待付款',void:'已作废',voided:'已作废',placed:'待发货',return_requested:'退货处理中',returned:'已退回',aftersale_requested:'售后中',waiting_human:'待人工接入',human_waiting:'待接入',human_assigned:'人工接待',published:'已发布',open:'处理中',waiting:'待接入',human_active:'人工接待',resolved:'已解决',closed:'已结束',submitted:'已提交',processing:'处理中',completed:'已完成',withdrawn:'已撤回'};
export const number=(v:unknown)=>Number(v??0).toLocaleString('en-US');
export const money=(v:unknown)=>v==null?'—':'¥'+(Number(v)/100).toFixed(2);
export function date(value:unknown,short=false){if(!value)return '—';const d=new Date(String(value));if(!Number.isFinite(d.getTime()))return '—';return new Date(d.getTime()+8*3600_000).toISOString().replace('T',' ').slice(short?5:0,short?16:16);}
export function userContext(){const a=getApp<IAppOption>().globalData;return a.sessionToken+'|'+a.apiBaseUrl+'|'+commerceContextRevision();}
export const userRead=<T=any>(owner:object,path:string)=>pageRead<T>(owner,{path});
export const userError=(e:unknown)=>(e as {title?:string})?.title||'暂未加载，请重试';
export const queryString=(q:UserQuery)=>Object.entries(q).map(([k,v])=>encodeURIComponent(k)+'='+encodeURIComponent(v)).join('&');
export function allowedViews(s:UserScope){return views.filter(v=>v.id==='profile'||v.id==='commerce'&&s.orders||v.id==='activity'&&s.care||v.id==='assets'&&s.points||v.id==='sharing'&&s.sharing);}
export type Column={id:string;label:string;width:number};
export function columns(view:string,s:UserScope):Column[]{const list:Column[]=[];const add=(allowed:boolean,id:string,label:string,width=78)=>{if(allowed)list.push({id,label,width});};
 if(view==='profile'){add(s.points,'points','积分',60);add(s.orders,'orders','已付订单',56);add(true,'onboarding','建档',60);add(true,'account','账号',60);add(true,'phone','手机',112);add(true,'registered','注册时间',126);}
 if(view==='commerce'){add(s.orders,'paid','实付',98);add(s.orders,'refunds','退款',98);add(s.orders,'net','净消费',98);add(s.orders,'orders','已付订单');add(s.orders,'aftersales','售后');}
 if(view==='activity'){add(s.care,'care','护理天数');add(s.care,'streak','连续天数');add(true,'posts','公开内容');add(true,'recent','最近记录',126);}
 if(view==='assets'){add(s.points,'points','可用积分',90);add(s.points,'frozen','冻结');add(s.points,'reserved','预占');add(s.points,'debt','待抵扣');add(s.rewards,'coupons','正装券');add(s.rewards,'rewards','活动奖励');}
 if(view==='sharing'){add(s.sharing,'officer','资格');add(s.sharing,'code','分享官编号',126);add(s.sharing,'referrer','推荐人编号',126);add(s.sharing,'direct','归属客户');}
 return list;
}
export function rowView(r:UserRow,fields:Column[],selected:string[]=[]){const values:Record<string,string>={points:number(r.points?.available),frozen:number(r.points?.frozen),reserved:number(r.points?.reserved),debt:number(r.points?.debt),orders:number(r.commerce?.paidOrderCount),paid:money(r.commerce?.paidCents),refunds:money(r.commerce?.refundedCents),net:money(r.commerce?.netCents),aftersales:number(r.commerce?.openAftersales),onboarding:labels[r.onboarding]||r.onboarding,account:labels[r.accountStatus]||r.accountStatus,phone:r.phoneMasked||'未绑定',registered:date(r.createdAt,true),care:number(r.activity.careDays),streak:number(r.activity.streak),posts:number(r.activity.publicPosts),recent:date(r.activity.recentAt,true),coupons:number(r.rewards?.availableCoupons),rewards:number(r.rewards?.unclaimedRewards),officer:r.sharing?.state==='active'?'已开通':labels[r.sharing?.state]||'未申请',code:r.sharing?.code||'—',referrer:r.sharing?.referrerCode||'—',direct:number(r.sharing?.directCount)};
 return {...r,selected:selected.includes(r.id),cells:fields.map(f=>({...f,value:values[f.id]??'—'}))};}
export const sections=[{id:'orders',label:'订单',scope:'orders'},{id:'aftersales',label:'售后',scope:'orders'},{id:'care',label:'护理记录',scope:'care'},{id:'points',label:'积分明细',scope:'points'},{id:'vouchers',label:'券与兑换',scope:'rewardsOrPoints'},{id:'sharing',label:'分享官与归属',scope:'sharing'},{id:'sharing-orders',label:'推广订单',scope:'commission'},{id:'settlements',label:'月结记录',scope:'commission'},{id:'posts',label:'公开内容',scope:'profile'},{id:'comments',label:'公开评论',scope:'profile'},{id:'support',label:'客服',scope:'support'},{id:'addresses',label:'地址',scope:'contact'},{id:'privacy',label:'隐私请求',scope:'privacy'}];
export function allowedSections(s:UserScope){return sections.filter(v=>v.scope==='rewardsOrPoints'?s.rewards||s.points:v.scope==='sharingOrFinance'?s.sharing||s.finance:s[v.scope as keyof UserScope]);}
const pointTitles:Record<string,string>={daily:'今日护理',note:'护理感受',streak7:'连续7天',streak30:'连续30天',grant_available:'获得积分',grant_frozen:'积分冻结',unfreeze:'积分解冻',debt_created:'待抵扣积分',questionnaire:'首次建档',care_day:'今日护理',care_note:'护理感受',care_streak:'连续护理',shopping:'购物奖励',first_order:'首单奖励',signup:'注册奖励',spend:'积分使用',reserve:'订单预占',release:'预占释放',expire:'积分到期',reversal:'积分退回',issue:'获得积分',grant:'获得积分',debt_offset:'抵扣待冲积分'};
export function recordView(r:any){let title=r.title,amount='',meta=[r.number,date(r.occurredAt)].filter(Boolean).join(' · '),details=[] as string[];
 if(r.kind==='audit'){const names:Record<string,string>={'member.admin.view':'查看用户','member.admin.list':'检索用户','member.admin.section':'查看业务记录','member.admin.contact.view':'查看联系资料','member.admin.export':'导出用户表格'};title=names[r.title]||(/^sharing/.test(r.title)?'分享官业务操作':/^commerce|^order/.test(r.title)?'订单操作':/^support/.test(r.title)?'客服操作':/^privacy/.test(r.title)?'资料权利处理':'操作记录');}
 else if(r.kind==='points'){title=pointTitles[r.title]||pointTitles[r.component]||pointTitles[r.state]||'积分变动';const sum=(r.changes.available||0)+(r.changes.frozen||0)+(r.changes.reserved||0);amount=sum?(sum>0?'+':'')+number(sum):'';details=Object.entries(r.changes).filter(([,v])=>Number(v)!==0).map(([k,v])=>({available:'可用',frozen:'冻结',reserved:'预占',debt:'待抵扣',used:'已用',expired:'到期'} as Record<string,string>)[k]+' '+(Number(v)>0?'+':'')+number(v));}
 else if(r.kind==='care'){meta=r.day+' · '+date(r.updatedAt,true);amount=r.rewards?`${Math.max(0,r.rewards.pointsGranted-r.rewards.pointsReversed-r.rewards.debtOffset)} 分`:'';}
 else if(r.kind==='settlement'){amount=money(r.netCents);details=['税前 '+money(r.grossCents),'扣税 '+money(r.taxCents)];}
 else if(r.kind==='sharing_order'){amount=money(r.cashMerchandiseCents);details=['待结算 '+money(r.pendingCents),'可结算 '+money(r.availableCents),'已结算 '+money(r.settledCents)];}
 else if(r.kind==='purchase_coupon'){amount=money(r.amount);details=['满 '+money(r.threshold)+' 可用'];}
 else if(r.kind==='points_gift')amount=number(r.amount)+' 分';
 else if(r.amountCents!=null)amount=money(r.amountCents);
 if(r.expiresAt)details.push('有效至 '+date(r.expiresAt));
 return {...r,title,meta,amount,details,body:r.note??r.body??'',stateLabel:r.kind==='address'?(r.isDefault?'默认':''):r.kind==='audit'?'':labels[r.state]||r.state||'',actor:r.actor??'',navigable:Boolean(r.source)};
}

// Exact phone search is a read-only POST so phone values never enter URL/access logs.
const searches=new WeakMap<object,Set<()=>void>>();
export function cancelUserReads(owner:object){cancelPageReads(owner);for(const cancel of searches.get(owner)??[])cancel();searches.delete(owner);}
export async function userSearch<T=any>(owner:object,q:UserQuery,cursor?:string|null):Promise<T>{
 if(!/^(?:1\d{10}|\+[1-9]\d{4,18})$/.test(q.q))return userRead<T>(owner,'/v1/management/users?'+queryString(q)+(cursor?'&cursor='+encodeURIComponent(cursor):''));
 let handles=searches.get(owner);if(!handles){handles=new Set();searches.set(owner,handles);}let cancel:(()=>void)|undefined;
 try{return await request<T>({path:'/v1/management/users/search',method:'POST',data:{...q,...(cursor?{cursor}:{})},registerAbort:fn=>{cancel=fn;handles!.add(fn);}});}catch(e){if((e as {code?:string}).code==='NETWORK_TIMEOUT')throw {code:'NETWORK_TIMEOUT',title:'加载超时，请重试'};throw e;}finally{if(cancel)handles.delete(cancel);}
}

/** Use the existing native JPEG cache; never put authenticated Base64 images in setData. */
export function prepareUserRows(rows:UserRow[]):Promise<UserRow[]>{return Promise.all(rows.map(async r=>({...r,avatar:await localMemberAvatar(r.avatar,r.avatarRevision)})));}
