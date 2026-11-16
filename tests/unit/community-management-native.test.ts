import {beforeEach,expect,it,vi} from 'vitest';
const m=vi.hoisted(()=>({read:vi.fn(),change:vi.fn(),login:vi.fn(),modal:vi.fn(),token:'admin-a',revision:0}));
vi.mock('../../apps/miniprogram/services/layout',()=>({currentChromeStyle:()=>''}));
vi.mock('../../apps/miniprogram/services/api',()=>({requireMemberAccess:m.login}));
vi.mock('../../apps/miniprogram/services/page-requests',()=>({cancelPageReads:vi.fn()}));
vi.mock('../../apps/miniprogram/services/commerce-command-store',()=>({commerceContextRevision:()=>m.revision}));
vi.mock('../../apps/miniprogram/services/member-avatar',()=>({localMemberAvatar:async()=>'/local-public-avatar'}));
vi.mock('../../apps/miniprogram/services/community-management',()=>({managedCommunityPosts:m.read,changeCommunityPost:m.change}));
const id='11111111-1111-4111-8111-111111111111';
const row=(v:Record<string,unknown>={})=>({id,version:4,revision:2,title:'公开的护理体验',body:'本人已经公开的护理感受',authorId:'22222222-2222-4222-8222-222222222222',author:'真实会员昵称',avatar:'data:image/png;base64,synthetic',avatarRevision:'r1',coverId:null,publishedAt:'2026-11-16T10:00:00Z',state:'published',placement:'recommend',likeCount:3,commentCount:2,...v});
const page=(rows:unknown[]=[row()],nextCursor:string|null=null)=>({items:rows,matchingTotal:rows.length,nextCursor});
const deferred=()=>{let resolve!:(v:any)=>void,reject!:(e:any)=>void;const promise=new Promise<any>((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
let p:any,wxMock:any;
const tap=(action:string)=>({currentTarget:{dataset:{id,action}}});
beforeEach(async()=>{
 vi.resetModules();vi.clearAllMocks();m.token='admin-a';m.revision=0;m.read.mockResolvedValue(page());m.change.mockResolvedValue({});m.modal.mockResolvedValue({confirm:true});
 (globalThis as any).getApp=()=>({globalData:{sessionToken:m.token,apiBaseUrl:'https://synthetic.invalid'}});
 wxMock={showToast:vi.fn(),showModal:m.modal,navigateTo:vi.fn(),navigateBack:vi.fn(),switchTab:vi.fn(),stopPullDownRefresh:vi.fn()};(globalThis as any).wx=wxMock;
 (globalThis as any).Page=(d:any)=>{p={...d,data:structuredClone(d.data),setData(v:any){Object.assign(this.data,v);}};};
 await import('../../apps/miniprogram/pages/management-community/index');p.visible=true;await p.load();
});
it('shows confirmed identity and counts, with local avatar paths rather than duplicating profile payloads over setData',()=>{
 expect(p.data).toMatchObject({total:1,ready:true,loading:false});expect(p.data.rows[0]).toMatchObject({author:'真实会员昵称',avatar:'',avatarSrc:'/local-public-avatar',likeCount:3});
});
it('keeps confirmed rows during refresh and never treats an offline read as an empty list',async()=>{
 const d=deferred();m.read.mockReturnValueOnce(d.promise);const read=p.load();expect(p.data.rows).toHaveLength(1);expect(p.data.ready).toBe(true);
 d.reject({title:'网络暂不可用'});await read;expect(p.data.rows).toHaveLength(1);expect(p.data.total).toBe(1);expect(p.data.error).toBe('网络暂不可用');
});
it.each(['account','environment','hidden'])('drops late private list data after %s change',async(change)=>{
 const d=deferred();m.read.mockReturnValueOnce(d.promise);const read=p.load();if(change==='account')m.token='admin-b';else if(change==='environment')m.revision++;else p.onHide();
 d.resolve(page([row({author:'旧账号读取'})]));await read;expect(p.data.rows).toEqual([]);expect(p.data.detail).toBeNull();expect(p.data.busyId).toBe('');
});
it('requires login and never reads the management endpoint for a guest',async()=>{
 m.token='';m.read.mockClear();await p.load();expect(m.read).not.toHaveBeenCalled();expect(m.login).toHaveBeenCalledWith('/pages/management-community/index');expect(p.data.rows).toEqual([]);
});
it('clears the rows and detail when the server revokes moderation permission',async()=>{
 p.openDetail(tap(''));m.read.mockRejectedValueOnce({status:403});await p.load();expect(p.data).toMatchObject({rows:[],detail:null,denied:true,total:null});await p.act(tap('delete'));expect(m.change).not.toHaveBeenCalled();
});
it('uses a single confirmed command for placement and does not open an unnecessary confirmation',async()=>{
 const d=deferred();m.change.mockReturnValueOnce(d.promise);const pending=p.act(tap('featured'));await p.act(tap('featured'));expect(m.change).toHaveBeenCalledTimes(1);expect(m.modal).not.toHaveBeenCalled();
 expect(p.data.rows).toHaveLength(1);m.read.mockResolvedValue(page([]));d.resolve({version:5});await pending;expect(p.data.rows).toEqual([]);expect(wxMock.showToast).toHaveBeenCalledWith({title:'已移入精选',icon:'success'});
});
it('cancelling a destructive confirmation never dispatches a mutation',async()=>{
 m.modal.mockResolvedValueOnce({confirm:false});await p.act(tap('delete'));expect(m.change).not.toHaveBeenCalled();expect(p.data.rows).toHaveLength(1);expect(p.data.busyId).toBe('');
});
it('changing accounts inside confirmation cannot delete the previous member post',async()=>{
 const d=deferred();m.modal.mockReturnValueOnce(d.promise);const pending=p.act(tap('delete'));m.token='admin-b';d.resolve({confirm:true});await pending;expect(m.change).not.toHaveBeenCalled();expect(p.data.rows).toEqual([]);
});
it('a stale version refreshes authoritative data without automatically retrying the write',async()=>{
 m.change.mockRejectedValueOnce({status:409});m.read.mockResolvedValueOnce(page([row({version:5})]));await p.act(tap('hide'));expect(m.change).toHaveBeenCalledTimes(1);expect(p.data.rows[0].version).toBe(5);expect(p.data.error).toContain('已刷新');
});
it('an unknown write outcome remains unconfirmed and is not sent again',async()=>{
 m.change.mockRejectedValueOnce(new Error('network'));await p.act(tap('delete'));expect(m.change).toHaveBeenCalledTimes(1);expect(wxMock.showToast).not.toHaveBeenCalled();expect(p.data.rows).toHaveLength(1);expect(p.data.error).toContain('结果暂未确认');
});
