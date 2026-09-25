import {mkdtemp,writeFile,rm,chmod,unlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach,it,expect,vi} from 'vitest';
import type {AppConfig} from '@cisme/config';
import {commerceAuthorization,commerceTransport} from '../../services/api/src/formalCommerceAuthorization';
const roots:string[]=[];
afterEach(async()=>{vi.unstubAllGlobals();vi.restoreAllMocks();await Promise.all(roots.splice(0).map(p=>rm(p,{recursive:true,force:true})));});
async function fixture(){
 const root=await mkdtemp(join(tmpdir(),'cisme-command-unit-'));roots.push(root);
 const path=join(root,'synthetic-authorization.json');
 const grant={schemaVersion:1,mode:'ordinary-merchant-commerce-commands',environment:'production',appId:'wx4eac2d4fb11d299b',merchantId:'1900000001',approvalReference:'SYNTHETIC-UNIT-ONLY',expiresAt:'2030-01-01T00:00:00Z',capabilities:['order.create','payment.prepare']};
 await writeFile(path,JSON.stringify(grant),{mode:0o600});
 return {path,grant,config:{env:'production'} as AppConfig,profile:{appId:grant.appId,merchantId:grant.merchantId,commerceAuthorizationFile:path} as NonNullable<AppConfig['commerce']['formalProtocol']>};
}
it('does not mistake recovery, staging, broad permissions or a path for live commerce approval',async()=>{
 const f=await fixture(),authorize=commerceAuthorization(f.config,f.profile);
 expect(authorize('payment.prepare')).toBe('SYNTHETIC-UNIT-ONLY');expect(()=>authorize('refund.submit')).toThrow();
 for(const change of [{mode:'ordinary-merchant-recovery-only'},{environment:'staging'},{appId:'wx0000000000000000'},
  {merchantId:'1900000002'},{expiresAt:'bad'},{expiresAt:'2000-01-01T00:00:00Z'},{approvalReference:''},{capabilities:['*']},
  {capabilities:['payment.prepare','payment.prepare']},{capabilities:['transfer.submit']}]){
  await writeFile(f.path,JSON.stringify({...f.grant,...change}));expect(()=>authorize('payment.prepare')).toThrow();
 }
 await writeFile(f.path,JSON.stringify(f.grant));expect(()=>commerceAuthorization({...f.config,env:'staging'},f.profile)).toThrow();
 await chmod(f.path,0o644);expect(()=>authorize('payment.prepare')).toThrow();
 await unlink(f.path);expect(()=>authorize('payment.prepare')).toThrow();
 const {commerceAuthorizationFile,...absent}=f.profile;expect(()=>commerceAuthorization(f.config,absent)('payment.prepare')).toThrow();
});
it('dispatches only the three ordinary-merchant writes, rechecks every send and never permits transfer',async()=>{
 const network=vi.fn(async(_input:unknown,_init:RequestInit)=>new Response('{}'));vi.stubGlobal('fetch',network);vi.spyOn(console,'info').mockImplementation(()=>{});
 const command=vi.fn(()=> 'SYNTHETIC-UNIT-ONLY'),recovery=vi.fn(()=> 'SYNTHETIC-RECOVERY-ONLY'),transport=commerceTransport(command,recovery);
 for(const url of ['https://api.mch.weixin.qq.com/v3/fund-app/mch-transfer/transfer-bills','https://evil.test/v3/pay/transactions/jsapi',
  'http://api.mch.weixin.qq.com/v3/pay/transactions/jsapi','https://api.mch.weixin.qq.com/v3/pay/transactions/jsapi?override=1',
  'https://api.mch.weixin.qq.com/v3/pay/partner/transactions/jsapi'])await expect(transport(url,{method:'POST'})).rejects.toThrow();
 expect(network).not.toHaveBeenCalled();
 for(const [path,cap] of [['/v3/pay/transactions/jsapi','payment.prepare'],['/v3/pay/transactions/out-trade-no/ORDER123/close','payment.close'],['/v3/refund/domestic/refunds','refund.submit']]){
  await transport('https://api.mch.weixin.qq.com'+path,{method:'POST'});expect(command).toHaveBeenLastCalledWith(cap);
 }
 expect(network).toHaveBeenCalledTimes(3);expect(network.mock.calls[0]?.[1]).toMatchObject({redirect:'error'});
 command.mockImplementation(()=>{throw Error('REVOKED');});await expect(transport('https://api.mch.weixin.qq.com/v3/pay/transactions/jsapi',{method:'POST'})).rejects.toThrow('REVOKED');
 expect(network).toHaveBeenCalledTimes(3);
 await transport('https://api.mch.weixin.qq.com/v3/pay/transactions/out-trade-no/ORDER123');expect(recovery).toHaveBeenCalledWith('payment.query');
});
