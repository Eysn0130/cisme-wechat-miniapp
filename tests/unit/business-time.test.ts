import {describe,it,expect} from 'vitest';
import {beijingCivilInstant,beijingDateParts,beijingDateLabel} from '../../apps/miniprogram/services/business-time';
describe('management uses China business time independently of the device',()=>{
 it('round-trips Beijing midnight across the UTC date boundary',()=>{
  const instant=beijingCivilInstant('2026-11-12','00:30');expect(instant).toBe('2026-11-11T16:30:00.000Z');
  expect(beijingDateParts(instant!)).toEqual({date:'2026-11-12',time:'00:30'});expect(beijingDateLabel(instant!)).toBe('2026/11/12');
 });
 it('keeps the same China date during a western daylight-saving transition and validates actual calendar dates',()=>{
  expect(beijingCivilInstant('2026-03-08','02:30')).toBe('2026-03-07T18:30:00.000Z');
  expect(beijingCivilInstant('2026-02-29','00:30')).toBeNull();expect(beijingCivilInstant('2024-02-29','00:30')).toBe('2024-02-28T16:30:00.000Z');
  expect(beijingCivilInstant('2026-11-12','24:00')).toBeNull();expect(beijingDateParts('invalid')).toEqual({date:'',time:''});
 });
});
