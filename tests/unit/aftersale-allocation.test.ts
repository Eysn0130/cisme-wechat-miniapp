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
    const prior:{lineId:string;quantity:number}[]=[];
    const totals={amountCents:0,cashRefundCents:0,creditRefundCents:0,shippingRefundCents:0,eligibleCashRefundCents:0};
    for(const selected of units){
      const claim=allocateAftersaleClaim({lines:paid,shippingCents,eligibleCashCents,prior,selected:[selected]});
      expect(claim.amountCents).toBeGreaterThanOrEqual(0);
      expect(claim.cashRefundCents).toBeGreaterThanOrEqual(0);
      expect(claim.creditRefundCents).toBeGreaterThanOrEqual(0);
      totals.amountCents+=claim.amountCents;totals.cashRefundCents+=claim.cashRefundCents;
      totals.creditRefundCents+=claim.creditRefundCents;totals.shippingRefundCents+=claim.shippingRefundCents;
      totals.eligibleCashRefundCents+=claim.lines.reduce((sum,line)=>sum+line.eligibleCashRefundCents,0);
      prior.push(selected);
    }
    expect(totals).toEqual({amountCents:grossA+grossB+shippingCents,
      cashRefundCents:cashMerchandise+shippingCents,creditRefundCents:creditA+creditB,
      shippingRefundCents:shippingCents,eligibleCashRefundCents:eligibleCashCents});
  }
});
