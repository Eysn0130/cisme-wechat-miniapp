import {request} from './api';
import {pageRead} from './page-requests';
import {beijingDateParts} from './business-time';
export type RewardBundleCode='moisture'|'dandruff';
export interface RewardTerms{maxAwardsPerMember:1;voucherValidityDays:30;shippingCents:0;dispatchHours:72;restoreGraceDays:0;stockoutPolicy:'retain_until_expiry';eligibleProductIds:string[]}
export interface RewardBundle{code:RewardBundleCode;name:string;shampoo:string;shampooMl:number;conditioner:string;conditionerMl:number;totalMl:number;image:string;availableQuantity?:number;stockConfirmed?:boolean}
export interface RewardVoucher{id:string;activityId:string;activityTitle:string;name:string;state:'unused'|'used'|'expired'|'revoked'|'locked';version:number;claimId:string|null;issuedAt:string;expiresAt:string;terms:RewardTerms}
export interface CouponProduct{id:string;code:string;name:string;image:string|null;priceCents:number}
export interface PurchaseCoupon{id:string;state:'available'|'locked'|'used'|'expired'|'revoked';thresholdCents:number;discountCents:number;issuedAt:string;expiresAt:string;orderId:string|null;products?:CouponProduct[]}
export interface EligibleCoupon{id:string;name:string;thresholdCents:number;discountCents:number;expiresAt:string;version:number}
export interface RewardClaim{id:string;claimNumber:string;memberId:string;voucherId:string;state:'placed'|'shipped'|'received'|'cancelled'|'aftersale_requested'|'closed';version:number;item:RewardBundle;terms:RewardTerms;shippingCents:number;carrierName:string|null;trackingNumber?:string|null;shippedAt:string|null;receivedAt:string|null;createdAt:string;updatedAt:string;aftersaleReason:string|null;couponId?:string|null;address?:{recipientName:string;phone:string;province:string;city:string;district:string;detail:string}}
export interface RewardWallet{memberId:string;vouchers:RewardVoucher[];claims:RewardClaim[];moreClaims:boolean;claimsNextCursor?:string|null;coupons:PurchaseCoupon[]}
export interface RewardSelection{memberId:string;voucher:RewardVoucher;bundles:RewardBundle[];survey:{completed:boolean;version:number;questionnaireVersion:string;recommendation:RewardBundleCode|null}}
export interface RewardQuote{id:string;voucherId:string;bundleCode:RewardBundleCode;item:RewardBundle;surveyVersion:number;addressId:string;addressVersion:number;shippingCents:0;totalCents:0;expiresAt:string;serverTime:string}
export interface RewardReceipt{status:'found'|'not_found'|'abandoned';action?:string;record?:{id:string;state?:string;version?:number}}
export interface RewardInventory{code:string;stock_on_hand:number;reserved_quantity:number;confirmed:boolean;version:number}
export interface RewardActivity{id:string;code:string;title:string;state:'draft'|'published'|'paused';version:number;terms:RewardTerms|null}
export interface RewardManagement{memberId:string;activities:RewardActivity[];inventory:RewardInventory[];vouchers:Array<{id:string;member_id:string;display_name:string;state:string;version:number;expires_at:string;claim_id:string|null;batch_id:string;source_record_id:string}>;claims:RewardClaim[];voucherNext:string|null;claimNext:string|null;permissions:{configure:boolean;stock:boolean;issue:boolean;fulfill:boolean}}
function read<T>(page:object,path:string){return pageRead<T>(page,{path,cacheTags:['rewards']});}
export const rewardWallet=(page:object,cursor?:string)=>read<RewardWallet>(page,`/v1/me/rewards${cursor?`?claimsCursor=${encodeURIComponent(cursor)}`:''}`);
export const rewardSelection=(page:object,id:string)=>read<RewardSelection>(page,`/v1/me/rewards/vouchers/${encodeURIComponent(id)}`);
export const rewardClaim=(page:object,id:string,management=false)=>read<RewardClaim>(page,`/v1/${management?'management':'me'}/rewards/claims/${encodeURIComponent(id)}`);
export const rewardReceipt=(page:object,operation:string)=>read<RewardReceipt>(page,`/v1/me/rewards/command-receipts/${encodeURIComponent(operation)}`);
export const abandonReward=(operation:string)=>request<RewardReceipt>({path:`/v1/me/rewards/command-receipts/${encodeURIComponent(operation)}/abandon`,method:'POST',data:{},cacheTags:['rewards']});
export const rewardQuote=(data:{voucherId:string;bundleCode:RewardBundleCode;addressId:string;addressVersion:number;surveyVersion:number},key:string)=>request<RewardQuote>({path:'/v1/me/rewards/quotes',method:'POST',data,idempotencyKey:key,cacheTags:['rewards']});
export const confirmReward=(quoteId:string,key:string)=>request<{id:string;state:string;version:number}>({path:'/v1/me/rewards/claims',method:'POST',data:{quoteId},idempotencyKey:key,cacheTags:['rewards']});
export const operateReward=(id:string,action:string,data:WechatMiniprogram.IAnyObject,key:string,management=false)=>request<{id:string;state:string;version:number}>({path:`/v1/${management?'management':'me'}/rewards/claims/${encodeURIComponent(id)}/${encodeURIComponent(action)}`,method:'POST',data,idempotencyKey:key,cacheTags:['rewards']});
export const eligibleCoupons=(page:object,skuId:string,quantity:number)=>read<{items:EligibleCoupon[]}>(page,`/v1/me/coupons/eligible?skuId=${encodeURIComponent(skuId)}&quantity=${quantity}`);
export const rewardManagement=(page:object,query='')=>read<RewardManagement>(page,`/v1/management/rewards${query}`);
export function rewardManagementCommand(path:string,data:WechatMiniprogram.IAnyObject,key:string){return request<{id:string;version?:number;issued?:number;existing?:number}>({path:`/v1/management/rewards/${path}`,method:'POST',data,idempotencyKey:key,cacheTags:['rewards','authority']});}
export function exportRewards(activity:string,kind:string,after?:string){return request<{fileBase64:string;fileName:string;count:number;nextCursor:string|null}>({path:`/v1/management/rewards/activities/${encodeURIComponent(activity)}/export/${encodeURIComponent(kind)}${after?`?after=${encodeURIComponent(after)}`:''}`});}
export function rewardCopy(error:unknown){const p=error as {code?:string;title?:string};const known:Record<string,string>={REWARD_SOLD_OUT:'这套暂时兑完，请选择另一套',REWARD_SURVEY_CHANGED:'问卷已更新，请重新确认套装',REWARD_QUOTE_EXPIRED:'领取资料已过期，请重新确认',REWARD_VOUCHER_UNAVAILABLE:'兑换券已更新，请返回我的奖励核对',REWARD_CHANGED:'记录已更新，请刷新后重试',REWARD_STOCK_UNCONFIRMED:'奖励库存待确认，可联系客服',REWARD_COMMAND_ABANDONED:'本次操作已取消，请重新确认',AUTH_REQUIRED:'请登录后继续',CAPABILITY_REQUIRED:'当前账号无此管理权限'};return known[p?.code??'']??(p?.title&&/^[\u3400-\u9fff]/.test(p.title)?p.title:'暂时无法完成，请重试');}
export function rewardDate(value:string|null|undefined){return value?beijingDateParts(value).date.replace(/-/g,'.'):'';}
export function rewardExpiry(value:string){const parts=beijingDateParts(value);return parts.date?`${parts.date.replace(/-/g,'.')} ${parts.time}`:'';}
export const purchaseCouponState:Record<string,string>={available:'可使用',locked:'订单占用',used:'已使用',expired:'已过期',revoked:'已撤销'};
export const rewardState:Record<string,string>={unused:'待领取',locked:'领取处理中',used:'已领取',expired:'已过期',revoked:'已撤销',placed:'待发货',shipped:'待收货',received:'已收货',cancelled:'已取消',aftersale_requested:'售后处理中',closed:'已完成',available:'可使用'};
