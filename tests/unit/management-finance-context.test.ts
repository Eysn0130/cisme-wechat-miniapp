import {beforeEach,afterEach,it,expect,vi} from 'vitest';
const m=vi.hoisted(()=>({token:'operator-a',revision:0,request:vi.fn(),authority:vi.fn(),runtime:vi.fn()}));
vi.mock('../../apps/miniprogram/services/api',()=>({request:m.request}));
vi.mock('../../apps/miniprogram/services/authority',()=>({authorityProjection:m.authority,hasCapability:(p:any,c:string)=>p?.capabilities?.includes(c)??false}));
vi.mock('../../apps/miniprogram/services/layout',()=>({currentChromeStyle:()=>''}));
vi.mock('../../apps/miniprogram/services/commerce-command-store',()=>({commerceContextRevision:()=>m.revision}));
vi.mock('../../apps/miniprogram/services/orders',()=>({orderRuntimeStatus:m.runtime,clientOperationKey:()=> 'synthetic-finance-operation'}));
const id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',row={id:'synthetic-request',orderId:id,version:2,amountCents:19800,createdAt:'2026-11-11T10:00:00Z'};
let page:any;
const flush=async()=>{for(let i=0;i<30;i++)await Promise.resolve();};
beforeEach(async()=>{
 vi.resetModules();vi.clearAllMocks();m.token='operator-a';m.revision=0;
 vi.stubGlobal('getApp',()=>({globalData:{get sessionToken(){return m.token;}}}));
 vi.stubGlobal('wx',{navigateTo:vi.fn(),showModal:vi.fn().mockResolvedValue({confirm:false}),navigateBack:vi.fn(),redirectTo:vi.fn()});
 vi.stubGlobal('Page',(d:any)=>{page={...d,data:structuredClone(d.data),setData(p:any){Object.assign(this.data,p);}};});
 m.authority.mockResolvedValue({version:1,managementAvailable:true,capabilities:['commerce.refund.approve','commerce.order.read','commerce.money.reconcile']});
 m.runtime.mockResolvedValue({version:2,scope:'formal_commerce',currency:'CNY',orderFlowEnabled:true,paymentAvailable:true,paymentOnboarding:'READY',formalMoneyOperationsAvailable:true,formalRecoveryAvailable:true,isolatedMoneyOperationsAvailable:false,isolatedTransferAvailable:false,isolatedCreditCheckoutAvailable:false});
 m.request.mockResolvedValue({items:[row],totalCount:1,nextCursor:null});await import('../../apps/miniprogram/pages/management-finance/index');await page.establish();await flush();
});
afterEach(()=>vi.unstubAllGlobals());
it('links only a current authorized finance row to its real order route and shows Beijing time',()=>{
 expect(page.data.items[0].dateLabel).toContain('18:00');expect(page.data.items[0].dateLabel).toContain('北京时间');
 page.openOrder({currentTarget:{dataset:{id:'forged-id'}}});expect(wx.navigateTo).not.toHaveBeenCalled();
 page.openOrder({currentTarget:{dataset:{id}}});page.openOrder({currentTarget:{dataset:{id}}});
 expect(wx.navigateTo).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({url:'/pages/management-order-detail/index?id='+id}));
});
it.each(['account','context'])('clears a stale finance snapshot before a %s change can initiate a decision',async(kind)=>{
 if(kind==='account')m.token='operator-b';else m.revision++;
 await page.decide({currentTarget:{dataset:{id:row.id,decision:'approve'}}});
 expect(wx.showModal).not.toHaveBeenCalled();expect(m.request.mock.calls.filter(([o])=>o.method)).toHaveLength(0);
 expect(page.data).toMatchObject({items:[],sections:[],cycle:null,authority:null,canReadOrders:false,errorRetryable:true});
});
it('drops a confirmation that returns after the operator changes',async()=>{
 let finish!:(r:any)=>void;(wx.showModal as any).mockImplementation(()=>new Promise(r=>finish=r));
 const work=page.decide({currentTarget:{dataset:{id:row.id,decision:'approve'}}});m.token='operator-b';finish({confirm:true,content:'合成复核依据'});await work;
 expect(m.request.mock.calls.filter(([o])=>o.method)).toHaveLength(0);
});
it('does not invent order access for a finance-only operator',async()=>{
 m.authority.mockResolvedValue({version:1,managementAvailable:true,capabilities:['commerce.refund.approve']});await page.establish();await flush();
 expect(page.data.canReadOrders).toBe(false);page.openOrder({currentTarget:{dataset:{id}}});expect(wx.navigateTo).not.toHaveBeenCalled();
});
