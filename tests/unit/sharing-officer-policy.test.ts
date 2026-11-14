import {describe,it,expect} from 'vitest';
import {sharingPolicyInput,sharingMonth,sharingTax,csvCell} from '../../services/api/src/sharingOfficerPolicy';

describe('sharing officer company rules',()=>{
 const policy={enabled:true,attributionDays:null,priority:'first',selfPurchase:false,basisPoints:1000,releaseDays:7,reason:'公司确认首期规则'};
 it('requires explicit attribution and money rules without silent defaults',()=>{
  expect(sharingPolicyInput(policy)).toEqual(policy);
  for(const field of ['enabled','attributionDays','priority','selfPurchase','basisPoints','releaseDays']){
   const value={...policy} as Record<string,unknown>;delete value[field];expect(()=>sharingPolicyInput(value)).toThrow();
  }
 });
 it('rejects self commission, fractional basis points and invalid release periods',()=>{
  for(const patch of [{selfPurchase:true},{basisPoints:10001},{basisPoints:999.1},{releaseDays:-1},{attributionDays:0},{priority:'random'}])
   expect(()=>sharingPolicyInput({...policy,...patch})).toThrow();
  expect(sharingPolicyInput({...policy,basisPoints:0,releaseDays:0,attributionDays:30,priority:'last'})).toMatchObject({basisPoints:0,releaseDays:0,attributionDays:30});
 });
 it('closes months at Shanghai midnight, including December rollover',()=>{
  expect(sharingMonth('2026-12',new Date('2026-12-31T16:00:00Z')).cutoff.toISOString()).toBe('2026-12-31T16:00:00.000Z');
  expect(()=>sharingMonth('2026-12',new Date('2026-12-31T15:59:59Z'))).toThrow();
  for(const invalid of ['2026-13','2026-1','2026-00','2026-10-01'])expect(()=>sharingMonth(invalid)).toThrow();
 });
 it('records reviewed tax rather than assuming a tax exemption or rate',()=>{
  expect(sharingTax(1980,0,'财务审核本次扣税为零')).toEqual({taxCents:0,taxNote:'财务审核本次扣税为零'});
  expect(sharingTax(1980,1980,'财务审核全额代扣')).toMatchObject({taxCents:1980});
  for(const value of [null,undefined,-1,1981,1.2])expect(()=>sharingTax(1980,value,'已审核')).toThrow();
  expect(()=>sharingTax(1980,10,' ')).toThrow();
 });
 it('neutralizes spreadsheet formulas without losing quotes/newlines',()=>{
  expect(csvCell('=1+1')).toBe('"\'=1+1"');expect(csvCell(' @SUM(A1)')).toBe('"\' @SUM(A1)"');
  expect(csvCell('订单"甲"\n乙')).toBe('"订单""甲""\n乙"');expect(csvCell(1980)).toBe('"1980"');
 });
});
