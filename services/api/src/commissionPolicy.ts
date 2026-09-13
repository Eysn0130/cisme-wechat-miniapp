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

/** Order-level discount applies to its actual SKU scope before eligibility is
 * considered. Points are an already-authorized per-line tender allocation; this
 * function never invents their conversion rate or includes freight in cash. */
export function scopedCommissionBasis(input:{lines:Array<{lineId:string;merchandiseCents:number;
  itemDiscountCents:number;pointsTenderCents:number;commissionEligible:boolean}>;
  orderDiscountCents:number;applicableLineIds:string[];rateBps:number}){
  const ids=new Set(input.lines.map(line=>line.lineId));
  if(!input.lines.length||ids.size!==input.lines.length||!Array.isArray(input.applicableLineIds)||
    !input.applicableLineIds.length||new Set(input.applicableLineIds).size!==input.applicableLineIds.length||
    input.applicableLineIds.some(id=>!ids.has(id)))
    throw new DomainError("COMMISSION_DISCOUNT_SCOPE_INVALID","优惠适用商品范围无效",422);
  const remainder=input.lines.map(line=>{
    const gross=cents(line.merchandiseCents,"商品"),itemDiscount=cents(line.itemDiscountCents,"商品优惠");
    if(itemDiscount>gross)throw new DomainError("COMMISSION_ALLOCATION_INVALID","商品优惠超过商品金额",422);
    return {lineId:line.lineId,merchandiseCents:gross-itemDiscount};
  });
  const scope=new Set(input.applicableLineIds);
  const split=allocateDiscount(remainder.filter(line=>scope.has(line.lineId)),input.orderDiscountCents);
  const discountById=new Map(split.map(line=>[line.lineId,line.allocatedDiscountCents]));
  const allocated=input.lines.map((line,index)=>{
    const orderDiscountCents=discountById.get(line.lineId)??0;
    const pointsTenderCents=cents(line.pointsTenderCents,"积分抵扣");
    if(orderDiscountCents+pointsTenderCents>remainder[index]!.merchandiseCents)
      throw new DomainError("COMMISSION_ALLOCATION_INVALID","商品支付组成不守恒",422);
    return {lineId:line.lineId,commissionEligible:line.commissionEligible,
      itemDiscountCents:line.itemDiscountCents,orderDiscountCents,pointsTenderCents,
      cashCents:remainder[index]!.merchandiseCents-orderDiscountCents-pointsTenderCents};
  });
  const cash=allocated.filter(line=>line.commissionEligible).reduce((sum,line)=>sum+BigInt(line.cashCents),0n);
  if(cash>BigInt(MAX_CENTS))throw new DomainError("COMMISSION_AMOUNT_INVALID","订单金额超出范围",422);
  const rate=basisPoints(input.rateBps);
  return {lines:allocated,eligibleCashCents:Number(cash),commissionCents:Number((cash*BigInt(rate)+5000n)/10000n),
    allocationVersion:"scoped-cash-v1" as const};
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
  if(held>released-paid)throw new DomainError("COMMISSION_HOLD_EXCEEDS_RELEASED","付款预占超过已释放金额",409);
  // A trusted refund can arrive after reservation. Preserve the in-flight
  // transfer and surface exposure; never manufacture a negative cash balance.
  const reservedRecovery=Math.max(0,held-availableBeforeHold);
  return {pendingCents:pending,availableCents:Math.max(0,availableBeforeHold-held),paymentHeldCents:held,
    settledCents:paid,recoveryCents:Math.max(0,paid-net),reservedRecoveryCents:reservedRecovery,
    netEarnedCents:net};
}

/** Bucket each source order before summing: min/max do not distribute over sum.
 * No implicit cross-order recovery or offset is authorized by this projection. */
export function commissionOrderBuckets(orders:Array<Parameters<typeof commissionBuckets>[0]>){
  const total={pendingCents:0,availableCents:0,paymentHeldCents:0,settledCents:0,
    recoveryCents:0,reservedRecoveryCents:0,netEarnedCents:0};
  for(const order of orders){
    const buckets=commissionBuckets(order);
    for(const field of Object.keys(total) as Array<keyof typeof total>){
      total[field]+=buckets[field];
      if(!Number.isSafeInteger(total[field]))
        throw new DomainError("COMMISSION_LEDGER_AMOUNT_INVALID","佣金汇总金额超出范围",409);
    }
  }
  return total;
}
