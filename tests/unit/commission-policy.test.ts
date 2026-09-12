import { describe,expect,it } from "vitest";
import { allocateDiscount,commissionAdjustment,commissionBuckets,cumulativeCommission } from "../../services/api/src/commissionPolicy";

describe("commission integer policy",()=>{
  it("allocates a whole-order discount exactly with deterministic remainders",()=>{
    const shares=allocateDiscount([{lineId:"b",merchandiseCents:101},{lineId:"a",merchandiseCents:101},
      {lineId:"c",merchandiseCents:101}],100);
    expect(shares).toEqual([{lineId:"b",allocatedDiscountCents:33},{lineId:"a",allocatedDiscountCents:34},
      {lineId:"c",allocatedDiscountCents:33}]);
    expect(shares.reduce((sum,line)=>sum+line.allocatedDiscountCents,0)).toBe(100);
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
});
