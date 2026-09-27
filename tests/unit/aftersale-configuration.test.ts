import {expect,it,vi} from 'vitest';
import {AftersaleService,returnInstruction} from '../../services/api/src/aftersale';

const valid={recipientName:'张女士',phone:'13800000000',region:'上海市浦东新区',address:'合成隔离收件地址，不用于真实寄件',freightPayer:'merchant',instructions:'保留寄出凭证'};

it('keeps only validated per-case return fields',()=>{
  expect(returnInstruction({...valid,privateExtra:'not in the business snapshot'})).toEqual(valid);
  expect(returnInstruction({...valid,phone:'+86-21-12345678'}).phone).toBe('+86-21-12345678');
});
it.each([
  {...valid,recipientName:''},{...valid,phone:'not-a-phone'},
  {...valid,phone:'-------'},{...valid,phone:'123----'},{...valid,phone:'1234567-'},
  {...valid,phone:'1234567890123456'},{...valid,region:''},
  {...valid,address:''},{...valid,freightPayer:'to_be_confirmed'},
  {...valid,instructions:'x'.repeat(501)}
])('rejects incomplete return instructions before a transaction',input=>{
  expect(()=>returnInstruction(input)).toThrowError(expect.objectContaining({code:'RETURN_INSTRUCTION_INVALID'}));
});
it.each(['constructor','toString','__proto__','unknown_action'])('rejects non-own action %s before opening a transaction',async action=>{
  const connect=vi.fn(()=>{throw Error('DATABASE_MUST_NOT_BE_OPENED');});
  const service=new AftersaleService({connect} as any,{} as any);
  await expect(service.act('11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222',
    'synthetic-invalid-action',{action,note:'合成非法动作',expectedVersion:1},true)).rejects.toMatchObject({code:'AFTERSALE_ACTION_INVALID'});
  expect(connect).not.toHaveBeenCalled();
});
