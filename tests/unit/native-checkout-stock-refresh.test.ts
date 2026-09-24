import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const m=vi.hoisted(()=>({catalog:vi.fn(),addresses:vi.fn(),runtime:vi.fn()}));
vi.mock('../../apps/miniprogram/services/api',()=>({requireMemberAccess:()=>true,retainMemberSnapshot:()=>true}));
vi.mock('../../apps/miniprogram/services/layout',()=>({currentChromeStyle:()=>''}));
vi.mock('../../apps/miniprogram/services/commerce',()=>({catalogDetail:m.catalog,centsToYuan:(n:number)=>(n/100).toFixed(2)}));
vi.mock('../../apps/miniprogram/services/orders',()=>({clientOperationKey:vi.fn(),createCheckoutQuote:vi.fn(),createPendingOrder:vi.fn(),
  isolatedCreditSummary:vi.fn(),memberAddresses:m.addresses,orderRuntimeStatus:m.runtime}));
let view:any;
beforeEach(()=>{
 vi.resetModules();vi.clearAllMocks();vi.useFakeTimers();
 vi.stubGlobal('getApp',()=>({globalData:{sessionToken:'owner'}}));
 vi.stubGlobal('Page',(def:any)=>{view={...def,data:structuredClone(def.data),setData(p:any){Object.assign(this.data,p);}};});
});
afterEach(()=>{vi.useRealTimers();});
it('invalidates the old two-item quote when foreground stock clamps the visible quantity to one',async()=>{
 await import('../../apps/miniprogram/pages/checkout/index');
 const expires=new Date(Date.now()+60_000).toISOString(),now=new Date().toISOString();
 view.mounted=true;view.visible=true;
 view.setData({productCode:'fixture',requestedSkuId:'sku',quantity:2,selectedAddressId:'address',
  quote:{id:'old-two-items',item:{skuId:'sku'},quantity:2,addressId:'address',addressVersion:1,creditTenderCents:0,expiresAt:expires,serverTime:now},
  createKey:'old-create',quoteKey:'old-quote'});
 m.catalog.mockResolvedValue({variants:[{id:'sku',active:true,availableQuantity:1,priceCents:1000}]});
 m.addresses.mockResolvedValue({enabled:true,addresses:[{id:'address',version:1,isDefault:true}]});
 m.runtime.mockResolvedValue({version:2,scope:'formal_commerce',currency:'CNY',orderFlowEnabled:true,
  paymentAvailable:true,paymentOnboarding:'READY',formalMoneyOperationsAvailable:true,formalRecoveryAvailable:true,
  isolatedMoneyOperationsAvailable:false,isolatedTransferAvailable:false,isolatedCreditCheckoutAvailable:false});
 await view.load();expect(view.data.quantity).toBe(1);expect(view.data.quote).toBeNull();
 expect(view.data.createKey).toBe('');expect(view.data.error).toContain('重新确认');
});
