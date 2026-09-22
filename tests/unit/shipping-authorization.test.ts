import {mkdtemp,writeFile,rm,chmod,unlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach,it,expect} from 'vitest';
import type {AppConfig} from '@cisme/config';
import {shippingAuthorization} from '../../services/api/src/fulfillmentRuntime';
const roots:string[]=[];afterEach(async()=>{await Promise.all(roots.splice(0).map(p=>rm(p,{recursive:true,force:true})));});
it('binds revocable shipping grants to environment, app, merchant and isolated staging order allowlist',async()=>{
 const root=await mkdtemp(join(tmpdir(),'cisme-shipping-grant-'));roots.push(root);const path=join(root,'grant.json');
 const grant={schemaVersion:1,mode:'wechat-shipping-sync',environment:'staging',appId:'wx4eac2d4fb11d299b',merchantId:'1900000001',approvalReference:'synthetic-only',expiresAt:'2030-01-01T00:00:00Z',capabilities:['shipping.query'],dataScope:'isolated-test-only',orderNumbers:['TESTORDER001']};
 await writeFile(path,JSON.stringify(grant),{mode:0o600});
 const config={env:'staging',commerce:{fulfillment:{appId:grant.appId,merchantId:grant.merchantId,authorizationFile:path}}} as AppConfig;
 const auth=shippingAuthorization(config),binding={transactionId:'42000000000000000001',merchantId:grant.merchantId,merchantOrderNumber:'TESTORDER001',payerOpenid:'synthetic-openid',payerTotalCents:100};
 expect(auth('shipping.query',binding)).toBe('synthetic-only');
 expect(()=>auth('shipping.upload',binding)).toThrow();
 expect(()=>auth('shipping.query',{...binding,merchantOrderNumber:'PRODUCTIONORDER'})).toThrow();
 for(const patch of [{environment:'production'},{dataScope:'all'},{orderNumbers:[]},{merchantId:'different'},{appId:'different'},{expiresAt:'2000-01-01T00:00:00Z'},{capabilities:['payment.create']}]){
  await writeFile(path,JSON.stringify({...grant,...patch}));expect(()=>auth('shipping.query',binding)).toThrow();
 }
 await writeFile(path,JSON.stringify(grant));await chmod(path,0o644);expect(()=>auth('shipping.query',binding)).toThrow();
 await unlink(path);expect(()=>auth('shipping.query',binding)).toThrow();
});
