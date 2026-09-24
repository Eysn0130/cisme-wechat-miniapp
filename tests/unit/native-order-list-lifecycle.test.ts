import { beforeEach, describe, expect, it, vi } from "vitest";
const m=vi.hoisted(()=>({token:"member-a",request:vi.fn()}));
vi.mock("../../apps/miniprogram/services/api",()=>({request:m.request,requireMemberAccess:()=>Boolean(m.token),
 historicalCommerceToken:()=>m.token,historicalCommerceClosed:()=>false,requireHistoricalCommerceAccess:()=>Boolean(m.token),
 retainMemberSnapshot:()=>true,clearAuthenticationRedirectSuppression:vi.fn()}));
vi.mock("../../apps/miniprogram/services/layout",()=>({currentChromeStyle:()=>""}));
const later=()=>{let resolve!:(x:any)=>void,reject!:(x:any)=>void;const promise=new Promise<any>((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const flush=async()=>{for(let i=0;i<30;i++)await Promise.resolve();};
let page:any,read:ReturnType<typeof later>,authority:ReturnType<typeof later>,aborts:Map<string,ReturnType<typeof vi.fn>>;
const item={id:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",status:"paid",totalCents:1234,createdAt:"2026-09-21T00:00:00Z",orderNumber:"SYNTHETIC",lines:[{productName:"合成商品",skuLabel:"规格",quantity:1}]};
const grant={version:1,managementAvailable:true,capabilities:["commerce.order.read"]};
beforeEach(()=>{vi.resetModules();vi.clearAllMocks();m.token="member-a";read=later();authority=later();aborts=new Map();
  m.request.mockImplementation((options:any)=>{const abort=vi.fn();aborts.set(options.path,abort);options.registerAbort?.(abort);return options.path==="/v1/me/authority"?authority.promise:read.promise;});
  (globalThis as any).getApp=()=>({globalData:{sessionToken:m.token}});
  (globalThis as any).wx={showToast:vi.fn(),navigateBack:vi.fn(),navigateTo:vi.fn(),redirectTo:vi.fn(),switchTab:vi.fn()};
  (globalThis as any).Page=(def:any)=>{page={...def,data:structuredClone(def.data),setData(p:any){Object.assign(this.data,p);}};};
});
describe.each(["orders","management-orders"])("owned list reads: %s",name=>{
  const path=()=>name==="orders"?"/v1/me/orders?limit=20":"/v1/management/commerce/orders?limit=20";
  const load=async()=>{if(name==="orders")await import("../../apps/miniprogram/pages/orders/index");else await import("../../apps/miniprogram/pages/management-orders/index");void page.onShow();authority.resolve(grant);await flush();};
  it("cancels its outstanding list read on hide and ignores its response",async()=>{await load();page.onHide();const aborted=aborts.get(path())?.mock.calls.length??0;read.resolve({items:[item],nextCursor:null});await flush();expect(aborted).toBe(1);expect(page.data.items).toEqual([]);});
  it("does not start retry or pagination while hidden",async()=>{await load();read.resolve({items:[item],nextCursor:"cursor"});await flush();page.onHide();m.request.mockClear();await page.load();await page.loadMore();expect(m.request).not.toHaveBeenCalled();});
  it("retains last verified display while refreshing but closes navigation until fresh facts",async()=>{await load();read.resolve({items:[item],nextCursor:null});await flush();read=later();void page.onShow();await flush();expect(page.data.items[0]?.totalYuan).toBe("12.34");page.open({currentTarget:{dataset:{id:item.id}}});expect(wx.navigateTo).not.toHaveBeenCalled();read.reject(new Error("synthetic unavailable"));await flush();expect(page.data.items[0]?.totalYuan).toBe("12.34");expect(page.data.error).not.toBe("");});
  it("clears retained sensitive display on forbidden refresh",async()=>{await load();read.resolve({items:[item],nextCursor:null});await flush();read=later();void page.onShow();await flush();read.reject({status:403,title:"synthetic revoked"});await flush();expect(page.data.items).toEqual([]);expect(page.data.nextCursor).toBeNull();});
  it("blocks navigation immediately after account change even before onShow",async()=>{await load();read.resolve({items:[item],nextCursor:null});await flush();m.token="member-b";page.open({currentTarget:{dataset:{id:item.id}}});expect(wx.navigateTo).not.toHaveBeenCalled();});
  it("ignores an old page after unload and allows fresh reads after show",async()=>{await load();const old=read;page.onUnload();read=later();void page.onShow();await flush();old.resolve({items:[item],nextCursor:"obsolete"});await flush();expect(page.data.items).toEqual([]);read.resolve({items:[{...item,orderNumber:"FRESH"}],nextCursor:null});await flush();expect(page.data.items[0].orderNumber).toBe("FRESH");});
  it("keeps the explicit paid display instead of an internal state label",async()=>{await load();read.resolve({items:[item],nextCursor:null});await flush();expect(page.data.items[0].statusLabel).toBe("已付款");});
});
it("hidden management authority denial cannot navigate the newly visible page",async()=>{await import("../../apps/miniprogram/pages/management-orders/index");void page.onShow();page.onHide();authority.reject({status:403});await flush();expect(wx.navigateBack).not.toHaveBeenCalled();expect(m.request.mock.calls.filter(([o])=>o.path.startsWith("/v1/management/"))).toHaveLength(0);});
