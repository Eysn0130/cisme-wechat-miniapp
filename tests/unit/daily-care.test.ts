import { describe, expect, it } from 'vitest';
import { DAILY_CARE_PROTOCOL_VERSION } from '@cisme/contracts';
import { dailyCareInput, DailyCareService, dailyCareServerDay } from '../../services/api/src/dailyCare';

const valid = () => ({stepCodes:['00','01','02','03'],selfAssessment:'comfortable'});
describe('independent daily care facts',()=>{
  it('uses the four canonical facts and copies the step array',()=>{
    const source=valid(),result=dailyCareInput(source);source.stepCodes.reverse();
    expect(result).toEqual(valid());expect(DAILY_CARE_PROTOCOL_VERSION).toBe('daily-care-v1');
  });
  it.each(['comfortable','neutral','attention'])('accepts the existing self assessment %s',selfAssessment=>{
    expect(dailyCareInput({...valid(),selfAssessment}).selfAssessment).toBe(selfAssessment);
  });
  it.each([[],['00','01','02'],['01','00','02','03'],['00','01','02','02'],['00','01','02','03','04'],null,'00,01,02,03'])('rejects incomplete/reordered/untyped steps %j',stepCodes=>{
    expect(()=>dailyCareInput({...valid(),stepCodes})).toThrow(expect.objectContaining({code:'CARE_PROTOCOL_STEPS_INCOMPLETE'}));
  });
  it.each([undefined,null,'unknown',{},false])('rejects missing or unsupported assessment %j',selfAssessment=>{
    expect(()=>dailyCareInput({...valid(),selfAssessment})).toThrow(expect.objectContaining({code:'CARE_SELF_ASSESSMENT_REQUIRED'}));
  });
  it.each(['memberId','cycleId','completedAt','timezone','protocolVersion','rewardPoints'])('rejects client-owned %s overrides',key=>{
    expect(()=>dailyCareInput({...valid(),[key]:'forged'})).toThrow(expect.objectContaining({code:'DAILY_CARE_INPUT_INVALID'}));
  });
  it.each([null,undefined,[],false,'input'])('rejects a non-object body %j',input=>{
    expect(()=>dailyCareInput(input)).toThrow(expect.objectContaining({code:'DAILY_CARE_INPUT_INVALID'}));
  });
  it('uses the server Shanghai day across UTC midnight boundaries',()=>{
    expect(dailyCareServerDay(new Date('2026-10-29T15:59:59.999Z'))).toBe('2026-10-29');
    expect(dailyCareServerDay(new Date('2026-10-29T16:00:00.000Z'))).toBe('2026-10-30');
  });
  it.each(['2026-02-30','2026-13-01','2026-1-01','not-a-day',false])('rejects invalid target day before opening a transaction: %j',async careDay=>{
    await expect(new DailyCareService({} as never).create('synthetic-member','synthetic-operation',{...valid(),careDay})).rejects.toMatchObject({code:'DAILY_CARE_DAY_INVALID'});
  });
  it.each([0,-1,1.2,true,'1',undefined])('requires an explicit positive integer version %j',async expectedVersion=>{
    await expect(new DailyCareService({} as never).visibility('synthetic-member','synthetic-id','synthetic-operation',{expectedVersion},'delete')).rejects.toMatchObject({code:'DAILY_CARE_VERSION_REQUIRED'});
  });
});
