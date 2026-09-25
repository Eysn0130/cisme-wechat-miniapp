import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
const m=vi.hoisted(()=>({request:vi.fn(),authority:vi.fn()}));
vi.mock('../../apps/miniprogram/services/api',()=>({request:m.request}));
vi.mock('../../apps/miniprogram/services/authority',()=>({authorityProjection:m.authority,hasCapability:(a:any,c:string)=>a?.capabilities.includes(c)}));
vi.mock('../../apps/miniprogram/services/layout',()=>({currentChromeStyle:()=>''}));
vi.mock('../../apps/miniprogram/services/commerce-command-store',()=>({commerceContextRevision:()=>0}));
let definition:any,token:string;
const authority={version:1,managementAvailable:true,capabilities:['privacy.request.manage']};
const rows=Array.from({length:35},(_,i)=>({id:`synthetic-request-${i}`,kind:'access',message:`Synthetic private request ${i}`,status:'received',response:null,version:1,due_at:'2026-10-22T00:00:00Z',execution:null}));
beforeEach(()=>{
  vi.resetModules();vi.useFakeTimers();token='synthetic-operator';
  m.authority.mockReset().mockResolvedValue(authority);
  m.request.mockReset().mockImplementation(async(o:any)=>o.path.includes('cursor=')?{items:rows.slice(30),nextCursor:null}:{items:rows.slice(0,30),nextCursor:'page-2'});
  (globalThis as any).getApp=()=>({globalData:{sessionToken:token}});
  (globalThis as any).Page=(p:any)=>definition=p;
  (globalThis as any).wx={navigateBack:vi.fn(),redirectTo:vi.fn()};
});
afterEach(()=>{vi.clearAllTimers();vi.useRealTimers();});
async function expandedPage(){
  await import('../../apps/miniprogram/pages/management-privacy/index');
  const p={...definition,data:structuredClone(definition.data),setData(v:any){Object.assign(this.data,v);}};
  await p.onShow();await p.loadMore();
  p.select({currentTarget:{dataset:{id:rows[34]!.id}}});
  p.onResponse({detail:{value:'Synthetic private draft'}});return p;
}
describe('privacy queue pagination keeps revocation monitoring',()=>{
  it('clears expanded rows and draft when authority is revoked without another user action',async()=>{
    const p=await expandedPage();expect(p.data.items).toHaveLength(35);expect(p.timer).not.toBeNull();
    m.authority.mockResolvedValue({version:1,managementAvailable:false,capabilities:[]});
    await vi.advanceTimersByTimeAsync(6000);
    expect(p.data.items).toEqual([]);expect(p.data.selected).toBeNull();expect(p.data.response).toBe('');expect(p.data.coreReady).toBe(false);expect(p.timer).toBeNull();
  });
  it('does not replace an expanded queue or its selected draft during an authority-only poll',async()=>{
    const p=await expandedPage();const calls=m.request.mock.calls.length;
    await vi.advanceTimersByTimeAsync(6000);
    expect(m.authority).toHaveBeenCalledTimes(2);expect(m.request).toHaveBeenCalledTimes(calls);
    expect(p.data.items).toHaveLength(35);expect(p.data.selected.id).toBe(rows[34]!.id);expect(p.data.response).toBe('Synthetic private draft');
  });
  it('resumes polling after a later page fails and retains the retry position',async()=>{
    const p=await expandedPage();await p.load();m.request.mockRejectedValueOnce({status:503});await p.loadMore();
    expect(p.data.nextCursor).toBe('page-2');expect(p.data.moreError).toContain('重试');expect(p.timer).not.toBeNull();
    m.authority.mockResolvedValue({version:1,managementAvailable:false,capabilities:[]});await vi.advanceTimersByTimeAsync(6000);
    expect(p.data.items).toEqual([]);expect(p.data.coreReady).toBe(false);
  });
  it('clears expanded data when the account changes',async()=>{
    const p=await expandedPage();token='another-operator';await vi.advanceTimersByTimeAsync(6000);
    expect(p.data.items).toEqual([]);expect(p.data.selected).toBeNull();expect(p.data.response).toBe('');expect(p.timer).toBeNull();
  });
  it('ignores late authority after hide and never restarts the hidden page timer',async()=>{
    const p=await expandedPage();let finish!:(value:any)=>void;m.authority.mockImplementationOnce(()=>new Promise(resolve=>finish=resolve));
    const pending=p.load(true);p.onHide();finish(authority);await pending;
    expect(p.data.items).toEqual([]);expect(p.timer).toBeNull();expect(vi.getTimerCount()).toBe(0);
  });
  it('explicit refresh still returns to the first page and clears the prior draft',async()=>{
    const p=await expandedPage();await p.load();expect(p.data.items).toHaveLength(30);
    expect(p.data.nextCursor).toBe('page-2');expect(p.data.selected).toBeNull();expect(p.data.response).toBe('');expect(p.timer).not.toBeNull();
  });
  it('clears private data rather than retaining it when authority cannot be verified',async()=>{
    const p=await expandedPage();m.authority.mockRejectedValueOnce({status:503});await vi.advanceTimersByTimeAsync(6000);
    expect(p.data.items).toEqual([]);expect(p.data.selected).toBeNull();expect(p.data.response).toBe('');expect(p.data.coreReady).toBe(false);
  });
});
