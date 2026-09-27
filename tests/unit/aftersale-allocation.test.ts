import { expect,it } from 'vitest';
import { allocateAftersaleClaim } from '../../services/api/src/aftersaleAllocation';

const lines=[{id:'a',quantity:3,line_total_cents:100,credit_tender_cents:20},
  {id:'b',quantity:2,line_total_cents:51,credit_tender_cents:0}];

it('conserves discounted merchandise, credit, cash, freight and eligible commission over quantities',()=>{
  const claims=[];
  let prior:{lineId:string;quantity:number}[]=[];
  for(const selected of [[{lineId:'a',quantity:1}],[{lineId:'b',quantity:1}],
    [{lineId:'a',quantity:2},{lineId:'b',quantity:1}]]){
    const claim=allocateAftersaleClaim({lines,shippingCents:19,eligibleCashCents:80,prior,selected});
    claims.push(claim);prior=[...prior,...selected];
  }
  expect(claims.map(claim=>claim.amountCents)).toEqual([37,28,105]);
  expect(claims.reduce((sum,claim)=>sum+claim.amountCents,0)).toBe(170);
  expect(claims.reduce((sum,claim)=>sum+claim.creditRefundCents,0)).toBe(20);
  expect(claims.reduce((sum,claim)=>sum+claim.cashRefundCents,0)).toBe(150);
  expect(claims.reduce((sum,claim)=>sum+claim.shippingRefundCents,0)).toBe(19);
  expect(claims.flatMap(claim=>claim.lines).reduce((sum,line)=>sum+line.eligibleCashRefundCents,0)).toBe(80);
  expect(()=>allocateAftersaleClaim({lines,shippingCents:19,eligibleCashCents:80,prior,
    selected:[{lineId:'a',quantity:1}]})).toThrow();
});

it('rejects unknown, duplicate or overdrawn line selections',()=>{
  const base={lines,shippingCents:19,eligibleCashCents:80,prior:[{lineId:'a',quantity:2}]};
  for(const selected of [[{lineId:'unknown',quantity:1}],
    [{lineId:'a',quantity:2}],[{lineId:'a',quantity:1},{lineId:'a',quantity:1}]])
    expect(()=>allocateAftersaleClaim({...base,selected})).toThrow();
});

it('conserves every cent across varied small paid orders regardless of claim order',()=>{
  for(let seed=1;seed<=80;seed++){
    const quantityA=1+seed%4,quantityB=1+Math.floor(seed/4)%4;
    const grossA=seed%37,grossB=(seed*7)%53;
    const creditA=grossA?seed%(grossA+1):0,creditB=grossB?(seed*3)%(grossB+1):0;
    const paid=[{id:'a',quantity:quantityA,line_total_cents:grossA,credit_tender_cents:creditA},
      {id:'b',quantity:quantityB,line_total_cents:grossB,credit_tender_cents:creditB}];
    const shippingCents=seed%17,cashMerchandise=grossA+grossB-creditA-creditB;
    const eligibleCashCents=cashMerchandise?seed%(cashMerchandise+1):0;
    const units=[...Array(quantityA)].map(()=>({lineId:'a',quantity:1}))
      .concat([...Array(quantityB)].map(()=>({lineId:'b',quantity:1})));
    if(seed%2)units.reverse();
    const prior:Array<{lineId:string;quantity:number;amountCents:number;cashRefundCents:number;
      creditRefundCents:number;eligibleCashRefundCents:number;otherCashRefundCents:number}>=[];
    const totals={amountCents:0,cashRefundCents:0,creditRefundCents:0,shippingRefundCents:0,eligibleCashRefundCents:0};
    for(const selected of units){
      const claim=allocateAftersaleClaim({lines:paid,shippingCents,eligibleCashCents,prior,selected:[selected]});
      expect(claim.amountCents).toBeGreaterThanOrEqual(0);
      expect(claim.cashRefundCents).toBeGreaterThanOrEqual(0);
      expect(claim.creditRefundCents).toBeGreaterThanOrEqual(0);
      for(const line of claim.lines){
        expect(line.cashRefundCents).toBeGreaterThanOrEqual(0);
        expect(line.creditRefundCents).toBeGreaterThanOrEqual(0);
        expect(line.eligibleCashRefundCents).toBeGreaterThanOrEqual(0);
        expect(line.otherCashRefundCents).toBeGreaterThanOrEqual(0);
        expect(line.cashRefundCents+line.creditRefundCents).toBe(line.amountCents);
        expect(line.eligibleCashRefundCents+line.otherCashRefundCents).toBe(line.cashRefundCents);
      }
      totals.amountCents+=claim.amountCents;totals.cashRefundCents+=claim.cashRefundCents;
      totals.creditRefundCents+=claim.creditRefundCents;totals.shippingRefundCents+=claim.shippingRefundCents;
      totals.eligibleCashRefundCents+=claim.lines.reduce((sum,line)=>sum+line.eligibleCashRefundCents,0);
      prior.push(...claim.lines);
    }
    expect(totals).toEqual({amountCents:grossA+grossB+shippingCents,
      cashRefundCents:cashMerchandise+shippingCents,creditRefundCents:creditA+creditB,
      shippingRefundCents:shippingCents,eligibleCashRefundCents:eligibleCashCents});
  }
});

it('uses actual v1 refund snapshots as consumed budget without rewriting them',()=>{
  const mixed=[{id:'mixed',quantity:5,line_total_cents:10003,credit_tender_cents:10002}];
  const old=[
    {lineId:'mixed',quantity:1,amountCents:2000,cashRefundCents:0,creditRefundCents:2000,
      eligibleCashRefundCents:0,otherCashRefundCents:0,allocationPolicyVersion:'quantity-net-components-v1'},
    {lineId:'mixed',quantity:1,amountCents:2001,cashRefundCents:1,creditRefundCents:2000,
      eligibleCashRefundCents:1,otherCashRefundCents:0,allocationPolicyVersion:'quantity-net-components-v1'}
  ];
  const third=allocateAftersaleClaim({lines:mixed,shippingCents:0,eligibleCashCents:1,
    prior:old,selected:[{lineId:'mixed',quantity:1}]});
  expect(third.lines[0]).toMatchObject({amountCents:2000,cashRefundCents:0,creditRefundCents:2000,
    eligibleCashRefundCents:0,otherCashRefundCents:0,allocationPolicyVersion:'quantity-net-components-v2'});
  const rest=allocateAftersaleClaim({lines:mixed,shippingCents:0,eligibleCashCents:1,
    prior:[...old,...third.lines],selected:[{lineId:'mixed',quantity:2}]});
  expect(rest).toMatchObject({amountCents:4002,cashRefundCents:0,creditRefundCents:4002});
  expect(()=>allocateAftersaleClaim({lines:mixed,shippingCents:0,eligibleCashCents:1,
    prior:[{...old[1]!,cashRefundCents:2}],selected:[{lineId:'mixed',quantity:1}]})).toThrow();
});

it('never allocates negative cash when one cent of cash is mixed with many credits',()=>{
  const mixed=[{id:'mixed',quantity:5,line_total_cents:10003,credit_tender_cents:10002}];
  const third=allocateAftersaleClaim({lines:mixed,shippingCents:0,eligibleCashCents:1,
    prior:[{lineId:'mixed',quantity:2}],selected:[{lineId:'mixed',quantity:1}]});
  expect(third.cashRefundCents).toBeGreaterThanOrEqual(0);
  expect(third.creditRefundCents).toBeLessThanOrEqual(third.amountCents);
  expect(third.lines[0]?.eligibleCashRefundCents).toBeGreaterThanOrEqual(0);
  expect(third.lines[0]?.otherCashRefundCents).toBeGreaterThanOrEqual(0);
});
