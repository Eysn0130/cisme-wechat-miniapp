import {beforeEach,expect,it,vi} from 'vitest';
const m=vi.hoisted(()=>({read:vi.fn(),write:vi.fn(),token:'synthetic-admin',revision:0,modal:vi.fn(),login:vi.fn(()=>true)}));
vi.mock('../../apps/miniprogram/services/api',()=>({request:m.write,requireMemberAccess:m.login}));
vi.mock('../../apps/miniprogram/services/page-requests',()=>({pageRead:(_owner:any,options:any)=>m.read(options),cancelPageReads:vi.fn()}));
vi.mock('../../apps/miniprogram/services/layout',()=>({currentChromeStyle:()=>''}));
vi.mock('../../apps/miniprogram/services/commerce-command-store',()=>({commerceContextRevision:()=>m.revision}));
let p:any;const id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',postId='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const row={id,version:2,targetType:'post',targetVersion:4,postId,title:'合成公开帖子',reason:'合成举报依据',postState:'hidden'};
const tap=(decision:string)=>({currentTarget:{dataset:{id,decision}}});
beforeEach(async()=>{vi.resetModules();vi.clearAllMocks();m.token='synthetic-admin';m.revision=0;m.read.mockReset().mockResolvedValue({items:[row],matchingTotal:1,nextCursor:null});m.modal.mockResolvedValue({confirm:true,content:'合成核查依据'});
 (globalThis as any).getApp=()=>({globalData:{sessionToken:m.token,apiBaseUrl:'https://synthetic.invalid'}});(globalThis as any).wx={showModal:m.modal,showToast:vi.fn(),navigateTo:vi.fn(),switchTab:vi.fn()};
 (globalThis as any).Page=(d:any)=>{p={...d,data:structuredClone(d.data),setData(v:any){Object.assign(this.data,v);}};};await import('../../apps/miniprogram/pages/community-review/index');
 p.onLoad({source:'moderation'});await vi.waitFor(()=>expect(p.data.loading).toBe(false));});
it('uses the administrator governance queue and never reads legacy private post candidates',()=>{
 expect(m.read.mock.calls.map(([r])=>r.path)).toEqual(['/v1/management/ugc/reports?limit=30']);expect(p.data.governanceItems).toHaveLength(1);
});
it('requires confirmation and the exact reported target version before hiding',async()=>{
 m.modal.mockResolvedValueOnce({confirm:false});await p.decideGovernance(tap('hide_post'));expect(m.write).not.toHaveBeenCalled();
 await p.decideGovernance(tap('hide_post'));expect(m.write).toHaveBeenCalledWith({path:`/v1/management/ugc/reports/${id}/decision`,method:'POST',data:{decision:'hide_post',reason:'合成核查依据',expectedVersion:2,expectedTargetVersion:4}});
});
it('erases private evidence on hide and never adopts a late response',async()=>{
 let resolve!:(v:any)=>void;m.read.mockReturnValueOnce(new Promise(r=>resolve=r));const pending=p.loadGovernance();p.onHide();resolve({items:[row],matchingTotal:1,nextCursor:null});await pending;expect(p.data.governanceItems).toEqual([]);
});
it('does not submit a confirmation returned after the administrator identity changed',async()=>{
 let resolve!:(v:any)=>void;m.modal.mockReturnValueOnce(new Promise(r=>resolve=r));const pending=p.decideGovernance(tap('hide_post'));m.token='another-admin';resolve({confirm:true,content:'原账号依据'});await pending;expect(m.write).not.toHaveBeenCalled();expect(p.data.governanceItems).toEqual([]);
});
it('denies restoration when the public gate is unavailable and clears revoked evidence',async()=>{
 p.data.governanceTab='appeals';p.data.governancePublicEnabled=false;await p.decideGovernance(tap('restore'));expect(m.modal).not.toHaveBeenCalled();
 m.write.mockRejectedValueOnce({status:403});p.data.governanceTab='reports';await p.decideGovernance(tap('dismiss'));expect(p.data.permissionDenied).toBe(true);expect(p.data.governanceItems).toEqual([]);
});
