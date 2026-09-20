import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks=vi.hoisted(()=>({request:vi.fn(),token:"session-a"}));
vi.mock("../../apps/miniprogram/services/api",()=>({request:mocks.request,resumeAuthentication:vi.fn()}));
vi.mock("../../apps/miniprogram/services/page-requests",()=>({pageRead:(_page:unknown,options:unknown)=>mocks.request(options),cancelPageReads:vi.fn()}));
vi.mock("../../apps/miniprogram/services/layout",()=>({currentChromeStyle:()=>""}));
let page:any;
const delayed=()=>{let resolve!:(value:any)=>void,reject!:(value:any)=>void;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const entry=(id:string)=>({id,title:id,authorId:"synthetic",likeCount:0});
function patch(target:any,key:string,value:any){const parts=key.replace(/\[(\d+)\]/g,".$1").split(".");let current=target;for(const [i,name] of parts.entries()){if(i===parts.length-1)current[name]=structuredClone(value);else current=current[name!]??=(/^\d+$/.test(parts[i+1]!)?[]:{});}}
beforeEach(async()=>{vi.resetModules();mocks.request.mockReset();mocks.token="session-a";(globalThis as any).getApp=()=>({globalData:{sessionToken:mocks.token,apiBaseUrl:"https://synthetic.invalid"}});(globalThis as any).wx={};(globalThis as any).Page=(definition:any)=>{page={...definition,data:structuredClone(definition.data),setData(updates:any,callback?:()=>void){for(const [key,value]of Object.entries(updates))patch(this.data,key,value);callback?.();}};};await import("../../apps/miniprogram/pages/community/index");Object.assign(page.data,{loading:false,mode:"recommend",ugcFeedEnabled:true,formalNextCursor:"start",feedColumns:[[],[]],displayFeedCount:0});});
describe("native community pagination response ownership",()=>{
  it("does not revive A's response after A→B→A or clear the new request's busy state",async()=>{
    const old=delayed();mocks.request.mockReturnValueOnce(old.promise);const first=page.onReachBottom();
    await page.selectMode({currentTarget:{dataset:{mode:"featured"}}});await page.selectMode({currentTarget:{dataset:{mode:"recommend"}}});
    const newer=delayed();mocks.request.mockReturnValueOnce(newer.promise);const second=page.onReachBottom();
    old.resolve({items:[entry("old")],nextCursor:null});await first;expect(page.data.formalLoadingMore).toBe(true);expect(page.data.displayFeedCount).toBe(0);
    newer.resolve({items:[entry("new")],nextCursor:null});await second;expect(page.data.feedColumns.flat().map((row:any)=>row.id)).toEqual(["new"]);
  });
  it("retains cards on a pagination failure and deduplicates both within and across pages",async()=>{
    mocks.request.mockResolvedValueOnce({items:[entry("a"),entry("a")],nextCursor:"second"});await page.onReachBottom();expect(page.data.displayFeedCount).toBe(1);
    mocks.request.mockRejectedValueOnce({code:"NETWORK_TIMEOUT"});await page.onReachBottom();expect(page.data.displayFeedCount).toBe(1);expect(page.data.moreError).toContain("已显示的故事保留");
    mocks.request.mockResolvedValueOnce({items:[entry("a"),entry("b")],nextCursor:null});await page.onReachBottom();expect(page.data.feedColumns.flat().map((row:any)=>row.id).sort()).toEqual(["a","b"]);
  });
  it("suppresses a pagination result and error after account change",async()=>{
    const old=delayed();mocks.request.mockReturnValueOnce(old.promise);const first=page.onReachBottom();mocks.token="session-b";page.onHide();old.reject({code:"NETWORK_TIMEOUT"});await first;
    expect(page.data.feedColumns).toEqual([[],[]]);expect(page.data.moreError).toBe("");
  });
});
