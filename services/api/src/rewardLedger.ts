import type {DbClient} from './db.js';
import {rewardBundle,restoredVoucher,rewardFailure} from './rewardPolicy.js';

export async function lockRewardComponents(c:DbClient,code:string){
 const bundle=rewardBundle(code);
 const rows=(await c.query('SELECT * FROM reward_component_inventory WHERE code=ANY($1::text[]) ORDER BY code FOR UPDATE',[bundle.components])).rows;
 if(rows.length!==2||rows.some(r=>!r.confirmed))rewardFailure('REWARD_STOCK_UNCONFIRMED','奖励库存待确认，请联系客服',409);
 return rows;
}
export async function reserveRewardComponents(c:DbClient,claimId:string,code:string){
 const rows=await lockRewardComponents(c,code);
 if(rows.some(r=>r.stock_on_hand-r.reserved_quantity<1))rewardFailure('REWARD_SOLD_OUT','这套暂时兑完，请选择另一套',409);
 for(const row of rows){
  await c.query('UPDATE reward_component_inventory SET reserved_quantity=reserved_quantity+1,version=version+1,updated_at=now() WHERE code=$1',[row.code]);
  await c.query("INSERT INTO reward_stock_reservation(claim_id,component_code,state) VALUES($1,$2,'active')",[claimId,row.code]);
 }
}
export async function settleRewardClaim(c:DbClient,claim:any,mode:'consume'|'release'|'cancel_unshipped',now:Date){
 const voucher=(await c.query('SELECT * FROM reward_voucher WHERE id=$1 FOR UPDATE',[claim.voucher_id])).rows[0];
 if(!voucher||voucher.claim_id!==claim.id||voucher.member_id!==claim.member_id)rewardFailure('REWARD_RESERVATION_DRIFT','领取状态需核对，请联系客服',409);
 const expected=mode==='cancel_unshipped'?'consumed':'active';
 const rows=await lockRewardComponents(c,claim.bundle_code);
 const allocations=(await c.query('SELECT * FROM reward_stock_reservation WHERE claim_id=$1 ORDER BY component_code FOR UPDATE',[claim.id])).rows;
 if(allocations.length!==2||allocations.some(a=>a.state!==expected)||rows.some(r=>!allocations.some(a=>a.component_code===r.code)))rewardFailure('REWARD_RESERVATION_DRIFT','领取库存需核对，请联系客服',409);
 for(const row of rows){
  if(mode!=='cancel_unshipped'&&row.reserved_quantity<1)rewardFailure('REWARD_RESERVATION_DRIFT','领取库存需核对，请联系客服',409);
  const delta=mode==='consume'?-1:mode==='cancel_unshipped'?1:0,reservedDelta=mode==='cancel_unshipped'?0:-1;
  await c.query('UPDATE reward_component_inventory SET stock_on_hand=stock_on_hand+$2,reserved_quantity=reserved_quantity+$3,version=version+1,updated_at=$4 WHERE code=$1',[row.code,delta,reservedDelta,now]);
 }
 await c.query('UPDATE reward_stock_reservation SET state=$2 WHERE claim_id=$1',[claim.id,mode==='consume'?'consumed':'released']);
 if(mode==='consume')await c.query("UPDATE reward_voucher SET state='used',version=version+1 WHERE id=$1 AND state='locked'",[voucher.id]);
 else {const restored=restoredVoucher(voucher,now);await c.query('UPDATE reward_voucher SET state=$2,expires_at=$3,claim_id=NULL,version=version+1 WHERE id=$1',[voucher.id,restored.state,restored.expiresAt]);}
}
export async function quotePurchaseCoupon(c:DbClient,owner:string,couponId:string,productId:string,subtotal:number,now:Date){
 const coupon=(await c.query('SELECT * FROM member_purchase_coupon WHERE id=$1 AND member_id=$2 FOR SHARE',[couponId,owner])).rows[0];
 if(!coupon||coupon.state!=='available'||coupon.expires_at<=now||!coupon.eligible_product_ids.includes(productId)||subtotal<coupon.threshold_cents)rewardFailure('COUPON_NOT_ELIGIBLE','这张券当前不可用，请重新选择',409);
 return coupon;
}
export async function reservePurchaseCoupon(c:DbClient,owner:string,quote:any,orderId:string,now:Date){
 if(!quote.coupon_id)return;
 const coupon=(await c.query('SELECT * FROM member_purchase_coupon WHERE id=$1 AND member_id=$2 FOR UPDATE',[quote.coupon_id,owner])).rows[0];
 if(coupon&&(await c.query('SELECT $1::timestamptz<=clock_timestamp() AS expired',[coupon.expires_at])).rows[0].expired)rewardFailure('COUPON_CHANGED','优惠券已过期，请重新确认金额',409);
 if(!coupon||coupon.state!=='available'||coupon.version!==quote.coupon_version||coupon.expires_at<=now||!coupon.eligible_product_ids.includes(quote.product_id)||Number(quote.subtotal_cents)<coupon.threshold_cents||quote.coupon_discount_cents!==coupon.discount_cents)rewardFailure('COUPON_CHANGED','优惠券已变化，请重新确认金额',409);
 await c.query("UPDATE member_purchase_coupon SET state='locked',order_id=$2,version=version+1 WHERE id=$1",[coupon.id,orderId]);
}
export async function settlePurchaseCoupon(c:DbClient,orderId:string,mode:'consume'|'release',now:Date){
 const order=(await c.query('SELECT coupon_id,member_id FROM commerce_order WHERE id=$1',[orderId])).rows[0];if(!order?.coupon_id)return;
 const coupon=(await c.query('SELECT * FROM member_purchase_coupon WHERE id=$1 FOR UPDATE',[order.coupon_id])).rows[0];
 if(!coupon||coupon.member_id!==order.member_id)rewardFailure('COUPON_RESERVATION_DRIFT','优惠券状态需核对',409);
 if(mode==='consume'&&coupon.state==='used'&&coupon.order_id===orderId)return;
 if(coupon.state!=='locked'||coupon.order_id!==orderId){if(mode==='release'&&coupon.order_id!==orderId)return;rewardFailure('COUPON_RESERVATION_DRIFT','优惠券状态需核对',409);}
 const state=mode==='consume'?'used':coupon.expires_at<=now?'expired':'available';
 await c.query('UPDATE member_purchase_coupon SET state=$2,order_id=$3,version=version+1 WHERE id=$1',[coupon.id,state,mode==='consume'?orderId:null]);
}
export async function restoreRefundedCoupon(c:DbClient,orderId:string,now:Date){
 const coupon=(await c.query("SELECT * FROM member_purchase_coupon WHERE order_id=$1 AND state='used' FOR UPDATE",[orderId])).rows[0];if(!coupon)return;
 const totals=(await c.query(`SELECT o.total_cents,COALESCE((SELECT sum(i.payer_refund_cents) FROM commission_refund_intent i WHERE i.order_id=o.id AND i.state='succeeded'),0)::text AS refunded
  FROM commerce_order o WHERE o.id=$1`,[orderId])).rows[0];
 if(!totals||Number(totals.refunded)<Number(totals.total_cents))return;
 const source=(await c.query('SELECT state FROM activity_reward_claim WHERE id=$1',[coupon.source_claim_id])).rows[0];
 await c.query('UPDATE member_purchase_coupon SET state=$2,order_id=NULL,version=version+1 WHERE id=$1',[coupon.id,source?.state==='closed'?'revoked':coupon.expires_at<=now?'expired':'available']);
}
