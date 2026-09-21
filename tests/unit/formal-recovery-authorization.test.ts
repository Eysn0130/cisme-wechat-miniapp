import { mkdtemp,writeFile,rm,chmod,symlink,unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach,expect,it,vi } from 'vitest';
import type { AppConfig } from '@cisme/config';
import { protectedText,recoveryAuthorization,recoveryTransport } from '../../services/api/src/formalPaymentAuthorization';
import { runFormalRecoveryCycle } from '../../services/worker/src/formalRecovery';
const roots:string[]=[];
afterEach(async()=>{vi.unstubAllGlobals();await Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true})));});
async function fixture(){
  const root=await mkdtemp(join(tmpdir(),'cisme-grant-'));roots.push(root);const path=join(root,'authorization.json');
  const grant={schemaVersion:1,mode:'ordinary-merchant-recovery-only',environment:'staging',appId:'wx4eac2d4fb11d299b',
    merchantId:'1900000001',approvalReference:'synthetic-approval',expiresAt:'2030-01-01T00:00:00Z',capabilities:['payment.query','payment.callback']};
  await writeFile(path,JSON.stringify(grant),{mode:0o600});
  const profile={appId:grant.appId,merchantId:grant.merchantId,recoveryAuthorizationFile:path} as NonNullable<AppConfig['commerce']['formalProtocol']>;
  const config={env:'staging'} as AppConfig;
  return {path,profile,config,grant};
}
it('checks exact environment, merchant, app, mode, scope, approval and expiry; no broad funds capability',async()=>{
  const f=await fixture();
  const authorize=recoveryAuthorization(f.config,f.profile);
  expect(authorize('payment.query')).toBe('synthetic-approval');
  expect(()=>authorize('refund.query')).toThrow('该支付恢复能力尚未授权');
  for(const change of [{environment:'production'},{merchantId:'1900000002'},{appId:'wx0000000000000000'},
    {mode:'service-provider'},{approvalReference:''},{expiresAt:'invalid'},{expiresAt:'2000-01-01T00:00:00Z'},
    {capabilities:['payment.create']},{capabilities:['payment.query','payment.query']}]){
    await writeFile(f.path,JSON.stringify({...f.grant,...change}));expect(()=>authorize('payment.query')).toThrow();
  }
  await unlink(f.path);expect(()=>authorize('payment.query')).toThrow();
});
it('rejects world-readable approval files and symlinks; a config path is not a grant',async()=>{
  const f=await fixture();await chmod(f.path,0o644);expect(()=>protectedText(f.path)).toThrow('PROTECTED_FILE_PERMISSIONS');
  await chmod(f.path,0o600);await symlink(f.path,f.path+'.link');expect(()=>protectedText(f.path+'.link')).toThrow();
  expect(()=>recoveryAuthorization({...f.config,env:'test'},f.profile)).toThrow('FORMAL_RECOVERY_GRANT_BINDING');
  const {recoveryAuthorizationFile,...inert}=f.profile;expect(()=>recoveryAuthorization(f.config,inert)('payment.query')).toThrow();
});
it('denies every write, unknown host, port and path before network and forces no redirect',async()=>{
  const network=vi.fn(async(_input:unknown,_options:RequestInit)=>new Response('{}'));vi.stubGlobal('fetch',network);
  const authorize=vi.fn(()=> 'synthetic-approval'),transport=recoveryTransport(authorize);
  for(const [url,method] of [
    ['https://api.mch.weixin.qq.com/v3/pay/transactions/jsapi','POST'],
    ['https://api.mch.weixin.qq.com/v3/refund/domestic/refunds','POST'],
    ['https://api.mch.weixin.qq.com/v3/fund-app/mch-transfer/transfer-bills','POST'],
    ['https://evil.test/v3/pay/transactions/out-trade-no/ORDER123','GET'],
    ['http://api.mch.weixin.qq.com/v3/pay/transactions/out-trade-no/ORDER123','GET'],
    ['https://api.mch.weixin.qq.com:444/v3/pay/transactions/out-trade-no/ORDER123','GET'],
    ['https://api.mch.weixin.qq.com/v3/certificates','GET']]){
    await expect(transport(url!,{method:method!})).rejects.toThrow();
  }
  expect(network).not.toHaveBeenCalled();
  await transport('https://api.mch.weixin.qq.com/v3/pay/transactions/out-trade-no/ORDER123?mchid=1900000001');
  expect(authorize).toHaveBeenCalledWith('payment.query');
  expect(network.mock.calls[0]?.[1]).toMatchObject({redirect:'error'});
});
it('keeps independent callback recovery running when query or another lane is disabled or fails',async()=>{
  const denied=vi.fn(),callback=vi.fn(async()=>{}),failed=vi.fn(async()=>{throw new Error('db');});
  expect(await runFormalRecoveryCycle([
    {authorize:()=>{throw new Error('revoked');},run:denied},
    {authorize:()=>true,run:failed},{authorize:()=>true,run:callback}
  ])).toEqual([{status:'not_authorized'},{status:'failed'},{status:'processed'}]);
  expect(denied).not.toHaveBeenCalled();expect(callback).toHaveBeenCalledTimes(1);
});
