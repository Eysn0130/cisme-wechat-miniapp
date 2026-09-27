import {expect,it,vi} from 'vitest';
import {queryShippingAccountReadiness} from '../../services/api/src/wechatOrderShipping';
it('reads only the two account enrollment endpoints and does not confuse false with an error',async()=>{
 const calls:string[]=[];
 const fetcher=vi.fn(async(input:unknown,init?:RequestInit)=>{
   const url=new URL(String(input));calls.push(url.pathname);
   expect(url.origin).toBe('https://api.weixin.qq.com');expect(init?.method).toBe('POST');expect(init?.redirect).toBe('error');
   expect(JSON.parse(String(init?.body))).toEqual({appid:'wx0000000000000001'});
   return new Response(JSON.stringify({errcode:0,...(url.pathname.endsWith('/is_trade_managed')?{is_trade_managed:true}:{completed:false})}));
 }) as typeof fetch;
 const authorize=vi.fn();
 expect(await queryShippingAccountReadiness('wx0000000000000001',async()=>'synthetic-token',authorize,fetcher)).toMatchObject({managed:true,settlementConfirmed:false});
 expect(calls).toEqual(['/wxa/sec/order/is_trade_managed','/wxa/sec/order/is_trade_management_confirmation_completed']);
 expect(authorize).toHaveBeenCalledTimes(3);
});
it('requires authorization again after token acquisition and never leaks token URLs on provider failure',async()=>{
 const fetcher=vi.fn(async()=>{throw Error('https://example.test?access_token=synthetic-private-token');});
 await expect(queryShippingAccountReadiness('wx0000000000000001',async()=>'token',undefined,fetcher)).rejects.toThrow();
 expect(fetcher).not.toHaveBeenCalled();
 let revoked=false;
 await expect(queryShippingAccountReadiness('wx0000000000000001',async()=>{revoked=true;return 'token';},()=>{if(revoked)throw Error('REVOKED');},fetcher)).rejects.toThrow('REVOKED');
 expect(fetcher).not.toHaveBeenCalled();
 const result=await queryShippingAccountReadiness('wx0000000000000001',async()=>'token',()=>{},fetcher);
 expect(result).toMatchObject({managed:null,settlementConfirmed:null});
 expect(JSON.stringify(result)).not.toContain('token');
});
it('retains safe provider error codes and still queries the independent confirmation status',async()=>{
 const fetcher=vi.fn(async()=>new Response(JSON.stringify({errcode:48001,errmsg:'UNTRUSTED_PRIVATE_DETAILS'})));
 const result=await queryShippingAccountReadiness('wx0000000000000001',async()=>'token',()=>{},fetcher);
 expect(result.checks).toHaveLength(2);expect(result.checks.every(x=>x.errcode===48001&&!x.verified)).toBe(true);
 expect(result.managed).toBeNull();expect(JSON.stringify(result)).not.toContain('UNTRUSTED_PRIVATE_DETAILS');
});
it('does not treat a non-success HTTP response as verified even if its body claims success',async()=>{
 const fetcher=vi.fn(async()=>new Response(JSON.stringify({errcode:0,is_trade_managed:true,completed:true}),{status:503}));
 const result=await queryShippingAccountReadiness('wx0000000000000001',async()=>'token',()=>{},fetcher);
 expect(result).toMatchObject({managed:null,settlementConfirmed:null});
 expect(result.checks.every(x=>x.httpStatus===503&&!x.verified)).toBe(true);
});
