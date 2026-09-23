import {mkdtempSync,rmSync,writeFileSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach,expect,it,vi} from 'vitest';
import {AftersaleService,approvedReturnDestination} from '../../services/api/src/aftersale';
let root:string|undefined;
afterEach(()=>{if(root)rmSync(root,{recursive:true,force:true});root=undefined;});
const candidate={approved:true,version:'synthetic-v1',approvalReference:'fixture://synthetic-business-confirmation',recipientName:'合成收件人',phone:'13800000000',address:'合成隔离地址，禁止真实邮寄'};
function file(value:unknown){root=mkdtempSync(join(tmpdir(),'cisme-return-config-test-'));const p=join(root,'return.json');writeFileSync(p,JSON.stringify(value),{mode:0o600});return p;}
it.each([undefined,'relative.json','/not-existing-cisme-return-policy'])('fails closed without a readable approved destination: %s',path=>{expect(()=>approvedReturnDestination(path)).toThrowError(expect.objectContaining({code:'RETURN_DESTINATION_UNAVAILABLE'}));});
it.each([{...candidate,approved:false},{...candidate,approvalReference:''},{...candidate,phone:''},{...candidate,address:''}])('rejects incomplete or unapproved configuration without exposing its content',value=>{const path=file(value);expect(()=>approvedReturnDestination(path)).toThrowError(expect.objectContaining({code:'RETURN_DESTINATION_UNAVAILABLE'}));});
it('reads only the necessary business fields and does not pass arbitrary config to consumers',()=>{expect(approvedReturnDestination(file({...candidate,privateExtra:'must-not-leave-config'}))).toEqual({version:candidate.version,approvalReference:candidate.approvalReference,recipientName:candidate.recipientName,phone:candidate.phone,address:candidate.address});});
it('rejects links and oversized input',()=>{const p=file(candidate),alias=join(root!,'alias.json');symlinkSync(p,alias);expect(()=>approvedReturnDestination(alias)).toThrow();writeFileSync(p,' '.repeat(9000));expect(()=>approvedReturnDestination(p)).toThrow();});
it.each(['constructor','toString','__proto__','unknown_action'])('rejects non-own action %s before opening a transaction',async action=>{
 const connect=vi.fn(()=>{throw Error('DATABASE_MUST_NOT_BE_OPENED');});
 const service=new AftersaleService({connect} as any,{} as any);
 await expect(service.act('11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222',
  'synthetic-invalid-action',{action,note:'合成非法动作',expectedVersion:1},true)).rejects.toMatchObject({code:'AFTERSALE_ACTION_INVALID'});
 expect(connect).not.toHaveBeenCalled();
});
