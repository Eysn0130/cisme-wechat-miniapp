import {expect,it,vi} from 'vitest';
import {WechatLogisticsQueryClient,WechatLogisticsMessageClient,LogisticsRegistrationRejected} from '../../services/api/src/wechatLogisticsQuery';
import {catalogPublicImage,catalogPublicImageByName,catalogPublicImageUrl} from '../../services/api/src/catalogPublicMedia';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import type pg from 'pg';
import {loadConfig} from '@cisme/config';
import {createApp} from '../../services/api/src/server';
import type {ObjectStorage} from '../../services/api/src/storage';
const binding={appId:'wx4eac2d4fb11d299b',merchantId:'1234567890',merchantOrderNumber:'SYNTHETIC_QUERY001',transactionId:'42000000000000000001',payerOpenid:'synthetic-query-buyer',payerTotalCents:19800};
const input={binding,carrierCode:'SF',trackingNumber:'SF123456789001',receiverPhone:'13800000000',
  goods:[{goods_name:'净润小紫瓶 280mL',goods_img_url:catalogPublicImageUrl('https://staging-api.cisme.cn','aigerong-moisture-shampoo-280')}],orderDetailPath:'pages/order-detail/index?id=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'};
const response=(body:unknown)=>new Response(JSON.stringify(body),{headers:{'Content-Type':'application/json'}});
it('uses only documented query registration fields and refuses redirects; readiness does not create a waybill',async()=>{
  const authorize=vi.fn(),fetcher=vi.fn().mockResolvedValueOnce(response({errcode:0,delivery_list:[{delivery_id:'SF'}]})).mockResolvedValueOnce(response({errcode:0,waybill_token:'synthetic-query-token-123456789'}));
  const client=new WechatLogisticsQueryClient(async()=>'synthetic-access',authorize,fetcher);
  await client.assertReady(binding);await client.assertReady(binding);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(await client.register(input)).toBe('synthetic-query-token-123456789');
  const [url,options]=fetcher.mock.calls[1]!;
  expect(new URL(url).origin).toBe('https://api.weixin.qq.com');
  expect(new URL(url).pathname).toBe('/cgi-bin/express/delivery/open_msg/trace_waybill');
  expect(options.redirect).toBe('error');expect(JSON.parse(options.body)).toEqual({openid:binding.payerOpenid,receiver_phone:input.receiverPhone,
    waybill_id:input.trackingNumber,delivery_id:'SF',trans_id:binding.transactionId,goods_info:{detail_list:input.goods},order_detail_path:input.orderDetailPath});
  expect(authorize.mock.calls.every(([cap,b])=>cap==='logistics.query.register'&&b===binding)).toBe(true);
});
it('keeps platform denial and uncertain registration honest without exposing tokens or provider payloads',async()=>{
  const denied=new WechatLogisticsQueryClient(async()=>'synthetic-access',()=>{},async()=>response({errcode:48001,errmsg:'sensitive-upstream-text'}));
  await expect(denied.assertReady(binding)).rejects.toMatchObject({code:'LOGISTICS_QUERY_NOT_READY'});
  await expect(denied.register(input)).rejects.toBeInstanceOf(LogisticsRegistrationRejected);
  const lost=new WechatLogisticsQueryClient(async()=>'synthetic-access',()=>{},async()=>{throw Error('sensitive-token-url');});
  await expect(lost.register(input)).rejects.toMatchObject({code:'LOGISTICS_QUERY_OUTCOME_UNKNOWN'});
  const invalid=new WechatLogisticsQueryClient(async()=>'synthetic-access',()=>{},async()=>response({errcode:0,waybill_token:'bad'}));
  await expect(invalid.register(input)).rejects.toMatchObject({code:'LOGISTICS_QUERY_OUTCOME_UNKNOWN'});
});
it('registers official messages against the actual verified buyer transaction, not a gift or operator',async()=>{
 const authorize=vi.fn(),fetcher=vi.fn().mockResolvedValue(response({errcode:0,waybill_token:'synthetic-follow-waybill-token-12345'}));
 const client=new WechatLogisticsMessageClient(async()=>'synthetic-access',authorize,fetcher);
 expect(await client.register(input)).toBe('synthetic-follow-waybill-token-12345');
 const [url,options]=fetcher.mock.calls[0]!;expect(new URL(url).pathname).toBe('/cgi-bin/express/delivery/open_msg/follow_waybill');
 expect(JSON.parse(options.body)).toMatchObject({openid:binding.payerOpenid,trans_id:binding.transactionId,receiver_phone:input.receiverPhone,waybill_id:input.trackingNumber,order_detail_path:input.orderDetailPath});
 expect(authorize.mock.calls.every(([cap,b])=>cap==='logistics.message.register'&&b===binding)).toBe(true);
 fetcher.mockClear();await expect(client.register({...input,binding:{...binding,payerTotalCents:0,transactionId:''}})).rejects.toThrow();expect(fetcher).not.toHaveBeenCalled();
});
it('distinguishes a local no-dispatch failure from a lost message response; malformed readiness never passes',async()=>{
 const fetcher=vi.fn();const denied=new WechatLogisticsMessageClient(async()=>'synthetic-access',()=>{throw Error('revoked');},fetcher);
 await expect(denied.register(input)).rejects.toMatchObject({code:'LOGISTICS_MESSAGE_NOT_DISPATCHED'});expect(fetcher).not.toHaveBeenCalled();
 const lost=new WechatLogisticsMessageClient(async()=>'synthetic-access',()=>{},async()=>{throw Error('secret provider URL');});
 await expect(lost.register(input)).rejects.toMatchObject({code:'LOGISTICS_QUERY_OUTCOME_UNKNOWN'});
 for(const body of [{errcode:0},{errcode:0,delivery_list:[]},{errcode:0,delivery_list:[{delivery_id:'SF'}],count:2}]){
  const client=new WechatLogisticsQueryClient(async()=>'synthetic-access',()=>{},async()=>response(body));await expect(client.assertReady(binding)).rejects.toMatchObject({code:'LOGISTICS_QUERY_NOT_READY'});
 }
});
it('invalidates a rejected access token without automatically replaying the waybill registration',async()=>{
 const invalidate=vi.fn(),fetcher=vi.fn().mockResolvedValue(response({errcode:40001}));
 const client=new WechatLogisticsMessageClient(async()=>'synthetic-old-access',()=>{},fetcher,invalidate);
 await expect(client.register(input)).rejects.toBeInstanceOf(LogisticsRegistrationRejected);expect(invalidate).toHaveBeenCalledTimes(1);expect(fetcher).toHaveBeenCalledTimes(1);
});
it('rechecks grant revocation before dispatch and after response',async()=>{
  let checks=0;const fetcher=vi.fn(async()=>response({errcode:0,waybill_token:'synthetic-query-token-123456789'}));
  const revoked=new WechatLogisticsQueryClient(async()=>'synthetic-access',()=>{if(++checks===2)throw Error('revoked');},fetcher);
  await expect(revoked.register(input)).rejects.toThrow('revoked');expect(fetcher).not.toHaveBeenCalled();
  checks=0;const late=new WechatLogisticsQueryClient(async()=>'synthetic-access',()=>{if(++checks===3)throw Error('revoked');},fetcher);
  await expect(late.register(input)).rejects.toThrow('revoked');expect(fetcher).toHaveBeenCalledTimes(1);
});
it('serves only byte-identical approved photographs with immutable names and pinned origins',()=>{
  for(const [code,file] of [['aigerong-moisture-shampoo-280','product1-clean-v2.jpg'],['aigerong-scalp-repair-essence-100','product2-clean-v2.jpg']]){
    const asset=catalogPublicImage(code!);expect(asset.bytes).toEqual(readFileSync(`apps/miniprogram/pages/product/assets/${file}`));
    expect(createHash('sha256').update(asset.bytes).digest('hex')).toBe(asset.sha256);
    expect(catalogPublicImageByName(asset.name)).toEqual(asset);
  }
  expect(()=>catalogPublicImageByName('../runtime.env')).toThrow();expect(()=>catalogPublicImage('__proto__')).toThrow();
  expect(()=>catalogPublicImageUrl('https://external.invalid','aigerong-moisture-shampoo-280')).toThrow();
});
it('serves both public photos through the real HTTP router within its parameter limit, keeping unknown media private',async()=>{
  const config=loadConfig({APP_ENV:'test',DATABASE_URL:'postgres://unused',APP_SESSION_SECRET:'route-test',ADMIN_API_TOKEN:'route-test',UPLOAD_TOKEN_SECRET:'route-test'});
  const pool={connect:()=>{throw Error('Public photos must not read member data');},query:()=>{throw Error('Public photos must not read member data');}} as unknown as pg.Pool;
  const app=await createApp({config,pool,storage:{} as ObjectStorage});
  try{
    for(const code of ['aigerong-moisture-shampoo-280','aigerong-scalp-repair-essence-100']){
      const asset=catalogPublicImage(code);expect(asset.name.length).toBeLessThanOrEqual(100);
      const response=await app.inject({method:'GET',url:`/v1/catalog/public-images/${asset.name}`});
      expect(response.statusCode).toBe(200);expect(response.rawPayload).toEqual(asset.bytes);
      expect(response.headers['cache-control']).toBe('public, max-age=31536000, immutable');expect(response.headers.etag).toBe(`"${asset.sha256}"`);
    }
    const missing=await app.inject({method:'GET',url:'/v1/catalog/public-images/unknown.jpg'});
    expect(missing.statusCode).toBe(404);expect(missing.headers['cache-control']).toBe('private, no-store');
    const denied=await app.inject({method:'POST',url:'/v1/me/orders/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/shipment/logistics-view',payload:{}});
    expect(denied.statusCode).toBe(401);
  }finally{await app.close();}
});
