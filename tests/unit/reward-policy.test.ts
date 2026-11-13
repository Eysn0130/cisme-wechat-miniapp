import {describe,it,expect} from 'vitest';
import {rewardBundles,rewardTerms,rewardRecommendation,visibleVoucherState,restoredVoucher} from '../../services/api/src/rewardPolicy';

const valid={maxAwardsPerMember:1,voucherValidityDays:30,shippingCents:0,dispatchHours:72,restoreGraceDays:0,stockoutPolicy:'retain_until_expiry',eligibleProductIds:['11111111-1111-4111-8111-111111111111']};
describe('confirmed travel-award policy',()=>{
 it('uses distinct actual shampoo capacities and one shared conditioner component',()=>{
  expect(rewardBundles.map(b=>[b.shampooMl,b.conditionerMl,b.totalMl])).toEqual([[100,100,200],[50,100,150]]);
  expect(new Set(rewardBundles.flatMap(b=>b.components)).size).toBe(3);
  expect(rewardBundles[0].components.filter(c=>rewardBundles[1].components.includes(c as never))).toEqual(['conditioner100']);
 });
 it('accepts the explicitly confirmed one-voucher, free-shipping policy',()=>expect(rewardTerms(valid)).toEqual(valid));
 it.each([{maxAwardsPerMember:2},{shippingCents:100},{voucherValidityDays:60},{dispatchHours:96},{restoreGraceDays:30},{eligibleProductIds:[]},{eligibleProductIds:['not-a-member-id']},{eligibleProductIds:[valid.eligibleProductIds[0],valid.eligibleProductIds[0]]},{stockoutPolicy:'consume-anyway'},{surprise:true}])('rejects an unapproved or unsafe rule extension %j',patch=>expect(()=>rewardTerms({...valid,...patch})).toThrow());
 it('honors explicit final preference before scalp-based recommendation',()=>{
  expect(rewardRecommendation({preference:{status:'answered',values:['net_run']},dandruff:{status:'answered',values:['often']}},'granted')).toBe('moisture');
  expect(rewardRecommendation({preference:{status:'answered',values:['net_xie']}},'declined')).toBe('dandruff');
 });
 it('never uses non-authorized health answers to recommend',()=>{
  expect(rewardRecommendation({dandruff:{status:'answered',values:['often']}},'declined')).toBe('moisture');
  expect(rewardRecommendation({dandruff:{status:'answered',values:['often']}},'granted')).toBe('dandruff');
 });
 it('does not expire a committed lock while handling ordinary voucher expiry',()=>{
  const now=new Date('2026-12-01T00:00:00Z'),expires_at=new Date('2026-11-30T23:59:59Z');
  expect(visibleVoucherState({state:'unused',expires_at},now)).toBe('expired');
  expect(visibleVoucherState({state:'locked',expires_at},now)).toBe('locked');
 });
 it('restores an already expired cancelled claim as expired without silent extension',()=>{
  const expires_at=new Date('2026-11-30T00:00:00Z');
  expect(restoredVoucher({expires_at,terms_snapshot:rewardTerms(valid)},new Date('2026-12-01T00:00:00Z'))).toEqual({state:'expired',expiresAt:expires_at});
 });
});
