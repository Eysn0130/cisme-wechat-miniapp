import {beforeEach,describe,expect,it,vi} from "vitest";
let runtime:any,wxMock:any,storage:Map<string,unknown>,response:any;
const source="/pages/post/index?id=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa&source=editorial";
beforeEach(()=>{
 vi.resetModules();storage=new Map();runtime={globalData:{sessionToken:"synthetic-existing-session",privacyRightsToken:"",apiBaseUrl:"https://synthetic.invalid",sessionStorageKey:"synthetic.session"}};
 response={statusCode:200,data:{accepted:true,documents:[{documentType:"terms",version:"v2"},{documentType:"privacy",version:"v2"}]}};
 (globalThis as any).getApp=()=>runtime;(globalThis as any).getCurrentPages=()=>[{route:"pages/post/index",options:{id:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",source:"editorial"}}];
 wxMock={getStorageSync:(key:string)=>storage.get(key)||"",setStorageSync:vi.fn((key:string,value:unknown)=>storage.set(key,value)),removeStorageSync:vi.fn((key:string)=>storage.delete(key)),navigateTo:vi.fn(),reLaunch:vi.fn(),showToast:vi.fn(),request:vi.fn((options:any)=>{queueMicrotask(()=>options.success(response));return {abort:vi.fn()};})};(globalThis as any).wx=wxMock;
});
describe("narrow legal renewal navigation and transport",()=>{
 it("keeps the old session, stores the exact source, and deduplicates the renew page",async()=>{
  const api=await import("../../apps/miniprogram/services/api");api.beginLegalRenewal(source);api.beginLegalRenewal(source);
  expect(runtime.globalData.sessionToken).toBe("synthetic-existing-session");expect(storage.get("cisme.authReturnUrl")).toBe(source);expect(wxMock.navigateTo).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({url:"/pages/account/index?intent=renew"}));expect(wxMock.request).not.toHaveBeenCalled();
 });
 it("falls back to the same explicit renew intent without replacing the token",async()=>{
  const api=await import("../../apps/miniprogram/services/api");api.beginLegalRenewal(source);wxMock.navigateTo.mock.calls[0][0].fail();expect(wxMock.reLaunch).toHaveBeenCalledWith(expect.objectContaining({url:"/pages/account/index?intent=renew"}));expect(runtime.globalData.sessionToken).toBe("synthetic-existing-session");
 });
 it("uses normal login intent for a truly missing member session",async()=>{
  runtime.globalData.sessionToken="";const api=await import("../../apps/miniprogram/services/api");api.beginLegalRenewal(source);expect(wxMock.navigateTo).toHaveBeenCalledWith(expect.objectContaining({url:"/pages/account/index?intent=login"}));expect(wxMock.request).not.toHaveBeenCalled();
 });
 it("sends only the two explicit versions to the authenticated acceptance route and does not issue identity or interaction calls",async()=>{
  const api=await import("../../apps/miniprogram/services/api");const consents=[{documentType:"terms" as const,version:"v2"},{documentType:"privacy" as const,version:"v2"}];await api.acceptCurrentLegalDocuments(consents);
  expect(wxMock.request).toHaveBeenCalledOnce();expect(wxMock.request.mock.calls[0][0]).toMatchObject({url:"https://synthetic.invalid/v1/me/legal-acceptances",method:"POST",data:{consents},header:{Authorization:"Bearer synthetic-existing-session"}});expect(runtime.globalData.sessionToken).toBe("synthetic-existing-session");expect(wxMock.navigateTo).not.toHaveBeenCalled();
 });
 it("rejects an unconfirmed or different-version acceptance receipt",async()=>{
  response={statusCode:200,data:{accepted:true,documents:[{documentType:"terms",version:"v1"},{documentType:"privacy",version:"v2"}]}};const api=await import("../../apps/miniprogram/services/api");await expect(api.acceptCurrentLegalDocuments([{documentType:"terms",version:"v2"},{documentType:"privacy",version:"v2"}])).rejects.toThrow("CURRENT_LEGAL_ACCEPTANCE_RESPONSE_INVALID");expect(runtime.globalData.sessionToken).toBe("synthetic-existing-session");expect(wxMock.navigateTo).not.toHaveBeenCalled();
 });
});
