import {beforeEach,expect,it,vi} from 'vitest';
const mocks=vi.hoisted(()=>({token:'buyer-a',request:vi.fn()}));
vi.mock('../../apps/miniprogram/services/api',()=>({request:mocks.request,historicalCommerceToken:()=>mocks.token,historicalCommerceClosed:()=>false,requireHistoricalCommerceAccess:()=>true}));
vi.mock('../../apps/miniprogram/services/layout',()=>({currentChromeStyle:()=>''}));
let page:any,open:any;const id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',shipmentId='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const result={orderId:id,shipmentId,source:'wechat_logistics_plugin',waybillToken:'synthetic-private-waybill-token-12345'};
const deferred=()=>{let resolve!:(value:unknown)=>void;const promise=new Promise(yes=>resolve=yes);return {promise,resolve};};
beforeEach(async()=>{
  vi.resetModules();vi.clearAllMocks();mocks.token='buyer-a';open=vi.fn();
  (globalThis as any).getApp=()=>({globalData:{sessionToken:mocks.token}});
  (globalThis as any).wx={setClipboardData:vi.fn().mockResolvedValue({})};
  (globalThis as any).requirePlugin=vi.fn(()=>({openWaybillTracking:open}));
  (globalThis as any).Page=(definition:any)=>{page={...definition,data:structuredClone(definition.data),setData(patch:any){Object.assign(this.data,patch);}};};
  await import('../../apps/miniprogram/pages/order-detail/index');page.onLoad({id});page.syncSession();
  Object.assign(page.data,{coreReady:true,visible:true,order:{transactionSourceKind:'verified_commerce'},shipment:{id:shipmentId,trackingNumber:'SF123456789001'}});
});
it('opens one official view after duplicate taps and keeps the token out of page data',async()=>{
  const pending=deferred();mocks.request.mockReturnValue(pending.promise);
  const first=page.openLogistics();await page.openLogistics();expect(mocks.request).toHaveBeenCalledTimes(1);
  expect(mocks.request.mock.calls[0]![0]).toEqual({path:`/v1/me/orders/${id}/shipment/logistics-view`,method:'POST',data:{}});
  pending.resolve(result);await first;
  expect(open).toHaveBeenCalledExactlyOnceWith({waybillToken:result.waybillToken});expect(JSON.stringify(page.data)).not.toContain(result.waybillToken);
  expect(page.data.trackingLoading).toBe(false);
});
it.each(['hidden','changed member','changed shipment'])('never opens a stale response after %s',async kind=>{
  const pending=deferred();mocks.request.mockReturnValue(pending.promise);const first=page.openLogistics();
  if(kind==='hidden')page.onHide();else if(kind==='changed member'){mocks.token='buyer-b';page.syncSession();}else page.data.shipment.id='different';
  pending.resolve(result);await first;expect(open).not.toHaveBeenCalled();
});
it('keeps waybill copying available when official query is unavailable',async()=>{
  mocks.request.mockRejectedValue({title:'物流详情暂未开通，可以复制运单号查询或联系客服'});await page.openLogistics();
  expect(page.data.trackingError).toContain('复制运单号');expect(open).not.toHaveBeenCalled();
  await page.copyWaybill();expect((globalThis as any).wx.setClipboardData).toHaveBeenCalledWith({data:'SF123456789001'});
  page.data.closedRights=true;await page.openLogistics();expect(mocks.request).toHaveBeenCalledTimes(1);
});
