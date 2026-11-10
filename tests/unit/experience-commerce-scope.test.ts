import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {it,expect} from 'vitest';
import type {AppConfig} from '@cisme/config';
import {commerceAuthorization} from '../../services/api/src/formalCommerceAuthorization';
import {recoveryAuthorization} from '../../services/api/src/formalPaymentAuthorization';
import {shippingAuthorization} from '../../services/api/src/fulfillmentRuntime';

it('binds owner-authorized experience commerce to its database and signed-callback origin, without weakening test-order or production grants',async()=>{
  const root=await mkdtemp(join(tmpdir(),'cisme-experience-scope-'));
  const appId='wx4eac2d4fb11d299b',merchantId='1900000001';
  const paths={commerce:join(root,'commands.json'),recovery:join(root,'recovery.json'),shipping:join(root,'shipping.json')};
  const common={schemaVersion:1,environment:'staging',appId,merchantId,dataScope:'owner-authorized-experience-commerce',databaseName:'cisme_trial',approvalReference:'SYNTHETIC-UNIT-SCOPE',expiresAt:'2030-01-01T00:00:00Z'};
  const command={...common,mode:'ordinary-merchant-commerce-commands',capabilities:['order.create','payment.prepare','payment.close']};
  const config={env:'staging',databaseUrl:'postgres://synthetic:synthetic@127.0.0.1/cisme_trial',commerce:{formalProtocol:{appId,merchantId,commerceAuthorizationFile:paths.commerce,recoveryAuthorizationFile:paths.recovery,paymentNotifyUrl:'https://staging-api.cisme.cn/v1/payments/wechat/callback',refundNotifyUrl:'https://staging-api.cisme.cn/v1/payments/wechat/refund-callback'},fulfillment:{appId,merchantId,authorizationFile:paths.shipping}}} as AppConfig;
  try{
    for(const [file,grant] of [[paths.commerce,command],[paths.recovery,{...common,mode:'ordinary-merchant-recovery-only',capabilities:['payment.query','payment.callback']}],[paths.shipping,{...common,mode:'wechat-shipping-sync',capabilities:['shipping.query','shipping.upload','logistics.tracking.read']}]] as const)await writeFile(file,JSON.stringify(grant),{mode:0o600});
    expect(commerceAuthorization(config,config.commerce.formalProtocol!)('payment.prepare')).toBe(common.approvalReference);
    expect(recoveryAuthorization(config,config.commerce.formalProtocol!)('payment.callback')).toBe(common.approvalReference);
    expect(shippingAuthorization(config)('shipping.query')).toBe(common.approvalReference);
    expect(()=>commerceAuthorization(config,config.commerce.formalProtocol!)('refund.submit')).toThrow();
    for(const change of [{databaseUrl:'postgres://synthetic:synthetic@127.0.0.1/cisme'},{env:'test'},{commerce:{...config.commerce,formalProtocol:{...config.commerce.formalProtocol,paymentNotifyUrl:'https://api.cisme.cn/v1/payments/wechat/callback'}}}]){
      const wrong={...config,...change} as AppConfig;
      expect(()=>commerceAuthorization(wrong,wrong.commerce.formalProtocol!)('order.create')).toThrow();
      expect(()=>shippingAuthorization(wrong)('shipping.query')).toThrow();
    }
    for(const patch of [{databaseName:'cisme'},{dataScope:'all'},{dataScope:'isolated-test-only'},{environment:'production'},{expiresAt:'2000-01-01T00:00:00Z'}]){
      await writeFile(paths.commerce,JSON.stringify({...command,...patch}));expect(()=>commerceAuthorization(config,config.commerce.formalProtocol!)('order.create')).toThrow();
    }
  }finally{await rm(root,{recursive:true,force:true});}
});
