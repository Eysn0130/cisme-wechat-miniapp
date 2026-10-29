import { describe, expect, it } from 'vitest';
import { DAILY_CARE_PROTOCOL_VERSION } from '@cisme/contracts';
import { dailyCareInput } from '../../services/api/src/dailyCare';

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
});
