import {DomainError} from '@cisme/domain';
import type {DbClient} from './db.js';

export const clubRulesV1={daily:10,note:5,streak7:50,streak30:200,post:50,featured:100,comment:5,questionnaire:100,
  firstOrder:300,inviteSponsor:300,inviteFriend:200,postWeeklyLimit:2,commentDailyLimit:2,
  expiryMonths:12,reminderDays:30,discountBps:2000,pointsPerYuan:100,refundGraceDays:30,birthdayMultiplier:2};
export type ClubRules=typeof clubRulesV1;
export type PointsPolicy={version:string;rules:ClubRules;monthly_budget:number|null;starts_at:Date;ends_at:Date|null;state:string};
export const pointDay=(date:Date)=>new Date(date.getTime()+8*3600000).toISOString().slice(0,10);
export function addPointMonths(date:Date,months:number){
  const d=new Date(date.getTime()+8*3600000),target=new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth()+months,1));
  const last=new Date(Date.UTC(target.getUTCFullYear(),target.getUTCMonth()+1,0)).getUTCDate();
  return new Date(Date.UTC(target.getUTCFullYear(),target.getUTCMonth(),Math.min(d.getUTCDate(),last),d.getUTCHours(),d.getUTCMinutes(),d.getUTCSeconds(),d.getUTCMilliseconds())-8*3600000);
}
export function validClubRules(input:unknown):ClubRules{
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).sort().join()!==Object.keys(clubRulesV1).sort().join())
    throw new DomainError('POINTS_RULES_INVALID','积分规则字段不完整',422);
  const r=input as ClubRules;
  for(const k of Object.keys(clubRulesV1) as Array<keyof ClubRules>)if(!Number.isSafeInteger(r[k])||r[k]<0||r[k]>100000)
    throw new DomainError('POINTS_RULES_INVALID','积分规则必须为支持范围内的整数',422);
  if(r.expiryMonths<1||r.expiryMonths>36||r.reminderDays<1||r.reminderDays>90||r.discountBps>2000||r.pointsPerYuan<1||r.pointsPerYuan>10000||r.refundGraceDays<1||r.refundGraceDays>90
    ||r.postWeeklyLimit>10||r.commentDailyLimit>10||r.birthdayMultiplier<1||r.birthdayMultiplier>3)
    throw new DomainError('POINTS_RULES_INVALID','有效期、兑换比例或频控超出支持范围',422);
  if(r.pointsPerYuan!==100)throw new DomainError('POINTS_VALUE_CONTRACT_FIXED','积分兑换比例固定为100积分抵1元，规则更新不能降低已获得积分的权益',422);
  return {...r};
}
export async function activePointPolicy(client:Pick<DbClient,'query'>,now=new Date()):Promise<PointsPolicy|null>{
  const p=(await client.query<PointsPolicy>(`SELECT * FROM member_points_policy WHERE approved_at IS NOT NULL AND starts_at<=$1 AND (ends_at IS NULL OR ends_at>$1)
    AND (retired_at IS NULL OR retired_at>$1) ORDER BY starts_at DESC LIMIT 1`,[now])).rows[0];
  if(!p)return null;validClubRules(p.rules);return p;
}
export async function pointPolicyByVersion(client:DbClient,version:string|null|undefined){
  if(!version)return null;
  const p=(await client.query<PointsPolicy>(`SELECT * FROM member_points_policy WHERE version=$1 AND approved_at IS NOT NULL`,[version])).rows[0];
  if(p)validClubRules(p.rules);return p??null;
}
export async function lockPointWallet(client:DbClient,owner:string,active=false){
  const member=(await client.query<{status:string}>('SELECT status FROM member WHERE id=$1 FOR UPDATE',[owner])).rows[0];
  if(!member||active&&member.status!=='active')throw new DomainError('AUTH_REVOKED','账号状态已变化，请重新登录',401);
  await client.query('INSERT INTO points_projection(member_id) VALUES($1) ON CONFLICT DO NOTHING',[owner]);
  return (await client.query<{available:number;frozen:number;debt:number;reserved:number;version:number}>('SELECT * FROM points_projection WHERE member_id=$1 FOR UPDATE',[owner])).rows[0]!;
}
type Changes={available?:number;frozen?:number;debt?:number;reserved?:number;used?:number;expired?:number};
export async function pointTransaction(client:DbClient,owner:string,businessKey:string,kind:string,now:Date,reason:string,ruleVersion:string|null=null,actor=`member:${owner}`,reverseOf:string|null=null){
  return (await client.query<{id:string}>(`INSERT INTO points_transaction(member_id,business_key,kind,occurred_at,actor_principal_id,rule_version,reason,reverse_of)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(business_key) DO NOTHING RETURNING id`,[owner,businessKey,kind,now,actor,ruleVersion,reason,reverseOf])).rows[0]?.id??null;
}
export async function pointEntry(client:DbClient,owner:string,transactionId:string,type:string,key:string,now:Date,delta:Changes,
  lot:{id:string;grant_id:string}|null,metadata:Record<string,unknown>={}){
  for(const n of Object.values(delta))if(!Number.isSafeInteger(n))throw new Error('POINTS_INTEGER_REQUIRED');
  await client.query(`INSERT INTO points_entry(member_id,transaction_id,grant_id,lot_id,entry_type,business_key,occurred_at,
    available_delta,frozen_delta,debt_delta,reserved_delta,used_delta,expired_delta,metadata)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
    [owner,transactionId,lot?.grant_id??null,lot?.id??null,type,key,now,delta.available??0,delta.frozen??0,delta.debt??0,delta.reserved??0,delta.used??0,delta.expired??0,metadata]);
  await client.query(`UPDATE points_projection SET available=available+$2,frozen=frozen+$3,debt=debt+$4,reserved=reserved+$5,
    version=version+1,updated_at=$6 WHERE member_id=$1`,[owner,delta.available??0,delta.frozen??0,delta.debt??0,delta.reserved??0,now]);
}
type Lot={invalid_reserved:number;invalid_used:number;invalid_offset:number;id:string;grant_id:string;available_amount:number;frozen_amount:number;reserved_amount:number;used_amount:number;expired_amount:number;offset_amount:number;reversed_amount:number;expires_at:Date|null;available_after?:Date|null};
export async function offsetPointDebt(client:DbClient,owner:string,tx:string,now:Date){
  let debt=(await client.query<{debt:number}>('SELECT debt FROM points_projection WHERE member_id=$1 FOR UPDATE',[owner])).rows[0]!.debt;
  if(!debt)return;
  const lots=(await client.query<Lot>(`SELECT l.* FROM points_lot l JOIN points_grant g ON g.id=l.grant_id
    WHERE g.member_id=$1 AND l.available_amount>0 AND (l.expires_at IS NULL OR l.expires_at>$2) ORDER BY l.expires_at ASC NULLS LAST,l.id FOR UPDATE OF l`,[owner,now])).rows;
  for(const lot of lots){const take=Math.min(debt,lot.available_amount);if(!take)break;
    await client.query('UPDATE points_lot SET available_amount=available_amount-$2,offset_amount=offset_amount+$2 WHERE id=$1',[lot.id,take]);
    await pointEntry(client,owner,tx,'debt_offset',`${tx}:offset:${lot.id}`,now,{available:-take,debt:-take},lot,{amount:take});debt-=take;
  }
}
export async function grantMemberPoints(client:DbClient,input:{owner:string;sourceType:string;sourceId:string;component:string;amount:number;policy:PointsPolicy;now:Date;bucket?:string}){
  const {owner,sourceType,sourceId,component,amount,policy,now}=input;
  if(amount===0)return null;
  if(!Number.isSafeInteger(amount)||amount<0||amount>2147483647)throw new Error('POINTS_GRANT_AMOUNT_INVALID');
  if((await client.query("SELECT enabled FROM emergency_switch WHERE key='rewards'")).rows[0]?.enabled!==true)
    throw new DomainError('REWARDS_PAUSED','积分发放暂时暂停，奖励来源将保留待处理',503);
  await lockPointWallet(client,owner);await sweepMemberPoints(client,owner,now);
  const prior=(await client.query<{id:string}>(`SELECT id FROM points_grant WHERE member_id=$1 AND source_type=$2 AND source_id=$3 AND component=$4`,[owner,sourceType,sourceId,component])).rows[0];
  if(prior)return prior.id;
  const month=pointDay(now).slice(0,7);
  await client.query(`INSERT INTO member_points_budget(policy_version,month_bucket) VALUES($1,$2) ON CONFLICT DO NOTHING`,[policy.version,month]);
  await client.query(`UPDATE member_points_budget SET issued=issued+$3 WHERE policy_version=$1 AND month_bucket=$2`,[policy.version,month,amount]);
  const business=`club:${owner}:${sourceType}:${sourceId}:${component}`;
  const tx=await pointTransaction(client,owner,business,'earn',now,'会员积分奖励',policy.version,'worker:member-points');if(!tx)throw new Error('POINTS_TRANSACTION_SOURCE_DRIFT');
  const expires=addPointMonths(now,policy.rules.expiryMonths);
  const grant=(await client.query<{id:string}>(`INSERT INTO points_grant(member_id,amount,state,source_type,source_id,component,rule_version,rule_snapshot,available_after,expires_at,created_at)
    VALUES($1,$2,'available',$3,$4,$5,$6,$7,$8,$9,$8) RETURNING id`,[owner,amount,sourceType,sourceId,component,policy.version,policy.rules,now,expires])).rows[0]!;
  const lot=(await client.query<Lot>(`INSERT INTO points_lot(grant_id,original_amount,frozen_amount,available_amount,expires_at)
    VALUES($1,$2,0,$2,$3) RETURNING *`,[grant.id,amount,expires])).rows[0]!;
  await pointEntry(client,owner,tx,'grant_available',business,now,{available:amount},lot,{sourceType,sourceId,component,ruleVersion:policy.version,amount,bucket:input.bucket??null});
  await offsetPointDebt(client,owner,tx,now);return grant.id;
}
export async function reverseMemberGrant(client:DbClient,grantId:string,target:number,sourceKey:string,now:Date,reason:string){
  const base=(await client.query<{member_id:string}>('SELECT member_id FROM points_grant WHERE id=$1',[grantId])).rows[0];if(!base)return;
  await lockPointWallet(client,base.member_id);await sweepMemberPoints(client,base.member_id,now);
  const g=(await client.query<{id:string;member_id:string;amount:number;reversed_total:number;rule_version:string|null}>('SELECT * FROM points_grant WHERE id=$1 FOR UPDATE',[grantId])).rows[0]!;
  if(!Number.isSafeInteger(target)||target<0||target>g.amount)throw new Error('POINTS_REVERSAL_AMOUNT_INVALID');
  let remaining=target-g.reversed_total;if(remaining<=0)return;
  const original=(await client.query<{transaction_id:string}>('SELECT transaction_id FROM points_entry WHERE grant_id=$1 AND entry_type IN (\'grant_available\',\'grant_frozen\') ORDER BY occurred_at,id LIMIT 1',[g.id])).rows[0];
  const tx=await pointTransaction(client,g.member_id,`points-reverse:${g.id}:${sourceKey}`,'reverse',now,reason,g.rule_version,'worker:member-points',original?.transaction_id??null);if(!tx)return;
  const lot=(await client.query<Lot>('SELECT * FROM points_lot WHERE grant_id=$1 FOR UPDATE',[g.id])).rows[0]!;
  const a=Math.min(remaining,lot.available_amount);remaining-=a;
  const f=Math.min(remaining,lot.frozen_amount);remaining-=f;
  const x=Math.min(remaining,lot.expired_amount);remaining-=x;
  const invalidUsed=Math.min(remaining,lot.used_amount-lot.invalid_used),invalidReserved=Math.min(remaining-invalidUsed,lot.reserved_amount-lot.invalid_reserved),invalidOffset=remaining-invalidUsed-invalidReserved;
  if(invalidOffset>lot.offset_amount-lot.invalid_offset)throw new Error('POINTS_REVERSAL_BUCKET_DRIFT');
  await client.query(`UPDATE points_lot SET available_amount=available_amount-$2,frozen_amount=frozen_amount-$3,expired_amount=expired_amount-$4,
    reversed_amount=reversed_amount+$2+$3+$4,invalid_used=invalid_used+$5,invalid_reserved=invalid_reserved+$6,invalid_offset=invalid_offset+$7 WHERE id=$1`,[lot.id,a,f,x,invalidUsed,invalidReserved,invalidOffset]);
  await pointEntry(client,g.member_id,tx,'reversal',`${tx}:reverse`,now,{available:-a,frozen:-f,expired:-x,debt:remaining-invalidReserved},lot,{amount:target-g.reversed_total,reason,invalidReservedPending:invalidReserved});
  await client.query(`UPDATE points_grant SET reversed_total=$2,blocked_for_use=CASE WHEN source_type IS NOT NULL THEN false ELSE blocked_for_use END,
    state=CASE WHEN $2=amount THEN 'blocked' ELSE state END,version=version+1 WHERE id=$1`,[g.id,target]);
  await offsetPointDebt(client,g.member_id,tx,now);
}
export async function sweepMemberPoints(client:DbClient,owner:string,now:Date){
  await lockPointWallet(client,owner);
  const lots=(await client.query<Lot>(`SELECT l.*,g.available_after FROM points_lot l JOIN points_grant g ON g.id=l.grant_id
    WHERE g.member_id=$1 AND (l.available_amount>0 OR l.frozen_amount>0) AND
      ((l.expires_at IS NOT NULL AND l.expires_at<=$2) OR (l.frozen_amount>0 AND NOT g.blocked_for_use AND g.available_after<=$2))
    ORDER BY l.expires_at NULLS LAST,l.id FOR UPDATE OF l,g`,[owner,now])).rows;
  for(const lot of lots){
    const expired=lot.expires_at&&lot.expires_at<=now,amount=expired?lot.available_amount+lot.frozen_amount:lot.frozen_amount;
    const tx=await pointTransaction(client,owner,`points-${expired?'expiry':'unlock'}:${lot.id}:${expired?lot.expires_at!.toISOString():lot.available_after!.toISOString()}`,
      expired?'expire':'unfreeze',now,expired?'积分按批次到期':'冻结积分到期解冻',null,'worker:member-points');if(!tx)continue;
    await client.query(`UPDATE points_lot SET frozen_amount=0,available_amount=$2,expired_amount=expired_amount+$3 WHERE id=$1`,[lot.id,expired?0:lot.available_amount+amount,expired?amount:0]);
    await pointEntry(client,owner,tx,expired?'expire':'unfreeze',tx,now,{available:expired?-lot.available_amount:amount,frozen:-lot.frozen_amount,expired:expired?amount:0},lot,{amount});
    await client.query(`UPDATE points_grant SET state=$2,version=version+1 WHERE id=$1`,[lot.grant_id,expired?'expired':'available']);
    if(!expired)await offsetPointDebt(client,owner,tx,now);
  }
}
export async function reserveMemberPoints(client:DbClient,owner:string,orderId:string,amount:number,now:Date){
  if(!amount)return;
  await sweepMemberPoints(client,owner,now);
  const p=await lockPointWallet(client,owner,true);
  if(p.debt||p.available<amount)throw new DomainError('POINTS_INSUFFICIENT','可用积分不足或存在待冲抵欠分，请重新确认',409);
  const tx=await pointTransaction(client,owner,`points-reserve:${orderId}`,'reserve',now,'订单积分预占');if(!tx)return;
  const lots=(await client.query<Lot>(`SELECT l.* FROM points_lot l JOIN points_grant g ON g.id=l.grant_id WHERE g.member_id=$1 AND l.available_amount>0 AND NOT g.blocked_for_use
    ORDER BY l.expires_at NULLS LAST,l.id FOR UPDATE OF l`,[owner])).rows;
  let remaining=amount;
  for(const lot of lots){const take=Math.min(remaining,lot.available_amount);if(!take)break;
    await client.query('UPDATE points_lot SET available_amount=available_amount-$2,reserved_amount=reserved_amount+$2 WHERE id=$1',[lot.id,take]);
    await client.query(`INSERT INTO member_points_allocation(order_id,lot_id,amount,state) VALUES($1,$2,$3,'reserved')`,[orderId,lot.id,take]);
    await pointEntry(client,owner,tx,'reserve',`${tx}:${lot.id}`,now,{available:-take,reserved:take},lot,{amount:take,orderId});remaining-=take;
  }
  if(remaining)throw new DomainError('POINTS_LOTS_DRIFT','积分批次需核对，请稍后重试',409);
}
export async function settleOrderPoints(client:DbClient,orderId:string,action:'spend'|'release',now=new Date()){
  const order=(await client.query<{member_id:string;points_spent:number}>('SELECT member_id,points_spent FROM commerce_order WHERE id=$1',[orderId])).rows[0];
  if(!order?.points_spent)return;
  await lockPointWallet(client,order.member_id);await sweepMemberPoints(client,order.member_id,now);
  const allocations=(await client.query<{lot_id:string;amount:number;state:string}>(`SELECT * FROM member_points_allocation WHERE order_id=$1 ORDER BY lot_id FOR UPDATE`,[orderId])).rows;
  if(allocations.reduce((s,a)=>s+a.amount,0)!==order.points_spent)throw new Error('POINTS_ORDER_ALLOCATION_DRIFT');
  if(allocations.every(a=>a.state===(action==='spend'?'spent':'released')))return;
  if(allocations.some(a=>a.state!=='reserved'))throw new Error('POINTS_ORDER_RESERVATION_STATE');
  const tx=await pointTransaction(client,order.member_id,`points-order-${action}:${orderId}`,action,now,action==='spend'?'订单积分已使用':'订单取消释放积分');if(!tx)return;
  for(const a of allocations){
    const lot=(await client.query<Lot>('SELECT * FROM points_lot WHERE id=$1 FOR UPDATE',[a.lot_id])).rows[0]!;
    const invalid=lot.invalid_reserved< a.amount?lot.invalid_reserved:a.amount;
    const expired=action==='release'&&lot.expires_at!==null&&lot.expires_at<=now,valid=a.amount-invalid;
    await client.query(`UPDATE points_lot SET reserved_amount=reserved_amount-$2,invalid_reserved=invalid_reserved-$3,
      used_amount=used_amount+$4,invalid_used=invalid_used+$5,reversed_amount=reversed_amount+$6,
      available_amount=available_amount+$7,expired_amount=expired_amount+$8 WHERE id=$1`,
      [lot.id,a.amount,invalid,action==='spend'?a.amount:0,action==='spend'?invalid:0,action==='release'?invalid:0,action==='release'&&!expired?valid:0,expired?valid:0]);
    await client.query('UPDATE member_points_allocation SET state=$3 WHERE order_id=$1 AND lot_id=$2',[orderId,lot.id,action==='spend'?'spent':'released']);
    await pointEntry(client,order.member_id,tx,action,`${tx}:${lot.id}`,now,{reserved:-a.amount,used:action==='spend'?a.amount:0,debt:action==='spend'?invalid:0,available:action==='release'&&!expired?valid:0,expired:expired?valid:0},lot,{amount:a.amount,orderId,expiredOnRelease:expired,invalidatedReservationCancelled:action==='release'?invalid:0,invalidatedDebtBooked:action==='spend'?invalid:0});

  }
  await offsetPointDebt(client,order.member_id,tx,now);
}
/** Returns of already spent invalidated points release their earlier debt or
 * restore repaid value. This is a traced refund credit, never new earnings.
 * Invalidated cash reservations book debt only on verified payment, not cancel. */
async function restoreInvalidatedPointCredit(client:DbClient,owner:string,original:Lot,amount:number,tx:string,now:Date,graceDays:number,source:Record<string,unknown>){
 const parent=(await client.query('SELECT rule_version,rule_snapshot FROM points_grant WHERE id=$1',[original.grant_id])).rows[0];
 const expiry=original.expires_at&&original.expires_at<=now?new Date(now.getTime()+graceDays*86400000):original.expires_at;
 const g=(await client.query<{id:string}>(`INSERT INTO points_grant(member_id,amount,state,source_type,source_id,component,rule_version,rule_snapshot,available_after,expires_at,created_at)
  VALUES($1,$2,'available','refund_recovery',$3,'restore',$4,$5,$6,$7,$6) RETURNING id`,[owner,amount,`${tx}:${original.id}`,parent.rule_version,parent.rule_snapshot,now,expiry])).rows[0]!;
 const lot=(await client.query<Lot>('INSERT INTO points_lot(grant_id,original_amount,frozen_amount,available_amount,expires_at) VALUES($1,$2,0,$2,$3) RETURNING *',[g.id,amount,expiry])).rows[0]!;
 await pointEntry(client,owner,tx,'refund_return',`${tx}:recovery:${original.id}`,now,{available:amount},lot,{...source,amount,restoredFromLot:original.id,restoredExpiry:expiry,repaymentRecovery:true});
}
export async function returnSpentMemberLot(client:DbClient,owner:string,lotId:string,amount:number,tx:string,now:Date,graceDays:number,source:Record<string,unknown>){
 const lot=(await client.query<Lot>('SELECT * FROM points_lot WHERE id=$1 FOR UPDATE',[lotId])).rows[0]!;
 const invalid=Math.min(amount,lot.invalid_used),valid=amount-invalid;
 const expiry=valid&&lot.expires_at&&lot.expires_at<=now?new Date(now.getTime()+graceDays*86400000):lot.expires_at;
 await client.query(`UPDATE points_lot SET used_amount=used_amount-$2,invalid_used=invalid_used-$3,reversed_amount=reversed_amount+$3,
  available_amount=available_amount+$4,expires_at=$5 WHERE id=$1`,[lot.id,amount,invalid,valid,expiry]);
 await pointEntry(client,owner,tx,'refund_return',`${tx}:${lot.id}`,now,{available:valid,used:-amount},lot,{...source,amount,invalidatedRestoration:invalid,restoredExpiry:expiry});
 if(invalid)await restoreInvalidatedPointCredit(client,owner,lot,invalid,tx,now,graceDays,source);
}
export async function returnOrderPoints(client:DbClient,orderId:string,cumulativeCashRefund:number,now:Date){
  const o=(await client.query<{member_id:string;points_spent:number;total_cents:string;shipping_cents:string;points_policy_version:string}>('SELECT * FROM commerce_order WHERE id=$1',[orderId])).rows[0];
  if(!o?.points_spent)return;
  const total=Number(o.total_cents)-Number(o.shipping_cents);if(!Number.isSafeInteger(cumulativeCashRefund)||cumulativeCashRefund<0||cumulativeCashRefund>total)throw new Error('POINTS_REFUND_AMOUNT_INVALID');
  const target=Number(BigInt(o.points_spent)*BigInt(cumulativeCashRefund)/BigInt(total));
  await lockPointWallet(client,o.member_id);await sweepMemberPoints(client,o.member_id,now);
  const tx=await pointTransaction(client,o.member_id,`points-order-refund:${orderId}:${target}`,'refund_return',now,'订单退款退回原积分批次');if(!tx)return;
  const policy=await pointPolicyByVersion(client,o.points_policy_version);let remaining=target;
  const rows=(await client.query<{lot_id:string;amount:number;returned:number;state:string}>(`SELECT * FROM member_points_allocation WHERE order_id=$1 ORDER BY lot_id FOR UPDATE`,[orderId])).rows;
  remaining-=rows.reduce((n,a)=>n+a.returned,0);
  for(const a of rows){const take=Math.min(remaining,a.amount-a.returned);if(!take)continue;if(a.state!=='spent')throw new Error('POINTS_REFUND_NOT_SPENT');
    await returnSpentMemberLot(client,o.member_id,a.lot_id,take,tx,now,policy?.rules.refundGraceDays??30,{orderId});
    await client.query('UPDATE member_points_allocation SET returned=returned+$3 WHERE order_id=$1 AND lot_id=$2',[orderId,a.lot_id,take]);remaining-=take;
  }
  if(remaining!==0)throw new Error('POINTS_REFUND_ALLOCATION_DRIFT');await offsetPointDebt(client,o.member_id,tx,now);
}
export async function quoteMemberPoints(client:DbClient,owner:string,skuId:string,subtotal:number,requested:number,now:Date){
  const policy=await activePointPolicy(client,now);
  const offer=(await client.query<{version:number}>('SELECT version FROM catalog_price WHERE sku_id=$1 FOR SHARE',[skuId])).rows[0];
  await sweepMemberPoints(client,owner,now);const wallet=await lockPointWallet(client,owner,true);
  const maximum=policy&&offer&&!wallet.debt
    ?Math.min(wallet.available,Number(BigInt(subtotal)*BigInt(policy.rules.discountBps)*BigInt(policy.rules.pointsPerYuan)/1000000n)):0;
  if(requested>maximum)throw new DomainError('POINTS_DISCOUNT_UNAVAILABLE','本次可抵扣积分不足或规则已更新，请重新确认',409);
  const discount=requested&&policy?Number(BigInt(requested)*100n/BigInt(policy.rules.pointsPerYuan)):0;
  if(requested&&!discount)throw new DomainError('POINTS_DISCOUNT_TOO_SMALL','本次积分不足以抵扣一分钱',422);
  return {policyVersion:policy?.version??null,offerVersion:offer?.version??null,maximum,discount,points:requested,
    enabled:Boolean(policy&&offer),pointsPerYuan:policy?.rules.pointsPerYuan??null,capBps:policy?.rules.discountBps??null};
}
