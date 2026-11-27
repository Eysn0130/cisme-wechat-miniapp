import {beforeEach,it,expect,vi} from 'vitest';
import {shanghaiShipmentInstant} from '../../apps/miniprogram/services/shipment-time';
const calls=vi.hoisted(()=>({authority:vi.fn(),order:vi.fn(),shipment:vi.fn(),carriers:vi.fn(),dispatch:vi.fn(),reconcile:vi.fn()}));
vi.mock('../../apps/miniprogram/services/authority',()=>({requireCapability:calls.authority}));
vi.mock('../../apps/miniprogram/services/orders',()=>({managementOrder:calls.order,managementShipment:calls.shipment,shipmentCarriers:calls.carriers,dispatchShipment:calls.dispatch,reconcileShipment:calls.reconcile,clientOperationKey:()=> 'synthetic-shipment-key'}));
vi.mock('../../apps/miniprogram/services/commerce',()=>({centsToYuan:(n:number)=>String(n/100)}));
vi.mock('../../apps/miniprogram/services/layout',()=>({currentChromeStyle:()=>''}));
let definition:any,session='operator-a';
const fixture={id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',orderNumber:'SYNTHETIC',status:'paid',transactionSourceKind:'verified_commerce',version:4,createdAt:'2026-09-22T00:00:00Z',totalCents:100,creditTenderCents:0,cashPayableCents:100,lines:[],address:null};
const form={carrierCode:'SF',carrierName:'合成承运商',trackingNumber:'SYNTHETIC123',evidenceReference:'synthetic-proof'};
function mount(){const page={...definition,data:{...definition.data,id:fixture.id,form:{...form}},setData(p:unknown){Object.assign(this.data,p);}};return page;}
beforeEach(async()=>{
 vi.resetModules();for(const call of Object.values(calls))call.mockReset();session='operator-a';
 calls.authority.mockResolvedValue({capabilities:['commerce.order.read','commerce.fulfillment.manage']});calls.order.mockResolvedValue(fixture);
 calls.shipment.mockResolvedValue({orderId:fixture.id,logisticsState:'awaiting_dispatch'});calls.carriers.mockResolvedValue({carriers:[{id:'SF',name:'合成承运商'}]});
 (globalThis as any).Page=(p:unknown)=>{definition=p;};(globalThis as any).getApp=()=>({globalData:{sessionToken:session}});
 (globalThis as any).wx={showModal:vi.fn((options:any)=>options.success({confirm:true})),
  showActionSheet:vi.fn((options:any)=>options.success({tapIndex:1})),navigateBack:vi.fn()};
 await import('../../apps/miniprogram/pages/management-order-detail/index');
});
it('keeps fulfillment unavailable for read-only operators and makes no shipment read',async()=>{
 calls.authority.mockResolvedValue({capabilities:['commerce.order.read']});const page=mount();await page.onShow();await page.submitShipment();
 expect(page.data.canDispatch).toBe(false);expect(calls.shipment).not.toHaveBeenCalled();expect(calls.dispatch).not.toHaveBeenCalled();
});
it('uses the existing atomic dispatch endpoint once under repeated clicks',async()=>{
 const page=mount();await page.onShow();page.data.form={...form};let finish!:(x:unknown)=>void;calls.dispatch.mockImplementation(()=>new Promise(r=>{finish=r;}));
 const first=page.submitShipment();await Promise.resolve();const second=page.submitShipment();await second;
 expect(calls.dispatch).toHaveBeenCalledTimes(1);expect(calls.dispatch.mock.calls[0]).toEqual([fixture.id,{
  expectedOrderVersion:4,trackingNumber:form.trackingNumber,carrierCode:form.carrierCode,carrierName:form.carrierName,
  evidenceReference:'dispatch:synthetic-shipment-key'},'synthetic-shipment-key']);
 expect((wx.showModal as any).mock.calls[0][0].content).toContain('自动记录当前交寄时间');
 calls.shipment.mockResolvedValue({id:'shipment',orderId:fixture.id,logisticsState:'shipped',wechatSyncState:'prepared'});finish({id:'shipment'});await first;
 expect(page.data.shipment.id).toBe('shipment');expect(page.data.syncLabel).toBe('等待微信同步');expect(page.data.form.trackingNumber).toBe('');
});
it('interprets shipment time in Shanghai across UTC days and rejects invalid dates',()=>{
 expect(shanghaiShipmentInstant('2026-09-22','00:30')).toBe('2026-09-21T16:30:00.000Z');
 expect(shanghaiShipmentInstant('2026-03-08','02:30')).toBe('2026-03-07T18:30:00.000Z');
 expect(shanghaiShipmentInstant('2024-02-29','23:59')).toBe('2024-02-29T15:59:00.000Z');
 expect(shanghaiShipmentInstant('2026-02-29','09:00')).toBeNull();
 expect(shanghaiShipmentInstant('2026-13-01','09:00')).toBeNull();
 expect(shanghaiShipmentInstant('2026-09-22','24:00')).toBeNull();
});
it('recovers an ambiguous submit through the authoritative shipment instead of dispatching again',async()=>{
 const page=mount();await page.onShow();page.data.form={...form};calls.dispatch.mockRejectedValue({status:504});
 calls.shipment.mockResolvedValue({id:'saved',orderId:fixture.id,logisticsState:'shipped',wechatSyncState:'verifying'});
 await page.submitShipment();await page.submitShipment();expect(calls.dispatch).toHaveBeenCalledTimes(1);expect(page.data.dispatchMessage).toContain('已核对到发货记录');expect(page.pendingDispatch).toBeNull();
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
 const page=mount();await page.onShow();page.data.form={...form};calls.dispatch.mockRejectedValue({status:422,code:"SHIPMENT_INPUT_INVALID"});await page.submitShipment();
 expect(page.pendingDispatch).toBeNull();expect(page.data.dispatchMessage).toContain("发货信息未通过校验");
 page.shipmentInput({currentTarget:{dataset:{field:"trackingNumber"}},detail:{value:"ACTUAL123"}});expect(page.data.form.trackingNumber).toBe("ACTUAL123");
});

it('registers the selected real handoff without courier fields and reuses an uncertain request',async()=>{
 const page=mount();await page.onShow();calls.dispatch.mockRejectedValueOnce({status:504});
 await page.submitWithoutLogistics();
 expect((wx.showActionSheet as any).mock.calls[0][0].itemList).toEqual(['同城配送','用户自提']);
 expect((wx.showModal as any).mock.calls[0][0]).toMatchObject({title:'确认买家已取货',content:expect.stringContaining('发货满 7 天')});
 expect(calls.dispatch.mock.calls[0]).toEqual([fixture.id,{deliveryMethod:'pickup',evidenceReference:'dispatch:synthetic-shipment-key',expectedOrderVersion:4},'synthetic-shipment-key']);
 expect(page.data.dispatchRecovery).toBe(true);
 await page.submitWithoutLogistics();expect(calls.dispatch).toHaveBeenCalledTimes(1);
 calls.shipment.mockResolvedValue({id:'saved',orderId:fixture.id,deliveryMethod:'pickup',logisticsState:'shipped',autoReceiptAt:'2026-11-27T06:00:00.000Z'});
 await page.submitShipment();
 expect(calls.dispatch.mock.calls[1]).toEqual(calls.dispatch.mock.calls[0]);
 expect(wx.showModal).toHaveBeenCalledTimes(1);expect(page.data.shipmentLabel).toBe('已发货');
});

it('leaves the order unchanged when the handoff chooser is cancelled',async()=>{
 const page=mount();await page.onShow();
 (wx.showActionSheet as any).mockImplementation((options:any)=>options.fail({errMsg:'showActionSheet:fail cancel'}));
 await page.submitWithoutLogistics();
 expect(wx.showModal).not.toHaveBeenCalled();expect(calls.dispatch).not.toHaveBeenCalled();expect(page.data.dispatchBusy).toBe(false);
});

it('runs manual recovery as query-only and drops responses after operator revocation',async()=>{
 const page=mount();calls.shipment.mockResolvedValue({id:'saved',orderId:fixture.id,logisticsState:'shipped',wechatSyncState:'manual_review'});
 await page.onShow();page.data.form={...form};calls.reconcile.mockResolvedValue({state:'manual_review',queryOutcome:'not_uploaded',queryOnly:true});
 await page.reconcile();expect(calls.dispatch).not.toHaveBeenCalled();expect(calls.reconcile).toHaveBeenCalledTimes(1);expect(page.data.dispatchMessage).toContain('尚未确认同一包裹');
 calls.reconcile.mockRejectedValue({status:403});await page.reconcile();expect(page.data).toMatchObject({order:null,shipment:null,canDispatch:false});
});

it('selects a carrier without asking the operator for its code and generates an honest operation reference only after confirmation',async()=>{const page=mount();await page.onShow();await vi.waitFor(()=>expect(page.data.carriers).toHaveLength(1));expect(page.data.carrierLabels).toEqual(['请选择快递公司','合成承运商']);page.selectCarrier({detail:{value:'1'}});expect(page.data.form).toMatchObject({carrierCode:'SF',carrierName:'合成承运商'});page.data.form={...form,evidenceReference:''};await page.submitShipment();expect(calls.dispatch).toHaveBeenCalledWith(fixture.id,expect.objectContaining({evidenceReference:'dispatch:synthetic-shipment-key'}),'synthetic-shipment-key');});
it('retains manual recovery for a failed carrier lookup and ignores a late list after switching accounts',async()=>{const page=mount();calls.carriers.mockRejectedValueOnce({status:503});await page.onShow();await vi.waitFor(()=>expect(page.data.carriersError).toContain('手动填写'));expect(page.data.canDispatch).toBe(true);let done!:(value:any)=>void;calls.carriers.mockImplementationOnce(()=>new Promise(resolve=>done=resolve));const read=page.loadCarriers();session='operator-b';done({carriers:[{id:'SF',name:'must not arrive'}]});await read;expect(page.data.carriers).toEqual([]);});

it('does not call carrier metadata for an already shipped or refund-paused order',async()=>{calls.shipment.mockResolvedValue({id:'shipped',orderId:fixture.id,logisticsState:'shipped'});const page=mount();await page.onShow();expect(calls.carriers).not.toHaveBeenCalled();calls.order.mockResolvedValue({...fixture,refundedCents:100});calls.shipment.mockResolvedValue({orderId:fixture.id,logisticsState:'awaiting_dispatch'});await page.onShow();expect(calls.carriers).not.toHaveBeenCalled();});
