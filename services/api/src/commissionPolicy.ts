import { DomainError } from "@cisme/domain";

export interface CommissionLine {
  lineId:string;
  merchandiseCents:number;
  allocatedDiscountCents:number;
  pointsTenderCents:number;
  cumulativeRefundCents:number;
}
const MAX_CENTS=9_900_000_000;
function cents(value:unknown,label:string):number{
  if(!Number.isSafeInteger(value)||Number(value)<0||Number(value)>MAX_CENTS)
    throw new DomainError("COMMISSION_AMOUNT_INVALID",`${label}金额无效`,422);
  return Number(value);
}
function basisPoints(value:unknown):number{
  if(!Number.isInteger(value)||Number(value)<2000||Number(value)>3500)
    throw new DomainError("COMMISSION_RATE_INVALID","佣金比例须在 20%–35% 之间",422);
  return Number(value);
}

/** Largest-remainder allocation conserves every cent and is stable by line ID. */
export function allocateDiscount(lines:Array<{lineId:string;merchandiseCents:number}>,discountCents:number){
  const discount=cents(discountCents,"优惠");
  if(!lines.length||new Set(lines.map(line=>line.lineId)).size!==lines.length)
    throw new DomainError("COMMISSION_LINES_INVALID","商品明细无效",422);
  const values=lines.map(line=>({lineId:line.lineId,merchandiseCents:cents(line.merchandiseCents,"商品")}));
  const total=values.reduce((sum,line)=>sum+line.merchandiseCents,0);
  if(!Number.isSafeInteger(total)||total===0||discount>total)throw new DomainError("COMMISSION_DISCOUNT_INVALID","优惠金额超过商品金额",422);
  const shares=values.map((line,index)=>{
    const numerator=BigInt(line.merchandiseCents)*BigInt(discount);
    return {index,lineId:line.lineId,base:Number(numerator/BigInt(total)),remainder:numerator%BigInt(total)};
  });
  let unallocated=discount-shares.reduce((sum,item)=>sum+item.base,0);
  for(const share of [...shares].sort((a,b)=>a.remainder===b.remainder?a.lineId.localeCompare(b.lineId):a.remainder>b.remainder?-1:1)){
    if(unallocated--<=0)break;
    share.base+=1;
  }
  return shares.sort((a,b)=>a.index-b.index).map(item=>({lineId:item.lineId,allocatedDiscountCents:item.base}));
}

/** Cumulative target avoids rounding drift across partial and split refunds. */
export function cumulativeCommission(lines:CommissionLine[],rateBps:number){
  const rate=basisPoints(rateBps);
  if(!lines.length||new Set(lines.map(line=>line.lineId)).size!==lines.length)
    throw new DomainError("COMMISSION_LINES_INVALID","商品明细无效",422);
  let eligible=0n;
  for(const line of lines){
    const gross=cents(line.merchandiseCents,"商品"),discount=cents(line.allocatedDiscountCents,"优惠"),
      points=cents(line.pointsTenderCents,"积分抵扣"),refund=cents(line.cumulativeRefundCents,"退款");
    if(discount+points>gross||refund>gross-discount-points)
      throw new DomainError("COMMISSION_ALLOCATION_INVALID","商品级现金分摊不守恒",422);
    eligible+=BigInt(gross-discount-points-refund);
  }
  if(eligible>BigInt(MAX_CENTS))throw new DomainError("COMMISSION_AMOUNT_INVALID","订单金额超出范围",422);
  const commission=(eligible*BigInt(rate)+5000n)/10000n;
  return {eligibleCashCents:Number(eligible),commissionCents:Number(commission),rateBps:rate,rounding:"half_up_order_total_v1" as const};
}

export function commissionAdjustment(previousAccruedCents:number,lines:CommissionLine[],rateBps:number){
  const prior=cents(previousAccruedCents,"已计佣");
  const target=cumulativeCommission(lines,rateBps);
  return {...target,deltaCents:target.commissionCents-prior};
}

/** Read projection of immutable movements. A later refund never erases paid
 * history; it creates a separate recovery exposure for manual resolution. */
export function commissionBuckets(input:{accruedCents:number;reversedCents:number;releasedCents:number;
  paidCents:number;heldCents?:number}){
  const total=(value:unknown)=>{
    if(!Number.isSafeInteger(value)||Number(value)<0)
      throw new DomainError("COMMISSION_LEDGER_AMOUNT_INVALID","佣金汇总金额超出范围",409);
    return Number(value);
  };
  const accrued=total(input.accruedCents),reversed=total(input.reversedCents),
    released=total(input.releasedCents),paid=total(input.paidCents),held=total(input.heldCents??0);
  if(reversed>accrued||released>accrued||paid>released)
    throw new DomainError("COMMISSION_LEDGER_INVARIANT","佣金分录不守恒，暂停结算并核对",409);
  const net=accrued-reversed;
  const pending=Math.max(0,net-released);
  const availableBeforeHold=Math.max(0,Math.min(net,released)-paid);
  if(held>availableBeforeHold)throw new DomainError("COMMISSION_HOLD_EXCEEDS_AVAILABLE","付款预占超过可结算金额",409);
  return {pendingCents:pending,availableCents:availableBeforeHold-held,paymentHeldCents:held,
    settledCents:paid,recoveryCents:Math.max(0,paid-net),netEarnedCents:net};
}
