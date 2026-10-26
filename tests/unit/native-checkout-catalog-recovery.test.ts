import {readFileSync} from 'node:fs';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';

const m=vi.hoisted(()=>({catalog:vi.fn(),addresses:vi.fn(),runtime:vi.fn(),quote:vi.fn(),order:vi.fn(),authority:vi.fn(),management:vi.fn()}));
vi.mock('../../apps/miniprogram/services/layout',()=>({currentChromeStyle:()=>''}));
vi.mock('../../apps/miniprogram/services/share',()=>({prepareShareLink:async()=>'',registerIncomingShare:vi.fn()}));
vi.mock('../../apps/miniprogram/services/commerce',()=>({catalogDetail:m.catalog,managementCatalog:m.management,centsToYuan:(n:number)=>(n/100).toFixed(2)}));
vi.mock('../../apps/miniprogram/services/orders',()=>({memberAddresses:m.addresses,orderRuntimeStatus:m.runtime,
 createCheckoutQuote:m.quote,createPendingOrder:m.order,clientOperationKey:()=> 'synthetic-operation',isolatedCreditSummary:vi.fn()}));
vi.mock('../../apps/miniprogram/services/authority',async(importOriginal)=>({...await importOriginal<object>(),authorityProjection:m.authority}));

let definition:any,app:any,wxMock:any,storage:Map<string,unknown>,pages:any[];
function mount(){return {...definition,data:structuredClone(definition.data),setData(patch:any){Object.assign(this.data,patch);}};}
async function checkout(query:Record<string,string>={product:'serum',sku:'sku',quantity:'2'}){
 await import('../../apps/miniprogram/pages/checkout/index');const page=mount();page.onLoad(query);page.visible=true;return page;
}
function deferred(){let resolve!:(value:any)=>void,reject!:(error:any)=>void;const promise=new Promise<any>((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
const product={variants:[{id:'sku',active:true,availableQuantity:5,priceCents:1000}]};
beforeEach(()=>{
 vi.resetModules();vi.clearAllMocks();storage=new Map();
 for(const fn of Object.values(m))fn.mockReset();
 app={globalData:{sessionToken:'member-a',privacyRightsToken:'',sessionStorageKey:'synthetic.session',apiBaseUrl:'https://synthetic.invalid'}};
 pages=[{route:'pages/checkout/index',options:{product:'serum',sku:'sku',quantity:'2'}}];
 vi.stubGlobal('getApp',()=>app);vi.stubGlobal('getCurrentPages',()=>pages);vi.stubGlobal('Page',(value:any)=>{definition=value;});
 wxMock={getStorageSync:(key:string)=>storage.get(key)||'',setStorageSync:vi.fn((key:string,value:unknown)=>storage.set(key,value)),
  removeStorageSync:vi.fn((key:string)=>storage.delete(key)),getStorageInfoSync:()=>({keys:[...storage.keys()]}),
  navigateTo:vi.fn(),navigateBack:vi.fn(),redirectTo:vi.fn(),reLaunch:vi.fn(),switchTab:vi.fn(),showToast:vi.fn(),hideShareMenu:vi.fn(),showShareMenu:vi.fn()};
 vi.stubGlobal('wx',wxMock);
 m.catalog.mockResolvedValue(product);m.addresses.mockResolvedValue({enabled:true,addresses:[{id:'address',version:1,isDefault:true}]});
 m.runtime.mockResolvedValue({version:1,scope:'disabled',currency:'CNY',orderFlowEnabled:false,paymentAvailable:false,paymentOnboarding:'IN_PROGRESS',
  isolatedMoneyOperationsAvailable:false,isolatedTransferAvailable:false,isolatedCreditCheckoutAvailable:false});
 m.management.mockResolvedValue({items:[],nextCursor:null});
});
afterEach(()=>vi.unstubAllGlobals());

describe('checkout distinguishes incomplete navigation from member authentication',()=>{
 it.each(['','../bad','UPPERCASE'])('does not request private or malformed public data for invalid product %j',async(code)=>{
  const page=await checkout({product:code});app.globalData.sessionToken='';page.onShow();
  expect(page.data).toMatchObject({loading:false,missingProduct:true,authenticationRequired:false,addresses:[],quote:null});
  expect(page.data.syncError).toContain('选择商品');expect(m.catalog).not.toHaveBeenCalled();expect(m.addresses).not.toHaveBeenCalled();
  expect(m.runtime).not.toHaveBeenCalled();expect(wxMock.navigateTo).not.toHaveBeenCalled();
  await page.retryLoad();expect(wxMock.redirectTo).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({url:'/pages/shop/index'}));
  expect(m.order).not.toHaveBeenCalled();
 });
 it('keeps a public catalog 401 separate from a still-valid member session',async()=>{
  const page=await checkout();m.catalog.mockRejectedValue({status:401,code:'AUTH_REQUIRED',title:'Bearer session required'});
  await page.load();expect(page.data.authenticationRequired).toBe(false);expect(page.data.syncError).toContain('商品资料');
  expect(page.data.syncError).not.toContain('Bearer');expect(app.globalData.sessionToken).toBe('member-a');expect(wxMock.navigateTo).not.toHaveBeenCalled();
 });
 it.each(['AUTH_REQUIRED','AUTHENTICATION_REQUIRED'])('clears private checkout facts and offers an explicit recovery for %s',async(code)=>{
  const page=await checkout();page.setData({addresses:[{id:'private-address'}],quote:{id:'private-quote'},creditInput:'5.00',busy:false});
  m.addresses.mockImplementation(async()=>{app.globalData.sessionToken='';throw {status:401,code,title:'Bearer session required'};});
  await page.load();expect(page.data).toMatchObject({authenticationRequired:true,loading:false,busy:false,quote:null,addresses:[],creditInput:'',runtimeEnabled:false});
  expect(page.data.syncError).toContain('重新登录');expect(page.data.syncError).not.toContain('Bearer');expect(wxMock.navigateTo).not.toHaveBeenCalled();
  await page.retryLoad();await page.retryLoad();expect(wxMock.navigateTo).toHaveBeenCalledOnce();
  const api=await import('../../apps/miniprogram/services/api');
  const query=new URL('https://synthetic.invalid'+wxMock.navigateTo.mock.calls[0][0].url).searchParams;
  expect(api.consumeAuthReturnUrl(query.get('authFlow')!)).toBe('/pages/checkout/index?product=serum&sku=sku&quantity=2');
  expect(api.consumeAuthReturnUrl(query.get('authFlow')!)).toBe('/pages/home/index');
 });
 it('honours cancellation on return, then permits an explicit fresh login',async()=>{
  const page=await checkout();app.globalData.sessionToken='';page.showLoginRequired();await page.retryLoad();
  const api=await import('../../apps/miniprogram/services/api');
  const query=new URL('https://synthetic.invalid'+wxMock.navigateTo.mock.calls[0][0].url).searchParams;
  api.cancelAuthentication(query.get('authFlow')!);api.suppressAuthenticationRedirectOnce('/pages/checkout/index');
  page.onShow();expect(wxMock.navigateTo).toHaveBeenCalledOnce();expect(page.data.loading).toBe(false);
  await page.retryLoad();expect(wxMock.navigateTo).toHaveBeenCalledTimes(2);expect(m.catalog).not.toHaveBeenCalled();
 });
 it.each(['hidden','other-member'])('does not apply a delayed auth failure to a %s page',async(change)=>{
  const page=await checkout();const read=deferred();m.addresses.mockReturnValue(read.promise);const pending=page.load();
  if(change==='hidden')page.onHide();else app.globalData.sessionToken='member-b';
  read.reject({status:401,code:'AUTH_REQUIRED'});await pending;expect(page.data.authenticationRequired).toBe(false);expect(wxMock.navigateTo).not.toHaveBeenCalled();
 });
 it('does not let an older load auth error replace the latest completed projection',async()=>{
  const page=await checkout();const old=deferred();m.addresses.mockReturnValueOnce(old.promise);
  const pending=page.load();await page.load();expect(page.data.addresses).toHaveLength(1);
  old.reject({status:401,code:'AUTH_REQUIRED'});await pending;
  expect(page.data).toMatchObject({authenticationRequired:false,loading:false,syncError:''});expect(page.data.addresses).toHaveLength(1);
 });
 it.each(['quote','order'])('recovers a private %s 401 without leaving a busy or reusable quote',async(action)=>{
  const page=await checkout();page.setData({loading:false,runtimeEnabled:true,selectedSku:product.variants[0],addresses:[{id:'address',version:1}],selectedAddressId:'address'});
  const rejected=async()=>{app.globalData.sessionToken='';throw {status:401,code:'AUTH_REQUIRED',title:'Bearer session required'};};
  if(action==='quote'){m.quote.mockImplementation(rejected);await page.requestQuote();}
  else {page.setData({quote:{id:'quote',expiresAt:new Date(Date.now()+60000).toISOString(),serverTime:new Date().toISOString()}});m.order.mockImplementation(rejected);await page.confirmOrder();}
  expect(page.data).toMatchObject({authenticationRequired:true,busy:false,quote:null,addresses:[],runtimeEnabled:false});
  expect(page.data.syncError).toContain('重新登录');
 });
 it('retains the disabled commerce capability after normal loading and retry',async()=>{
  const page=await checkout();await page.load();await page.retryLoad();expect(page.data).toMatchObject({loading:false,runtimeEnabled:false,authenticationRequired:false});
  await page.requestQuote();expect(m.quote).not.toHaveBeenCalled();expect(m.order).not.toHaveBeenCalled();
 });
});

describe('product selection, unavailable items and failed reads remain distinct',()=>{
 it.each(['','../bad'])('keeps invalid selection %j local and opens the directory without authentication',async(id)=>{
  await import('../../apps/miniprogram/pages/product/index');const page=mount();page.onLoad({id});await page.load();
  expect(page.data).toMatchObject({loading:false,item:null,errorKind:'selection',errorTitle:'先选一件商品'});
  expect(m.catalog).not.toHaveBeenCalled();expect(wxMock.navigateTo).not.toHaveBeenCalled();page.back();
  expect(wxMock.redirectTo).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({url:'/pages/shop/index'}));expect(wxMock.navigateBack).not.toHaveBeenCalled();
 });
 it.each([{error:{status:404,code:'CATALOG_PRODUCT_NOT_FOUND'},kind:'missing'},
  {error:new Error('offline'),kind:'load'}])('preserves $kind recovery for an actual selected product',async({error,kind})=>{
  await import('../../apps/miniprogram/pages/product/index');const page=mount();page.onLoad({id:'serum'});m.catalog.mockRejectedValue(error);await page.load();
  expect(m.catalog).toHaveBeenCalledExactlyOnceWith('serum');expect(page.data).toMatchObject({loading:false,item:null,errorKind:kind});
  expect(page.data.errorTitle).not.toBe('先选一件商品');expect(wxMock.navigateTo).not.toHaveBeenCalled();
 });
});

describe('catalog list permission and product creation remain separate',()=>{
 it.each(['commerce.qualification.manage','commerce.inventory.manage','commerce.product.manage'])('keeps %s list access while projecting creation separately',async(capability)=>{
  m.authority.mockResolvedValue({version:1,managementAvailable:true,capabilities:[capability]});
  await import('../../apps/miniprogram/pages/management-catalog/index');const page=mount();await page.onShow();
  expect(m.management).toHaveBeenCalledOnce();expect(page.data.canCreate).toBe(capability==='commerce.product.manage');page.create();
  expect(wxMock.navigateTo).toHaveBeenCalledTimes(capability==='commerce.product.manage'?1:0);
 });
 it('rechecks authority on retry instead of fetching an unauthorized catalog',async()=>{
  m.authority.mockResolvedValueOnce({capabilities:['support.read']}).mockResolvedValueOnce({capabilities:['commerce.inventory.manage']}).mockResolvedValueOnce({capabilities:['support.read']});
  await import('../../apps/miniprogram/pages/management-catalog/index');const page=mount();await page.onShow();expect(m.management).not.toHaveBeenCalled();
  await page.load();expect(m.management).toHaveBeenCalledOnce();await page.load();expect(m.management).toHaveBeenCalledOnce();
  expect(m.authority).toHaveBeenCalledTimes(3);expect(page.data).toMatchObject({items:[],canCreate:false,loading:false});
 });
 it('drops a stale permission result and prevents creation after account replacement',async()=>{
  const permission=deferred();m.authority.mockReturnValueOnce(permission.promise).mockResolvedValue({capabilities:['commerce.product.manage']});
  await import('../../apps/miniprogram/pages/management-catalog/index');const page=mount();const old=page.onShow();app.globalData.sessionToken='member-b';
  permission.resolve({capabilities:['commerce.product.manage']});await old;expect(m.management).not.toHaveBeenCalled();expect(page.data.canCreate).toBe(false);
  await page.onShow();expect(page.data.canCreate).toBe(true);app.globalData.sessionToken='member-c';page.create();expect(wxMock.navigateTo).not.toHaveBeenCalled();expect(page.data.canCreate).toBe(false);
 });
 it('does not restore creation from a permission response arriving after hide',async()=>{
  const permission=deferred();m.authority.mockReturnValue(permission.promise);
  await import('../../apps/miniprogram/pages/management-catalog/index');const page=mount();const pending=page.onShow();page.onHide();permission.resolve({capabilities:['commerce.product.manage']});await pending;
  expect(page.data.canCreate).toBe(false);expect(m.management).not.toHaveBeenCalled();page.create();expect(wxMock.navigateTo).not.toHaveBeenCalled();
 });
 it('renders only the creation action for product managers and an honest empty list otherwise',()=>{
  const source=readFileSync('apps/miniprogram/pages/management-catalog/index.wxml','utf8');
  expect(source).toContain('<button wx:if="{{canCreate}}"');expect(source).toContain('当前没有可查看的商品。');
  expect(readFileSync('apps/miniprogram/pages/checkout/index.wxml','utf8')).toContain("missingProduct?'查看商品':authenticationRequired?'重新登录':'重新加载'");
 });
});
