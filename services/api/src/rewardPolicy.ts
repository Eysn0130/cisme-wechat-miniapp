import {DomainError} from '@cisme/domain';

export const rewardBundles = [
 {code:'moisture',name:'净润旅行洗护套',shampoo:'净润洗发水',shampooMl:100,conditioner:'柔光强韧护发乳',conditionerMl:100,totalMl:200,
  components:['conditioner100','moisture100'],image:'/pages/rewards/assets/moisture-100-100-v1.jpg'},
 {code:'dandruff',name:'净屑旅行洗护套',shampoo:'控油净屑洗发水',shampooMl:50,conditioner:'柔光强韧护发乳',conditionerMl:100,totalMl:150,
  components:['conditioner100','dandruff50'],image:'/pages/rewards/assets/dandruff-50-100-v1.jpg'}
] as const;
export type RewardBundleCode=typeof rewardBundles[number]['code'];
export type RewardTerms={maxAwardsPerMember:number;voucherValidityDays:number;shippingCents:number;dispatchHours:number;
 restoreGraceDays:number;stockoutPolicy:'retain_until_expiry';eligibleProductIds:string[]};
export const rewardUuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function rewardFailure(code:string,copy:string,status=422):never{throw new DomainError(code,copy,status);}
export function rewardId(v:unknown):string{if(typeof v!=='string'||!rewardUuid.test(v))rewardFailure('REWARD_ID_INVALID','记录编号无效');return v;}
export function rewardInt(v:unknown,min=1,max=2_000_000_000):number{if(typeof v!=='number'||!Number.isSafeInteger(v)||v<min||v>max)rewardFailure('REWARD_INPUT_INVALID','请核对数量、期限或版本');return v;}
export function rewardBody(v:unknown,allowed:string[]):Record<string,unknown>{if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).some(k=>!allowed.includes(k)))rewardFailure('REWARD_INPUT_INVALID','请核对活动内容');return v as Record<string,unknown>;}
export function rewardKey(v:string){if(!/^[A-Za-z0-9._:-]{8,200}$/.test(v))rewardFailure('IDEMPOTENCY_KEY_INVALID','操作编号无效',400);return v;}
export function rewardText(v:unknown,min=1,max=120):string{if(typeof v!=='string'||v.trim().length<min||v.trim().length>max||/[\u0000-\u001f\u007f]/.test(v))rewardFailure('REWARD_INPUT_INVALID','请核对填写内容');return v.trim();}
export function rewardTerms(v:unknown):RewardTerms{
 const b=rewardBody(v,['maxAwardsPerMember','voucherValidityDays','shippingCents','dispatchHours','restoreGraceDays','stockoutPolicy','eligibleProductIds']);
 if(b.stockoutPolicy!=='retain_until_expiry'||!Array.isArray(b.eligibleProductIds)||!b.eligibleProductIds.length||b.eligibleProductIds.length>100)rewardFailure('REWARD_TERMS_INVALID','请确认缺货处理及正装券适用商品');
 if(b.maxAwardsPerMember!==1||b.voucherValidityDays!==30||b.shippingCents!==0||b.dispatchHours!==72||b.restoreGraceDays!==0)rewardFailure('REWARD_TERMS_INVALID','当前活动按一人一券、30天、大陆包邮、72小时发货执行');
 const products=(b.eligibleProductIds as unknown[]).map(rewardId);if(new Set(products).size!==products.length)rewardFailure('REWARD_TERMS_INVALID','适用商品不能重复');
 return {maxAwardsPerMember:rewardInt(b.maxAwardsPerMember,1,1000),voucherValidityDays:rewardInt(b.voucherValidityDays,1,366),shippingCents:rewardInt(b.shippingCents,0,100000),dispatchHours:rewardInt(b.dispatchHours,1,720),restoreGraceDays:rewardInt(b.restoreGraceDays,0,90),stockoutPolicy:'retain_until_expiry',eligibleProductIds:[...products].sort()};
}
export function rewardBundle(code:unknown){const b=rewardBundles.find(b=>b.code===code);if(!b)rewardFailure('REWARD_BUNDLE_INVALID','请选择一套旅行洗护');return b;}
export function rewardRecommendation(answers:Record<string,{status:string;values:string[]}>,health:string):RewardBundleCode{
 const preference=answers.preference?.values??[];
 if(preference.includes('net_xie'))return 'dandruff';
 if(preference.includes('net_run'))return 'moisture';
 return health==='granted'&&(answers.concerns?.values.includes('dandruff')||answers.dandruff?.values.some(v=>['often','sometimes'].includes(v)))?'dandruff':'moisture';
}
export function visibleVoucherState(row:{state:string;expires_at:Date},now=new Date()){return row.state==='unused'&&row.expires_at<=now?'expired':row.state;}
export function restoredVoucher(row:{expires_at:Date;terms_snapshot:RewardTerms},now:Date){
 const expiresAt=row.expires_at<=now&&row.terms_snapshot.restoreGraceDays>0?new Date(now.getTime()+row.terms_snapshot.restoreGraceDays*86400000):row.expires_at;
 return {state:expiresAt<=now?'expired':'unused',expiresAt};
}
