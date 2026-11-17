import {beforeEach,expect,it,vi} from 'vitest';
const m=vi.hoisted(()=>({token:'member-a',request:vi.fn()}));
vi.mock('../../apps/miniprogram/services/api',()=>({request:m.request,historicalCommerceToken:()=>m.token,historicalCommerceClosed:()=>false,requireHistoricalCommerceAccess:()=>Boolean(m.token)}));
vi.mock('../../apps/miniprogram/services/layout',()=>({currentChromeStyle:()=>''}));
const id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',number='CM20261117AAAAAAAAAAAA';
const later=()=>{let resolve!:(v:any)=>void;const promise=new Promise<any>(r=>resolve=r);return {promise,resolve};};
const flush=async()=>{for(let n=0;n<30;n++)await Promise.resolve();};
let page:any;
beforeEach(async()=>{
 vi.resetModules();m.token='member-a';m.request.mockReset();
 Object.assign(globalThis,{wx:{},getApp:()=>({globalData:{sessionToken:m.token}}),Page:(d:any)=>{page={...d,data:structuredClone(d.data),setData(v:any,done?:()=>void){Object.assign(this.data,v);done?.();}};}});
 await import('../../apps/miniprogram/pages/order-detail/index');
 page.loadRuntime=vi.fn();page.loadRefunds=vi.fn();page.loadShipment=vi.fn();page.loadRecovery=vi.fn();
});
it.each([{outTradeNo:number,source:'wechat_order'},{merchant_trade_no:number,source:'wechat_shipping'}])('accepts both official entry formats and resolves under the current member: %j',async query=>{
 page.onLoad(query);expect(page.data.invalidId).toBe(false);const lookup=later();m.request.mockImplementation((o:any)=>o.path.includes('/resolve?')?lookup.promise:new Promise(()=>{}));
 void page.load();await flush();expect(m.request.mock.calls[0]?.[0].path).toBe('/v1/me/orders/resolve?outTradeNo='+number);
 lookup.resolve({id});await flush();expect(m.request.mock.calls.some(([o])=>o.path==='/v1/me/orders/'+id)).toBe(true);expect(page.data.id).toBe(id);
});
it('discards a late resolution after account change, then resolves again for the new owner',async()=>{
 page.onLoad({outTradeNo:number});const old=later();m.request.mockReturnValueOnce(old.promise);void page.load();await flush();
 m.token='member-b';page.syncSession();expect(page.data.id).toBe('');old.resolve({id});await flush();expect(page.data.id).toBe('');expect(m.request).toHaveBeenCalledTimes(1);
 const fresh=later();m.request.mockReturnValueOnce(fresh.promise);void page.load();await flush();expect(m.request.mock.calls[1]?.[0].path).toContain('/resolve?');
});
it.each([{outTradeNo:'bad'},{id,outTradeNo:number},{outTradeNo:number,merchant_trade_no:'CM20261117BBBBBBBBBBBB'},{}])('rejects invalid or ambiguous entry before private reads: %j',async query=>{
 page.onLoad(query);await page.load();expect(page.data.invalidId).toBe(true);expect(m.request).not.toHaveBeenCalled();
});
it('retains existing internal UUID links',()=>{page.onLoad({id});expect(page.data).toMatchObject({id,invalidId:false});});
