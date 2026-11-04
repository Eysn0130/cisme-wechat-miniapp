import {beforeEach,it,expect,vi} from "vitest";
import {PlatformService} from "../../services/api/src/platformService";
import {FormalUgcService} from "../../services/api/src/formalUgc";
vi.mock("../../apps/miniprogram/services/layout",()=>({currentChromeStyle:()=>""}));

const removed=["getTask","claimTask","authorizeMedia","completeMedia","deleteMedia","saveSubmissionDraft","submit","review","appeal","publishSubmission","updateCampaign"];
it.each(removed)("permanently rejects retired task/proof %s before any database or object mutation",async name=>{
  const pool={query:vi.fn(),connect:vi.fn()},storage={writeGatewayObject:vi.fn(),delete:vi.fn()};
  const service=new PlatformService(pool as never,{ugcGoLiveGate:true,allowDevAdapters:true} as never,storage as never);
  await expect((service as any)[name]("synthetic","synthetic","synthetic",{},new Date())).rejects.toMatchObject({status:410,code:"TASK_PROOF_REMOVED"});
  expect(pool.query).not.toHaveBeenCalled();expect(pool.connect).not.toHaveBeenCalled();expect(storage.delete).not.toHaveBeenCalled();
});
it.each(["reviewMedia","reviewPost","publish"])("removes the old ordinary-post human %s operation",async name=>{
  const pool={query:vi.fn(),connect:vi.fn()};const service=new FormalUgcService(pool as never,{} as never,{} as never,{} as never);
  await expect((service as any)[name]("synthetic","synthetic",{})).rejects.toMatchObject({status:410,code:"UGC_MANUAL_REVIEW_REMOVED"});
  expect(pool.query).not.toHaveBeenCalled();expect(pool.connect).not.toHaveBeenCalled();
});
let definition:any,native:any;
beforeEach(()=>{vi.resetModules();native={switchTab:vi.fn()};Object.assign(globalThis,{wx:native,Page:(value:any)=>{definition=value;}});});
it.each(["task","submit","progress"])("returns old %s links to Community without a form, login or network operation",async route=>{
  const load={task:()=>import("../../apps/miniprogram/pages/task/index"),submit:()=>import("../../apps/miniprogram/pages/submit/index"),progress:()=>import("../../apps/miniprogram/pages/progress/index")};
  await load[route as keyof typeof load]();
  const page={...definition,data:{...definition.data},setData(patch:any){Object.assign(this.data,patch);}};
  page.onLoad({id:"synthetic-previous-submission"});
  expect(native.switchTab).toHaveBeenCalledWith(expect.objectContaining({url:"/pages/community/index"}));
  expect(Object.keys(page.data).sort()).toEqual(["chromeStyle","returnFailed"]);
  native.switchTab.mock.calls[0][0].fail();expect(page.data.returnFailed).toBe(true);
  page.returnToCommunity();expect(native.switchTab).toHaveBeenCalledTimes(2);expect(page.data.returnFailed).toBe(false);
});
