import {mkdtemp,writeFile,rm,unlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach,expect,it} from 'vitest';
import type {AppConfig} from '@cisme/config';
import {commerceAuthorization} from '../../services/api/src/formalCommerceAuthorization';
import {recoveryAuthorization} from '../../services/api/src/formalPaymentAuthorization';
import {shippingAuthorization} from '../../services/api/src/fulfillmentRuntime';
import {runFormalRecoveryCycle} from '../../services/worker/src/formalRecovery';

const roots:string[]=[];
afterEach(async()=>{await Promise.all(roots.splice(0).map(p=>rm(p,{recursive:true,force:true})));});
it.each(['expired','revoked','wrong-merchant'] as const)('restarts with %s command grants while independent recovery remains authorized',async state=>{
  const root=await mkdtemp(join(tmpdir(),'cisme-grant-restart-'));roots.push(root);
  let now=Date.parse('2026-09-26T00:00:00Z');
  const common={schemaVersion:1,environment:'production',appId:'wx0000000000000001',merchantId:'1900000001',
    approvalReference:'SYNTHETIC-RESTART-ONLY',expiresAt:new Date(now+60_000).toISOString()};
  const paths={commerce:join(root,'commerce.json'),recovery:join(root,'recovery.json'),shipping:join(root,'shipping.json')};
  const grants={commerce:{...common,mode:'ordinary-merchant-commerce-commands',capabilities:['payment.prepare']},
    recovery:{...common,expiresAt:new Date(now+600_000).toISOString(),mode:'ordinary-merchant-recovery-only',capabilities:['payment.query','payment.callback']},
    shipping:{...common,mode:'wechat-shipping-sync',capabilities:['shipping.query','shipping.upload']}};
  for(const key of Object.keys(paths) as Array<keyof typeof paths>)await writeFile(paths[key],JSON.stringify(grants[key]),{mode:0o600});
  const profile={appId:common.appId,merchantId:common.merchantId,commerceAuthorizationFile:paths.commerce,recoveryAuthorizationFile:paths.recovery};
  const config={env:'production',commerce:{formalProtocol:profile,fulfillment:{appId:common.appId,merchantId:common.merchantId,authorizationFile:paths.shipping}}} as AppConfig;
  const start=()=>({commerce:commerceAuthorization(config,config.commerce.formalProtocol!,()=>now),
    recovery:recoveryAuthorization(config,config.commerce.formalProtocol!,()=>now),shipping:shippingAuthorization(config,()=>now)});
  expect(start().commerce('payment.prepare')).toBe(common.approvalReference);
  if(state==='expired')now+=60_001;
  if(state==='revoked'){await unlink(paths.commerce);await unlink(paths.shipping);}
  if(state==='wrong-merchant')for(const key of ['commerce','shipping'] as const)
    await writeFile(paths[key],JSON.stringify({...grants[key],merchantId:'1900000002'}));
  const restarted=start();
  expect(()=>restarted.commerce('payment.prepare')).toThrow();
  expect(()=>restarted.shipping('shipping.upload')).toThrow();
  expect(restarted.recovery('payment.callback')).toBe(common.approvalReference);
  expect(restarted.recovery('payment.query')).toBe(common.approvalReference);
  await unlink(paths.recovery);
  expect(()=>start().recovery('payment.callback')).toThrow();
  expect(()=>start()).not.toThrow();
});

it('cuts off new money at its deadline while bounded in-flight recovery remains independently authorized',async()=>{
  const root=await mkdtemp(join(tmpdir(),'cisme-grant-deadline-'));roots.push(root);
  const cutoff=Date.parse('2026-12-25T15:59:59Z');
  let now=cutoff-1;
  const common={schemaVersion:1,environment:'production',appId:'wx0000000000000001',merchantId:'1900000001',
    approvalReference:'SYNTHETIC-DEADLINE-ONLY'};
  const commercePath=join(root,'commerce.json'),recoveryPath=join(root,'recovery.json');
  await writeFile(commercePath,JSON.stringify({...common,mode:'ordinary-merchant-commerce-commands',
    expiresAt:new Date(cutoff).toISOString(),capabilities:['order.create','payment.prepare','refund.submit']}),{mode:0o600});
  // This later recovery deadline is synthetic and only proves how an explicitly
  // approved finite grant would behave; it does not change the real R5 grant.
  await writeFile(recoveryPath,JSON.stringify({...common,mode:'ordinary-merchant-recovery-only',
    expiresAt:new Date(cutoff+60_000).toISOString(),
    capabilities:['payment.callback','payment.query','refund.callback','refund.query']}),{mode:0o600});
  const profile={appId:common.appId,merchantId:common.merchantId,
    commerceAuthorizationFile:commercePath,recoveryAuthorizationFile:recoveryPath} as NonNullable<AppConfig['commerce']['formalProtocol']>;
  const config={env:'production',commerce:{formalProtocol:profile}} as AppConfig;
  const command=commerceAuthorization(config,profile,()=>now),recover=recoveryAuthorization(config,profile,()=>now);
  expect(command('payment.prepare')).toBe(common.approvalReference);
  expect(recover('payment.callback')).toBe(common.approvalReference);
  now=cutoff;
  expect(()=>command('order.create')).toThrow();
  expect(()=>command('refund.submit')).toThrow();
  const applied:string[]=[];
  const lanes=(['payment.callback','payment.query','refund.callback','refund.query'] as const)
    .map(capability=>({authorize:()=>recover(capability),run:async()=>{applied.push(capability);}}));
  expect(await runFormalRecoveryCycle(lanes)).toEqual(Array(4).fill({status:'processed'}));
  expect(applied).toEqual(['payment.callback','payment.query','refund.callback','refund.query']);
  now=cutoff+60_000;
  expect(await runFormalRecoveryCycle(lanes)).toEqual(Array(4).fill({status:'not_authorized'}));
  expect(applied).toHaveLength(4);
});
