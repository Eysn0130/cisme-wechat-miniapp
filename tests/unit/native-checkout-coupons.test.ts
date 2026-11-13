import {readFileSync} from 'node:fs';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';

const m=vi.hoisted(()=>({catalog:vi.fn(),addresses:vi.fn(),runtime:vi.fn(),quote:vi.fn(),order:vi.fn(),authority:vi.fn(),management:vi.fn(),coupons:vi.fn()}));
vi.mock('../../apps/miniprogram/services/rewards',()=>({eligibleCoupons:m.coupons,rewardExpiry:()=> '2026.12.13 20:00'}));
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
const product={variants:[{id:'sku',active:true,availableQuantity:5,priceCents:19800}]};
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
 m.management.mockResolvedValue({items:[],nextCursor:null});m.coupons.mockResolvedValue({items:[coupon]});
});
afterEach(()=>vi.unstubAllGlobals());


const couponId='55555555-5555-4555-8555-555555555555';
const coupon={id:couponId,name:'体验正装券',thresholdCents:19800,discountCents:2000,expiresAt:'2026-12-13T12:00:00Z',version:1};
function serverQuote(body:any={}){const discount=body.couponId?2000:0,points=body.points??0;return {id:'quote-'+discount+'-'+points,item:{skuId:'sku'},quantity:1,addressId:'address',addressVersion:1,subtotalCents:19800,memberDiscountCents:discount+points,couponDiscountCents:discount,...(body.couponId?{couponId:body.couponId}:{}),pointsSpent:points,pointsMaximum:850,shippingCents:0,totalCents:19800-discount-points,creditTenderCents:0,cashPayableCents:19800-discount-points,expiresAt:new Date(Date.now()+60000).toISOString(),serverTime:new Date().toISOString()};}
async function ready(){const page=await checkout({product:'serum',quantity:'1'});await page.load();page.setData({runtimeEnabled:true});m.quote.mockImplementation(async(body:any)=>serverQuote(body));await page.loadCoupons();return page;}
describe('explicit receipt coupon checkout',()=>{
 it('preserves the selected wallet coupon through the first private-state reset',async()=>{
  const page=await checkout({product:'serum',quantity:'1',coupon:couponId});page.onShow();await vi.waitFor(()=>expect(page.data.couponState).toBe('ready'));expect(page.data.couponId).toBe(couponId);expect(page.incomingCouponId).toBe('');page.onHide();
 });
 it('never carries a wallet coupon across a member-session change',async()=>{
  const page=await checkout({product:'serum',quantity:'1',coupon:couponId});app.globalData.sessionToken='member-b';page.onShow();await vi.waitFor(()=>expect(page.data.loading).toBe(false));expect(page.data.couponId).toBe('');page.onHide();
 });
 it('applies and clears the coupon only by an explicit choice and requotes the amount',async()=>{
  const page=await ready();expect(page.data.couponId).toBe('');page.chooseCoupon({currentTarget:{dataset:{id:couponId}}});await vi.waitFor(()=>expect(page.data.quote?.couponId).toBe(couponId));expect(page.data.totalYuan).toBe('178.00');
  page.chooseCoupon({currentTarget:{dataset:{id:''}}});await vi.waitFor(()=>expect(page.data.quote?.totalCents).toBe(19800));expect(m.quote.mock.calls.at(-1)![0]).not.toHaveProperty('couponId');page.onHide();
 });
 it('keeps a selected unavailable coupon visible and blocks order creation instead of charging full price',async()=>{
  const page=await ready();page.setData({couponId,quote:serverQuote({couponId})});m.coupons.mockResolvedValue({items:[]});await page.loadCoupons();expect(page.data.couponId).toBe(couponId);expect(page.data.couponState).toBe('error');expect(page.data.quote).toBeNull();await page.confirmOrder();expect(m.order).not.toHaveBeenCalled();page.onHide();
 });
 it('blocks a selected-coupon checkout after a failed refresh, until it is retried or explicitly removed',async()=>{
  const page=await ready();page.setData({couponId,quote:serverQuote({couponId})});m.coupons.mockRejectedValue({status:503});await page.loadCoupons();await page.confirmOrder();expect(m.order).not.toHaveBeenCalled();expect(page.data.couponId).toBe(couponId);page.onHide();
 });
 it('shows points separately from the coupon and submits the exact server-confirmed combination',async()=>{
  const page=await ready();page.setData({couponId,couponState:'ready',pointsInput:850});await page.requestQuote();expect(m.quote).toHaveBeenCalledWith(expect.objectContaining({couponId,points:850}),expect.any(String));expect(page.data).toMatchObject({couponDiscountYuan:'20.00',pointsDiscountYuan:'8.50',totalYuan:'169.50'});page.onHide();
 });
});
