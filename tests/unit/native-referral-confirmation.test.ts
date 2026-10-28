import {beforeEach,describe,expect,it,vi} from "vitest";

const mocks=vi.hoisted(()=>({token:"synthetic-member",request:vi.fn(),resume:vi.fn()}));
vi.mock("../../apps/miniprogram/services/api",()=>({request:mocks.request,resumeAuthentication:mocks.resume}));
vi.mock("../../apps/miniprogram/services/layout",()=>({currentChromeStyle:()=>""}));
const code="CMABCDEFGHJK";
let page:any,patches:unknown[];
const deferred=()=>{let reject!:(error:unknown)=>void;const promise=new Promise<never>((_,fail)=>{reject=fail;});return {promise,reject};};
async function mount(){
 await import("../../apps/miniprogram/pages/referral/index");page.onLoad({code});await page.preview();mocks.request.mockClear();
}
beforeEach(()=>{
 vi.resetModules();mocks.token="synthetic-member";mocks.request.mockReset();mocks.resume.mockReset();patches=[];
 (globalThis as any).getApp=()=>({globalData:{sessionToken:mocks.token}});
 (globalThis as any).Page=(definition:any)=>{page={...definition,data:structuredClone(definition.data),setData(update:unknown){patches.push(structuredClone(update));Object.assign(this.data,structuredClone(update));}};};
 (globalThis as any).wx={showModal:vi.fn(),navigateBack:vi.fn(),switchTab:vi.fn()};
 mocks.request.mockImplementation(async(options:any)=>options.method==="POST"?{confirmed:true,alreadyConfirmed:false}:{code,sponsorLabel:"合成推荐人",relationState:"available",attributionLevel:1});
});

describe("native referral confirmation dialog recovery",()=>{
 it("reports a failed native dialog without submitting or replacing the confirmation key, then permits an explicit retry",async()=>{
  await mount();const key=page.data.key,preview=structuredClone(page.data.preview);
  (globalThis as any).wx.showModal.mockRejectedValueOnce({errMsg:"showModal:fail"});
  await expect(page.confirm()).resolves.toBeUndefined();
  expect(page.data).toMatchObject({busy:false,confirmed:false,key,preview,error:"确认窗口暂时无法打开，请重试。"});expect(mocks.request).not.toHaveBeenCalled();
  (globalThis as any).wx.showModal.mockResolvedValueOnce({confirm:true});await page.confirm();
  expect(mocks.request).toHaveBeenCalledExactlyOnceWith({path:"/v1/me/referral/confirm",method:"POST",data:{code,confirmationKey:key}});
  expect(page.data).toMatchObject({busy:false,confirmed:true,error:""});
 });
 it("treats an ordinary native cancel as a choice, with no failure or relationship write",async()=>{
  await mount();const key=page.data.key;(globalThis as any).wx.showModal.mockResolvedValueOnce({confirm:false,cancel:true});await page.confirm();
  expect(page.data).toMatchObject({busy:false,confirmed:false,key,error:""});expect(mocks.request).not.toHaveBeenCalled();
 });
 it.each(["actor","code","unload"] as const)("does not display a late dialog failure after %s changes its ownership",async(change)=>{
  await mount();const pending=deferred();(globalThis as any).wx.showModal.mockReturnValueOnce(pending.promise);const confirming=page.confirm();
  if(change==="actor")mocks.token="different-synthetic-member";
  else if(change==="code")page.editCode({detail:{value:"CMBCDEFGHJKL"}});
  else page.onUnload();
  const before=patches.length;pending.reject({errMsg:"showModal:fail"});await expect(confirming).resolves.toBeUndefined();
  expect(patches.slice(before)).toEqual([]);expect(mocks.request).not.toHaveBeenCalled();expect(page.data.error).toBe("");
 });
});
