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
