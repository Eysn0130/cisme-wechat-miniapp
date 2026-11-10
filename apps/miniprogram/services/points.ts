import {request} from './api';
export type PointRules=Record<'daily'|'note'|'streak7'|'streak30'|'post'|'featured'|'comment'|'questionnaire'|'firstOrder'|'inviteSponsor'|'inviteFriend'|'postWeeklyLimit'|'commentDailyLimit'|'expiryMonths'|'reminderDays'|'discountBps'|'pointsPerYuan'|'refundGraceDays'|'birthdayMultiplier',number>;
export type PointBalances={available:number;frozen:number;debt:number;reserved:number;version:number};
export type PointEntry={id:string;entry_type:string;available_delta:number;frozen_delta:number;debt_delta:number;reserved_delta?:number;used_delta?:number;expired_delta?:number;
 business_key:string;occurred_at:string;source_type?:string;component?:string;amount_points?:string|null;displayTitle?:string;displaySource?:string;displayAmount?:string;displayDate?:string};
export interface PointsSnapshot {projection:PointBalances;rulesEnabled:boolean;entries:PointEntry[];nextCursor:string|null;totalCount:number;
 lifetimeEarned:number;used:number;expired:number;expiring:{points:number;earliestAt:string|null;withinDays:number};clubPolicy:{version:string;rules:PointRules}|null}
export interface PointsClub {upcomingPolicies?:Array<{version:string;rules:PointRules;starts_at:string;ends_at:string|null}>;memberId:string;enabled:boolean;policy:{version:string;rules:PointRules}|null;serverDay:string;checkedIn:boolean;streak:number;
 today:{id:string;products:string[];note:string;version:number}|null;badges:Array<{code:string;earned_at:string}>;pendingRewardSources:number;questionnaireCompleted:boolean;birthday:string|null;birthdayChangeAfter:string|null}
export interface PointsGift {skuId:string;name:string;label:string;image:string|null;points:number;version:number;availableQuantity:number;policyVersion:string}
export interface PointsRedemption {id:string;skuId:string;quantity:number;pointsCost:number;item:{name:string;label:string;image:string|null};state:string;version:number;carrierName:string|null;trackingNumber:string|null;createdAt:string;updatedAt:string;stateLabel?:string}
export function pointInteger(v:unknown,nonnegative=true){if(typeof v!=='number'&&typeof v!=='string'||typeof v==='string'&&!/^-?\d+$/.test(v))throw new Error('POINTS_INTEGER_INVALID');const n=Number(v);if(!Number.isSafeInteger(n)||nonnegative&&n<0)throw new Error('POINTS_INTEGER_INVALID');return n;}
export function parsePointBalances(v:any):PointBalances{
 if(!v||typeof v!=='object')throw new Error('POINTS_BALANCE_UNAVAILABLE');
 const p={available:pointInteger(v.available),frozen:pointInteger(v.frozen),debt:pointInteger(v.debt),reserved:pointInteger(v.reserved??0),version:pointInteger(v.version)};
 if(p.debt>0&&p.available>0)throw new Error('POINTS_DEBT_BALANCE_INVALID');return p;
}
const titles:Record<string,string>={grant_available:'积分到账',grant_frozen:'奖励进入冻结期',unfreeze:'冻结积分转为可用',expire:'积分到期失效',reversal:'奖励撤回',debt_created:'待冲抵积分',debt_offset:'冲抵欠分',reserve:'订单预占积分',release:'订单积分释放',spend:'积分已使用',refund_return:'退款退回积分',adjustment:'积分调整'};
const sources:Record<string,string>={care_day:'每日护理打卡',care_streak:'连续护理奖励',questionnaire:'首次护理建档',post:'体验笔记',featured:'官方精选',comment:'社区互动',order:'购物与邀请奖励'};
const components:Record<string,string>={daily:'每日护理',note:'护理感受',streak7:'连续7天',streak30:'连续30天',shopping:'购物积分',first_order:'首次购物',birthday:'生日双倍',invite_sponsor:'好友首购邀请奖励',invite_friend:'受邀首购奖励'};
export function presentPointEntry(e:PointEntry):PointEntry{
 const a=pointInteger(e.available_delta??0,false),f=pointInteger(e.frozen_delta??0,false),d=pointInteger(e.debt_delta??0,false),r=pointInteger(e.reserved_delta??0,false),u=pointInteger(e.used_delta??0,false),x=pointInteger(e.expired_delta??0,false);
 const amount=e.entry_type==='spend'?-u:e.entry_type==='reserve'?-r:e.entry_type==='expire'?-(x||Math.max(0,-a-f)):e.entry_type==='unfreeze'?a:e.entry_type==='release'?(x>0?-x:a):e.entry_type==='refund_return'?a:a+f-d;
 const label=components[e.component??'']??sources[e.source_type??'']??(String(e.business_key).startsWith('grant:')?'历史投稿奖励':'积分账本');
 return {...e,displayTitle:e.entry_type==='release'&&x>0?'订单取消，积分已到期':titles[e.entry_type]??'积分变动',displaySource:label,displayAmount:amount===0?'—':`${amount>0?'+':''}${amount}`,displayDate:new Date(new Date(e.occurred_at).getTime()+8*3600000).toISOString().slice(0,16).replace('T',' ')};
}
export function parsePointsSnapshot(v:any):PointsSnapshot{
 if(!v||!Array.isArray(v.entries)||!(v.nextCursor===null||typeof v.nextCursor==='string'))throw new Error('POINTS_PAYLOAD_INVALID');
 return {...v,projection:parsePointBalances(v.projection),entries:v.entries.map(presentPointEntry),totalCount:pointInteger(v.totalCount),lifetimeEarned:pointInteger(v.lifetimeEarned),used:pointInteger(v.used),expired:pointInteger(v.expired),
  expiring:{...v.expiring,points:pointInteger(v.expiring?.points),withinDays:pointInteger(v.expiring?.withinDays)}};
}
export async function readMyPoints(source='all',cursor:string|null=null){return parsePointsSnapshot(await request({path:`/v1/me/points?limit=20&source=${encodeURIComponent(source)}${cursor?'&cursor='+encodeURIComponent(cursor):''}`,cacheTags:['points']}));}
export async function readPointsClub(){const value=await request<PointsClub>({path:'/v1/me/points/club',cacheTags:['points','member','care']});
 if(!value||typeof value.memberId!=='string'||typeof value.enabled!=='boolean'||!/^\d{4}-\d{2}-\d{2}$/.test(value.serverDay)||!Array.isArray(value.badges)||!Number.isSafeInteger(value.streak)||value.streak<0||!Number.isSafeInteger(value.pendingRewardSources)||value.pendingRewardSources<0||value.enabled&&!value.policy)throw Error('POINTS_CLUB_PAYLOAD_INVALID');
 const fields=['daily','note','streak7','streak30','post','featured','comment','questionnaire','firstOrder','inviteSponsor','inviteFriend','postWeeklyLimit','commentDailyLimit','expiryMonths','reminderDays','discountBps','pointsPerYuan','refundGraceDays','birthdayMultiplier'] as const;
 for(const policy of [value.policy,...(value.upcomingPolicies??[])])if(policy&&(typeof policy.version!=='string'||!policy.rules||fields.some(k=>!Number.isSafeInteger(policy.rules[k])||policy.rules[k]<0)))throw Error('POINTS_RULES_PAYLOAD_INVALID');
 return value;
}
export function readPointsGifts(){return request<{enabled:boolean;items:PointsGift[]}>({path:'/v1/me/points/gifts',cacheTags:['points','catalog']});}
export function readMyRedemptions(cursor:string|null=null){return request<{items:PointsRedemption[];nextCursor:string|null}>({path:'/v1/me/points/redemptions'+(cursor?'?cursor='+encodeURIComponent(cursor):''),cacheTags:['points','orders']});}
export const redemptionLabels:Record<string,string>={placed:'待发货',shipped:'已发货',received:'已收货',cancelled:'已取消',return_requested:'退货处理中',returned:'已退回积分'};
