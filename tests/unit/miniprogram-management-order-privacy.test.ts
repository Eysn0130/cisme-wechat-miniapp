import { afterEach, beforeEach, expect, it, vi } from "vitest";

const requireCapabilityMock=vi.hoisted(()=>vi.fn());
const managementOrderMock=vi.hoisted(()=>vi.fn());
const managementOrdersMock=vi.hoisted(()=>vi.fn());
const managementShipmentMock=vi.hoisted(()=>vi.fn());
const shipmentCarriersMock=vi.hoisted(()=>vi.fn());
const dispatchShipmentMock=vi.hoisted(()=>vi.fn());
const managementCatalogMock=vi.hoisted(()=>vi.fn());
const requestMock=vi.hoisted(()=>vi.fn());
vi.mock("../../apps/miniprogram/services/authority",()=>({requireCapability:requireCapabilityMock,authorityProjection:()=>requireCapabilityMock("commerce.order.read"),hasCapability:(projection:any,capability:string)=>Boolean(projection?.capabilities.includes(capability))}));
vi.mock("../../apps/miniprogram/services/orders",()=>({managementOrder:managementOrderMock,
  managementOrders:managementOrdersMock,managementShipment:managementShipmentMock,
  shipmentCarriers:shipmentCarriersMock,dispatchShipment:dispatchShipmentMock,clientOperationKey:()=>"test-aftersale-key"}));
vi.mock("../../apps/miniprogram/services/commerce",()=>({centsToYuan:(n:number)=>(n/100).toFixed(2),
  managementCatalog:managementCatalogMock}));
vi.mock("../../apps/miniprogram/services/layout",()=>({currentChromeStyle:()=>""}));

vi.mock("../../apps/miniprogram/services/api",()=>({request:requestMock,requireMemberAccess:()=>Boolean(session),retainMemberSnapshot:()=>false,clearAuthenticationRedirectSuppression:vi.fn()}));

type PageDefinition=Record<string,any>&{data:Record<string,any>};
let definition:PageDefinition|null=null,session="operator-a";
function mount(overrides:Record<string,unknown>={}){
  const page:Record<string,any>={data:{...definition!.data,...overrides},
    setData(patch:Record<string,unknown>){Object.assign(this.data,patch);}};
  for(const [name,value] of Object.entries(definition!))if(name!=="data")page[name]=value;
  return page;
}
beforeEach(async()=>{
  vi.resetModules();requireCapabilityMock.mockReset();managementOrderMock.mockReset();managementOrdersMock.mockReset();
  vi.useFakeTimers();managementCatalogMock.mockReset();managementShipmentMock.mockReset();
  shipmentCarriersMock.mockReset();dispatchShipmentMock.mockReset();
  requestMock.mockReset();
  session="operator-a";definition=null;
  (globalThis as any).getApp=()=>({globalData:{sessionToken:session}});
  (globalThis as any).Page=(page:PageDefinition)=>{definition=page;};
  (globalThis as any).wx={showToast:vi.fn(),showModal:vi.fn(),navigateTo:vi.fn(),navigateBack:vi.fn(),redirectTo:vi.fn(),switchTab:vi.fn()};
  await vi.importActual("../../apps/miniprogram/pages/management-order-detail/index");
});
afterEach(()=>vi.useRealTimers());

const orderId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const caseId='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const conversationId='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const paid={id:orderId,version:3,address:null,lines:[],createdAt:'2026-11-26T16:00:00Z',status:'paid',
  totalCents:29800,creditTenderCents:0,cashPayableCents:29800,transactionSourceKind:'verified_commerce',refundedCents:0};
const returning={...paid,aftersale:{caseId,phase:'returning'}};
const capabilities=["commerce.order.read","commerce.fulfillment.manage","commerce.aftersale.review",
  "commerce.refund.approve","support.read","support.reply"];

it('opens the linked refund case with the eligible review action without submitting it',()=>{
 const page=mount({order:{aftersale:{caseId}},canOpenAftersale:true,decision:'request_refund'});
 page.lastReadToken=session;
 page.openAftersale();
 expect(wx.navigateTo).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
  url:`/pages/aftersale/index?mode=management&caseId=${caseId}&action=request_refund`}));
 expect(requestMock).not.toHaveBeenCalled();
});

it('prevents navigation into a stale or unauthorized refund case',()=>{
 const page=mount({order:{aftersale:{caseId}},canOpenAftersale:false,decision:'request_refund'});
 page.lastReadToken=session;
 page.openAftersale();
 page.data.canOpenAftersale=true;session='operator-b';page.openAftersale();
 expect(wx.navigateTo).not.toHaveBeenCalled();
 expect(requestMock).not.toHaveBeenCalled();
});

it("clears prior operator order data before a denied authority check returns",async()=>{
  let deny!:()=>void;
  requireCapabilityMock.mockReturnValue(new Promise(resolve=>{deny=()=>resolve(null);}));
  const page=mount({order:{id:"prior-private-order",address:{phoneMasked:"138****1111"}},
    id:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",loading:false});
  session="operator-b";
  const pending=page.onShow();
  expect(page.data.order).toBeNull();
  deny();await pending;
  expect(page.data).toMatchObject({order:null,loading:false,error:"当前账号没有订单查看权限。"});
  expect(managementOrderMock).not.toHaveBeenCalled();
});

it("ignores an old account's delayed order response after the new account reloads",async()=>{
  requireCapabilityMock.mockResolvedValue({version:1,managementAvailable:true,capabilities:["commerce.order.read"]});
  let resolveOld!:(value:unknown)=>void,resolveNew!:(value:unknown)=>void;
  managementOrderMock
    .mockImplementationOnce(()=>new Promise(resolve=>{resolveOld=resolve;}))
    .mockImplementationOnce(()=>new Promise(resolve=>{resolveNew=resolve;}));
  const page=mount({id:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",loading:false});
  const first=page.onShow();await Promise.resolve();
  expect(managementOrderMock).toHaveBeenCalledTimes(1);
  session="operator-b";
  const second=page.onShow();await Promise.resolve();
  expect(managementOrderMock).toHaveBeenCalledTimes(2);
  resolveOld({id:"private-order-a",address:{recipientNameMasked:"旧账号"},lines:[],
    createdAt:new Date().toISOString(),status:"paid",totalCents:100,creditTenderCents:0,cashPayableCents:100});
  await first;
  expect(page.data.order).toBeNull();
  resolveNew({id:orderId,address:null,lines:[],createdAt:new Date().toISOString(),
    status:"paid",totalCents:100,creditTenderCents:0,cashPayableCents:100});
  await second;
  expect(page.data.order.id).toBe(orderId);
});

it("blocks both dispatch modes on an already open order as soon as its aftersale is observed",async()=>{
  requireCapabilityMock.mockResolvedValue({capabilities});
  managementOrderMock.mockResolvedValueOnce(paid).mockResolvedValue(returning);
  managementShipmentMock.mockResolvedValue({orderId,logisticsState:'awaiting_dispatch'});
  shipmentCarriersMock.mockResolvedValue({carriers:[{id:'SF',name:'顺丰速运'}]});
  requestMock.mockResolvedValue({id:caseId,orderId,canReview:true,canStartRefund:true,state:'requested',kind:'refund_only'});
  const page=mount({id:orderId});
  await page.onShow();
  expect(page.data.canDispatch).toBe(true);
  await page.recheckOrder();
  expect(page.data).toMatchObject({canDispatch:false,decision:'request_refund',decisionLabel:'同意退款',canReject:true,canContact:true});
  await page.submitShipment();
  await page.submitWithoutLogistics();
  expect(dispatchShipmentMock).not.toHaveBeenCalled();
  expect(shipmentCarriersMock).toHaveBeenCalledOnce();
});

it("opens rejection and the verified case conversation while keeping shipped history available",async()=>{
  requireCapabilityMock.mockResolvedValue({capabilities});
  managementOrderMock.mockResolvedValue(returning);
  managementShipmentMock.mockResolvedValue({orderId,id:'original-parcel',logisticsState:'shipped',wechatSyncState:'manual_review'});
  requestMock.mockResolvedValueOnce({id:caseId,orderId,canReview:true,canStartRefund:false,state:'requested',
    kind:'return_refund',fulfillment:{state:'shipped',canRefundWithoutReturn:false}})
    .mockResolvedValueOnce({caseId,orderId,conversationId});
  const page=mount({id:orderId});
  await page.onShow();
  expect(page.data).toMatchObject({shipment:{id:'original-parcel'},canDispatch:false,decisionLabel:'同意退货'});
  page.openAftersale({currentTarget:{dataset:{action:'reject'}}});
  expect(wx.navigateTo).toHaveBeenLastCalledWith(expect.objectContaining({
    url:`/pages/aftersale/index?mode=management&caseId=${caseId}&action=reject`}));
  page.data.navigating=false;
  await page.contactBuyer();
  expect(requestMock).toHaveBeenLastCalledWith(expect.objectContaining({path:`/v1/management/aftersales/${caseId}/contact`,method:'POST'}));
  expect(wx.navigateTo).toHaveBeenLastCalledWith(expect.objectContaining({
    url:`/pages/management-support-chat/index?id=${conversationId}&caseId=${caseId}`}));
});

it("approves the original unshipped order and retries an uncertain response with the same command",async()=>{
  requireCapabilityMock.mockResolvedValue({capabilities});
  managementOrderMock.mockResolvedValue(returning);
  managementShipmentMock.mockResolvedValue({orderId,logisticsState:'awaiting_dispatch',holdReason:'aftersale'});
  let row={id:caseId,orderId,version:1,state:'requested',kind:'return_refund',amountCents:29800,
    canReview:true,canStartRefund:true,fulfillment:{state:'unshipped',canRefundWithoutReturn:true}};
  let writes=0;
  requestMock.mockImplementation(async (input)=>{
    if(input.method!=='POST')return row;
    if(++writes===1)throw {code:'NETWORK_TIMEOUT'};
    row={...row,version:2,state:'refund_pending',canStartRefund:false};
    managementOrderMock.mockResolvedValue({...returning,version:4,aftersale:{caseId,phase:'refunding'}});
    return row;
  });
  vi.mocked(wx.showModal).mockResolvedValue({confirm:true,cancel:false,content:''});
  const page=mount({id:orderId});
  await page.onShow();
  await page.decideAftersale({currentTarget:{dataset:{action:'request_refund'}}});
  expect(wx.showModal).toHaveBeenCalledWith(expect.objectContaining({title:'同意退款',content:expect.stringContaining('¥298.00')}));
  expect(page.data).toMatchObject({decisionRetry:true,canDispatch:false});
  await page.decideAftersale({currentTarget:{dataset:{action:'reject'}}});
  expect(writes).toBe(1);
  await page.decideAftersale({currentTarget:{dataset:{}}});
  const commands=requestMock.mock.calls.map(([input])=>input).filter(input=>input.method==='POST');
  expect(commands).toHaveLength(2);
  expect(commands[0]).toMatchObject({
    path:`/v1/management/aftersales/${caseId}/actions`,idempotencyKey:'test-aftersale-key',
    data:{action:'request_refund',expectedVersion:1,approveRefund:true}
  });
  expect(commands[1]).toEqual(commands[0]);
  expect(page.data).toMatchObject({decisionRetry:false,decisionFeedback:'已同意退款，等待渠道确认。',order:{statusLabel:'退款中'}});
});

it("requires a rejection reason and sends it on the same order",async()=>{
  requireCapabilityMock.mockResolvedValue({capabilities});
  managementOrderMock.mockResolvedValue(returning);
  managementShipmentMock.mockResolvedValue({orderId,logisticsState:'awaiting_dispatch',holdReason:'aftersale'});
  const row={id:caseId,orderId,version:7,state:'requested',kind:'return_refund',canReview:true,canStartRefund:true,
    amountCents:29800,fulfillment:{state:'unshipped',canRefundWithoutReturn:true}};
  requestMock.mockImplementation(async (input)=>input.method==='POST'?{...row,version:8,state:'rejected'}:row);
  vi.mocked(wx.showModal).mockResolvedValueOnce({confirm:true,cancel:false,content:' '})
    .mockResolvedValueOnce({confirm:true,cancel:false,content:'请补发包装照片'});
  const page=mount({id:orderId});
  await page.onShow();
  const click={currentTarget:{dataset:{action:'reject'}}};
  await page.decideAftersale(click);
  expect(page.data.decisionFeedback).toContain('填写');
  expect(requestMock.mock.calls.some(([input])=>input.method==='POST')).toBe(false);
  await page.decideAftersale(click);
  expect(wx.showModal).toHaveBeenLastCalledWith(expect.objectContaining({title:'拒绝退款',editable:true}));
  expect(requestMock).toHaveBeenCalledWith(expect.objectContaining({
    path:`/v1/management/aftersales/${caseId}/actions`,
    data:{action:'reject',expectedVersion:7,note:'请补发包装照片'}
  }));
});

it("keeps a settled refund out of dispatch without labeling the case as still in progress",async()=>{
  requireCapabilityMock.mockResolvedValue({capabilities});
  managementOrderMock.mockResolvedValue({...paid,refundedCents:paid.totalCents,aftersaleCaseId:caseId});
  managementShipmentMock.mockResolvedValue({orderId,logisticsState:'not_ready',holdReason:'aftersale'});
  requestMock.mockResolvedValue({id:caseId,orderId,state:'refund_pending',canStartRefund:false});
  const page=mount({id:orderId});
  await page.onShow();
  expect(page.data).toMatchObject({order:{statusLabel:'已退款'},shipmentLabel:'退款后暂停发货',canDispatch:false,decision:''});
});

it("clears the order queue before a new operator's authority check and drops delayed pages",async()=>{
  await vi.importActual("../../apps/miniprogram/pages/management-orders/index");
  let resolveOld!:(value:unknown)=>void,resolveNew!:(value:unknown)=>void;
  requireCapabilityMock.mockResolvedValue({version:1,managementAvailable:true,capabilities:["commerce.order.read"]});
  managementOrdersMock.mockImplementationOnce(()=>new Promise(resolve=>{resolveOld=resolve;}))
    .mockImplementationOnce(()=>new Promise(resolve=>{resolveNew=resolve;}));
  const page=mount({items:[{id:"old-sensitive-order"}],nextCursor:"private-cursor",loading:false});
  const first=page.onShow();await Promise.resolve();
  expect(page.data).toMatchObject({items:[],nextCursor:null,loading:true});
  session="operator-b";
  const second=page.onShow();await Promise.resolve();
  resolveOld({items:[{id:"late-order-a"}],nextCursor:"late-cursor"});
  await first;
  expect(page.data).toMatchObject({items:[],nextCursor:null});
  resolveNew({items:[],nextCursor:null});await second;
  expect(page.data).toMatchObject({items:[],nextCursor:null,loading:false});
});

it("does not retain a private catalog queue after the product-management permission changes",async()=>{
  await vi.importActual("../../apps/miniprogram/pages/management-catalog/index");
  let deny!:()=>void;
  requireCapabilityMock.mockReturnValue(new Promise(resolve=>{deny=()=>resolve(null);}));
  const page=mount({items:[{id:"private-sku-a",price:10000}],nextCursor:"private-next",
    loading:false,loadingMore:true});
  session="operator-b";
  const checking=page.onShow();
  expect(page.data).toMatchObject({items:[],nextCursor:null,loading:true,loadingMore:false});
  deny();await checking;
  expect(page.data).toMatchObject({items:[],loading:false,error:"当前账号没有商品管理权限。"});
  expect(managementCatalogMock).not.toHaveBeenCalled();
});

it.each(["commerce.product.manage","commerce.qualification.manage","commerce.inventory.manage"])("opens the catalog for its existing %s permission",async(capability)=>{
  requireCapabilityMock.mockResolvedValue({version:1,managementAvailable:true,capabilities:[capability]});
  managementCatalogMock.mockResolvedValue({items:[],nextCursor:null});
  await vi.importActual("../../apps/miniprogram/pages/management-catalog/index");
  const page=mount();
  await page.onShow();
  expect(managementCatalogMock).toHaveBeenCalledOnce();
  expect(page.data).toMatchObject({loading:false,error:"",items:[]});
});

it("keeps unrelated management roles out of the catalog",async()=>{
  requireCapabilityMock.mockResolvedValue({version:1,managementAvailable:true,capabilities:["support.read"]});
  await vi.importActual("../../apps/miniprogram/pages/management-catalog/index");
  const page=mount();
  await page.onShow();
  expect(page.data).toMatchObject({loading:false,error:"当前账号没有商品管理权限。"});
  expect(managementCatalogMock).not.toHaveBeenCalled();
});
