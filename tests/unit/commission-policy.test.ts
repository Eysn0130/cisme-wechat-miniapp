import { describe,expect,it } from "vitest";
import { allocateDiscount,commissionAdjustment,commissionBuckets,commissionOrderBuckets,cumulativeCommission,
  scopedCommissionBasis } from "../../services/api/src/commissionPolicy";

describe("commission integer policy",()=>{
  it("allocates a whole-order discount exactly with deterministic remainders",()=>{
    const shares=allocateDiscount([{lineId:"b",merchandiseCents:101},{lineId:"a",merchandiseCents:101},
      {lineId:"c",merchandiseCents:101}],100);
    expect(shares).toEqual([{lineId:"b",allocatedDiscountCents:33},{lineId:"a",allocatedDiscountCents:34},
      {lineId:"c",allocatedDiscountCents:33}]);
    expect(shares.reduce((sum,line)=>sum+line.allocatedDiscountCents,0)).toBe(100);
  });
  it("allocates scoped coupons to all applicable SKUs before filtering eligible cash",()=>{
    const lines=[{lineId:"eligible",merchandiseCents:10_000,itemDiscountCents:1000,
      pointsTenderCents:500,commissionEligible:true},
      {lineId:"other",merchandiseCents:10_000,itemDiscountCents:0,
        pointsTenderCents:0,commissionEligible:false}];
    const both=scopedCommissionBasis({lines,orderDiscountCents:1900,
      applicableLineIds:["eligible","other"],rateBps:2000});
    expect(both.lines).toEqual([{lineId:"eligible",commissionEligible:true,itemDiscountCents:1000,
      orderDiscountCents:900,pointsTenderCents:500,cashCents:7600},
    {lineId:"other",commissionEligible:false,itemDiscountCents:0,orderDiscountCents:1000,
      pointsTenderCents:0,cashCents:9000}]);
    expect(both).toMatchObject({eligibleCashCents:7600,commissionCents:1520});
    const onlyOther=scopedCommissionBasis({lines,orderDiscountCents:1900,
      applicableLineIds:["other"],rateBps:2000});
    expect(onlyOther).toMatchObject({eligibleCashCents:8500,commissionCents:1700});
    expect(scopedCommissionBasis({lines:[...lines].reverse(),orderDiscountCents:1900,
      applicableLineIds:["other","eligible"],rateBps:2000}).lines
      .find(line=>line.lineId==="eligible")?.orderDiscountCents).toBe(900);
    expect(()=>scopedCommissionBasis({lines,orderDiscountCents:19_001,
      applicableLineIds:["eligible","other"],rateBps:2000})).toThrow();
    expect(()=>scopedCommissionBasis({lines,orderDiscountCents:100,
      applicableLineIds:["missing"],rateBps:2000})).toThrow();
  });
  it("uses merchandise cash after discount, points and cumulative refunds, never freight",()=>{
    const line={lineId:"sku-1",merchandiseCents:50_000,allocatedDiscountCents:0,pointsTenderCents:0,cumulativeRefundCents:0};
    expect(cumulativeCommission([line],2500)).toMatchObject({eligibleCashCents:50_000,commissionCents:12_500});
    expect(commissionAdjustment(12_500,[{...line,cumulativeRefundCents:10_000}],2500)).toMatchObject({commissionCents:10_000,deltaCents:-2_500});
    expect(commissionAdjustment(12_500,[{...line,cumulativeRefundCents:4_000+6_000}],2500).deltaCents).toBe(-2_500);
    expect(cumulativeCommission([{...line,allocatedDiscountCents:5_000,pointsTenderCents:5_000}],2000).commissionCents).toBe(8_000);
    expect(cumulativeCommission([line],3500).commissionCents).toBe(17_500);
  });
  it("rejects out-of-range rates, excess refunds and non-integer money",()=>{
    const line={lineId:"x",merchandiseCents:10_000,allocatedDiscountCents:0,pointsTenderCents:0,cumulativeRefundCents:0};
    for(const rate of [1999,3501,20.5,NaN])expect(()=>cumulativeCommission([line],rate)).toThrow();
    expect(()=>cumulativeCommission([{...line,cumulativeRefundCents:10_001}],2000)).toThrow();
    expect(()=>allocateDiscount([{lineId:"x",merchandiseCents:100}],101)).toThrow();
  });
  it("rebuilds pending, available, held, paid and recovery without counting one cent twice",()=>{
    expect(commissionBuckets({accruedCents:2000,reversedCents:500,releasedCents:1000,paidCents:200,heldCents:300}))
      .toMatchObject({pendingCents:500,availableCents:500,paymentHeldCents:300,settledCents:200,recoveryCents:0});
    expect(commissionBuckets({accruedCents:2000,reversedCents:1800,releasedCents:2000,paidCents:1000}))
      .toMatchObject({pendingCents:0,availableCents:0,settledCents:1000,recoveryCents:800,netEarnedCents:200});
    expect(()=>commissionBuckets({accruedCents:100,reversedCents:101,releasedCents:0,paidCents:0})).toThrow();
    expect(()=>commissionBuckets({accruedCents:100,reversedCents:0,releasedCents:100,paidCents:0,heldCents:101})).toThrow();
  });
  it("keeps a refunded paid order separate from another order that has not released",()=>{
    const orders=[
      {accruedCents:10_000,reversedCents:10_000,releasedCents:10_000,paidCents:10_000,heldCents:0},
      {accruedCents:10_000,reversedCents:0,releasedCents:0,paidCents:0,heldCents:0}];
    expect(commissionBuckets({accruedCents:20_000,reversedCents:10_000,releasedCents:10_000,paidCents:10_000}))
      .toMatchObject({pendingCents:0,recoveryCents:0}); // reproduces the old, lossy aggregation
    for(const permutation of [orders,[...orders].reverse()])
      expect(commissionOrderBuckets(permutation)).toMatchObject({pendingCents:10_000,
        settledCents:10_000,recoveryCents:10_000,availableCents:0});
  });
  it("keeps spent-to-credit source exposure distinct from cash paid and a different order's pending",()=>{
    const orders=[{accruedCents:10_000,reversedCents:10_000,releasedCents:10_000,
      paidCents:0,convertedCents:10_000,heldCents:0},
    {accruedCents:10_000,reversedCents:0,releasedCents:0,paidCents:0,convertedCents:0,heldCents:0}];
    for(const ordered of [orders,[...orders].reverse()])
      expect(commissionOrderBuckets(ordered)).toMatchObject({pendingCents:10_000,
        creditConvertedCents:10_000,settledCents:0,recoveryCents:10_000,availableCents:0});
    expect(commissionBuckets({accruedCents:20_000,reversedCents:0,releasedCents:20_000,
      paidCents:5000,convertedCents:5000,heldCents:5000})).toMatchObject({availableCents:5000,
        settledCents:5000,creditConvertedCents:5000,paymentHeldCents:5000});
    expect(()=>commissionBuckets({accruedCents:10_000,reversedCents:0,releasedCents:10_000,
      paidCents:6000,convertedCents:5000})).toThrow("佣金分录不守恒");
  });
  it("rebuilds per-order recovery and pending under deterministic multi-order permutations",()=>{
    let seed=0x13579bdf;
    const next=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed;};
    for(let round=0;round<128;round++){
      const orders=Array.from({length:3+next()%7},()=>{
        const accruedCents=1+next()%100_000,releasedCents=next()%(accruedCents+1),
          reversedCents=next()%(accruedCents+1),paidCents=next()%(releasedCents+1),
          convertedCents=next()%(releasedCents-paidCents+1),
          heldCents=next()%(releasedCents-paidCents-convertedCents+1);
        return {accruedCents,reversedCents,releasedCents,paidCents,convertedCents,heldCents};
      });
      const expectedPending=orders.reduce((sum,o)=>sum+Math.max(0,o.accruedCents-o.reversedCents-o.releasedCents),0);
      const expectedRecovery=orders.reduce((sum,o)=>sum+Math.max(0,o.paidCents+o.convertedCents-
        (o.accruedCents-o.reversedCents)),0);
      const shuffled=[...orders];
      for(let index=shuffled.length-1;index>0;index--){
        const other=next()%(index+1);
        [shuffled[index],shuffled[other]]=[shuffled[other]!,shuffled[index]!];
      }
      for(const ordered of [orders,[...orders].reverse(),shuffled]){
        const result=commissionOrderBuckets(ordered);
        expect(result.pendingCents).toBe(expectedPending);
        expect(result.recoveryCents).toBe(expectedRecovery);
        expect(result.netEarnedCents).toBe(ordered.reduce((sum,o)=>sum+o.accruedCents-o.reversedCents,0));
        expect(result.settledCents+result.creditConvertedCents+result.paymentHeldCents+
          result.availableCents-result.reservedRecoveryCents).toBeLessThanOrEqual(
            ordered.reduce((sum,o)=>sum+o.releasedCents,0));
      }
    }
  });
});
