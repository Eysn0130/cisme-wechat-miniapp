import { beforeEach, expect, it, vi } from "vitest";

const requireCapabilityMock=vi.hoisted(()=>vi.fn());
const managementOrderMock=vi.hoisted(()=>vi.fn());
const managementOrdersMock=vi.hoisted(()=>vi.fn());
const managementCatalogMock=vi.hoisted(()=>vi.fn());
vi.mock("../../apps/miniprogram/services/authority",()=>({requireCapability:requireCapabilityMock,authorityProjection:()=>requireCapabilityMock("commerce.order.read")}));
vi.mock("../../apps/miniprogram/services/orders",()=>({managementOrder:managementOrderMock,
  managementOrders:managementOrdersMock}));
vi.mock("../../apps/miniprogram/services/commerce",()=>({centsToYuan:(n:number)=>(n/100).toFixed(2),
  managementCatalog:managementCatalogMock}));
vi.mock("../../apps/miniprogram/services/layout",()=>({currentChromeStyle:()=>""}));

vi.mock("../../apps/miniprogram/services/api",()=>({request:vi.fn(),requireMemberAccess:()=>Boolean(session),retainMemberSnapshot:()=>false,clearAuthenticationRedirectSuppression:vi.fn()}));

type PageDefinition=Record<string,any>&{data:Record<string,any>};
let definition:PageDefinition|null=null,session="operator-a";
function mount(overrides:Record<string,unknown>={}){
  const page:Record<string,any>={data:{...definition!.data,...overrides},
    setData(patch:Record<string,unknown>){Object.assign(this.data,patch);}};
  for(const [name,value] of Object.entries(definition!))if(typeof value==="function")page[name]=value;
  return page;
}
beforeEach(async()=>{
  vi.resetModules();requireCapabilityMock.mockReset();managementOrderMock.mockReset();managementOrdersMock.mockReset();
  managementCatalogMock.mockReset();
  session="operator-a";definition=null;
  (globalThis as any).getApp=()=>({globalData:{sessionToken:session}});
  (globalThis as any).Page=(page:PageDefinition)=>{definition=page;};
  (globalThis as any).wx={showToast:vi.fn(),navigateBack:vi.fn(),redirectTo:vi.fn(),switchTab:vi.fn()};
  await vi.importActual("../../apps/miniprogram/pages/management-order-detail/index");
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
  resolveNew({id:"visible-order-b",address:null,lines:[],createdAt:new Date().toISOString(),
    status:"paid",totalCents:100,creditTenderCents:0,cashPayableCents:100});
  await second;
  expect(page.data.order.id).toBe("visible-order-b");
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
