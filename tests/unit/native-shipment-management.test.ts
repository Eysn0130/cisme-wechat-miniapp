import {beforeEach,it,expect,vi} from 'vitest';
const calls=vi.hoisted(()=>({authority:vi.fn(),order:vi.fn(),shipment:vi.fn(),dispatch:vi.fn(),reconcile:vi.fn()}));
vi.mock('../../apps/miniprogram/services/authority',()=>({requireCapability:calls.authority}));
vi.mock('../../apps/miniprogram/services/orders',()=>({managementOrder:calls.order,managementShipment:calls.shipment,dispatchShipment:calls.dispatch,reconcileShipment:calls.reconcile,clientOperationKey:()=> 'synthetic-shipment-key'}));
vi.mock('../../apps/miniprogram/services/commerce',()=>({centsToYuan:(n:number)=>String(n/100)}));
vi.mock('../../apps/miniprogram/services/layout',()=>({currentChromeStyle:()=>''}));
let definition:any,session='operator-a';
const fixture={id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',orderNumber:'SYNTHETIC',status:'paid',transactionSourceKind:'verified_commerce',version:4,createdAt:'2026-09-22T00:00:00Z',totalCents:100,creditTenderCents:0,cashPayableCents:100,lines:[],address:null};
const form={carrierCode:'SF',carrierName:'合成承运商',trackingNumber:'SYNTHETIC123',evidenceReference:'synthetic-proof',date:'2026-09-22',time:'09:00'};
function mount(){const page={...definition,data:{...definition.data,id:fixture.id,form:{...form}},setData(p:unknown){Object.assign(this.data,p);}};return page;}
beforeEach(async()=>{
 vi.resetModules();for(const call of Object.values(calls))call.mockReset();session='operator-a';
 calls.authority.mockResolvedValue({capabilities:['commerce.order.read','commerce.fulfillment.manage']});calls.order.mockResolvedValue(fixture);
 calls.shipment.mockResolvedValue({orderId:fixture.id,logisticsState:'awaiting_dispatch'});
 (globalThis as any).Page=(p:unknown)=>{definition=p;};(globalThis as any).getApp=()=>({globalData:{sessionToken:session}});
 (globalThis as any).wx={showModal:vi.fn((options:any)=>options.success({confirm:true})),navigateBack:vi.fn()};
 await import('../../apps/miniprogram/pages/management-order-detail/index');
});
it('keeps fulfillment unavailable for read-only operators and makes no shipment read',async()=>{
 calls.authority.mockResolvedValue({capabilities:['commerce.order.read']});const page=mount();await page.onShow();await page.submitShipment();
 expect(page.data.canDispatch).toBe(false);expect(calls.shipment).not.toHaveBeenCalled();expect(calls.dispatch).not.toHaveBeenCalled();
});
it('uses the existing atomic dispatch endpoint once under repeated clicks',async()=>{
 const page=mount();await page.onShow();page.data.form={...form};let finish!:(x:unknown)=>void;calls.dispatch.mockImplementation(()=>new Promise(r=>{finish=r;}));
 const first=page.submitShipment();await Promise.resolve();const second=page.submitShipment();await second;
 expect(calls.dispatch).toHaveBeenCalledTimes(1);expect(calls.dispatch.mock.calls[0]).toEqual([fixture.id,expect.objectContaining({expectedOrderVersion:4,trackingNumber:form.trackingNumber}),'synthetic-shipment-key']);
 calls.shipment.mockResolvedValue({id:'shipment',orderId:fixture.id,logisticsState:'shipped',wechatSyncState:'prepared'});finish({id:'shipment'});await first;
 expect(page.data.shipment.id).toBe('shipment');expect(page.data.syncLabel).toBe('等待微信同步');expect(page.data.form.trackingNumber).toBe('');
});
it('recovers an ambiguous submit through the authoritative shipment instead of dispatching again',async()=>{
 const page=mount();await page.onShow();page.data.form={...form};calls.dispatch.mockRejectedValue({status:504});
 calls.shipment.mockResolvedValue({id:'saved',orderId:fixture.id,logisticsState:'shipped',wechatSyncState:'verifying'});
 await page.submitShipment();await page.submitShipment();expect(calls.dispatch).toHaveBeenCalledTimes(1);expect(page.data.dispatchMessage).toContain('原订单已记录交寄');expect(page.pendingDispatch).toBeNull();
});
it('discards mutation responses after page hide and never leaves old parcel details visible',async()=>{
 const page=mount();await page.onShow();page.data.form={...form};let finish!:(x:unknown)=>void;calls.dispatch.mockImplementation(()=>new Promise(r=>{finish=r;}));
 const write=page.submitShipment();await Promise.resolve();page.onHide();finish({id:'late'});await write;
 expect(page.data).toMatchObject({order:null,shipment:null,canDispatch:false,form:{trackingNumber:''}});
});
it('clears order, parcel and controls when the server rejects revoked authority',async()=>{
 const page=mount();await page.onShow();page.data.form={...form};calls.dispatch.mockRejectedValue({status:403});await page.submitShipment();
 expect(page.data).toMatchObject({order:null,shipment:null,canDispatch:false});expect(page.pendingDispatch).toBeNull();
});
it('does not submit invalid tracking data, cancelled confirmation or a changed identity',async()=>{
 const page=mount();await page.onShow();page.data.form={...form,trackingNumber:'bad'};await page.submitShipment();expect(calls.dispatch).not.toHaveBeenCalled();
 page.data.form={...form};(wx.showModal as any).mockImplementation((options:any)=>options.success({confirm:false}));await page.submitShipment();expect(calls.dispatch).not.toHaveBeenCalled();
 session='operator-b';await page.submitShipment();expect(calls.dispatch).not.toHaveBeenCalled();expect(page.data.form.trackingNumber).toBe('');
});

it("releases an explicitly rejected input for correction while preserving ambiguous requests",async()=>{
 const page=mount();await page.onShow();page.data.form={...form};calls.dispatch.mockRejectedValue({status:422,code:"SHIPMENT_TIME_INVALID"});await page.submitShipment();
 expect(page.pendingDispatch).toBeNull();expect(page.data.dispatchMessage).toContain("晚于支付成功时间");
 page.shipmentInput({currentTarget:{dataset:{field:"time"}},detail:{value:"10:30"}});expect(page.data.form.time).toBe("10:30");
});

it('runs manual recovery as query-only and drops responses after operator revocation',async()=>{
 const page=mount();calls.shipment.mockResolvedValue({id:'saved',orderId:fixture.id,logisticsState:'shipped',wechatSyncState:'manual_review'});
 await page.onShow();page.data.form={...form};calls.reconcile.mockResolvedValue({state:'manual_review',queryOutcome:'not_uploaded',queryOnly:true});
 await page.reconcile();expect(calls.dispatch).not.toHaveBeenCalled();expect(calls.reconcile).toHaveBeenCalledTimes(1);expect(page.data.dispatchMessage).toContain('尚未确认同一包裹');
 calls.reconcile.mockRejectedValue({status:403});await page.reconcile();expect(page.data).toMatchObject({order:null,shipment:null,canDispatch:false});
});
